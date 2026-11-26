/**
 * Inspect: breaks one stored message down the way an analyst would triage it.
 * Sender, Route, Links and Attachments, each with findings.
 *
 * THIS MODULE MUST STAY OFFLINE. It is a set of pure functions over bytes the caller
 * hands in: it performs no I/O, no DNS lookup, no HTTP request, no reputation or
 * threat-intelligence query, and it never renders or loads the HTML it reads. Do not
 * import node:net, node:dns, node:http(s), node:tls, node:dgram or nodemailer here;
 * a test reads this file and fails if any of them appears.
 *
 * Every string that comes out of a message is made printable first (control and
 * bidirectional-override characters become visible [U+XXXX] markers) and capped in
 * length. The caller renders them with escaping and never as HTML.
 *
 * The checks are heuristics meant for training. They are not a verdict.
 */
import { domainToASCII, domainToUnicode } from 'node:url';

const MAX_HEADER_BYTES = 256 * 1024;
const MAX_HEADERS = 5000;
const MAX_HOPS = 200;
const MAX_LINKS = 500;
const MAX_HTML_CHARS = 8 * 1024 * 1024;
const MAX_TAG_CHARS = 128 * 1024;
const MAX_SCAN_BUDGET = 20_000_000;
const MAX_ATTACHMENTS = 100;
const SHOW_MAX = 2000;

// ---------------------------------------------------------------- text helpers

/** Characters that hide or reorder text; made visible as [U+XXXX] wherever a message value is shown. */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;
const BIDI_RE = /[\u061c\u202a-\u202e\u2066-\u2069]/;
const HIDDEN_RE = /[\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Printable, bounded version of anything that came out of a message. */
export function vis(value, max = SHOW_MAX) {
  let s = String(value ?? '');
  const over = s.length > max;
  if (over) s = s.slice(0, max);
  s = s.replace(INVISIBLE_RE, (c) =>
    `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`,
  );
  return over ? `${s}... (${String(value).length} characters in all)` : s;
}

const finding = (severity, code, text) => ({ severity, code, text });

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const map = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t',
      newline: '\n', sol: '/', lpar: '(', rpar: ')', period: '.', commat: '@',
    };
    return map[e.toLowerCase()] ?? m;
  });
}

/** RFC 2047 encoded words, enough to read a display name. Never throws. */
function decodeWords(s) {
  return s.replace(/=\?([\w-]{1,40})\?([bq])\?([^?]{0,2000})\?=/gi, (m, cs, enc, text) => {
    try {
      let bytes;
      if (enc.toLowerCase() === 'b') bytes = Buffer.from(text, 'base64');
      else {
        const t = text.replace(/_/g, ' ');
        bytes = Buffer.from(t.replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      }
      return new TextDecoder(cs.toLowerCase() === 'us-ascii' ? 'utf-8' : cs, { fatal: false }).decode(bytes);
    } catch {
      return m;
    }
  });
}

// --------------------------------------------------------------------- headers

/** Header section of a raw message as [{name, value}], unfolded. Tolerates junk. */
export function parseHeaders(raw) {
  const buf = Buffer.isBuffer(raw) ? raw.subarray(0, MAX_HEADER_BYTES) : Buffer.from(String(raw ?? ''));
  let text = buf.toString('utf8');
  const end = text.search(/\r?\n\r?\n/);
  if (end >= 0) text = text.slice(0, end);
  const headers = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && cur) {
      cur.value += ' ' + line.trim();
    } else {
      const i = line.indexOf(':');
      if (i > 0 && !/\s/.test(line.slice(0, i))) {
        if (headers.length >= MAX_HEADERS) break;
        cur = { name: line.slice(0, i).toLowerCase(), value: line.slice(i + 1).trim() };
        headers.push(cur);
      } else {
        cur = null;
      }
    }
  }
  return headers;
}

/** Addresses in a header value, as [{name, address}]. Deliberately forgiving. */
export function extractAddresses(value) {
  const out = [];
  // Whitespace is collapsed and the input capped first, so a run of spaces cannot make the scan slow.
  const s = decodeWords(String(value ?? '').replace(/\s+/g, ' ').slice(0, 1000));
  const re = /(?:"((?:[^"\\]|\\.){0,300})"|([^<>,;"]{0,300}?))\s*<([^<>\s]{1,300})>|([^\s<>,;"()]{1,300}@[^\s<>,;"()]{1,300})/g;
  let m;
  while ((m = re.exec(s)) && out.length < 50) {
    if (m[3] !== undefined) out.push({ name: (m[1] ?? m[2] ?? '').trim(), address: m[3].trim().toLowerCase() });
    else out.push({ name: '', address: m[4].trim().toLowerCase() });
  }
  return out;
}

const domainOfAddr = (a) => {
  const i = String(a ?? '').lastIndexOf('@');
  return i < 0 ? '' : a.slice(i + 1).trim().toLowerCase().replace(/\.$/, '');
};

// -------------------------------------------------------------- domain checks

const BRANDS = [
  'paypal', 'microsoft', 'google', 'apple', 'amazon', 'netflix', 'facebook', 'linkedin', 'dropbox',
  'docusign', 'outlook', 'office365', 'github', 'adobe', 'fedex', 'instagram', 'whatsapp', 'twitter',
  'wellsfargo', 'citibank', 'barclays', 'santander', 'ebay', 'spotify', 'yahoo', 'icloud', 'binance',
  'coinbase', 'wikipedia', 'chase', 'hsbc', 'mastercard', 'steam',
];
const LEET = { 0: 'o', 1: 'l', 3: 'e', 5: 's' };

