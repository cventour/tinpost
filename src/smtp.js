import { SMTPServer } from 'smtp-server';
import { MaxSizeExceeded } from './blobstore.js';
import { domainOf } from './db.js';

/**
 * The SMTP side of the lab: accepts anonymous submission on a high port and hands
 * every accepted message to the shared delivery path.
 *
 * No AUTH and no STARTTLS by design — lab senders are scripts and test harnesses
 * on loopback, and demanding credentials would only get in the way. The listener
 * binds 127.0.0.1 unless explicitly told otherwise.
 */
export function createSmtpServer({ db, blobs, delivery, config, logger = console }) {
  const server = new SMTPServer({
    name: 'mailbutler',
    banner: 'MailButler lab mail server',
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: config.maxSize,
    // Lab senders often have no resolvable reverse DNS; looking it up only adds latency.
    disableReverseLookup: true,
    logger: false,

    onRcptTo(address, session, callback) {
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
      // The incoming stream goes straight to disk while being hashed, so a large
      // attachment never has to fit in memory.
      blobs
        .put(stream, { maxSize: config.maxSize })
        .then(async ({ hash, size }) => {
          if (stream.sizeExceeded) {
            const err = new Error('Message exceeds the configured size limit');
            err.responseCode = 552;
            throw err;
          }
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
          if (err instanceof MaxSizeExceeded) {
            const e = new Error('Message exceeds the configured size limit');
            e.responseCode = 552;
            return callback(e);
          }
          logger.error?.(`smtp: delivery failed: ${err.stack || err.message}`);
          const e = new Error('Local error processing message');
          e.responseCode = 451;
          callback(e);
        });
    },
  });

  server.on('error', (err) => logger.error?.(`smtp: ${err.message}`));

  return {
    server,
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
