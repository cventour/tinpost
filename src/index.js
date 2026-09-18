import { loadConfig } from './config.js';
import { Db } from './db.js';
import { BlobStore } from './blobstore.js';
import { Delivery } from './delivery.js';
import { readSetting } from './settings.js';
import {
  defaultSmtpPort,
  privilegeState,
  portNotice,
  STANDARD_SMTP_PORT,
  FALLBACK_SMTP_PORT,
} from './privilege.js';
import { createSmtpServer } from './smtp.js';
import { createWebServer } from './web/server.js';

/**
 * Wire the whole instance together and start both listeners.
 * Returns handles so tests (and the CLI) can shut it down cleanly.
 */
export async function start(flags = {}, { logger = console } = {}) {
  let config = loadConfig(flags);
  const db = new Db(config.dbPath);

  // Ports resolve as: command line, then the stored setting, then privilege. The
  // database has to be open before this can be settled, so the config is rebuilt
  // once with whatever the admin page last saved.
  //
  // Running as root is read as intent to be a real mail server, so an unconfigured
  // instance takes port 25 there and 2525 everywhere else. A port the operator
  // actually chose, by flag or on the admin page, always outranks that.
  const smtpPortChosen = config.smtpPortExplicit || db.getSetting('smtp_port') !== null;
  const storedPorts = {};
  if (!config.smtpPortExplicit) {
    storedPorts.smtpPort = smtpPortChosen ? readSetting(db, 'smtp_port') : defaultSmtpPort();
  }
  if (!config.httpPortExplicit) storedPorts.httpPort = readSetting(db, 'http_port');
  if (Object.keys(storedPorts).length) config = loadConfig({ ...flags, ...storedPorts });
  const blobs = new BlobStore(config);
  const delivery = new Delivery({ db, blobs, maxSize: config.maxSize });

  // An explicit --max-size is an instruction, so it seeds the stored setting that
  // the admin page edits. Without the flag, the stored setting stands.
  if (config.maxSizeExplicit) {
    db.setSetting('smtp_max_size', String(Math.max(1, Math.round(config.maxSize / (1024 * 1024)))));
  }

  let smtp = createSmtpServer({ db, blobs, delivery, config, logger });
  let smtpFallbackReason = null;

  try {
    await smtp.listen();
  } catch (err) {
    // Reaching for port 25 must never be the reason the lab will not start. Linux can
    // grant CAP_NET_BIND_SERVICE to a non-root process, so the attempt is worth making
    // even when we did not predict it would work — but if it fails, step back to 2525
    // and say so rather than dying.
    const reachingForStandardPort = config.smtpPort === STANDARD_SMTP_PORT && !config.smtpPortExplicit;
    if (!reachingForStandardPort || !['EACCES', 'EADDRINUSE'].includes(err.code)) {
      db.close();
      throw err;
    }
    smtpFallbackReason = err.code;
    logger.info?.(`smtp: could not bind port 25 (${err.code}); falling back to ${FALLBACK_SMTP_PORT}`);
    config = loadConfig({ ...flags, ...storedPorts, smtpPort: FALLBACK_SMTP_PORT });
    smtp = createSmtpServer({ db, blobs, delivery, config, logger });
    await smtp.listen();
  }

  // Settled only once the listener is actually bound, because a fallback may have
  // moved the port after the config said otherwise.
  const privilege = privilegeState();
  const notice = portNotice({ smtpPort: smtp.address().port, chosenExplicitly: smtpPortChosen });

  // The web layer holds the listener so the admin page can push new limits onto it,
  // and the notice so every page can carry the warning.
  const web = await createWebServer({
    db,
    blobs,
    delivery,
    config,
    smtp,
    privilege,
    portNotice: notice,
    logger,
  });
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
    privilege,
    portNotice: notice,
    smtpFallbackReason,
    async stop() {
      await web.close();
      await smtp.close();
      db.close();
    },
  };
}

export { loadConfig, Db, BlobStore, Delivery };
