import { loadConfig } from './config.js';
import { Db } from './db.js';
import { BlobStore } from './blobstore.js';
import { Delivery } from './delivery.js';
import { readSetting } from './settings.js';
import { createSmtpServer } from './smtp.js';
import { createWebServer } from './web/server.js';

/**
 * Wire the whole instance together and start both listeners.
 * Returns handles so tests (and the CLI) can shut it down cleanly.
 */
export async function start(flags = {}, { logger = console } = {}) {
  let config = loadConfig(flags);
  const db = new Db(config.dbPath);

  // Ports resolve as: command line, then the stored setting, then the default. The
  // database has to be open before this can be settled, so the config is rebuilt
  // once with whatever the admin page last saved.
  const storedPorts = {};
  if (!config.smtpPortExplicit) storedPorts.smtpPort = readSetting(db, 'smtp_port');
  if (!config.httpPortExplicit) storedPorts.httpPort = readSetting(db, 'http_port');
  if (Object.keys(storedPorts).length) config = loadConfig({ ...flags, ...storedPorts });
  const blobs = new BlobStore(config);
  const delivery = new Delivery({ db, blobs, maxSize: config.maxSize });

  // An explicit --max-size is an instruction, so it seeds the stored setting that
  // the admin page edits. Without the flag, the stored setting stands.
  if (config.maxSizeExplicit) {
    db.setSetting('smtp_max_size', String(Math.max(1, Math.round(config.maxSize / (1024 * 1024)))));
  }

  const smtp = createSmtpServer({ db, blobs, delivery, config, logger });
  await smtp.listen();

  // The web layer holds the listener so the admin page can push new limits onto it.
  const web = await createWebServer({ db, blobs, delivery, config, smtp, logger });
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
    async stop() {
      await web.close();
      await smtp.close();
      db.close();
    },
  };
}

export { loadConfig, Db, BlobStore, Delivery };