const SCRIPTS = [
  ['Latin', /\p{Script=Latin}/u], ['Cyrillic', /\p{Script=Cyrillic}/u], ['Greek', /\p{Script=Greek}/u],
  ['Armenian', /\p{Script=Armenian}/u], ['Hebrew', /\p{Script=Hebrew}/u], ['Arabic', /\p{Script=Arabic}/u],
  ['Thai', /\p{Script=Thai}/u], ['Devanagari', /\p{Script=Devanagari}/u],
  ['CJK', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
];

/** Scripts used by a (decoded) label, with Japanese, Chinese and Korean counted as one. */
function scriptsIn(label) {
  return SCRIPTS.filter(([, re]) => re.test(label)).map(([name]) => name);
}

/** Findings about a host name: punycode, mixed scripts, digits standing in for letters. */
export function domainFindings(domain, { where = 'domain' } = {}) {
  const out = [];
  const d = String(domain ?? '').toLowerCase().replace(/\.$/, '');
  if (!d || d.length > 1000) return out;

  const labels = d.split('.');
  let unicode = d;
  if (labels.some((l) => l.startsWith('xn--'))) {
    let decoded = '';
    try {
      decoded = domainToUnicode(d);
    } catch {
      decoded = '';
    }
    if (decoded) {
      unicode = decoded;
      out.push(finding('notice', 'punycode', `The ${where} ${vis(d)} is punycode and reads ${vis(decoded)}.`));
    } else {
      out.push(finding('notice', 'punycode', `The ${where} ${vis(d)} uses punycode that does not decode.`));
    }
  }

  for (const label of unicode.split('.')) {
    const scripts = scriptsIn(label);
    if (scripts.length > 1) {
      out.push(finding('notice', 'mixed_script', `A label of the ${where} mixes scripts (${scripts.join(' and ')}): ${vis(label)}.`));
      break;
    }
  }

  const ascii = labels.filter((l) => /^[a-z0-9-]+$/.test(l) && !l.startsWith('xn--'));
  for (const label of ascii) {
    const swapped = label.replace(/[0135]/g, (c) => LEET[c]);
    const variants = [swapped, swapped.replace(/rn/g, 'm').replace(/vv/g, 'w')];
    const brand = BRANDS.find((b) => !label.includes(b) && variants.some((v) => v !== label && v.includes(b)));
    const inner = /[a-z][0135]+[a-z]/.test(label) && /[a-z]{3}/.test(label);
    if (brand) {
      out.push(finding('notice', 'lookalike', `The ${where} label ${vis(label)} looks like "${brand}" with digits or letters swapped.`));
      break;
    }
    if (inner) {
      out.push(finding('notice', 'lookalike', `The ${where} label ${vis(label)} has digits in the middle of a word, a common way to imitate a name.`));
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------- sender

function buildSender(headers, { fromAddr, fromName }) {
  const rows = [];
  const fromDomain = domainOfAddr(fromAddr);

  const fromF = [];
  if (fromAddr) fromF.push(...domainFindings(fromDomain, { where: 'sender domain' }));
  const name = String(fromName ?? '').replace(/\s+/g, ' ').slice(0, 1000);
  const nameAddrs = extractAddresses(name).filter((a) => a.address.includes('@'));
  const bare = /[^\s<>"@]{1,64}@[^\s<>"@]{1,64}/.exec(name);
  const inName = nameAddrs[0]?.address ?? bare?.[0]?.toLowerCase();
  if (inName && inName !== fromAddr) {
    fromF.push(
      finding('high', 'display_name_address', `The display name contains the address ${vis(inName)}, which is not the real sender address.`),
    );
  }
  rows.push({
    field: 'From',
    value: fromAddr ? `${fromName ? vis(fromName, 300) + ' ' : ''}<${vis(fromAddr, 300)}>` : '(no From address)',
    findings: fromAddr ? fromF : [finding('info', 'no_from', 'The message has no usable From address.')],
  });

  const rt = headers.find((h) => h.name === 'reply-to');
  if (rt) {
    const addrs = extractAddresses(rt.value);
    const f = [];
    let subdomain = null;
    let other = null;
    for (const a of addrs) {
      const dom = domainOfAddr(a.address);
      if (!fromDomain || !dom || dom === fromDomain) continue;
      // Labels are compared exactly: corp.test and evilcorp.test are not a subdomain pair.
      if (dom.endsWith('.' + fromDomain) || fromDomain.endsWith('.' + dom)) subdomain ??= dom;
      else other ??= dom;
    }
    if (other) {
      f.push(finding('high', 'reply_to_mismatch', `Replies go to ${vis(other)}, not to the sender's own domain ${vis(fromDomain)}.`));
    } else if (subdomain) {
      f.push(finding('notice', 'reply_to_subdomain', `Replies go to ${vis(subdomain)}, a subdomain relation of the sender's domain ${vis(fromDomain)}.`));
    }
    if (!f.length && addrs.some((a) => a.address !== fromAddr)) {
      f.push(finding('info', 'reply_to_other_mailbox', 'Replies go to a different mailbox on the same domain.'));
    }
    if (!addrs.length) f.push(finding('info', 'reply_to_unreadable', 'The Reply-To header holds no readable address.'));
    for (const a of addrs) f.push(...domainFindings(domainOfAddr(a.address), { where: 'Reply-To domain' }));
    rows.push({ field: 'Reply-To', value: vis(rt.value, 400), findings: f });
  } else {
    rows.push({ field: 'Reply-To', value: '(not set)', findings: [] });
  }

  const rp = headers.find((h) => h.name === 'return-path');
  if (rp) {
    const addrs = extractAddresses(rp.value);
    const addr = addrs[0]?.address ?? '';
    const f = [];
    if (!addr) {
      f.push(finding('info', 'return_path_empty', 'The Return-Path is empty, which is normal for a bounce but unusual for a first-hand message.'));
    } else if (addr !== fromAddr) {
      const sameDomain = domainOfAddr(addr) === fromDomain;
      f.push(
        finding(
          'notice',
          'return_path_mismatch',
          sameDomain
            ? 'The Return-Path is a different mailbox from the From address, on the same domain.'
            : `The Return-Path domain ${vis(domainOfAddr(addr))} differs from the From domain ${vis(fromDomain)}.`,
        ),
      );
      f.push(...domainFindings(domainOfAddr(addr), { where: 'Return-Path domain' }));
    }
    rows.push({ field: 'Envelope sender (Return-Path)', value: vis(rp.value, 400) || '(empty)', findings: f });
  } else {
    rows.push({
      field: 'Envelope sender',
      value: 'not recorded',
      findings: [
        finding('info', 'envelope_not_recorded', 'Tinpost does not keep the SMTP MAIL FROM, and this message carries no Return-Path header.'),
      ],
    });
  }
  return rows;
}

// ----------------------------------------------------------------------- route

const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export function fmtDelay(sec) {
  const s = Math.abs(sec);
  const sign = sec < 0 ? '-' : '';
  if (s < 60) return `${sign}${s}s`;
  if (s < 3600) return `${sign}${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${sign}${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${sign}${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function parseReceived(value) {
  const v = String(value ?? '').slice(0, 2000);
  const semi = v.lastIndexOf(';');
  const dateText = (semi >= 0 ? v.slice(semi + 1) : '').replace(/\([^)]{0,200}\)/g, '').trim();
  const main = semi >= 0 ? v.slice(0, semi) : v;
  const lower = main.toLowerCase();
  const iFrom = lower.indexOf('from ');
  const iBy = lower.indexOf(' by ');
  const fromClause = iFrom >= 0 ? main.slice(iFrom + 5, iBy > iFrom ? iBy : undefined).trim() : '';
  const byClause = iBy >= 0 ? main.slice(iBy + 4).trim() : lower.startsWith('by ') ? main.slice(3).trim() : '';
  const byHost = byClause.split(/\s+/)[0] ?? '';
  const withM = /\bwith\s+([A-Za-z0-9-]{1,30})/i.exec(main);
  const ips = [];
  const ipRe = /\[(?:ipv6:)?(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]{2,45})\]/gi;
  let m;
  while ((m = ipRe.exec(fromClause)) && ips.length < 4) ips.push(m[1].toLowerCase());
  const t = dateText ? Date.parse(dateText) : NaN;
  const fromHost = fromClause.split(/\s+/)[0] ?? '';
  return {
    from: fromClause,
    fromHost: fromHost.replace(/^\[|\]$/g, ''),
    by: byHost,
    with: withM?.[1] ?? '',
    ips,
    time: Number.isNaN(t) ? null : t,
    parsed: !!(fromClause || byHost),
  };
}

function buildRoute(headers, { message, events }) {
  const notes = [];
  const received = headers.filter((h) => h.name === 'received');
  let list = received;
  if (received.length > MAX_HOPS) {
    list = received.slice(0, MAX_HOPS);
    notes.push(`Route: the message has ${received.length} Received headers; only the ${MAX_HOPS} most recent were analysed.`);
  }

  // Header order is newest first; the table reads oldest to newest.
  const hops = list
    .map((h) => {
      const r = parseReceived(h.value);
      const f = [];
      if (!r.parsed) f.push(finding('info', 'received_unreadable', 'This Received header could not be read.'));
      return {
        from: vis(r.from || '(unknown)', 400),
        by: vis(r.by || '(unknown)', 300),
        with: vis(r.with, 40),
        time: r.time,
        source: 'header',
        ips: r.ips,
        hosts: [r.fromHost, r.by],
        findings: f,
      };
    })
    .reverse();

  const evs = (events ?? []).slice(0, 20);
  const stamp = headers.find((h) => h.name === 'x-tinpost-relayed');
  const relayInEvents = evs.some((e) => e.relay === 'outbound' || e.relay === 'inbound' || e.relay === 'upstream');

  if (stamp && !relayInEvents) {
    const semi = stamp.value.indexOf(';');
    const t = semi >= 0 ? Date.parse(stamp.value.slice(semi + 1).trim()) : NaN;
    const hop = {
      from: 'Tinpost',
      by: `upstream relay (stamped by ${vis(semi >= 0 ? stamp.value.slice(0, semi) : stamp.value, 100)})`,
      with: '',
      time: Number.isNaN(t) ? null : t,
      source: 'header',
      ips: [],
      hosts: [],
      findings: [finding('info', 'tinpost_relay_stamp', 'Tinpost handed this message to the upstream relay (X-Tinpost-Relayed header).')],
    };
    let at = hops.length;
    if (hop.time !== null) {
      const i = hops.findIndex((h) => h.time !== null && h.time > hop.time);
      if (i >= 0) at = i;
    }
    hops.splice(at, 0, hop);
  }

  const record = (hop) => hops.push({ with: '', ips: [], hosts: [], findings: [], source: 'tinpost record', ...hop });
  if (evs.length) {
    for (const e of evs) {
      const t = e.at ? Date.parse(e.at) : NaN;
      const time = Number.isNaN(t) ? null : t;
      if (e.via === 'webmail') {
        record({
          from: 'Tinpost webmail (composed here)',
          by: 'Tinpost',
          time,
          findings: [finding('info', 'webmail_origin', 'Sent from the webmail: there is no inbound SMTP hop for this message.')],
        });
      } else if (e.via === 'gateway') {
        record({
          from: `upstream gateway${e.source_ip ? ' ' + vis(e.source_ip, 80) : ''}`,
          by: 'Tinpost',
          with: 'SMTP',
          time,
          ips: e.source_ip ? [String(e.source_ip)] : [],
          findings: [finding('info', 'returned_from_relay', 'Scanned by the upstream gateway and sent back to Tinpost.')],
        });
      } else {
        record({
          from: e.source_ip ? vis(e.source_ip, 80) : '(source address not recorded)',
          by: 'Tinpost',
          with: 'SMTP',
          time,
          ips: e.source_ip ? [String(e.source_ip)] : [],
        });
      }
      if (e.relay === 'outbound' || e.relay === 'inbound' || e.relay === 'upstream') {
        record({
          from: 'Tinpost',
          by: 'upstream relay',
          time,
          findings: [
            finding(
              'info',
              'to_upstream_relay',
              `Handed to the upstream relay${e.relay === 'upstream' ? '' : ` (${e.relay})`}${e.response ? ': ' + vis(e.response, 300) : '.'}`,
            ),
          ],
        });
      }
    }
  } else if (message) {
    // received_at is Tinpost's own clock; date_utc is whatever the sender wrote.
    const t = message.received_at ? Date.parse(message.received_at) : NaN;
    const time = Number.isNaN(t) ? null : t;
    if (message.origin === 'webmail') {
      record({
        from: 'Tinpost webmail (composed here)',
        by: 'Tinpost',
        time,
        findings: [finding('info', 'webmail_origin', 'Sent from the webmail: there is no inbound SMTP hop for this message.')],
      });
    } else {
      record({ from: '(source address not recorded)', by: 'Tinpost', with: 'SMTP', time });
    }
  }
  if (message?.relay_status === 'failed') {
    record({
      from: 'Tinpost',
      by: 'upstream relay',
      time: null,
      findings: [finding('info', 'relay_failed', `The upstream relay could not take it; delivered unscanned. ${vis(message.relay_detail ?? '', 300)}`.trim())],
    });
  } else if (message?.relay_status === 'relayed' && !evs.some((e) => e.relay) && !stamp) {
    record({
      from: 'Tinpost',
      by: 'upstream relay',
      time: null,
      findings: [finding('info', 'to_upstream_relay', 'Handed to the upstream relay and awaiting its return.')],
    });
  }

  let prev = null;
  const rows = hops.map((h, i) => {
    const row = {
      n: i + 1,
      from: h.from,
      by: h.by,
      with: h.with,
      time: h.time === null ? null : fmtTime(h.time),
      delaySeconds: null,
      delay: null,
      source: h.source,
      findings: h.findings,
    };
    if (h.time !== null && prev !== null) {
      row.delaySeconds = Math.round((h.time - prev) / 1000);
      row.delay = fmtDelay(row.delaySeconds);
      if (row.delaySeconds < 0) {
        row.findings = [
          ...row.findings,
          finding('notice', 'time_backwards', `This hop is stamped ${fmtDelay(-row.delaySeconds)} before the one above it: clock skew, or headers out of order.`),
        ];
      }
    }
    if (h.time !== null) prev = h.time;
    return row;
  });
  return { rows, notes, hops };
}

// ----------------------------------------------------------------------- links

const COMMON_TLDS = new Set(
  'com net org edu gov mil int info biz io co app dev xyz online site top club shop live cloud ai me tv us uk de fr nl ru cn jp br in it es se no ch pl'.split(' '),
);
const TEXT_HOST_RE =
  /^(?:(?:https?|ftp):\/\/)?((?:[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?\.)+[a-z\u00a1-\uffff]{2,24})(?::\d{1,5})?(?:[/?#]\S{0,200})?$/i;
const TEXT_MAIL_RE = /^([^\s@<>]{1,64})@((?:[a-z0-9-]{1,63}\.)+[a-z]{2,24})$/i;

/** The host a piece of link text claims to point at, or null when it does not look like one. */
function shownHost(text) {
  const t = String(text ?? '').trim().slice(0, 300);
  const mail = TEXT_MAIL_RE.exec(t);
  if (mail) return mail[2].toLowerCase();
  const m = TEXT_HOST_RE.exec(t);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const tld = host.slice(host.lastIndexOf('.') + 1);
  const hasScheme = /^[a-z]+:\/\//i.test(t);
  if (hasScheme || host.startsWith('www.') || tld.length === 2 || COMMON_TLDS.has(tld) || tld.startsWith('xn--')) return host;
  return null;
}

const normHost = (h) => {
  const a = domainToASCII(String(h).toLowerCase().replace(/\.$/, '')) || String(h).toLowerCase();
  return a.replace(/^www\./, '');
};

function ipLike(host) {
  if (host.startsWith('[')) return true;
  const parts = host.split('.');
  return parts.length <= 4 && parts.every((p) => /^(0x[0-9a-f]*|\d+)$/i.test(p));
}

/** Pull the first href out of an opening tag's attribute text. */
function hrefOf(tag) {
  let i = 0;
  const n = tag.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(tag[i])) i++;
    const start = i;
    while (i < n && !/[\s=/>]/.test(tag[i])) i++;
    const name = tag.slice(start, i).toLowerCase();
    while (i < n && /\s/.test(tag[i])) i++;
    let value = null;
    if (tag[i] === '=') {
      i++;
      while (i < n && /\s/.test(tag[i])) i++;
      if (tag[i] === '"' || tag[i] === "'") {
        const q = tag[i];
        const close = tag.indexOf(q, i + 1);
        value = tag.slice(i + 1, close < 0 ? n : close);
        i = close < 0 ? n : close + 1;
      } else {
        const s = i;
        while (i < n && !/\s/.test(tag[i])) i++;
        value = tag.slice(s, i);
      }
    }
    if (name === 'href' && value !== null) return value;
    if (i === start) i++;
  }
  return null;
}

/** Remove <...> runs from a short window in one linear pass; a '<' with no nearby '>' is kept as text. */
function stripTags(inner) {
  const n = inner.length;
  const nextGt = new Int32Array(n + 1);
  nextGt[n] = -1;
  for (let k = n - 1; k >= 0; k--) nextGt[k] = inner.charCodeAt(k) === 62 ? k : nextGt[k + 1];
  let out = '';
  let k = 0;
  while (k < n) {
    // Only '<' followed by a letter, '/', '!' or '?' starts a tag; "1 < 2" is text.
    if (inner.charCodeAt(k) === 60 && /[a-z/!?]/i.test(inner[k + 1] ?? '')) {
      const e = nextGt[k];
      if (e >= 0 && e - k <= 500) {
        k = e + 1;
        continue;
      }
    }
    out += inner[k++];
  }
  return out;
}

/** Every <a href> and <area href> in a stored HTML part. A scanner; nothing is rendered. */
export function extractLinks(html, { max = MAX_LINKS } = {}) {
  const src = String(html ?? '').slice(0, MAX_HTML_CHARS);
  const out = [];
  let truncated = false;
  let i = 0;
  let scanned = 0;
  while (i < src.length && scanned < MAX_SCAN_BUDGET) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const c = src[lt + 1];
    let nameLen = 0;
    if ((c === 'a' || c === 'A') && /[\s/>]/.test(src[lt + 2] ?? '')) nameLen = 1;
    else if (src.slice(lt + 1, lt + 5).toLowerCase() === 'area' && /[\s/>]/.test(src[lt + 5] ?? '')) nameLen = 4;
    if (!nameLen) {
      i = lt + 1;
      continue;
    }
    // End of tag: first '>' outside quotes, within a sane bound.
    let j = lt + 1 + nameLen;
    let q = null;
    const limit = Math.min(src.length, lt + MAX_TAG_CHARS);
    while (j < limit) {
      const ch = src[j];
      if (q) {
        if (ch === q) q = null;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') break;
      j++;
    }
    scanned += j - lt;
    if (j >= limit) {
      // No end to this tag within reach. Skip past what was scanned instead of
      // rescanning it from the next '<a', which would make a run of them quadratic.
      i = limit;
      continue;
    }
    const href = hrefOf(src.slice(lt + 1 + nameLen, j));
    i = j + 1;
    if (href === null) continue;
    if (out.length >= max) {
      truncated = true;
      break;
    }
    let text = '';
    if (nameLen === 1) {
      const win = src.slice(i, i + 3000);
      const close = win.toLowerCase().indexOf('</a');
      const inner = close < 0 ? win : win.slice(0, close);
      text = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!text && /<img\b/i.test(inner)) text = '[image]';
    }
    out.push({ rawHref: href, text });
  }
  return { links: out, truncated };
}

/** Make a raw href into what a browser would act on: entities, stray whitespace. */
function cleanHref(raw) {
  return decodeEntities(String(raw))
    .replace(/[\t\n\r]/g, '')
    .replace(/^[\u0000- ]+/, '')
    .replace(/[\u0000- ]+$/, '');
}

export function classifyLink(rawHref, text) {
  const findings = [];
  const href = cleanHref(rawHref);
  const row = { text: vis(text, 300), target: vis(href), host: '', kind: 'other', findings };
  const ioc = { url: null, domain: null, ip: null };
  const sm = /^([a-z][a-z0-9+.-]{0,30}):/i.exec(href.slice(0, 40));
  let scheme = sm ? sm[1].toLowerCase() : '';
  // A leading // is whatever scheme the page used; treat it as a web link for host checks.
  const protoRelative = !scheme && href.startsWith('//');
  if (protoRelative) scheme = 'https';

  if (scheme === 'javascript' || scheme === 'vbscript') {
    row.kind = 'script';
    findings.push(finding('high', 'script_url', `The link runs script (${scheme}:) instead of going to a web address.`));
    return { row, ioc };
  }
  if (scheme === 'data') {
    row.kind = 'data';
    findings.push(finding('high', 'data_url', 'The link carries its content inline (data:) instead of going to a web address.'));
    return { row, ioc };
  }

  let host = '';
  if (scheme === 'mailto') {
    row.kind = 'mailto';
    let addr = href.slice(7).split('?')[0];
    try {
      addr = decodeURIComponent(addr);
    } catch {
      /* keep as is */
    }
    host = domainOfAddr(addr.split(',')[0]);
    row.target = vis(`mailto:${addr}`);
  } else if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') {
    row.kind = 'web';
    const rest = (protoRelative ? href : href.slice(scheme.length + 1)).replace(/\\/g, '/');
    if (rest.startsWith('//')) {
      const authority = rest.slice(2).split(/[/?#]/, 1)[0];
      const at = authority.lastIndexOf('@');
      const hostport = at >= 0 ? authority.slice(at + 1) : authority;
      host = (hostport.startsWith('[') ? hostport.slice(0, hostport.indexOf(']') + 1) : hostport.replace(/:\d*$/, '')).toLowerCase();
      if (at >= 0) {
        findings.push(finding('notice', 'userinfo', `The address has "${vis(authority.slice(0, at), 60)}@" in front of the real host ${vis(host, 100)}; only what follows the @ is where it goes.`));
      }
      if (scheme === 'http') findings.push(finding('notice', 'insecure', 'The link is plain http, not https.'));
      if (ipLike(host)) {
        let norm = '';
        try {
          norm = new URL(`http://${host}/`).hostname;
        } catch {
          norm = '';
        }
        findings.push(
          finding('notice', 'ip_host', `The link goes to an IP address, not a name (${vis(host, 100)}${norm && norm !== host ? ', which is ' + vis(norm, 100) : ''}).`),
        );
        ioc.ip = norm || host;
      } else {
        findings.push(...domainFindings(host, { where: 'link host' }));
        ioc.domain = host;
      }
      ioc.url = href.length <= 4096 ? (protoRelative ? `https:${href}` : href) : null;
    }
  } else if (scheme) {
    findings.push(finding('info', 'other_scheme', `The link uses the ${vis(scheme, 30)}: scheme.`));
  }

  row.host = vis(host, 300);
  if (host && !ipLike(host)) {
    try {
      const uni = domainToUnicode(host);
      if (uni && uni !== host) row.hostDecoded = vis(uni, 300);
    } catch {
      /* none */
    }
  }

  const claimed = shownHost(text);
  if (claimed && host && !ipLike(host) && normHost(claimed) !== normHost(host)) {
    findings.push(finding('high', 'link_mismatch', `The text suggests ${vis(claimed, 200)} but the link goes to ${vis(host, 200)}.`));
  } else if (claimed && host && ipLike(host)) {
    findings.push(finding('high', 'link_mismatch', `The text suggests ${vis(claimed, 200)} but the link goes to an IP address.`));
  }
  return { row, ioc };
}

