import { normaliseDomain } from '../db.js';
import {
  SMTP_SETTINGS,
  ICAP_SETTINGS,
  SETTINGS,
  readAllDisplay,
  saveSettings,
  pendingRestart,
  checkPortAvailable,
} from '../settings.js';
import { testConnection, icapConfig, icapAddress } from '../scan.js';
import {
  checkDataDir,
  writePointer,
  readPointer,
  clearPointer,
  platformDefaultDataDir,
  pointerPath,
  moveNotice,
} from '../datadir.js';

/**
 * The admin area has no password.
 *
 * Tinpost is a lab tool: the mailboxes themselves are deliberately readable by
 * anyone who can reach the web port, so a gate on the settings alongside them would
 * protect nothing an attacker on that network could not already reach. It binds to
 * loopback by default for that reason, and every page says so when it does not.
 */
export async function registerAdminRoutes(app) {
  const { db, blobs, config, logger, smtp, privilege, portNotice } = app.mb;

  // ---------- shared model ----------

  /**
   * Everything the shell needs, whichever section is showing: the ribbon's counts,
   * and the banner that warns when the instance is not on loopback.
   */
  /**
   * The ports this process actually bound, which are not always the ones asked for:
   * port 0 means "pick one", and tests rely on that.
   */
  function runningPorts() {
    const httpAddress = app.server?.address?.();
    return {
      http_port: (httpAddress && typeof httpAddress === 'object' ? httpAddress.port : null) ?? config.httpPort,
      smtp_port: smtp?.address?.()?.port ?? config.smtpPort,
    };
  }

  async function shell(section, extra = {}) {
    const usage = await blobs.totalSize();
    return {
      addr: null,
      wide: true,
      section,
      stats: db.stats(),
      usage,
      exposed: config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1',
      host: config.host,
      notice: null,
      error: null,
      ...extra,
    };
  }

  // ---------- SMTP ----------

  app.get('/admin', async (req, reply) => {
    return reply.view('admin/smtp', await smtpModel());
  });

  async function smtpModel(extra = {}) {
    const running = runningPorts();
    return shell('smtp', {
      title: 'SMTP — Tinpost admin',
      portNotice,
      privilege,
      specs: SMTP_SETTINGS,
      values: readAllDisplay(db),
      pending: pendingRestart(db, running),
      listeners: {
        host: config.host,
        smtpPort: running.smtp_port,
        httpPort: running.http_port,
        dataDir: config.dataDir,
      },
      ...extra,
    });
  }

  app.post('/admin/smtp', async (req, reply) => {

    const body = req.body ?? {};

    // A port is the one setting that can stop Tinpost from starting at all, so it
    // is checked before being written rather than discovered at the next start.
    const running = runningPorts();
    for (const key of ['http_port', 'smtp_port']) {
      if (!(key in body)) continue;
      const wanted = Number.parseInt(String(body[key]), 10);
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) continue; // caught below
      if (wanted === running[key]) continue;
      const check = await checkPortAvailable(wanted, config.host, {
        ignorePorts: [running.http_port, running.smtp_port],
      });
      if (!check.ok) {
        const values = { ...readAllDisplay(db), ...pickSubmitted(body) };
        return reply.code(400).view('admin/smtp', await smtpModel({ error: check.error, values }));
      }
    }

    const result = saveSettings(db, body);
    if (!result.ok) {
      // Re-render with what they typed, so a rejected value is not silently lost.
      const values = { ...readAllDisplay(db), ...pickSubmitted(body) };
      return reply.code(400).view('admin/smtp', await smtpModel({ error: result.error, values }));
    }

    // The listener reads these per connection, so they are live immediately.
    smtp?.refresh?.();
    logger.info?.('admin: settings updated');

    const stillPending = pendingRestart(db, runningPorts());
    const notice = stillPending.length
      ? 'Saved. The limits are live now; the port change applies the next time Tinpost starts.'
      : 'Saved. The listener picked these up straight away.';
    return reply.view('admin/smtp', await smtpModel({ notice }));
  });

  // ---------- domains ----------

  app.get('/admin/domains', async (req, reply) => {
    return reply.view('admin/domains', await domainsModel());
  });

  async function domainsModel(extra = {}) {
    return shell('domains', {
      title: 'Domains — Tinpost admin',
      policy: db.getAcceptPolicy(),
      domains: db.listDomains(),
      ...extra,
    });
  }

  app.post('/admin/policy', async (req, reply) => {
    const policy = req.body?.policy === 'allowlist' ? 'allowlist' : 'any';
    db.setAcceptPolicy(policy);
    logger.info?.(`admin: accept policy set to ${policy}`);
    return reply.view(
      'admin/domains',
      await domainsModel({ notice: `Now accepting mail for ${policy === 'any' ? 'any domain' : 'the allowlist only'}.` }),
    );
  });

  app.post('/admin/domains/add', async (req, reply) => {
    const raw = String(req.body?.domain ?? '');
    const added = [];
    for (const piece of raw.split(/[\s,;]+/)) {
      const d = normaliseDomain(piece);
      if (!d) continue;
      if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(d)) {
        return reply.code(400).view('admin/domains', await domainsModel({ error: `"${piece}" is not a valid domain.` }));
      }
      db.addDomain(d);
      added.push(d);
    }
    return reply.view(
      'admin/domains',
      await domainsModel({ notice: added.length ? `Added ${added.join(', ')}.` : 'Nothing to add.' }),
    );
  });

  app.post('/admin/domains/remove', async (req, reply) => {
    const d = normaliseDomain(req.body?.domain);
    db.removeDomain(d);
    return reply.view('admin/domains', await domainsModel({ notice: `Removed ${d}.` }));
  });

  // ---------- ICAP ----------

  app.get('/admin/icap', async (req, reply) => {
    return reply.view('admin/icap', await icapModel());
  });

  async function icapModel(extra = {}) {
    const config = icapConfig(db);
    return shell('icap', {
      title: 'Attachment scanning — Tinpost admin',
      specs: ICAP_SETTINGS,
      values: readAllDisplay(db),
      icapAddress: icapAddress(config),
      icapEnabled: config.enabled,
      scanByDefault: config.scanByDefault,
      // Domains that carry a scanning setting of their own, plus the allowlist, since
      // one list of domains is easier to reason about than two.
      domains: db.listDomainSettings(),
      policy: db.getAcceptPolicy(),
      test: null,
      ...extra,
    });
  }

  app.post('/admin/icap', async (req, reply) => {
    const body = req.body ?? {};
    const result = saveSettings(db, body);
    if (!result.ok) {
      const values = { ...readAllDisplay(db), ...pickSubmitted(body) };
      return reply.code(400).view('admin/icap', await icapModel({ error: result.error, values }));
    }
    logger.info?.('admin: ICAP settings updated');
    const config = icapConfig(db);
    return reply.view(
      'admin/icap',
      await icapModel({
        notice: config.enabled
          ? `Saved. Attachments are now scanned by ${icapAddress(config)} before a message is accepted.`
          : 'Saved. Attachment scanning is off, so nothing is sent to a scanner.',
      }),
    );
  });

  /**
   * Prove the scanner answers, without having to send a message through. An ICAP
   * OPTIONS request is the protocol's own way to ask, and it also reports which
   * methods the service supports — the usual reason a correct address still fails.
   */
  app.post('/admin/icap/test', async (req, reply) => {
    const result = await testConnection(db);
    logger.info?.(`admin: ICAP test ${result.ok ? 'succeeded' : 'failed'} for ${result.where}`);
    return reply.view(
      'admin/icap',
      await icapModel(result.ok ? { notice: result.detail } : { error: result.error }),
    );
  });

  app.post('/admin/icap/domain', async (req, reply) => {
    const domain = normaliseDomain(req.body?.domain);
    const choice = String(req.body?.scan ?? 'inherit');

    if (!domain || !/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain)) {
      return reply
        .code(400)
        .view('admin/icap', await icapModel({ error: `"${req.body?.domain ?? ''}" is not a valid domain.` }));
    }
    if (!['on', 'off', 'inherit'].includes(choice)) {
      return reply.code(400).view('admin/icap', await icapModel({ error: 'Choose on, off, or the default.' }));
    }

    db.setDomainIcap(domain, choice === 'inherit' ? null : choice === 'on');
    logger.info?.(`admin: ICAP scanning for ${domain} set to ${choice}`);

    const wording = {
      on: `Mail to and from ${domain} is scanned.`,
      off: `Mail to and from ${domain} is never scanned.`,
      inherit: `${domain} now follows the default, which is ${icapConfig(db).scanByDefault ? 'to scan' : 'not to scan'}.`,
    };
    return reply.view('admin/icap', await icapModel({ notice: wording[choice] }));
  });

  // ---------- mailboxes ----------

  app.get('/admin/mailboxes', async (req, reply) => {
    return reply.view('admin/mailboxes', await mailboxesModel());
  });

  async function mailboxesModel(extra = {}) {
    return shell('mailboxes', {
      title: 'Mailboxes — Tinpost admin',
      mailboxes: db.listMailboxes(),
      ...extra,
    });
  }

  app.post('/admin/mailbox/delete', async (req, reply) => {
    const address = String(req.body?.address ?? '');
    const removed = db.deleteMailbox(address);
    const gc = await blobs.gc(db.referencedHashes());
    logger.info?.(`admin: deleted mailbox ${address} (${removed} messages, ${gc.removed} blobs)`);
    return reply.view(
      'admin/mailboxes',
      await mailboxesModel({
        notice:
          `Deleted ${removed} message(s) for ${address} and reclaimed ${gc.removed} stored file(s).` +
          unwritableNote(gc),
      }),
    );
  });

  // ---------- storage ----------

  app.get('/admin/storage', async (req, reply) => {
    return reply.view('admin/storage', await storageModel());
  });

  async function storageModel(extra = {}) {
    const saved = await readPointer();
    return shell('storage', {
      title: 'Storage — Tinpost admin',
      dataDir: config.dataDir,
      // What the pointer says, which is not necessarily what this run is using.
      savedDataDir: saved,
      defaultDataDir: platformDefaultDataDir(),
      pointerPath: pointerPath(),
      // A flag or the environment overrides the saved location for this run, and the
      // page should not pretend the field is in charge when it is not.
      dataDirOverridden: config.dataDirExplicit,
      dataDirPending: moveNotice({
        current: config.dataDir,
        pending: saved,
        occupied: true,
      }),
      ...extra,
    });
  }

  app.post('/admin/storage/location', async (req, reply) => {
    const wanted = String(req.body?.dataDir ?? '').trim();

    // Clearing the field means "go back to the platform default".
    if (!wanted) {
      await clearPointer();
      logger.info?.('admin: data directory reset to the platform default');
      return reply.view(
        'admin/storage',
        await storageModel({
          notice: `Reset to the default location. Tinpost will use ${platformDefaultDataDir()} the next time it starts.`,
        }),
      );
    }

    // A bad path here is the one setting that can stop Tinpost from starting at all,
    // and unlike a port it cannot be fixed from this page afterwards. So it is proven
    // usable — created if need be, and actually written to — before it is saved.
    const check = await checkDataDir(wanted);
    if (!check.ok) {
      return reply.code(400).view('admin/storage', await storageModel({ error: check.error }));
    }

    await writePointer(check.path);
    logger.info?.(`admin: data directory set to ${check.path}`);

    const detail = check.occupied
      ? 'It already contains a Tinpost database, which will be used as it is.'
      : 'It is empty, so Tinpost will start with no mail. Nothing has been copied or deleted — the current data stays where it is.';

    return reply.view(
      'admin/storage',
      await storageModel({
        notice: `Saved. Tinpost will use ${check.path} the next time it starts. ${detail}`,
      }),
    );
  });

  app.post('/admin/gc', async (req, reply) => {
    const gc = await blobs.gc(db.referencedHashes());
    return reply.view(
      'admin/storage',
      await storageModel({
        notice: `Reclaimed ${gc.removed} unreferenced file(s), ${fmtBytesPlain(gc.bytes)}.` + unwritableNote(gc),
      }),
    );
  });

  app.post('/admin/purge', async (req, reply) => {
    // Typed confirmation: purging is not undoable and this is the one destructive control.
    if (String(req.body?.confirm ?? '').trim().toUpperCase() !== 'PURGE') {
      return reply
        .code(400)
        .view('admin/storage', await storageModel({ error: 'Type PURGE to confirm. Nothing was deleted.' }));
    }
    const removed = db.purgeAll();
    const gc = await blobs.gc(db.referencedHashes());
    logger.info?.(`admin: purged all mail (${removed} messages, ${gc.removed} blobs)`);
    return reply.view(
      'admin/storage',
      await storageModel({
        notice: `Purged ${removed} message(s) and freed ${fmtBytesPlain(gc.bytes)}.` + unwritableNote(gc),
      }),
    );
  });
}

/** Echo back what was typed, so a rejected form does not lose the operator's input. */
function pickSubmitted(body) {
  const out = {};
  for (const key of Object.keys(SETTINGS)) {
    if (key in body) out[key] = body[key];
  }
  return out;
}

/**
 * Files a reclaim could not delete are almost always left by a `sudo` run: root wrote
 * them, and an ordinary user cannot remove them. Saying so names the fix.
 */
function unwritableNote(gc) {
  if (!gc.unwritable) return '';
  return (
    ` ${gc.unwritable} file(s) could not be deleted because they belong to another user —` +
    ' they were most likely written while Tinpost was running with sudo. Remove them with' +
    ' sudo, or take ownership of the data directory.'
  );
}

function fmtBytesPlain(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
