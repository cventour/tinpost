import { EventEmitter } from 'node:events';

/**
 * Tinpost's own log, kept in memory so the admin page can show it.
 *
 * There is no log file on purpose. A lab instance is started, used for an afternoon
 * and thrown away; a file would have to be rotated, permissioned and cleaned up, and
 * the thing an operator actually wants — "what did SMTP just do?" — is answered by
 * the last few thousand lines and nothing older. So the lines are held in a ring
 * buffer, the oldest falling off the end, and the viewer says how many it has lost.
 *
 * Every line is recorded exactly as it was written, prefix and all, because the page
 * shows the raw log rather than a reformatted version of it. The level and the
 * channel ride alongside as metadata so the page can filter without touching the text.
 */

/** Lines held before the oldest start falling off. */
export const LOG_CAPACITY = 3000;

/** One line's ceiling. A stack trace is welcome; a megabyte of it is not. */
export const MAX_LINE = 4000;

/** Severities, least to most. The viewer's level filter reads this as an order. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * The channels a line can belong to, keyed by the prefix the code already writes —
 * `smtp: accepted #3 ...` and so on. Anything with no recognised prefix is "app",
 * which is where a stray line ends up rather than being dropped or mislabelled.
 */
export const LOG_CHANNELS = [
  ['smtp', 'SMTP'],
  ['icap', 'Scanning'],
  ['admin', 'Admin'],
  ['web', 'Web'],
  ['app', 'Other'],
];

const CHANNEL_KEYS = new Set(LOG_CHANNELS.map(([key]) => key));

/** Which channel a line belongs to, read from the prefix it was written with. */
export function channelOf(text) {
  const match = /^([a-z][a-z0-9-]{0,15}):/.exec(text);
  if (match && CHANNEL_KEYS.has(match[1])) return match[1];
  return 'app';
}

/**
 * Which way a transcript line was travelling, or null for anything that is not part
 * of a conversation.
 *
 * Read from the `C:` / `S:` the SMTP library writes, after the channel prefix and the
 * connection id: `smtp: [abc123] C: EHLO client.test`. A line that carries neither —
 * a delivery summary, a connection notice, an error — has no direction and is left
 * alone.
 */
export function wireOf(text) {
  const match = /^[a-z][a-z0-9-]*: (?:\[[^\]]*\] )?([CS]): /.exec(text);
  if (!match) return null;
  return match[1] === 'C' ? 'in' : 'out';
}

function clip(text) {
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)} … [${text.length - MAX_LINE} more characters]` : text;
}

export class LogBuffer extends EventEmitter {
  #lines = [];
  #capacity;
  #seq = 0;
  #dropped = 0;

  constructor({ capacity = LOG_CAPACITY } = {}) {
    super();
    this.#capacity = Math.max(1, capacity);
    // Every open viewer subscribes, and the default ceiling of ten would start
    // warning about a leak that is not one.
    this.setMaxListeners(0);
  }

  get capacity() {
    return this.#capacity;
  }

  /** How many lines have fallen off the end since the start, so the page can say so. */
  get dropped() {
    return this.#dropped;
  }

  /** The highest sequence number issued, which is what a tailing client resumes from. */
  get lastSeq() {
    return this.#seq;
  }

  get size() {
    return this.#lines.length;
  }

  /**
   * Record one line. Returns the record so a caller can use its sequence number.
   *
   * Sequence numbers are per-process and never reused, which is what lets the viewer
   * ask for "everything after 412" and get an answer that cannot double-count even
   * when lines have aged out in between.
   */
  add(level, message) {
    const text = clip(String(message ?? ''));
    const record = {
      seq: (this.#seq += 1),
      time: new Date().toISOString(),
      level: LOG_LEVELS.includes(level) ? level : 'info',
      channel: channelOf(text),
      wire: wireOf(text),
      text,
    };

    this.#lines.push(record);
    const excess = this.#lines.length - this.#capacity;
    if (excess > 0) {
      this.#lines.splice(0, excess);
      this.#dropped += excess;
    }

    this.emit('line', record);
    return record;
  }

  /**
   * The lines a viewer asked for.
   *
   * `since` is a sequence number, not an index, so a client that was away while the
   * buffer turned over still gets every line the buffer still holds rather than a
   * silent gap. `limit` keeps the most recent, because that is the end anyone reads.
   */
  select({ since = 0, channel = 'all', level = 'debug', limit = 0 } = {}) {
    const floor = LOG_LEVELS.indexOf(level);
    const minLevel = floor === -1 ? 0 : floor;

    const out = [];
    for (const line of this.#lines) {
      if (line.seq <= since) continue;
      if (channel !== 'all' && line.channel !== channel) continue;
      if (LOG_LEVELS.indexOf(line.level) < minLevel) continue;
      out.push(line);
    }
    return limit > 0 && out.length > limit ? out.slice(-limit) : out;
  }

  /** How many held lines each channel has, for the counts beside the filters. */
  counts() {
    const out = { all: this.#lines.length };
    for (const [key] of LOG_CHANNELS) out[key] = 0;
    for (const line of this.#lines) out[line.channel] += 1;
    return out;
  }

  clear() {
    const had = this.#lines.length;
    this.#lines = [];
    // The sequence deliberately keeps climbing: a viewer holding an old cursor must
    // not be handed numbers it has already seen.
    this.#dropped = 0;
    return had;
  }
}

/**
 * Wrap a logger so everything it is told is also kept for the admin page.
 *
 * `info`, `warn` and `error` go both places — the terminal is still the first thing
 * an operator looks at. `debug` is recorded only. That asymmetry is the point: it is
 * where the SMTP conversation goes, which is far too much to print but is exactly
 * what the Logs page exists to show.
 */
export function recordingLogger(base, buffer) {
  return {
    info(message) {
      buffer.add('info', message);
      base?.info?.(message);
    },
    warn(message) {
      buffer.add('warn', message);
      base?.warn?.(message);
    },
    error(message) {
      buffer.add('error', message);
      base?.error?.(message);
    },
    debug(message) {
      buffer.add('debug', message);
    },
  };
}

/** One line as it appears in a downloaded log file. */
export function formatLine(line) {
  return `${line.time} ${line.level.toUpperCase().padEnd(5)} ${line.text}`;
}