function buildLinks(html) {
  if (!html) return { rows: [], notes: [], iocs: [] };
  const { links, truncated } = extractLinks(html);
  const notes = truncated ? [`Links: only the first ${MAX_LINKS} links were analysed; the message has more.`] : [];
  const rows = [];
  const iocs = [];
  for (const l of links) {
    const { row, ioc } = classifyLink(l.rawHref, l.text);
    rows.push(row);
    iocs.push(ioc);
  }
  return { rows, notes, iocs };
}

// ----------------------------------------------------------------- attachments

const EXEC_CATS = new Set(['pe', 'elf', 'macho', 'script']);
const EXEC_EXT = new Set('exe dll scr com sys cpl ocx msi bat cmd js jse vbs vbe wsf wsh ps1 hta jar lnk pif reg msc sh'.split(' '));
const RISKY_NAME_EXT = new Set('exe scr com bat cmd ps1 vbs vbe js jse wsf hta lnk msi'.split(' '));
const DOC_EXT = new Set('pdf doc docx xls xlsx ppt pptx txt rtf csv jpg jpeg png gif zip rar 7z odt ods html htm'.split(' '));
const MACRO_EXT = new Set('docm xlsm pptm dotm xlam xlsb ppam potm sldm'.split(' '));

const OFFICE = ['ooxml', 'zip'];
const EXT_EXPECT = {
  pdf: ['pdf'], png: ['png'], jpg: ['jpeg'], jpeg: ['jpeg'], gif: ['gif'],
  zip: ['zip', 'ooxml', 'odf', 'jar', 'apk'],
  docx: OFFICE, xlsx: OFFICE, pptx: OFFICE, docm: OFFICE, xlsm: OFFICE, pptm: OFFICE, dotx: OFFICE, dotm: OFFICE, xlam: OFFICE,
  odt: ['odf', 'zip'], ods: ['odf', 'zip'], odp: ['odf', 'zip'], jar: ['jar', 'zip'], apk: ['apk', 'zip'],
  doc: ['ole2', 'ooxml', 'zip', 'rtf'], xls: ['ole2', 'ooxml', 'zip'], ppt: ['ole2', 'ooxml', 'zip'], msi: ['ole2'],
  rtf: ['rtf'], txt: ['text'], csv: ['text'], log: ['text'], md: ['text'], json: ['text'], xml: ['text'],
  html: ['text'], htm: ['text'], ics: ['text'], eml: ['text'],
  rar: ['rar'], '7z': ['7z'], gz: ['gzip'], tgz: ['gzip'],
  exe: ['pe'], dll: ['pe'], scr: ['pe'], com: ['pe'], sys: ['pe'], cpl: ['pe'], ocx: ['pe'],
  js: ['text', 'script'], vbs: ['text'], ps1: ['text'], bat: ['text'], cmd: ['text'], sh: ['script', 'text'],
};
const MIME_EXPECT = {
  'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpeg'], 'image/gif': ['gif'], 'text/plain': ['text'],
  'application/zip': ['zip', 'ooxml', 'odf', 'jar', 'apk'],
};
const LABEL = {
  pe: 'Windows executable (MZ/PE)', elf: 'ELF executable', macho: 'Mach-O executable or Java class', pdf: 'PDF document',
  zip: 'ZIP archive', ooxml: 'Office Open XML document (ZIP)', odf: 'OpenDocument file (ZIP)', jar: 'Java archive (ZIP)',
  apk: 'Android package (ZIP)', ole2: 'OLE2 compound file (legacy Office, MSI)', rar: 'RAR archive', '7z': '7-Zip archive',
  gzip: 'gzip data', png: 'PNG image', jpeg: 'JPEG image', gif: 'GIF image', script: 'Script (#! shebang)', rtf: 'RTF document',
  text: 'Plain text', empty: 'Empty file', unknown: 'Unknown binary',
};

