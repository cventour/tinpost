import { SMTPServer } from 'smtp-server';
import { MaxSizeExceeded } from './blobstore.js';
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

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    // Lab senders often have no resolvable reverse DNS; looking it up only adds latency.
    disableReverseLookup: true,
    logger: false,

    onConnect(session, callback) {
      // smtp-server reads name, banner, size, maxClients and socketTimeout from this
      // object on every connection, so applying the admin's settings here makes them
      // take effect immediately rather than at the next restart.
      applyLimits(server, limits());
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
        return callback(err);
      }

      const domain = domainOf(address.address);
      if (db.isDomainAccepted(domain)) return callback();

      // Same refusal a real MTA gives for a domain it does not handle, so clients
      // under test see a realistic failure rather than a silent drop.
      const err = new Error(`Relay denied for ${domain || 'missing domain'}`);
      err.responseCode = 550;
      logger.info?.(`smtp: rejected ${address.address} (policy=allowlist)`);
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
          callback(null, `Message queued as ${summary.id}`);
        })
        .catch((err) => {
          if (refused || session.mbAborted) return;
          // The blob store hit the same ceiling from its side.
          if (err instanceof MaxSizeExceeded) return refuseOversize();

          logger.error?.(`smtp: delivery failed: ${err.stack || err.message}`);
          const e = new Error('Local error processing message');
          e.responseCode = 451;
          callback(e);
        });
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
