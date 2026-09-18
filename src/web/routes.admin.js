import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { normaliseDomain } from '../db.js';

const SESSION_COOKIE = 'mb_admin';
const SESSION_TTL_MS = 60 * 60 * 1000; // idle timeout

export async function registerAdminRoutes(app) {
  const { db, blobs, config, logger } = app.mb;
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

  app.get('/admin/password', (req, reply) => {
    if (!requireAdmin(req, reply, { allowWhileTemporary: true })) return reply;
    return reply.view('admin-password', {
      addr: null,
      error: null,
      mustChange: db.adminPasswordMustChange(),
    });
  });

  app.post('/admin/password', (req, reply) => {
    if (!requireAdmin(req, reply, { allowWhileTemporary: true })) return reply;

    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');
    const confirm = String(req.body?.confirm ?? '');
    const mustChange = db.adminPasswordMustChange();

    const fail = (error) =>
      reply.code(400).view('admin-password', { addr: null, error, mustChange });

    // Knowing the current password is required even here: a session cookie alone
    // must not be enough to take over the instance.
    if (!db.verifyAdminPassword(current)) return fail('That is not the current password.');
    if (next.length < 8) return fail('The new password must be at least 8 characters.');
    if (next !== confirm) return fail('The two new passwords do not match.');
    if (next === current) return fail('The new password must be different from the current one.');

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

  // ---------- dashboard ----------

  app.get('/admin', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return reply.view('admin', await dashboardModel(req));
  });

  async function dashboardModel(req, notice = null) {
    const usage = await blobs.totalSize();
    return {
      addr: null,
      notice,
      policy: db.getAcceptPolicy(),
      domains: db.listDomains(),
      mailboxes: db.listMailboxes(),
      stats: db.stats(),
      usage,
      config: {
        host: config.host,
        smtpPort: config.smtpPort,
        httpPort: config.httpPort,
        dataDir: config.dataDir,
        maxSize: config.maxSize,
      },
      exposed: config.host !== '127.0.0.1' && config.host !== 'localhost',
      mustChange: db.adminPasswordMustChange(),
    };
  }

  // ---------- policy and domains ----------

  app.post('/admin/policy', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const policy = req.body?.policy === 'allowlist' ? 'allowlist' : 'any';
    db.setAcceptPolicy(policy);
    logger.info?.(`admin: accept policy set to ${policy}`);
    return reply.view('admin', await dashboardModel(req, `Accept policy is now "${policy}".`));
  });

  app.post('/admin/domains/add', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const raw = String(req.body?.domain ?? '');
    const added = [];
    for (const piece of raw.split(/[\s,;]+/)) {
      const d = normaliseDomain(piece);
      if (!d) continue;
      if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(d)) {
        return reply.code(400).view('admin', await dashboardModel(req, `"${piece}" is not a valid domain.`));
      }
      db.addDomain(d);
      added.push(d);
    }
    const notice = added.length ? `Added ${added.join(', ')}.` : 'Nothing to add.';
    return reply.view('admin', await dashboardModel(req, notice));
  });

  app.post('/admin/domains/remove', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const d = normaliseDomain(req.body?.domain);
    db.removeDomain(d);
    return reply.view('admin', await dashboardModel(req, `Removed ${d}.`));
  });

  // ---------- maintenance ----------

  app.post('/admin/mailbox/delete', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const address = String(req.body?.address ?? '');
    const removed = db.deleteMailbox(address);
    const gc = await blobs.gc(db.referencedHashes());
    logger.info?.(`admin: deleted mailbox ${address} (${removed} messages, ${gc.removed} blobs)`);
    return reply.view(
      'admin',
      await dashboardModel(req, `Deleted ${removed} message(s) for ${address} and reclaimed ${gc.removed} blob(s).`),
    );
  });

  app.post('/admin/purge', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    // Typed confirmation: purging is not undoable and this is the one destructive control.
    if (String(req.body?.confirm ?? '').trim().toUpperCase() !== 'PURGE') {
      return reply.code(400).view('admin', await dashboardModel(req, 'Type PURGE to confirm. Nothing was deleted.'));
    }
    const removed = db.purgeAll();
    const gc = await blobs.gc(db.referencedHashes());
    logger.info?.(`admin: purged all mail (${removed} messages, ${gc.removed} blobs)`);
    return reply.view('admin', await dashboardModel(req, `Purged ${removed} message(s) and freed ${gc.bytes} bytes.`));
  });

  app.post('/admin/gc', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const gc = await blobs.gc(db.referencedHashes());
    return reply.view(
      'admin',
      await dashboardModel(req, `Reclaimed ${gc.removed} unreferenced blob(s), ${gc.bytes} bytes.`),
    );
  });
}