function zipEntries(buf) {
  const names = [];
  const encrypted = { local: false, central: false };
  let pos = 0;
  while (names.length < 5000) {
    const i = buf.indexOf('PK\x03\x04', pos, 'latin1');
    if (i < 0 || i + 30 > buf.length) break;
    const len = buf.readUInt16LE(i + 26);
    if (buf.readUInt16LE(i + 6) & 1) encrypted.local = true;
    if (i + 30 + len <= buf.length) names.push(buf.toString('utf8', i + 30, i + 30 + len));
    pos = i + 4;
  }
  pos = 0;
  while (names.length < 10000) {
    const i = buf.indexOf('PK\x01\x02', pos, 'latin1');
    if (i < 0 || i + 46 > buf.length) break;
    const len = buf.readUInt16LE(i + 28);
    if (buf.readUInt16LE(i + 8) & 1) encrypted.central = true;
    if (i + 46 + len <= buf.length) names.push(buf.toString('utf8', i + 46, i + 46 + len));
    pos = i + 4;
  }
  return { names, encrypted: encrypted.local || encrypted.central };
}

/**
 * "MZ" alone is two letters that plain text can start with. A file counts as a Windows
 * executable when a PE signature sits where the DOS header says it should, or when the
 * bytes after "MZ" (up to 64) include a binary one. "MZ" followed only by readable
 * text, or nothing, is treated as text.
 */
