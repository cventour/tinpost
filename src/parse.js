import { simpleParser } from 'mailparser';
import { normaliseAddress } from './db.js';

/**
 * Turn a raw RFC822 buffer into the shape delivery.js stores. Everything large
 * (HTML part, attachment content) comes back as a Buffer here and is handed
 * straight to the blob store by the caller — nothing large reaches SQLite.
 */
export async function parseMessage(raw) {
  const parsed = await simpleParser(raw, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipHtmlToText: false,
  });

  const from = firstAddress(parsed.from);
  const to = addressList(parsed.to, 'to');
  const cc = addressList(parsed.cc, 'cc');
  const bcc = addressList(parsed.bcc, 'bcc');

  const attachments = (parsed.attachments ?? []).map((a) => ({
    filename: safeFilename(a.filename, a.contentType),
    contentType: a.contentType || 'application/octet-stream',
    content: a.content,
    size: a.size ?? a.content?.length ?? 0,
    contentId: stripAngles(a.cid || a.contentId),
    // Only treat a part as inline when it is both flagged inline and has a cid to
    // reference it by; otherwise it is a normal attachment the reader should see.
    isInline: a.contentDisposition === 'inline' && !!(a.cid || a.contentId),
  }));

  return {
    messageId: stripAngles(parsed.messageId),
    fromAddr: from.address,
    fromName: from.name,
    subject: parsed.subject ?? '',
    date: parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf()) ? parsed.date : null,
    bodyText: parsed.text ?? null,
    html: typeof parsed.html === 'string' && parsed.html.length ? parsed.html : null,
    inReplyTo: stripAngles(parsed.inReplyTo),
    references: normaliseReferences(parsed.references),
    recipients: [...to, ...cc, ...bcc],
    attachments,
    headerLines: (parsed.headerLines ?? []).map((h) => h.line),
  };
}

function firstAddress(node) {
  const v = node?.value?.[0];
  return {
    address: normaliseAddress(v?.address || ''),
    name: v?.name || null,
  };
}

function addressList(node, kind) {
  const out = [];
  for (const v of node?.value ?? []) {
    const address = normaliseAddress(v?.address || '');
    if (!address) continue; // group syntax and undisclosed-recipients produce empty entries
    out.push({ address, name: v.name || null, kind });
  }
  return out;
}

function stripAngles(value) {
  if (!value) return null;
  const s = String(value).trim();
  return s.replace(/^<|>$/g, '') || null;
}

function normaliseReferences(refs) {
  if (!refs) return null;
  const list = Array.isArray(refs) ? refs : [refs];
  const cleaned = list.map((r) => stripAngles(r)).filter(Boolean);
  return cleaned.length ? cleaned.join(' ') : null;
}

/**
 * Attachment names are attacker-chosen. Blobs are stored under hashes so the name
 * never touches a path, but it is still displayed and sent in a download header,
 * so strip anything that could be used for traversal or header injection.
 */
export function safeFilename(name, contentType) {
  const fallback = extensionFor(contentType);
  let n = String(name ?? '').replace(/[\r\n\t\0]/g, '').trim();
  n = n.split(/[\\/]/).pop() ?? '';
  n = n.replace(/^\.+/, '');
  if (!n) return `attachment${fallback}`;
  return n.slice(0, 200);
}

function extensionFor(contentType) {
  const map = {
    'text/plain': '.txt',
    'text/html': '.html',
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'application/zip': '.zip',
  };
  return map[String(contentType ?? '').toLowerCase()] ?? '.bin';
}

/**
 * A stable key for grouping a conversation: the subject with any reply/forward
 * prefixes removed. Good enough for a lab, and independent of client quirks.
 */
export function threadKeyFor(subject) {
  const s = String(subject ?? '')
    .replace(/^\s*((re|fw|fwd|aw|sv|vs|antwort|rif)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return s || '(no subject)';
}

/** Plain-text fallback when a message carries only an HTML part. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  - ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}
