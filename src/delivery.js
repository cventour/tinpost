import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer';
import { parseMessage, threadKeyFor, htmlToText } from './parse.js';
import { normaliseAddress, domainOf } from './db.js';

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

  constructor({ db, blobs, maxSize, scanner = null }) {
    super();
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
   * @param {{ rawHash: string, size: number, envelopeRecipients?: string[], origin?: string }} input
   */
  async deliverStored({ rawHash, size, envelopeRecipients = [], origin = 'smtp' }) {
    const raw = await this.#blobs.read(rawHash);
    return this.#persist({ raw, rawHash, size, envelopeRecipients, origin });
  }

  /** Store a raw buffer we already hold (tests, imports). */
  async deliverRaw(raw, { envelopeRecipients = [], origin = 'smtp' } = {}) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const { hash, size } = await this.#blobs.put(Readable.from([buf]), { maxSize: this.#maxSize });
    return this.#persist({ raw: buf, rawHash: hash, size, envelopeRecipients, origin });
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
  async deliverComposed(draft) {
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
      origin: 'webmail',
    });
  }

  async #persist({ raw, rawHash, size, envelopeRecipients, origin }) {
    const parsed = await parseMessage(raw);

    // Envelope recipients (RCPT TO) are authoritative for where mail lands — that is
    // how bcc works, and how a message addressed to one header but sent to another
    // still reaches the right mailbox.
    const recipients = mergeRecipients(parsed.recipients, envelopeRecipients);

    // Nothing is written to the index until the scanner has approved the message, so
    // a rejected one never appears in a mailbox. Its raw blob is already on disk —
    // the SMTP path streams it there as it arrives — and is reclaimed by the next
    // pass of blob GC, which keeps only what a row still points at.
    //
    // Scanning happens after parsing because that is where the attachments are, and
    // before the insert because a message that is not approved is not delivered.
    if (this.#scanner) {
      await this.#scanner.check({
        attachments: parsed.attachments,
        from: parsed.fromAddr,
        recipients: recipients.map((r) => r.address),
        origin,
        subject: parsed.subject,
      });
    }

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
      },
      recipients,
      storedAttachments,
    );

    const summary = {
      id,
      from: parsed.fromAddr,
      subject: parsed.subject,
      addresses: [...new Set([...recipients.map((r) => r.address), parsed.fromAddr].filter(Boolean))],
    };

    // Drives the live inbox: the web layer forwards these over SSE to whoever is
    // looking at one of the affected mailboxes.
    this.emit('message', summary);
    return summary;
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
