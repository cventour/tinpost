import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer';
import { parseMessage, threadKeyFor, htmlToText } from './parse.js';
import { normaliseAddress, domainOf } from './db.js';
import {
  relayConfig,
  relayAddress,
  planRoute,
  isLocalSender,
  relayMessage,
  hasBeenRelayed,
  withRelayFootnote,
} from './relay.js';

/**
 * The single write path for every message in the system.
 *
 * Both the SMTP listener and the webmail compose form come through here, which is
 * what makes mail sent from the UI indistinguishable from mail that arrived over
 * the wire, and what makes "internal routing" automatic: there is only one store,
 * so delivering is just writing to it.
 */
export class Delivery extends EventEmitter {
  #db;
  #blobs;
  #maxSize;
  #scanner;
  #logger;
  #timeline;

  constructor({ db, blobs, maxSize, scanner = null, logger = console, timeline = null }) {
    super();
    this.#logger = logger;
    // Optional: every stored message becomes an event on the Timeline page.
    this.#timeline = timeline;
    this.#db = db;
    this.#blobs = blobs;
    this.#maxSize = maxSize;
    // Optional ICAP scanner. Sitting here rather than in the SMTP listener is what
    // makes one check cover both directions: everything that arrives and everything
    // the webmail sends comes through this class.
    this.#scanner = scanner;
  }

  /**
   * Store an already-persisted raw message (the SMTP path: the stream has been
   * written to the blob store as it arrived, so only the hash is passed in).
   *
   * `fromGateway` marks a message the upstream gateway sent back after scanning it,
   * which is delivered and never relayed again.
   *
   * @param {{ rawHash: string, size: number, envelopeRecipients?: string[], envelopeFrom?: string|null,
   *           origin?: string, fromGateway?: boolean, sourceIp?: string|null }} input
   */
  async deliverStored({ rawHash, size, envelopeRecipients = [], envelopeFrom = null, origin = 'smtp', fromGateway = false, sourceIp = null }) {
    const raw = await this.#blobs.read(rawHash);
    return this.#persist({ raw, rawHash, size, envelopeRecipients, envelopeFrom, origin, fromGateway, sourceIp });
  }

