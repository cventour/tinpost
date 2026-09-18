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

  // Nobody is asked to invent a password at first start. One is generated, printed
  // to the log, and marked as temporary: signing in with it leads straight to a
  // change-password page and nothing else works until it has been replaced.
  let generatedPassword = null;
  let passwordOverridden = false;
  if (config.adminPassword) {
    // An explicitly supplied password is the operator's own choice, so it stands.
    // But a flag left in a launch script would otherwise silently undo a password
    // chosen in the admin page on every restart, so that case is reported.
    passwordOverridden = db.hasAdminPassword() && !db.verifyAdminPassword(config.adminPassword);
    db.setAdminPassword(config.adminPassword);
  } else if (!db.hasAdminPassword()) {
    generatedPassword = generatePassword();
    db.setAdminPassword(generatedPassword, { mustChange: true });
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
    passwordOverridden,
    async stop() {
      await web.close();
      await smtp.close();
      db.close();
    },
  };
}

export { loadConfig, Db, BlobStore, Delivery };
