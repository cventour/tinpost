import { normaliseDomain } from '../db.js';
import {
  SMTP_SETTINGS,
  readAllDisplay,
  saveSettings,
  pendingRestart,
  checkPortAvailable,
} from '../settings.js';

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
    return shell('storage', {
      title: 'Storage — Tinpost admin',
      dataDir: config.dataDir,
      ...extra,
    });
  }

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
  for (const key of Object.keys(SMTP_SETTINGS)) {
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
