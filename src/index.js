import { loadConfig, generatePassword } from './config.js';
import { Db } from './db.js';
import { BlobStore } from './blobstore.js';
import { Delivery } from './delivery.js';
import { createSmtpServer } from './smtp.js';
import { createWebServer } from './web/server.js';

/**
 * Wire the whole instance together and start both listeners.
 * Returns handles so tests (and the CLI) can shut it down cleanly.
 */
export async function start(flags = {}, { logger = console } = {}) {
  const config = loadConfig(flags);
  const db = new Db(config.dbPath);
  const blobs = new BlobStore(config);
  const delivery = new Delivery({ db, blobs, maxSize: config.maxSize });

  // Bootstrap the admin password on first run, or whenever one is supplied.
  let generatedPassword = null;
  if (config.adminPassword) {
    db.setAdminPassword(config.adminPassword);
  } else if (!db.hasAdminPassword()) {
    generatedPassword = generatePassword();
    db.setAdminPassword(generatedPassword);
  }

  const smtp = createSmtpServer({ db, blobs, delivery, config, logger });
  await smtp.listen();

  const web = await createWebServer({ db, blobs, delivery, config, logger });
  const webAddress = await web.listen();

  const ports = {
    smtp: smtp.address().port,
    http: typeof webAddress === 'object' ? webAddress.port : config.httpPort,
  };

  return {
    config,
    db,
    blobs,
    delivery,
    ports,
    generatedPassword,
    async stop() {
      await web.close();
      await smtp.close();
      db.close();
    },
  };
}

export { loadConfig, Db, BlobStore, Delivery };
