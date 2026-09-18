import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { normaliseDomain } from '../db.js';
import {
  SMTP_SETTINGS,
  readAllDisplay,
  saveSettings,
  pendingRestart,
  checkPortAvailable,
} from '../settings.js';

const SESSION_COOKIE = 'mb_admin';
const SESSION_TTL_MS = 60 * 60 * 1000; // idle timeout

export async function registerAdminRoutes(app) {
  const { db, blobs, config, logger, smtp } = app.mb;
  const secret = db.getSetting('session_secret');

  function issueSession() {
    const payload = `${Date.now()}.${randomBytes(8).toString('hex')}`;
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    return `${payload}.${sig}`;
  }

  function validSession(token) {
    if (typeof token !== 'string') return false;
    const idx = token.lastIndexOf('.');
    if (idx === -1) return false;
    const payload = token.slice(0, idx);
    const sig = Buffer.from(token.slice(idx + 1), 'hex');
    const expected = createHmac('sha256', secret).update(payload).digest();
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;

    const issuedAt = Number.parseInt(payload.split('.')[0], 10);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt >= SESSION_TTL_MS) return false;

    // Changing the password moves the epoch forward, which retires every token
    // issued before it. Rotating the signing secret would not do this, because it
    // is read once when the server starts.
    return issuedAt >= sessionEpoch();
  }

  function sessionEpoch() {
    return Number.parseInt(db.getSetting('session_epoch') ?? '0', 10) || 0;
  }

  function isAdmin(req) {
    return validSession(req.cookies?.[SESSION_COOKIE]);
  }

  /**
   * Guard for every admin route.
   *
   * While the first-start password is still in use, every route but the change
   * form is diverted to it: the temporary password gets the operator in, and
   * nothing else until they have replaced it.
   */
  function requireAdmin(req, reply, { allowWhileTemporary = false } = {}) {
    if (!isAdmin(req)) {
      reply.redirect('/admin/login');
      return false;
    }
    // Sliding expiry: an admin actively working does not get logged out mid-task.
    reply.setCookie(SESSION_COOKIE, issueSession(), cookieOpts());

    if (!allowWhileTemporary && db.adminPasswordMustChange()) {
      reply.redirect('/admin/password');
      return false;
    }
    return true;
  }

  function cookieOpts() {
    return { path: '/admin', httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS / 1000 };
  }

  // ---------- login ----------

  app.get('/admin/login', (req, reply) => {
    if (isAdmin(req)) return reply.redirect('/admin');
    return reply.view('admin-login', {
      error: null,
      addr: null,
      firstRun: db.adminPasswordMustChange(),
    });
  });

  app.post('/admin/login', (req, reply) => {
    const password = String(req.body?.password ?? '');
    if (!db.verifyAdminPassword(password)) {
      logger.info?.('admin: failed login');
      return reply.code(401).view('admin-login', {
        error: 'Incorrect password.',
        addr: null,
        firstRun: db.adminPasswordMustChange(),
      });
    }
    reply.setCookie(SESSION_COOKIE, issueSession(), cookieOpts());
    return reply.redirect(db.adminPasswordMustChange() ? '/admin/password' : '/admin');
  });

  app.post('/admin/logout', (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/admin' });
    return reply.redirect('/admin/login');
  });

  // ---------- change password ----------

  app.get('/admin/password', async (req, reply) => {
    if (!requireAdmin(req, reply, { allowWhileTemporary: true })) return reply;
    return reply.view('admin/password', await passwordModel());
  });

  /**
   * While the password is still the temporary one, this page is the only thing
   * reachable, so the ribbon is left off: it would only offer links that divert
   * straight back here.
   */
  async function passwordModel(extra = {}) {
    const mustChange = db.adminPasswordMustChange();
    const usage = await blobs.totalSize();
    return {
      addr: null,
      wide: true,
      section: 'password',
      title: 'Password — MailButler admin',
      mustChange,
      chrome: !mustChange,
      stats: db.stats(),
      usage,
      exposed: false,
      notice: null,
      error: null,
      ...extra,
    };
  }

  app.post('/admin/password', async (req, reply) => {
    if (!requireAdmin(req, reply, { allowWhileTemporary: true })) return reply;

    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');
    const confirm = String(req.body?.confirm ?? '');
    const fail = async (error) => reply.code(400).view('admin/password', await passwordModel({ error }));

    // Knowing the current password is required even here: a session cookie alone
    // must not be enough to take over the instance.
    if (!db.verifyAdminPassword(current)) return await fail('That is not the current password.');
    if (next.length < 8) return await fail('The new password must be at least 8 characters.');
    if (next !== confirm) return await fail('The two new passwords do not match.');
    if (next === current) return await fail('The new password must be different from the current one.');

    db.setAdminPassword(next);
    // A password change retires every session issued so far, including this one.
    db.setSetting('session_epoch', String(Date.now()));
    logger.info?.('admin: password changed; existing sessions invalidated');
    reply.clearCookie(SESSION_COOKIE, { path: '/admin' });
    return reply.view('admin-login', {
      addr: null,
      error: null,
      firstRun: false,
      notice: 'Password changed. Sign in with your new password.',
    });
  });

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
    if (!requireAdmin(req, reply)) return reply;
    return reply.view('admin/smtp', await smtpModel());
  });

  async function smtpModel(extra = {}) {
    const running = runningPorts();
    return shell('smtp', {
      title: 'SMTP — MailButler admin',
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
    if (!requireAdmin(req, reply)) return reply;

    const body = req.body ?? {};

    // A port is the one setting that can stop MailButler from starting at all, so it
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
      ? 'Saved. The limits are live now; the port change applies the next time MailButler starts.'
      : 'Saved. The listener picked these up straight away.';
    return reply.view('admin/smtp', await smtpModel({ notice }));
  });

  // ---------- domains ----------

  app.get('/admin/domains', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return reply.view('admin/domains', await domainsModel());
  });

  async function domainsModel(extra = {}) {
    return shell('domains', {
      title: 'Domains — MailButler admin',
      policy: db.getAcceptPolicy(),
      domains: db.listDomains(),
      ...extra,
    });
  }

  app.post('/admin/policy', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const policy = req.body?.policy === 'allowlist' ? 'allowlist' : 'any';
    db.setAcceptPolicy(policy);
    logger.info?.(`admin: accept policy set to ${policy}`);
    return reply.view(
      'admin/domains',
      await domainsModel({ notice: `Now accepting mail for ${policy === 'any' ? 'any domain' : 'the allowlist only'}.` }),
    );
  });

  app.post('/admin/domains/add', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
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
    if (!requireAdmin(req, reply)) return reply;
    const d = normaliseDomain(req.body?.domain);
    db.removeDomain(d);
    return reply.view('admin/domains', await domainsModel({ notice: `Removed ${d}.` }));
  });

  // ---------- mailboxes ----------

  app.get('/admin/mailboxes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return reply.view('admin/mailboxes', await mailboxesModel());
  });

  async function mailboxesModel(extra = {}) {
    return shell('mailboxes', {
      title: 'Mailboxes — MailButler admin',
      mailboxes: db.listMailboxes(),
      ...extra,
    });
  }

  app.post('/admin/mailbox/delete', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const address = String(req.body?.address ?? '');
    const removed = db.deleteMailbox(address);
    const gc = await blobs.gc(db.referencedHashes());
    logger.info?.(`admin: deleted mailbox ${address} (${removed} messages, ${gc.removed} blobs)`);
    return reply.view(
      'admin/mailboxes',
      await mailboxesModel({
        notice: `Deleted ${removed} message(s) for ${address} and reclaimed ${gc.removed} stored file(s).`,
      }),
    );
  });

  // ---------- storage ----------

  app.get('/admin/storage', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return reply.view('admin/storage', await storageModel());
  });

  async function storageModel(extra = {}) {
    return shell('storage', {
      title: 'Storage — MailButler admin',
      dataDir: config.dataDir,
      ...extra,
    });
  }

  app.post('/admin/gc', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const gc = await blobs.gc(db.referencedHashes());
    return reply.view(
      'admin/storage',
      await storageModel({ notice: `Reclaimed ${gc.removed} unreferenced file(s), ${fmtBytesPlain(gc.bytes)}.` }),
    );
  });

  app.post('/admin/purge', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
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
      await storageModel({ notice: `Purged ${removed} message(s) and freed ${fmtBytesPlain(gc.bytes)}.` }),
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
