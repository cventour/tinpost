import { EventEmitter } from 'node:events';

/**
 * The timeline's recorder: writes one event per thing the instance saw happen and
 * tells whoever is watching the Timeline page that something new arrived.
 *
 * Kept apart from the log on purpose. The log is text for reading and falls off the
 * end of a ring buffer; the timeline is structured, lives in the database and
 * survives a restart, because "what happened to the mail I sent an hour ago" is a
 * question asked after the fact.
 */
export class Timeline extends EventEmitter {
  #db;

  constructor(db) {
    super();
    this.#db = db;
  }

  /**
   * @param {{ kind: 'delivered'|'relayed'|'returned'|'failed'|'refused'|'connection',
   *           sourceIp?: string|null, via?: string, fromAddr?: string|null, toAddrs?: string|null,
   *           subject?: string|null, messageId?: number|null, openAs?: string|null,
   *           relay?: string|null, response?: string|null }} event
   */
  record(event) {
    try {
      const id = this.#db.insertEvent({ ...event, sourceIp: normaliseIp(event.sourceIp) });
      this.emit('event', { id, kind: event.kind });
      return id;
    } catch {
      // The timeline is a record of mail, never a reason to lose it.
      return null;
    }
  }
}

/** A client on a dual-stack socket reads as ::ffff:1.2.3.4; show the address people know. */
function normaliseIp(address) {
  if (!address) return null;
  return String(address).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
}
