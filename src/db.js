import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const SCHEMA_VERSION = 4;

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
  origin         TEXT NOT NULL DEFAULT 'smtp',
  -- 0 for the copy an upstream gateway hands back: the sender already has their own.
  sender_copy    INTEGER NOT NULL DEFAULT 1,
  -- Upstream relay: NULL when it was never relayed, else relayed, failed or returned.
  relay_status   TEXT,
  relay_detail   TEXT
);

CREATE TABLE IF NOT EXISTS recipients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  name       TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('to','cc','bcc')),
  seen       INTEGER NOT NULL DEFAULT 0,
  -- 0 when this address is listed on the message but it was not delivered to them
  -- here: it went to the upstream gateway, and their copy arrives when it comes back.
  delivered  INTEGER NOT NULL DEFAULT 1
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
  created_at TEXT NOT NULL,
  -- Per-domain ICAP scanning: 1 on, 0 off, NULL to follow the global default.
  icap_scan  INTEGER
);

-- The timeline: one row per thing the instance saw happen. A message row points at
-- the message it stored, but not by foreign key: deleting a mailbox must not erase
-- the history of what arrived.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  -- delivered, relayed, returned, failed, refused or connection
  kind       TEXT NOT NULL,
  source_ip  TEXT,
  -- smtp, webmail or gateway
  via        TEXT,
  from_addr  TEXT,
  to_addrs   TEXT,
  subject    TEXT,
  message_id INTEGER,
  -- The mailbox to open the message as: one that can actually see it.
  open_as    TEXT,
  -- outbound, inbound or returned when the upstream relay was involved; upstream when
  -- it was, but the direction predates the timeline
  relay      TEXT,
  response   TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
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
    this.#migrate();
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.#bootstrapSettings();
  }

  close() {
    this.#db.close();
  }

  get raw() {
    return this.#db;
  }

  /**
   * Bring a database written by an older version up to date.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
   * column added after the fact has to be added explicitly. Checked by inspection
   * rather than by version number, because a user_version of 0 is also what a
   * database from before versioning looks like.
   */
  #migrate() {
    const columns = this.#db.prepare('PRAGMA table_info(domains)').all().map((c) => c.name);
    if (!columns.includes('icap_scan')) {
      this.#db.exec('ALTER TABLE domains ADD COLUMN icap_scan INTEGER');
    }

    const messageColumns = this.#db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!messageColumns.includes('sender_copy')) {
      this.#db.exec('ALTER TABLE messages ADD COLUMN sender_copy INTEGER NOT NULL DEFAULT 1');
    }
    if (!messageColumns.includes('relay_status')) this.#db.exec('ALTER TABLE messages ADD COLUMN relay_status TEXT');
    if (!messageColumns.includes('relay_detail')) this.#db.exec('ALTER TABLE messages ADD COLUMN relay_detail TEXT');

    const recipientColumns = this.#db.prepare('PRAGMA table_info(recipients)').all().map((c) => c.name);
    if (!recipientColumns.includes('delivered')) {
      this.#db.exec('ALTER TABLE recipients ADD COLUMN delivered INTEGER NOT NULL DEFAULT 1');
    }

    this.#backfillEvents();
  }

  /**
   * Give mail stored before the timeline existed a place on it, once. What was not
   * recorded then — the source address, the relay's exact reply — is left empty
   * rather than guessed.
   */
  #backfillEvents() {
    if (this.getSetting('events_backfilled') === '1') return;
    const messages = this.#db.prepare('SELECT * FROM messages ORDER BY id').all();
    for (const m of messages) {
      const recipients = this.getRecipients(m.id);
      const visible = recipients.find((r) => r.delivered);
      const kind = { relayed: 'relayed', failed: 'failed', returned: 'returned' }[m.relay_status] ?? 'delivered';
      this.insertEvent({
        at: m.received_at,
        kind,
        via: m.origin === 'webmail' ? 'webmail' : m.relay_status === 'returned' ? 'gateway' : 'smtp',
        fromAddr: m.from_addr,
        toAddrs: recipients.map((r) => r.address).join(', '),
        subject: m.subject,
        messageId: m.id,
        // A message still waiting on the gateway is only visible to its sender.
        openAs: kind === 'relayed' ? m.from_addr : (visible?.address ?? m.from_addr),
        // Which way it went was not recorded before the timeline, only that it did.
        relay: m.relay_status === 'returned' ? 'returned' : m.relay_status ? 'upstream' : null,
        response: m.relay_detail,
      });
    }
    this.setSetting('events_backfilled', '1');
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

  /** Every domain with its scanning override, for the ICAP page. */
  listDomainSettings() {
    return this.#db
      .prepare('SELECT domain, icap_scan FROM domains ORDER BY domain')
      .all()
      .map((r) => ({ domain: r.domain, icapScan: r.icap_scan === null ? null : !!r.icap_scan }));
  }

  /**
   * Set (or clear) this domain's scanning override. `null` means "follow the global
   * default"; the row is created if the domain is not known yet, so scanning can be
   * configured for a domain without also having to allowlist it first.
   */
  setDomainIcap(domain, value) {
    const d = normaliseDomain(domain);
    if (!d) throw new Error('empty domain');
    const stored = value === null || value === undefined ? null : value ? 1 : 0;
    this.#db
      .prepare(
        `INSERT INTO domains (domain, created_at, icap_scan) VALUES (?, ?, ?)
           ON CONFLICT(domain) DO UPDATE SET icap_scan = excluded.icap_scan`,
      )
      .run(d, new Date().toISOString(), stored);
    return d;
  }

  /** This domain's override, or `null` when it has none. */
  getDomainIcap(domain) {
    const row = this.#db.prepare('SELECT icap_scan FROM domains WHERE domain = ?').get(normaliseDomain(domain));
    if (!row || row.icap_scan === null || row.icap_scan === undefined) return null;
    return !!row.icap_scan;
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
              body_text, html_hash, in_reply_to, refs, thread_key, size_bytes, has_attachments, origin,
              sender_copy, relay_status, relay_detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          msg.senderCopy === false ? 0 : 1,
          msg.relayStatus ?? null,
          msg.relayDetail ?? null,
        );
      const id = Number(info.lastInsertRowid);

      const rcpt = this.#db.prepare(
        'INSERT INTO recipients (message_id, address, name, kind, delivered) VALUES (?,?,?,?,?)',
      );
      for (const r of recipients) rcpt.run(id, r.address, r.name ?? null, r.kind, r.delivered === false ? 0 : 1);

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
      .prepare('SELECT address, name, kind, seen, delivered FROM recipients WHERE message_id = ? ORDER BY id')
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
          WHERE r.address = ? AND r.delivered = 1 AND m.id > ?
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
          WHERE m.from_addr = ? AND m.sender_copy = 1 AND m.id > ?
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
          WHERE m.id = ? AND ((m.from_addr = ? AND m.sender_copy = 1) OR EXISTS (
                SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.address = ? AND r.delivered = 1))`,
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
      .prepare('SELECT COUNT(*) AS n FROM recipients WHERE address = ? AND seen = 0 AND delivered = 1')
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
              WHERE r.delivered = 1
              GROUP BY r.address
             UNION ALL
             SELECT from_addr AS address, 0 AS received, COUNT(*) AS sent, MAX(date_utc) AS last_at
               FROM messages WHERE sender_copy = 1 GROUP BY from_addr
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
            WHERE (m.from_addr = ? AND m.sender_copy = 1)
               OR EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.address = ? AND r.delivered = 1))`,
      )
      .run(a, a);
    return Number(info.changes);
  }

  purgeAll() {
    const info = this.#db.prepare('DELETE FROM messages').run();
    // A reset lab starts with an empty history too.
    this.#db.prepare('DELETE FROM events').run();
    return Number(info.changes);
  }

  // ---------- timeline ----------

  insertEvent(e) {
    const info = this.#db
      .prepare(
        `INSERT INTO events (at, kind, source_ip, via, from_addr, to_addrs, subject, message_id, open_as, relay, response)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.at ?? new Date().toISOString(),
        e.kind,
        e.sourceIp ?? null,
        e.via ?? null,
        e.fromAddr ?? null,
        e.toAddrs ?? null,
        e.subject ?? null,
        e.messageId ?? null,
        e.openAs ?? null,
        e.relay ?? null,
        e.response ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  getEvent(id) {
    return this.#db.prepare('SELECT * FROM events WHERE id = ?').get(id) ?? null;
  }

  /**
   * The WHERE clause shared by the list, the counts and the chart, so the three can
   * never disagree about which events are in view.
   */
  #eventWhere({ from, to, show = null, q = '' }) {
    const clauses = ['at >= ?', 'at < ?'];
    const params = [from, to];
    // `show` is the set of categories switched on; null means all of them.
    if (Array.isArray(show)) {
      const kinds = show.flatMap((c) => EVENT_CATEGORIES[c] ?? []);
      if (!kinds.length) clauses.push('0');
      else {
        clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
        params.push(...kinds);
      }
    }
    const term = String(q ?? '').trim().toLowerCase();
    if (term) {
      clauses.push(
        "(instr(lower(coalesce(from_addr,'') || ' ' || coalesce(to_addrs,'') || ' ' || coalesce(source_ip,'') || ' ' || coalesce(subject,'') || ' ' || coalesce(response,'')), ?) > 0)",
      );
      params.push(term);
    }
    return { sql: clauses.join(' AND '), params };
  }

  /** Events in a window, newest first. `before` pages back by id. */
  listEvents({ from, to, show, q, before = null, limit = 200 }) {
    const where = this.#eventWhere({ from, to, show, q });
    const page = before ? ' AND id < ?' : '';
    return this.#db
      .prepare(`SELECT * FROM events WHERE ${where.sql}${page} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...where.params, ...(before ? [before] : []), limit);
  }

  countEvents({ from, to, show, q }) {
    const where = this.#eventWhere({ from, to, show, q });
    return Number(this.#db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where.sql}`).get(...where.params).n);
  }

  /** Time and kind of every event in the window: what the activity chart is drawn from. */
  eventMarks({ from, to, show, q }) {
    const where = this.#eventWhere({ from, to, show, q });
    return this.#db.prepare(`SELECT at, kind FROM events WHERE ${where.sql}`).all(...where.params);
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

/** The timeline's categories, each with the event kinds it covers. They do not overlap. */
export const EVENT_CATEGORIES = {
  delivered: ['delivered'],
  relayed: ['relayed'],
  returned: ['returned'],
  failed: ['failed'],
  refused: ['refused'],
  connection: ['connection'],
};

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