function isDosExecutable(h) {
  if (h.length < 3 || h[0] !== 0x4d || h[1] !== 0x5a) return false;
  if (h.length >= 0x40) {
    const off = h.readUInt32LE(0x3c);
    if (off <= h.length - 4 && h.toString('latin1', off, off + 4) === 'PE\0\0') return true;
  }
  const n = Math.min(h.length, 64);
  for (let i = 2; i < n; i++) {
    const b = h[i];
    if (b < 9 || (b > 13 && b < 32) || b > 126) return true;
  }
  return false;
}

/** Sniff the real type from the first (and, for archives, last) bytes. */
export function detectType(head, tail = Buffer.alloc(0)) {
  const h = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
  const out = { cat: 'unknown', encrypted: false, macro: false, names: [] };
  const starts = (sig) => h.length >= sig.length && h.subarray(0, sig.length).equals(Buffer.from(sig, 'latin1'));
  if (!h.length) return { ...out, cat: 'empty' };
  if (isDosExecutable(h)) out.cat = 'pe';
  else if (starts('\x7fELF')) out.cat = 'elf';
  else if (['\xfe\xed\xfa\xce', '\xfe\xed\xfa\xcf', '\xce\xfa\xed\xfe', '\xcf\xfa\xed\xfe', '\xca\xfe\xba\xbe'].some(starts)) out.cat = 'macho';
  else if (starts('%PDF-')) out.cat = 'pdf';
  else if (starts('PK\x03\x04') || starts('PK\x05\x06')) {
    const { names, encrypted } = zipEntries(Buffer.concat([h, tail]));
    out.names = names;
    out.encrypted = encrypted;
    out.cat = 'zip';
    if (names.includes('[Content_Types].xml') || names.some((n) => /^(word|xl|ppt)\//.test(n))) out.cat = 'ooxml';
    else if (h.toString('latin1', 0, 200).includes('mimetype') && h.toString('latin1').includes('application/vnd.oasis.opendocument')) out.cat = 'odf';
    else if (names.includes('AndroidManifest.xml') && names.some((n) => n.endsWith('.dex'))) out.cat = 'apk';
    else if (names.includes('META-INF/MANIFEST.MF')) out.cat = 'jar';
    out.macro = names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n));
  } else if (starts('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')) out.cat = 'ole2';
  else if (starts('Rar!\x1a\x07')) {
    out.cat = 'rar';
    // RAR 4: the main header follows the 7-byte marker; flag 0x0080 means encrypted headers.
    if (h.length >= 12 && h[6] === 0x00 && h[9] === 0x73 && (h.readUInt16LE(10) & 0x0080)) out.encrypted = true;
    // RAR 5: an encryption header (type 4) first means the whole archive is encrypted.
    if (h.length >= 14 && h[6] === 0x01 && h[7] === 0x00) {
      let p = 12; // after marker (8) and CRC32 (4)
      const vint = () => {
        let v = 0;
        for (let s = 0; s < 28 && p < h.length; s += 7) {
          const b = h[p++];
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
        }
        return v;
      };
      vint();
      if (vint() === 4) out.encrypted = true;
    }
  } else if (starts('7z\xbc\xaf\x27\x1c')) out.cat = '7z';
  else if (starts('\x1f\x8b')) out.cat = 'gzip';
  else if (starts('\x89PNG')) out.cat = 'png';
  else if (starts('\xff\xd8\xff')) out.cat = 'jpeg';
  else if (starts('GIF87a') || starts('GIF89a')) out.cat = 'gif';
  else if (starts('#!')) out.cat = 'script';
  else if (starts('{\\rtf')) out.cat = 'rtf';
  else {
    let odd = 0;
    const n = Math.min(h.length, 4096);
    for (let i = 0; i < n; i++) {
      const b = h[i];
      if (b === 0 || (b < 9) || (b > 13 && b < 32)) odd++;
    }
    const bom = starts('\xff\xfe') || starts('\xfe\xff') || starts('\xef\xbb\xbf');
    out.cat = bom || odd / n < 0.02 ? 'text' : 'unknown';
  }
  return out;
}

