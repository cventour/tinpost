import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id     TEXT,
  from_addr      TEXT NOT NULL,
  from_name      TEXT,
  subject        TEXT,
  date_utc       TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  raw_hash       TEXT NOT NULL,
  body_text      TEXT,
  html_hash      TEXT,
  in_reply_to    TEXT,
  refs           TEXT,
  thread_key     TEXT,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  origin         TEXT NOT NULL DEFAULT 'smtp'
);

CREATE TABLE IF NOT EXISTS recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  name       TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('to','cc','bcc')),
  seen       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  content_id   TEXT,
  is_inline    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  domain     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipients_address ON recipients(address);
CREATE INDEX IF NOT EXISTS idx_recipients_message ON recipients(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_addr);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_utc DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
`;

/**
 * All SQL lives here. The database is deliberately an index only: it stores
 * metadata plus SHA-256 pointers into the blob store, never the bytes themselves.
 */
export class Db {
  #db;

  constructor(path) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.#bootstrapSettings();
  }

  close() {
    this.#db.close();
  }

  get raw() {
    return this.#db;
  }

  #bootstrapSettings() {
    if (this.getSetting('accept_policy') === null) this.setSetting('accept_policy', 'any');
    if (this.getSetting('session_secret') === null) {
      this.setSetting('session_secret', randomBytes(32).toString('hex'));
    }
  }

  // ---------- settings ----------

  getSetting(key) {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.#db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  getAcceptPolicy() {
    return this.getSetting('accept_policy') === 'allowlist' ? 'allowlist' : 'any';
  }

  setAcceptPolicy(policy) {
    if (policy !== 'any' && policy !== 'allowlist') throw new Error(`bad policy: ${policy}`);
    this.setSetting('accept_policy', policy);
  }

  // ---------- admin password ----------

  /**
   * @param {string} plain
   * @param {{ mustChange?: boolean }} [opts] mark the password as temporary, so the
   *   admin page forces it to be replaced before anything else can be done.
   */
  setAdminPassword(plain, { mustChange = false } = {}) {
    const salt = randomBytes(16);
    const derived = scryptSync(plain, salt, 64);
    this.setSetting('admin_password_hash', `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
    this.setSetting('admin_password_must_change', mustChange ? '1' : '0');
  }

  /** True while the admin is still on the password generated at first start. */
  adminPasswordMustChange() {
    return this.getSetting('admin_password_must_change') === '1';
  }

  hasAdminPassword() {
    return this.getSetting('admin_password_hash') !== null;
  }

  verifyAdminPassword(plain) {
    const stored = this.getSetting('admin_password_hash');
    if (!stored) return false;
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    let actual;
    try {
      actual = scryptSync(plain, Buffer.from(saltHex, 'hex'), expected.length);
    } catch {
      return false;
    }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  // ---------- domains ----------

  listDomains() {
    return this.#db.prepare('SELECT domain FROM domains ORDER BY domain').all().map((r) => r.domain);
  }

  addDomain(domain) {
    const d = normaliseDomain(domain);
    if (!d) throw new Error('empty domain');
    this.#db
      .prepare('INSERT INTO domains (domain, created_at) VALUES (?, ?) ON CONFLICT(domain) DO NOTHING')
      .run(d, new Date().toISOString());
    return d;
  }

  removeDomain(domain) {
    this.#db.prepare('DELETE FROM domains WHERE domain = ?').run(normaliseDomain(domain));
  }

  /** True when mail for this recipient should be accepted under the current policy. */
  isDomainAccepted(domain) {
    if (this.getAcceptPolicy() === 'any') return true;
    const d = normaliseDomain(domain);
    return !!this.#db.prepare('SELECT 1 FROM domains WHERE domain = ?').get(d);
  }

  // ---------- messages ----------

  insertMessage(msg, recipients, attachments) {
    const tx = () => {
      const info = this.#db
        .prepare(
          `INSERT INTO messages
             (message_id, from_addr, from_name, subject, date_utc, received_at, raw_hash,
              body_text, html_hash, in_reply_to, refs, thread_key, size_bytes, has_attachments, origin)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          msg.messageId ?? null,
          msg.fromAddr,
          msg.fromName ?? null,
          msg.subject ?? null,
          msg.dateUtc,
          msg.receivedAt,
          msg.rawHash,
          msg.bodyText ?? null,
          msg.htmlHash ?? null,
          msg.inReplyTo ?? null,
          msg.references ?? null,
          msg.threadKey ?? null,
          msg.sizeBytes ?? 0,
          attachments.some((a) => !a.isInline) ? 1 : 0,
          msg.origin ?? 'smtp',
        );
      const id = Number(info.lastInsertRowid);

      const rcpt = this.#db.prepare(
        'INSERT INTO recipients (message_id, address, name, kind) VALUES (?,?,?,?)',
      );
      for (const r of recipients) rcpt.run(id, r.address, r.name ?? null, r.kind);

      const att = this.#db.prepare(
        `INSERT INTO attachments (message_id, filename, content_type, size_bytes, content_hash, content_id, is_inline)
         VALUES (?,?,?,?,?,?,?)`,
      );
      for (const a of attachments) {
        att.run(id, a.filename, a.contentType ?? null, a.size ?? 0, a.hash, a.contentId ?? null, a.isInline ? 1 : 0);
      }
      return id;
    };

    this.#db.exec('BEGIN');
    try {
      const id = tx();
      this.#db.exec('COMMIT');
      return id;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  getMessage(id) {
    return this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(id) ?? null;
  }

  getRecipients(messageId) {
    return this.#db
      .prepare('SELECT address, name, kind, seen FROM recipients WHERE message_id = ? ORDER BY id')
      .all(messageId);
  }

  getAttachments(messageId, { includeInline = true } = {}) {
    const sql = includeInline
      ? 'SELECT * FROM attachments WHERE message_id = ? ORDER BY id'
      : 'SELECT * FROM attachments WHERE message_id = ? AND is_inline = 0 ORDER BY id';
    return this.#db.prepare(sql).all(messageId);
  }

  getAttachment(messageId, attachmentId) {
    return (
      this.#db.prepare('SELECT * FROM attachments WHERE id = ? AND message_id = ?').get(attachmentId, messageId) ?? null
    );
  }

  findInlineByCid(messageId, contentId) {
    return (
      this.#db
        .prepare('SELECT * FROM attachments WHERE message_id = ? AND content_id = ?')
        .get(messageId, contentId) ?? null
    );
  }

  /** Inbox: everything addressed to this mailbox, newest first. */
  listInbox(address, { limit = 200, sinceId = 0 } = {}) {
    return this.#db
      .prepare(
        `SELECT m.*, MIN(r.seen) AS seen
           FROM messages m
           JOIN recipients r ON r.message_id = m.id
          WHERE r.address = ? AND m.id > ?
          GROUP BY m.id
          ORDER BY m.id DESC
          LIMIT ?`,
      )
      .all(normaliseAddress(address), sinceId, limit);
  }

  /** Sent: everything this mailbox is the author of. */
  listSent(address, { limit = 200, sinceId = 0 } = {}) {
    return this.#db
      .prepare(
        `SELECT m.*, 1 AS seen FROM messages m
          WHERE m.from_addr = ? AND m.id > ?
          ORDER BY m.id DESC LIMIT ?`,
      )
      .all(normaliseAddress(address), sinceId, limit);
  }

  /** Can this mailbox see this message? Mailboxes are unauthenticated but not cross-readable. */
  canAccess(address, messageId) {
    const a = normaliseAddress(address);
    const row = this.#db
      .prepare(
        `SELECT 1 FROM messages m
          WHERE m.id = ? AND (m.from_addr = ? OR EXISTS (
                SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.address = ?))`,
      )
      .get(messageId, a, a);
    return !!row;
  }

  markSeen(address, messageId) {
    this.#db
      .prepare('UPDATE recipients SET seen = 1 WHERE message_id = ? AND address = ?')
      .run(messageId, normaliseAddress(address));
  }

  unreadCount(address) {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM recipients WHERE address = ? AND seen = 0')
      .get(normaliseAddress(address));
    return row ? Number(row.n) : 0;
  }

  /** Every mailbox known to the instance, with counts — powers the admin table. */
  listMailboxes() {
    return this.#db
      .prepare(
        `SELECT address,
                SUM(received) AS received,
                SUM(sent) AS sent,
                MAX(last_at) AS last_at
           FROM (
             SELECT r.address AS address, COUNT(*) AS received, 0 AS sent, MAX(m.date_utc) AS last_at
               FROM recipients r JOIN messages m ON m.id = r.message_id
              GROUP BY r.address
             UNION ALL
             SELECT from_addr AS address, 0 AS received, COUNT(*) AS sent, MAX(date_utc) AS last_at
               FROM messages GROUP BY from_addr
           )
          GROUP BY address
          ORDER BY address`,
      )
      .all();
  }

  /** Delete every message this mailbox can see. Blobs are reclaimed separately by gc(). */
  deleteMailbox(address) {
    const a = normaliseAddress(address);
    const info = this.#db
      .prepare(
        `DELETE FROM messages WHERE id IN (
           SELECT m.id FROM messages m
            WHERE m.from_addr = ?
               OR EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.address = ?))`,
      )
      .run(a, a);
    return Number(info.changes);
  }

  purgeAll() {
    const info = this.#db.prepare('DELETE FROM messages').run();
    return Number(info.changes);
  }

  /** Hashes still pointed at by any row — the keep-set for blob GC. */
  referencedHashes() {
    const set = new Set();
    for (const r of this.#db.prepare('SELECT raw_hash FROM messages').all()) set.add(r.raw_hash);
    for (const r of this.#db.prepare("SELECT html_hash FROM messages WHERE html_hash IS NOT ''").all()) {
      if (r.html_hash) set.add(r.html_hash);
    }
    for (const r of this.#db.prepare('SELECT content_hash FROM attachments').all()) set.add(r.content_hash);
    return set;
  }

  stats() {
    const q = (sql) => Number(this.#db.prepare(sql).get().n);
    return {
      messages: q('SELECT COUNT(*) AS n FROM messages'),
      attachments: q('SELECT COUNT(*) AS n FROM attachments'),
      mailboxes: q('SELECT COUNT(*) AS n FROM (SELECT address FROM recipients UNION SELECT from_addr FROM messages)'),
    };
  }
}

export function normaliseAddress(address) {
  return String(address ?? '').trim().toLowerCase();
}

export function normaliseDomain(domain) {
  return String(domain ?? '').trim().toLowerCase().replace(/^@/, '');
}

export function domainOf(address) {
  const at = normaliseAddress(address).lastIndexOf('@');
  return at === -1 ? '' : normaliseAddress(address).slice(at + 1);
}
