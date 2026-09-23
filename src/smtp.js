import { format } from 'node:util';
import { SMTPServer } from 'smtp-server';
import { MaxSizeExceeded } from './blobstore.js';
import { ScanRejected } from './scan.js';
import { domainOf } from './db.js';
import { readAllEffective } from './settings.js';

/**
 * The SMTP side of the lab: accepts anonymous submission on a high port and hands
 * every accepted message to the shared delivery path.
 *
 * No AUTH and no STARTTLS by design — lab senders are scripts and test harnesses
 * on loopback, and demanding credentials would only get in the way. The listener
 * binds 127.0.0.1 unless explicitly told otherwise.
 */
export function createSmtpServer({ db, blobs, delivery, config, logger = console }) {
  const limits = () => readAllEffective(db);

  // Whether the line-by-line conversation is being recorded. Read once per
  // connection rather than per line, which is both cheap and coherent: a session
  // is transcribed in full or not at all, never half of one.
  const transcript = { on: protocolLoggingOn(db) };

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    // Lab senders often have no resolvable reverse DNS; looking it up only adds latency.
    disableReverseLookup: true,
    // smtp-server writes the protocol itself — every C: and S: line, connection
    // open and close, and its own errors. That is the raw SMTP log an operator
    // actually wants, so it is captured rather than discarded, but only into the
    // in-memory buffer: printing it would bury the one-line summaries below.
    logger: protocolLogger(logger, transcript),

    onConnect(session, callback) {
      // smtp-server reads name, banner, size, maxClients and socketTimeout from this
      // object on every connection, so applying the admin's settings here makes them
      // take effect immediately rather than at the next restart.
      applyLimits(server, limits());
      transcript.on = protocolLoggingOn(db);

      // A connection is worth a line of its own. "Did the sender reach me at all?"
      // is the first question asked of a lab mail server, and until now only a
      // delivered or refused message answered it — a client that connected and then
      // failed to send anything left no trace whatsoever unless the full transcript
      // was switched on.
      logger.info?.(`smtp: connection from ${session.remoteAddress || 'unknown'}`);
      return callback();
    },

    onMailFrom(address, session, callback) {
      session.mbRecipientCount = 0;
      return callback();
    },

    onRcptTo(address, session, callback) {
      const { smtp_max_recipients: maxRecipients } = limits();
      session.mbRecipientCount = (session.mbRecipientCount ?? 0) + 1;

      // One message must not be able to fan out to thousands of mailbox rows.
      if (session.mbRecipientCount > maxRecipients) {
        const err = new Error(`Too many recipients (limit is ${maxRecipients})`);
        err.responseCode = 452;
        logger.info?.(`smtp: refused recipient ${address.address} (over the ${maxRecipients} limit)`);
        session.mbOutcomeLogged = true;
        return callback(err);
      }

      const domain = domainOf(address.address);
      if (db.isDomainAccepted(domain)) return callback();

      // Same refusal a real MTA gives for a domain it does not handle, so clients
      // under test see a realistic failure rather than a silent drop.
      const err = new Error(`Relay denied for ${domain || 'missing domain'}`);
      err.responseCode = 550;
      logger.info?.(`smtp: rejected ${address.address} (policy=allowlist)`);
      session.mbOutcomeLogged = true;
      return callback(err);
    },

    onData(stream, session, callback) {
      const maxSize = limits().smtp_max_size;
      let refused = false;

      /**
       * Stop an oversized transfer instead of reading it to the end.
       *
       * The library advertises `size` and checks a declared `MAIL FROM SIZE=`, but it
       * does not enforce the transfer itself, and it only emits the handler's own
       * response once it has seen the terminating dot. Waiting for that would mean
       * reading every byte of a message we have already refused, so the refusal is
       * written to the socket directly and the connection is then closed: the client
       * still gets a proper `552`, and we stop reading.
       */
      const refuseOversize = () => {
        if (refused || session.mbAborted) return;
        refused = true;
        session.mbAborted = true;

        // Destroy with an error rather than unpiping: a clean end would let the blob
        // store commit the truncated message as a file nothing references, which is
        // the very disk leak this limit exists to prevent. The error makes the store
        // discard its partial write instead.
        stream.destroy(new MaxSizeExceeded(maxSize));

        logger.info?.(
          `smtp: cut off an oversized message from ${session.envelope?.mailFrom?.address ?? 'unknown'}`,
        );
        session.mbOutcomeLogged = true;

        const connection = connectionFor(server, session);
        if (connection) {
          connection.send(552, 'Message exceeds the configured size limit');
          connection.close();
        }
      };

      // `sizeExceeded` updates during the transfer, so this can fire well before the
      // blob store reaches its own limit.
      stream.on('data', () => {
        if (stream.sizeExceeded) refuseOversize();
      });

      // The incoming stream goes straight to disk while being hashed, so a large
      // attachment never has to fit in memory.
      blobs
        .put(stream, { maxSize })
        .then(async ({ hash, size }) => {
          if (refused || session.mbAborted) return;
          if (stream.sizeExceeded) return refuseOversize();

          const summary = await delivery.deliverStored({
            rawHash: hash,
            size,
            envelopeRecipients: session.envelope.rcptTo.map((r) => r.address),
            origin: 'smtp',
          });
          logger.info?.(
            `smtp: accepted #${summary.id} from ${summary.from} -> ${summary.addresses.join(', ')}`,
          );
          session.mbOutcomeLogged = true;
          callback(null, `Message queued as ${summary.id}`);
        })
        .catch((err) => {
          if (refused || session.mbAborted) return;
          // The blob store hit the same ceiling from its side.
          if (err instanceof MaxSizeExceeded) return refuseOversize();

          // The ICAP scanner did not approve it. A virus is a permanent refusal, so
          // the sender is told 550 and does not retry; a scanner that could not be
          // reached is 451, which is a real MTA's "come back later" and is exactly
          // what an unscanned message deserves.
          if (err instanceof ScanRejected) {
            const e = new Error(err.message);
            e.responseCode = err.temporary ? 451 : 550;
            logger.info?.(
              `smtp: refused a message from ${session.envelope?.mailFrom?.address ?? 'unknown'} (${err.message})`,
            );
            session.mbOutcomeLogged = true;
            return callback(e);
          }

          logger.error?.(`smtp: delivery failed: ${err.stack || err.message}`);
          session.mbOutcomeLogged = true;
          const e = new Error('Local error processing message');
          e.responseCode = 451;
          callback(e);
        });
    },

    /**
     * Say so when a connection came and went with nothing to show for it.
     *
     * A session that delivered or was refused has already written its own line, so
     * this stays quiet for those and speaks only for the case that used to be
     * invisible: something connected, spoke or did not, and left. That is what a
     * misconfigured sender looks like from this side.
     */
    onClose(session) {
      if (session?.mbOutcomeLogged) return;
      logger.info?.(
        `smtp: connection from ${session?.remoteAddress || 'unknown'} closed without sending a message`,
      );
    },
  });

  // Apply once up front so the very first greeting already carries the right name.
  applyLimits(server, limits());

  server.on('error', (err) => logger.error?.(`smtp: ${err.message}`));

  return {
    server,
    /** Push the current admin settings onto the live listener. */
    refresh() {
      applyLimits(server, limits());
      transcript.on = protocolLoggingOn(db);
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.listen(config.smtpPort, config.host, (err) => (err ? reject(err) : resolve()));
        server.once('error', reject);
      });
    },
    address() {
      return server.server.address();
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The stored flag behind the Logs page's transcript switch. Off unless turned on. */
export function protocolLoggingOn(db) {
  return db.getSetting('log_smtp_protocol') === '1';
}

/**
 * Hand smtp-server a logger of the shape it expects — `level(meta, format, ...args)`,
 * the bunyan-ish interface nodemailer's shared helper calls — and turn each call into
 * one recorded line.
 *
 * Every severity the library uses is declared. Leaving one out would not silence it:
 * the helper falls back to whichever method it can find, so an undeclared `error`
 * would quietly arrive as something else.
 */
function protocolLogger(logger, transcript) {
  // Nothing to record into, so let the library skip the work entirely.
  if (typeof logger?.debug !== 'function') return false;

  const write = (meta, message, args) => {
    if (!transcript.on) return;
    // The connection id groups a session's lines together, which is the only way to
    // read a transcript when several senders overlap.
    const cid = meta?.cid ? `[${meta.cid}] ` : '';
    logger.debug(`smtp: ${cid}${format(message, ...args)}`);
  };

  return {
    trace: (meta, message, ...args) => write(meta, message, args),
    debug: (meta, message, ...args) => write(meta, message, args),
    info: (meta, message, ...args) => write(meta, message, args),
    warn: (meta, message, ...args) => write(meta, message, args),
    error: (meta, message, ...args) => write(meta, message, args),
    fatal: (meta, message, ...args) => write(meta, message, args),
  };
}

/**
 * The session object the handlers receive carries no reference back to its
 * connection, so it is matched by id against the set the server keeps. `send` and
 * `close` are the connection's own public methods for exactly this.
 */
function connectionFor(server, session) {
  for (const connection of server.connections) {
    if (connection.id === session.id) return connection;
  }
  return null;
}

function applyLimits(server, values) {
  server.options.size = values.smtp_max_size;
  server.options.maxClients = values.smtp_max_clients;
  server.options.socketTimeout = values.smtp_socket_timeout;
  server.options.name = values.smtp_name;
  server.options.banner = values.smtp_banner;
}