  /** Store a raw buffer we already hold (tests, imports). */
  async deliverRaw(raw, { envelopeRecipients = [], envelopeFrom = null, origin = 'smtp', fromGateway = false, sourceIp = null } = {}) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const { hash, size } = await this.#blobs.put(Readable.from([buf]), { maxSize: this.#maxSize });
    return this.#persist({ raw: buf, rawHash: hash, size, envelopeRecipients, envelopeFrom, origin, fromGateway, sourceIp });
  }

  /**
   * Build and deliver a message composed in the webmail UI. Uses nodemailer's
   * MailComposer so the stored .eml is a genuine RFC822 message rather than
   * something hand-rolled — it opens correctly in any real mail client.
   *
   * @param {{ from: string, to: string[], cc?: string[], subject?: string,
   *           text?: string, html?: string|null, attachments?: Array<{filename:string,contentType:string,hash:string,size:number}>,
   *           inReplyTo?: string|null, references?: string|null }} draft
   */
  async deliverComposed(draft, { sourceIp = null } = {}) {
    const attachments = [];
    for (const a of draft.attachments ?? []) {
      attachments.push({
        filename: a.filename,
        contentType: a.contentType,
        content: await this.#blobs.read(a.hash),
      });
    }

    const text = draft.text ?? (draft.html ? htmlToText(draft.html) : '');
    const mail = new MailComposer({
      from: draft.from,
      to: draft.to,
      cc: draft.cc?.length ? draft.cc : undefined,
      subject: draft.subject || '',
      text,
      html: draft.html || undefined,
      inReplyTo: draft.inReplyTo ? `<${draft.inReplyTo}>` : undefined,
      references: draft.references || undefined,
      attachments,
      date: new Date(),
      // Keep the composer offline: never let it read a local file or fetch a URL.
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    const raw = await new Promise((resolve, reject) => {
      mail.compile().build((err, message) => (err ? reject(err) : resolve(message)));
    });

    return this.deliverRaw(raw, {
      envelopeRecipients: [...(draft.to ?? []), ...(draft.cc ?? [])],
      envelopeFrom: draft.from,
      origin: 'webmail',
      sourceIp,
    });
  }

  async #persist({ raw, rawHash, size, envelopeRecipients, envelopeFrom = null, origin, fromGateway = false, sourceIp = null }) {
    const parsed = await parseMessage(raw);

    // Envelope recipients (RCPT TO) are authoritative for where mail lands — that is
    // how bcc works, and how a message addressed to one header but sent to another
    // still reaches the right mailbox.
    const recipients = mergeRecipients(parsed.recipients, envelopeRecipients);
    const relay = relayConfig(this.#db);
    // MAIL FROM decides where mail is going, as it would for any MTA; the header is
    // the fallback for the webmail, whose envelope sender is the header sender.
    const from = normaliseAddress(envelopeFrom) || parsed.fromAddr;

    // The gateway handing back what it scanned. It was relayed from here once and is
    // not relayed again; it is scanned by the gateway rather than by ICAP; and only
    // the addresses it was sent back for receive it — the sender and anyone in their
    // own domain already have their copy.
    if (relay.enabled && fromGateway) {
      const envelope = new Set(envelopeRecipients.map(normaliseAddress).filter(Boolean));
      if (envelope.size) for (const r of recipients) r.delivered = envelope.has(r.address);
      this.#logger.info?.(`relay: ${relay.host} returned a message from ${from || 'unknown'} for ${[...envelope].join(', ')}`);
      return this.#store({
        parsed,
        rawHash,
        size,
        recipients,
        origin,
        senderCopy: false,
        relayStatus: 'returned',
        relayDetail: `Returned by the upstream gateway after scanning`,
        event: { sourceIp, via: 'gateway', relay: 'returned', response: 'Scanned and returned by the gateway' },
      });
    }

    const route = planRoute(relay, { from, recipients: recipients.map((r) => r.address) });

    // Nothing is written to the index until the scanner has approved the message, so
    // a rejected one never appears in a mailbox. Its raw blob is already on disk —
    // the SMTP path streams it there as it arrives — and is reclaimed by the next
    // pass of blob GC, which keeps only what a row still points at.
    //
    // Scanning happens after parsing because that is where the attachments are, and
    // before the insert because a message that is not approved is not delivered.
    //
    // Mail for the gateway is the gateway's to scan, so only the recipients delivered
    // here are put to ICAP — and with none of them, nothing is.
    if (this.#scanner && route.local.length) {
      await this.#scanner.check({
        attachments: parsed.attachments,
        from: parsed.fromAddr,
        recipients: route.local,
        origin,
        subject: parsed.subject,
      });
    }

    const via = origin === 'webmail' ? 'webmail' : 'smtp';
    if (!route.relay.length) return this.#store({ parsed, rawHash, size, recipients, origin, event: { sourceIp, via } });

    // Which way the message crosses the boundary: out of a local domain, or into one.
    const direction = isLocalSender(relay, from) ? 'outbound' : 'inbound';

    // A message stamped by a Tinpost relay that did not come back from the gateway is
    // going round in a circle: the gateway sent it back from an address that is not
    // listed as its return address. Refused, as any MTA refuses a loop, rather than
    // relayed forever or delivered without the scan it was meant to have.
    if (hasBeenRelayed(parsed.headerLines)) {
      this.#logger.error?.(
        `relay: refused a message from ${from} that has already been relayed once — add the address the gateway sends back from to the gateway return addresses`,
      );
      throw new RelayLoop('Mail loop detected: this message has already been relayed by Tinpost');
    }

    const where = relayAddress(relay);
    const result = await relayMessage(relay, { from, to: route.relay, raw });
    const accepted = new Set(result.accepted.map(normaliseAddress));

    if (result.ok) {
      // Listed on the sender's copy, but not delivered: their copy is the one the
      // gateway sends back.
      for (const r of recipients) if (accepted.has(r.address)) r.delivered = false;
      this.#logger.info?.(`relay: sent a message from ${from} to ${where} for ${route.relay.join(', ')} (${result.response})`);
      return this.#store({
        parsed,
        rawHash,
        size,
        recipients,
        origin,
        relayStatus: 'relayed',
        relayDetail: `Handed to ${where} for ${route.relay.join(', ')}: ${result.response}`,
        event: { sourceIp, via, relay: direction, response: result.response },
      });
    }

    // The gateway would not take it, or not for everyone. There is no queue, so the
    // recipients it refused get the message here, unscanned, with the reason in its
    // body; any it did accept still get theirs when it comes back.
    const failed = route.relay.filter((a) => !accepted.has(normaliseAddress(a)));
    for (const r of recipients) if (accepted.has(r.address)) r.delivered = false;
    this.#logger.error?.(
      `relay: could not relay a message from ${from} to ${where} for ${failed.join(', ')} (${result.error}); delivering it locally without scanning`,
    );

    const annotated = await withRelayFootnote(parsed, { where, recipients: failed, error: result.error });
    const stored = await this.#blobs.put(Readable.from([annotated]));
    return this.#store({
      parsed: await parseMessage(annotated),
      rawHash: stored.hash,
      size: stored.size,
      recipients,
      origin,
      relayStatus: 'failed',
      relayDetail: `Could not relay to ${where} for ${failed.join(', ')}: ${result.error}`,
      event: { sourceIp, via, relay: direction, response: result.error },
    });
  }

  async #store({ parsed, rawHash, size, recipients, origin, senderCopy = true, relayStatus = null, relayDetail = null, event = {} }) {
    let htmlHash = null;
    if (parsed.html) {
      const r = await this.#blobs.put(Readable.from([Buffer.from(parsed.html, 'utf8')]));
      htmlHash = r.hash;
    }

    const storedAttachments = [];
    for (const a of parsed.attachments) {
      const r = await this.#blobs.put(Readable.from([a.content]), { maxSize: this.#maxSize });
      storedAttachments.push({
        filename: a.filename,
        contentType: a.contentType,
        size: r.size,
        hash: r.hash,
        contentId: a.contentId,
        isInline: a.isInline,
      });
    }

    const now = new Date();
    const id = this.#db.insertMessage(
      {
        messageId: parsed.messageId,
        fromAddr: parsed.fromAddr || 'unknown@invalid',
        fromName: parsed.fromName,
        subject: parsed.subject,
        dateUtc: (parsed.date ?? now).toISOString(),
        receivedAt: now.toISOString(),
        rawHash,
        // Fall back to a text rendering of the HTML so the plain-text view is never
        // a dead end for HTML-only mail.
        bodyText: parsed.bodyText ?? (parsed.html ? htmlToText(parsed.html) : ''),
        htmlHash,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        threadKey: threadKeyFor(parsed.subject),
        sizeBytes: size,
        origin,
        senderCopy,
        relayStatus,
        relayDetail,
      },
      recipients,
      storedAttachments,
    );

    // Only the mailboxes that can actually see this row: a recipient still waiting on
    // the gateway is not told about a copy they cannot open.
    const visible = recipients.filter((r) => r.delivered !== false).map((r) => r.address);
    if (senderCopy && parsed.fromAddr) visible.push(parsed.fromAddr);

    const summary = {
      id,
      from: parsed.fromAddr,
      subject: parsed.subject,
      addresses: [...new Set(visible.filter(Boolean))],
      relayStatus,
    };

    // Opened from the timeline as a mailbox that can actually see it: a recipient who
    // has it, or the sender while it is still with the gateway.
    const holder = recipients.find((r) => r.delivered !== false)?.address;
    this.#timeline?.record({
      kind: { relayed: 'relayed', failed: 'failed', returned: 'returned' }[relayStatus] ?? 'delivered',
      sourceIp: event.sourceIp,
      via: event.via,
      fromAddr: parsed.fromAddr || null,
      toAddrs: recipients.map((r) => r.address).join(', '),
      subject: parsed.subject,
      messageId: id,
      openAs: relayStatus === 'relayed' || !holder ? parsed.fromAddr : holder,
      relay: event.relay ?? null,
      response: event.response ?? null,
    });

    // Drives the live inbox: the web layer forwards these over SSE to whoever is
    // looking at one of the affected mailboxes.
    this.emit('message', summary);
    return summary;
  }
}

/** Refused because the message has already been through a Tinpost relay once. */
export class RelayLoop extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayLoop';
  }
}

/**
 * Header recipients plus envelope recipients, de-duplicated. Envelope-only
 * addresses are recorded as bcc, which is exactly what they are.
 */
function mergeRecipients(headerRecipients, envelopeRecipients) {
  const out = [];
  const seen = new Set();
  for (const r of headerRecipients) {
    const address = normaliseAddress(r.address);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ address, name: r.name, kind: r.kind });
  }
  for (const raw of envelopeRecipients) {
    const address = normaliseAddress(raw);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ address, name: null, kind: 'bcc' });
  }
  return out;
}

export { domainOf };