/** Name as a person would see it, with markers for characters that can disguise it. */
function nameChecks(rawName) {
  const findings = [];
  const name = String(rawName ?? '');
  if (BIDI_RE.test(name)) {
    findings.push(finding('high', 'rtl_override', 'The file name contains a right-to-left override or similar control character, which can make the real extension read as something harmless.'));
  }
  // Drop invisible controls and collapse padding so "x.pdf      .exe" reads as it is.
  const plain = name.replace(HIDDEN_RE, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  const exts = plain.slice(-500).split('.').slice(1).map((e) => e.trim().toLowerCase());
  const last = exts[exts.length - 1] ?? '';
  const prev = exts[exts.length - 2] ?? '';
  if (DOC_EXT.has(prev) && (EXEC_EXT.has(last) || MACRO_EXT.has(last))) {
    findings.push(finding('high', 'double_extension', `The name ends in two extensions (.${prev}.${last}): it looks like a ${prev} document but is a .${last} file.`));
  } else if (/\.[a-z0-9]{1,8}\s{2,}\.[a-z0-9]{2,8}$/i.test(name.trim().replace(/[. ]+$/, ''))) {
    findings.push(finding('high', 'double_extension', 'The name has padding spaces between two extensions, which hides the real one.'));
  }
  return { findings, ext: last, plain };
}

function buildAttachment(a) {
  const findings = [];
  const det = detectType(a.head, a.tail);
  const nc = nameChecks(a.filename);
  findings.push(...nc.findings);
  const ext = nc.ext;
  const mime = String(a.contentType ?? '').toLowerCase().split(';')[0].trim();
  const expected = EXT_EXPECT[ext] ?? MIME_EXPECT[mime];

  const execDetected = EXEC_CATS.has(det.cat);
  let mismatched = false;
  if (expected && det.cat !== 'unknown' && det.cat !== 'empty' && !expected.includes(det.cat)) {
    mismatched = true;
    const sev = execDetected && !EXEC_EXT.has(ext) ? 'high' : 'notice';
    const claimed = EXT_EXPECT[ext] ? `.${vis(ext, 20)}` : `declared type ${vis(mime, 80)}`;
    findings.push(finding(sev, 'type_mismatch', `Type mismatch: the file is named or declared as ${claimed}, but its content is detected as: ${LABEL[det.cat]}.`));
  }
  // Executable content is high whatever the file is called, unless the mismatch finding
  // above has already said so. A few extensions are high on the name alone, even when
  // the content reads as text (scripts, shortcuts, installers).
  if (execDetected && !findings.some((f) => f.code === 'type_mismatch' && f.severity === 'high')) {
    findings.push(finding('high', 'executable', `The attachment is an executable (${LABEL[det.cat]}).`));
  } else if (!execDetected && RISKY_NAME_EXT.has(ext)) {
    findings.push(finding('high', 'executable_extension', `The .${vis(ext, 20)} extension is one that runs code or launches something when opened.`));
  }
  if (MACRO_EXT.has(ext) || det.macro) {
    if (det.macro && !MACRO_EXT.has(ext)) {
      findings.push(finding('high', 'hidden_macro', 'The file is named as a macro-free document but contains a VBA macro project (vbaProject.bin).'));
    } else {
      findings.push(finding('notice', 'macro_enabled', det.macro ? 'A macro-enabled Office file that contains a VBA macro project.' : 'A macro-enabled Office file type.'));
    }
  }
  if (det.encrypted) {
    findings.push(finding('notice', 'encrypted_archive', 'The archive is encrypted, so its contents cannot be inspected or scanned.'));
  }
  return {
    id: a.id,
    name: vis(a.filename, 300),
    inline: !!a.isInline,
    size: a.size,
    declared: vis(a.contentType || '(none)', 120),
    detected: LABEL[det.cat],
    detectedCode: det.cat,
    sha256: a.sha256,
    sha1: a.sha1 ?? null,
    md5: a.md5 ?? null,
    findings,
  };
}

// ------------------------------------------------------------------ top level

const uniq = (list) => [...new Set(list.filter(Boolean))];

/**
 * @param {object} input
 * @param {Buffer} input.rawHead   the start of the stored .eml (the header section is all that is read)
 * @param {{address:string,name:string|null}} input.from  header From, as stored
 * @param {string|null} input.html the stored HTML part
 * @param {Array} input.attachments rows: {id, filename, contentType, size, sha256, isInline, head, tail, sha1?, md5?}
 * @param {number} [input.attachmentsTotal] how many attachments the message has, when more than were passed
 * @param {string[]} [input.labDomains] domains this instance accepts mail for; kept out of the IOC list
 * @param {object} input.message   the messages row (origin, relay_status, relay_detail, date_utc)
 * @param {Array} input.events     the events rows for this message
 */
export function inspectMessage(input) {
  const notes = [];
  const safe = (label, fn, fallback) => {
    try {
      return fn();
    } catch {
      notes.push(`${label}: this section could not be analysed.`);
      return fallback;
    }
  };

  const headers = safe('Headers', () => parseHeaders(input.rawHead), []);
  const sender = safe('Sender', () => buildSender(headers, { fromAddr: input.from?.address ?? '', fromName: input.from?.name ?? '' }), []);
  const routeBuilt = safe('Route', () => buildRoute(headers, { message: input.message, events: input.events }), { rows: [], notes: [], hops: [] });
  const linksBuilt = safe('Links', () => buildLinks(input.html), { rows: [], notes: [], iocs: [] });
  let atts = input.attachments ?? [];
  const total = Math.max(input.attachmentsTotal ?? 0, atts.length);
  if (atts.length > MAX_ATTACHMENTS) atts = atts.slice(0, MAX_ATTACHMENTS);
  if (total > atts.length) notes.push(`Attachments: only the first ${atts.length} of ${total} were analysed.`);
  const attachments = safe('Attachments', () => atts.map(buildAttachment), []);
  notes.push(...routeBuilt.notes, ...linksBuilt.notes);

  const all = [...sender, ...routeBuilt.rows, ...linksBuilt.rows, ...attachments].flatMap((r) => r.findings);
  const summary = {
    high: all.filter((f) => f.severity === 'high').length,
    notice: all.filter((f) => f.severity === 'notice').length,
    hashed: attachments.length,
  };

  const looksIp = (s) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) || (/^[0-9a-f:]{2,45}$/.test(s) && s.includes(':'));
  const hopHosts = routeBuilt.hops.flatMap((h) => h.hosts ?? []).filter((h) => h && h !== '(unknown)' && !looksIp(h) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h));
  const domains = uniq([
    domainOfAddr(input.from?.address),
    ...headers.filter((h) => h.name === 'reply-to' || h.name === 'return-path').flatMap((h) => extractAddresses(h.value).map((a) => domainOfAddr(a.address))),
    ...linksBuilt.iocs.map((i) => i.domain),
    ...hopHosts.map((h) => h.toLowerCase()),
  ]).map((d) => vis(d, 300));
  const ips = uniq([...linksBuilt.iocs.map((i) => i.ip), ...routeBuilt.hops.flatMap((h) => h.ips ?? [])]);
  const urls = uniq(linksBuilt.iocs.map((i) => i.url));
  const hashes = uniq(attachments.flatMap((a) => [a.sha256, a.sha1, a.md5]));

  // Copy IOCs is for what an analyst would block or hunt for, so the lab's own
  // infrastructure is set aside: loopback addresses, *.lab.local and the domains this
  // instance is configured to accept. Route still shows every hop; the rest is kept in
  // iocsExcluded so nothing is hidden from the export.
  const own = (input.labDomains ?? []).map((d) => String(d).toLowerCase());
  const ownDomain = (d) => {
    const x = String(d).toLowerCase();
    return x === 'lab.local' || x.endsWith('.lab.local') || own.some((o) => o && (x === o || x.endsWith('.' + o)));
  };
  const ownIp = (a) => /^(?:::ffff:)?127\./i.test(a) || a === '::1' || /^0*:0*:0*:0*:0*:0*:0*:0*1$/.test(a);
  const urlHost = (u) => {
    try {
      return new URL(u).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return '';
    }
  };
  const split = (list, isOwn) => [list.filter((x) => !isOwn(x)), list.filter(isOwn)];
  const [domainsKept, domainsOut] = split(domains, ownDomain);
  const [ipsKept, ipsOut] = split(ips, ownIp);
  const [urlsKept, urlsOut] = split(urls, (u) => ownDomain(urlHost(u)) || ownIp(urlHost(u)));

  return {
    summary,
    notes,
    sender,
    route: routeBuilt.rows,
    links: linksBuilt.rows,
    attachments,
    iocs: { domains: domainsKept, urls: urlsKept, ips: ipsKept, hashes },
    iocsExcluded: { domains: domainsOut, urls: urlsOut, ips: ipsOut, hashes: [] },
  };
}

/** The IOC lists as the text Copy IOCs puts on the clipboard. */
export function iocsToText(iocs) {
  const groups = [
    ['Domains', iocs?.domains],
    ['URLs', iocs?.urls],
    ['IP addresses', iocs?.ips],
    ['Hashes', iocs?.hashes],
  ];
  return groups
    .filter(([, list]) => list?.length)
    .map(([title, list]) => `# ${title}\n${list.join('\n')}`)
    .join('\n\n');
}
