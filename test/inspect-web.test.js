import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { makeLab, eml } from './helpers.js';
import { createWebServer } from '../src/web/server.js';

const quiet = { info() {}, error() {} };
const asAlice = { cookie: 'mb_addr=alice@lab.local' };

async function withWeb(t, labOptions) {
  const lab = await makeLab(labOptions);
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet });
  t.after(async () => {
    await web.close();
    await lab.cleanup();
  });
  return { ...lab, app: web.app };
}

/** A multipart message: an HTML body plus any number of attachments. */
function multipart({ from = 'bob@corp.test', to = 'alice@lab.local', subject = 'Hello', extraHeaders = [], html = '<p>hi</p>', text = 'hi', attachments = [] }) {
  const b = 'BOUNDARY-inspect';
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, ...extraHeaders, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: multipart/alternative; boundary="ALT"', '',
    '--ALT', 'Content-Type: text/plain; charset=utf-8', '', text,
  ];
  if (html !== null) lines.push('--ALT', 'Content-Type: text/html; charset=utf-8', '', html);
  lines.push('--ALT--');
  for (const a of attachments) {
    lines.push(
      `--${b}`, `Content-Type: ${a.type ?? 'application/octet-stream'}`,
      a.dispo ?? `Content-Disposition: attachment; filename="${a.name}"`,
      'Content-Transfer-Encoding: base64', '',
      ...a.data.toString('base64').match(/.{1,76}/g),
    );
  }
  lines.push(`--${b}--`, '');
  return eml(lines);
}

async function seed(lab, opts = {}) {
  return lab.delivery.deliverRaw(multipart(opts), { envelopeRecipients: [opts.to ?? 'alice@lab.local'] });
}

const inspectView = (lab, id, headers = asAlice) => lab.app.inject({ url: `/mail/${id}?view=inspect`, headers });
const jsonOf = async (lab, id, headers = asAlice) => JSON.parse((await lab.app.inject({ url: `/mail/${id}/inspect.json`, headers })).body);
const badgeOf = (body) => {
  const m = /<span class="badge"[^>]*>(\d+)<\/span>/.exec(body);
  return m ? Number(m[1]) : 0;
};

const PHISH_HTML =
  '<p>Dear user</p><a href="http://evil.test/login">https://paypal.com/signin</a> ' +
  '<a href="https://192.168.4.7/x">open</a> <a href="https://xn--80ak6aa92e.com/">apple</a>';

// ------------------------------------------------------------- 1: every message

test('the Inspect tab appears on every kind of message, and the badge equals the high count', async (t) => {
  const lab = await withWeb(t);
  const mx = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
  const phish = await seed(lab, {
    subject: 'Phish',
    extraHeaders: ['Reply-To: help@evil.test', 'Return-Path: <bounce@mailer.test>'],
    html: PHISH_HTML,
    attachments: [{ name: 'Invoice.pdf', data: Buffer.from(mx) }, { name: 'x.pdf.exe', data: Buffer.from(mx) }],
  });
  const textOnly = await seed(lab, { subject: 'Plain', html: null });
  const noAtt = await seed(lab, { subject: 'No attachments' });
  const webmail = await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['bob@corp.test'], subject: 'From webmail', text: 'x' });

  for (const id of [phish.id, textOnly.id, noAtt.id]) {
    const res = await lab.app.inject({ url: `/mail/${id}`, headers: asAlice });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-view="inspect"/);
  }
  const sent = await lab.app.inject({ url: `/mail/${webmail.id}`, headers: asAlice });
  assert.equal(sent.statusCode, 200);
  assert.match(sent.body, /data-view="inspect"/);

  // Reply-To (high), link text mismatch (high), .pdf that is MZ (high), x.pdf.exe (double extension, high)
  const page = await lab.app.inject({ url: `/mail/${phish.id}`, headers: asAlice });
  const json = await jsonOf(lab, phish.id);
  assert.equal(json.summary.high, 4);
  assert.equal(badgeOf(page.body), json.summary.high);
  const tab = await inspectView(lab, phish.id);
  assert.equal(tab.statusCode, 200);
  assert.equal(badgeOf(tab.body), json.summary.high);
  assert.equal((tab.body.match(/class="tag sev-high"/g) ?? []).length, json.summary.high);
  assert.match(tab.body, new RegExp(`<b class="sev-count sev-high">${json.summary.high} high</b>`));
  assert.match(tab.body, /no network lookups made/);
  assert.match(tab.body, /Nothing is looked up online/);
  assert.match(tab.body, /Type mismatch/);
  assert.match(tab.body, /two extensions/);

  // The badge is the same with and without hashing: the cheap page and the full tab agree.
  const clean = await lab.app.inject({ url: `/mail/${noAtt.id}`, headers: asAlice });
  assert.equal(badgeOf(clean.body), 0);
  assert.equal((await jsonOf(lab, noAtt.id)).summary.high, 0);
});

test('a relayed message shows the relay in its route, with the source of each hop', async (t) => {
  const lab = await withWeb(t);
  const gw = new SMTPServer({
    disabledCommands: ['AUTH', 'STARTTLS'], authOptional: true, logger: false,
    onData(stream, session, cb) { stream.on('data', () => {}); stream.on('end', () => cb()); },
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => gw.close(r)));
  lab.db.setSetting('relay_enabled', '1');
  lab.db.setSetting('relay_host', '127.0.0.1');
  lab.db.setSetting('relay_port', String(gw.server.address().port));
  lab.db.setSetting('relay_local_domains', 'lab.local');

  const sent = await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['carol@partner.test'], subject: 'Out', text: 'x' }, { sourceIp: '::ffff:192.0.2.77' });
  const res = await inspectView(lab, sent.id);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /data-view="inspect"/);
  const json = await jsonOf(lab, sent.id);
  assert.ok(json.route.some((r) => r.source === 'tinpost record' && r.findings.some((f) => f.code === 'to_upstream_relay')));
  assert.ok(json.route.some((r) => r.findings.some((f) => f.code === 'webmail_origin')));
});

test('an SMTP-received message records its source address as the first Tinpost hop', async (t) => {
  const lab = await withWeb(t);
  const m = await lab.delivery.deliverRaw(multipart({ extraHeaders: ['Received: from mx.example.test (mx.example.test [198.51.100.7]) by mail.lab.local with ESMTP; Thu, 26 Nov 2026 10:00:00 +0000'] }), {
    envelopeRecipients: ['alice@lab.local'], sourceIp: '::ffff:203.0.113.20',
  });
  const json = await jsonOf(lab, m.id);
  assert.equal(json.route[0].source, 'header');
  assert.equal(json.route[1].source, 'tinpost record');
  assert.equal(json.route[1].from, '203.0.113.20');
  assert.ok(json.iocs.ips.includes('198.51.100.7'));
  assert.ok(json.iocs.ips.includes('203.0.113.20'));
});

// ------------------------------------------------------------- 2-4: the findings

test('the findings appear in the tab as the acceptance cases describe', async (t) => {
  const lab = await withWeb(t);
  const m = await seed(lab, {
    from: 'Support <alerts@paypa1.com>',
    extraHeaders: ['Reply-To: help@evil.test', 'Return-Path: <bounce@mailer.test>'],
    html: PHISH_HTML,
    attachments: [{ name: 'Invoice_Nov.pdf.exe', data: Buffer.from('MZ\x90\x00') }],
  });
  const json = await jsonOf(lab, m.id);
  const code = (rows, c) => rows.flatMap((r) => r.findings).find((f) => f.code === c);
  assert.equal(code(json.sender, 'reply_to_mismatch').severity, 'high');
  assert.equal(code(json.sender, 'return_path_mismatch').severity, 'notice');
  assert.equal(code(json.sender, 'lookalike').severity, 'notice');
  assert.equal(code(json.links, 'link_mismatch').severity, 'high');
  assert.equal(code(json.links, 'ip_host').severity, 'notice');
  assert.equal(code(json.links, 'punycode').severity, 'notice');
  assert.equal(json.links.find((l) => l.hostDecoded).hostDecoded, 'аррӏе.com');
  assert.equal(code(json.attachments, 'double_extension').severity, 'high');

  const page = (await inspectView(lab, m.id)).body;
  assert.match(page, /аррӏе\.com/);
});

// ------------------------------------------------------------------- 5: hashes

test('SHA-256, SHA-1 and MD5 match the bytes the attachment route serves, for a multi-megabyte file', async (t) => {
  const lab = await withWeb(t);
  const data = randomBytes(6 * 1024 * 1024);
  const m = await seed(lab, { attachments: [{ name: 'big.bin', data }] });
  const att = lab.db.getAttachments(m.id)[0];

  const read = lab.blobs.read.bind(lab.blobs);
  const open = lab.blobs.openRead.bind(lab.blobs);
  const readHashes = [];
  let streamed = 0;
  lab.blobs.read = (h) => { readHashes.push(h); return read(h); };
  lab.blobs.openRead = (h) => { if (h === att.content_hash) streamed++; return open(h); };

  const json = await jsonOf(lab, m.id);
  lab.blobs.read = read;
  lab.blobs.openRead = open;
  assert.ok(!readHashes.includes(att.content_hash), 'the attachment is never loaded into memory');
  assert.equal(streamed, 1, 'it is streamed through the hashes once');

  const dl = await lab.app.inject({ url: `/mail/${m.id}/attachment/${att.id}`, headers: asAlice });
  assert.equal(dl.statusCode, 200);
  const bytes = dl.rawPayload;
  assert.equal(bytes.length, data.length);
  const a = json.attachments[0];
  assert.equal(a.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(a.sha1, createHash('sha1').update(bytes).digest('hex'));
  assert.equal(a.md5, createHash('md5').update(bytes).digest('hex'));

  const tab = (await inspectView(lab, m.id)).body;
  for (const h of [a.sha256, a.sha1, a.md5]) assert.ok(tab.includes(h));
  assert.match(tab, /data-copy="[0-9a-f]{64}"/);
  assert.deepEqual(json.iocs.hashes, [a.sha256, a.sha1, a.md5]);
});

test('the ordinary message page does not stream-hash attachments', async (t) => {
  const lab = await withWeb(t);
  const m = await seed(lab, { attachments: [{ name: 'a.bin', data: randomBytes(4096) }] });
  const att = lab.db.getAttachments(m.id)[0];
  const open = lab.blobs.openRead.bind(lab.blobs);
  let streamed = 0;
  lab.blobs.openRead = (h) => { if (h === att.content_hash) streamed++; return open(h); };
  const res = await lab.app.inject({ url: `/mail/${m.id}`, headers: asAlice });
  assert.equal(res.statusCode, 200);
  assert.equal(streamed, 0);
  lab.blobs.openRead = open;
});

// ------------------------------------------------------------- 6: offline, hostile

test('opening the tab and the export makes no outbound network call', async (t) => {
  const lab = await withWeb(t);
  const m = await seed(lab, {
    from: 'a@real-looking-bank.example',
    extraHeaders: [
      'Received: from mail.real-looking-bank.example (mail.real-looking-bank.example [93.184.216.34]) by mx.corp.test; Thu, 26 Nov 2026 10:00:00 +0000',
      'Reply-To: x@another.example',
    ],
    html: '<a href="http://login.real-looking-bank.example/x">https://real-looking-bank.example</a><a href="http://8.8.8.8/">dns</a><a href="https://xn--80ak6aa92e.com/">p</a>',
    attachments: [{ name: 'f.pdf', data: Buffer.from('%PDF-1.4') }],
  });

  const fail = (what) => () => { throw new Error(`network call attempted: ${what}`); };
  const saved = [];
  const patch = (obj, key, fn) => { saved.push([obj, key, obj[key]]); obj[key] = fn; };
  for (const k of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveMx', 'resolveTxt', 'resolveCname', 'resolveNs', 'resolvePtr', 'reverse']) {
    if (typeof dns[k] === 'function') patch(dns, k, fail(`dns.${k}`));
    if (typeof dns.promises[k] === 'function') patch(dns.promises, k, fail(`dns.promises.${k}`));
  }
  patch(net.Socket.prototype, 'connect', fail('net.Socket.connect'));
  patch(net, 'connect', fail('net.connect'));
  patch(net, 'createConnection', fail('net.createConnection'));
  for (const mod of [http, https]) {
    patch(mod, 'request', fail('request'));
    patch(mod, 'get', fail('get'));
  }
  patch(globalThis, 'fetch', fail('fetch'));
  try {
    const tab = await inspectView(lab, m.id);
    const json = await lab.app.inject({ url: `/mail/${m.id}/inspect.json?download`, headers: asAlice });
    assert.equal(tab.statusCode, 200);
    assert.equal(json.statusCode, 200);
  } finally {
    for (const [obj, key, fn] of saved.reverse()) obj[key] = fn;
  }
});

const HOSTILE = [
  '<script>alert(1337)</script>',
  '<img src=x onerror=alert(1337)>',
  '"><svg/onload=alert(1337)>',
];

test('hostile content is shown escaped and never becomes markup or a working link', async (t) => {
  const lab = await withWeb(t);
  const [s, img, svg] = HOSTILE;
  const m = await seed(lab, {
    from: `"${s.replace(/"/g, '')}" <x@evil.test>`,
    subject: `Subj ${s}`,
    extraHeaders: [
      `Reply-To: "${img.replace(/"/g, '')}" <r@other.test>`,
      `Received: from ${s} by ${img}; Thu, 26 Nov 2026 10:00:00 +0000`,
      `X-Tinpost-Relayed: ${svg}; today`,
    ],
    html:
      `<a href="javascript:alert(1337)">${s}</a><a href='${svg.replace(/'/g, '')}'>${img}</a>` +
      '<a href="data:text/html,<script>alert(1337)</script>">d</a>' +
      '<a href="https://evil.test/a\nb\u0007c">ctrl</a>',
    attachments: [{ name: 'x', dispo: `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(`${svg}.pdf.exe`)}`, data: Buffer.from('MZ') }],
  });
  assert.ok(m.id);

  const res = await inspectView(lab, m.id);
  assert.equal(res.statusCode, 200);
  const body = res.body;
  for (const raw of [...HOSTILE, 'alert(1337)</script>']) {
    assert.ok(!body.includes(raw), `raw markup survived: ${raw}`);
  }
  assert.ok(!/<svg\/onload/i.test(body));
  assert.ok(!/<img src=x/i.test(body));
  assert.doesNotMatch(body, /href=["']?\s*javascript:/i);
  assert.doesNotMatch(body, /href=["']?\s*data:/i);
  assert.match(body, /javascript:alert\(1337\)/, 'the target is shown as text');
  assert.match(body, /&lt;script&gt;alert\(1337\)&lt;\/script&gt;/);
  assert.match(body, /\[U\+0007\]/, 'control characters are made visible');

  const json = await lab.app.inject({ url: `/mail/${m.id}/inspect.json`, headers: asAlice });
  assert.match(json.headers['content-type'], /^application\/json/);
  assert.equal(json.headers['x-content-type-options'], 'nosniff');
  assert.doesNotThrow(() => JSON.parse(json.body));
});

// ---------------------------------------------------------------- 7: the export

test('Export .json holds every finding and the IOC list', async (t) => {
  const lab = await withWeb(t);
  const m = await seed(lab, {
    extraHeaders: ['Reply-To: help@evil.test'],
    html: PHISH_HTML,
    attachments: [{ name: 'x.pdf.exe', data: Buffer.from('MZ') }],
  });
  const plain = await lab.app.inject({ url: `/mail/${m.id}/inspect.json`, headers: asAlice });
  assert.equal(plain.headers['content-disposition'], undefined);

  const res = await lab.app.inject({ url: `/mail/${m.id}/inspect.json?download`, headers: asAlice });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-disposition'], `attachment; filename="message-${m.id}-inspect.json"`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const json = JSON.parse(res.body);
  assert.deepEqual(Object.keys(json).sort(), ['attachments', 'iocs', 'links', 'notes', 'route', 'sender', 'summary']);
  const all = [...json.sender, ...json.route, ...json.links, ...json.attachments].flatMap((r) => r.findings);
  assert.equal(json.summary.high, all.filter((f) => f.severity === 'high').length);
  assert.equal(json.summary.notice, all.filter((f) => f.severity === 'notice').length);
  assert.ok(json.iocs.domains.includes('evil.test'));
  assert.ok(json.iocs.urls.includes('http://evil.test/login'));
  assert.ok(json.iocs.ips.includes('192.168.4.7'));
  assert.equal(json.iocs.hashes.length, 3);

  const page = (await inspectView(lab, m.id)).body;
  assert.match(page, /href="\/mail\/\d+\/inspect\.json\?download"/);
  assert.match(page, />Export \.json</);
  assert.match(page, /data-copy-iocs/);
});

// ---- a minimal DOM, to run the shipped client script without a browser

function runClient({ saved = null, theme = null } = {}) {
  const calls = { replaced: [], clipboard: [], execCopied: [], stored: {} };
  let ready;
  const listeners = (el) => (el.handlers = {}) && ((ev, fn) => { el.handlers[ev] = fn; });
  const fakeButton = (attrs) => {
    const b = { attrs, textContent: 'Copy', handlers: {}, getAttribute: (k) => attrs[k] ?? null };
    b.addEventListener = (ev, fn) => { b.handlers[ev] = fn; };
    return b;
  };
  const sha = fakeButton({ 'data-copy': 'a'.repeat(64) });
  const iocs = fakeButton({
    'data-copy-iocs': '',
    'data-iocs': JSON.stringify({ domains: ['evil.test'], urls: ['http://evil.test/x'], ips: ['192.0.2.1'], hashes: ['abc123'] }),
  });
  const root = {
    querySelectorAll: (sel) => (sel === '[data-copy]' ? [sha] : sel === '[data-copy-iocs]' ? [iocs] : []),
  };
  const inspectLink = { classList: { contains: () => false }, getAttribute: (k) => (k === 'data-view' ? 'inspect' : '/mail/9?view=inspect') };
  const tabs = {
    querySelectorAll: (sel) => (sel === '[data-view]' ? [inspectLink] : []),
    addEventListener() {},
  };
  const document = {
    addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') ready = fn; },
    querySelector: (sel) => (sel === '[data-inspect]' ? root : sel === '[data-view-tabs]' ? tabs : null),
    createElement: () => ({ style: {}, setAttribute() {}, select() {} }),
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
    documentElement: { dataset: {} },
  };
  const sandbox = {
    document,
    window: { isSecureContext: true, matchMedia: () => ({ matches: false }) },
    navigator: { clipboard: { writeText: async (t) => { calls.clipboard.push(t); } } },
    localStorage: { getItem: (k) => (k === 'mb.view' ? saved : null), setItem: (k, v) => { calls.stored[k] = v; } },
    location: { replace: (u) => calls.replaced.push(u) },
    setTimeout: () => 0,
    EventSource: class { addEventListener() {} close() {} },
    fetch: async () => ({ ok: true, text: async () => '' }),
  };
  vm.runInNewContext(readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8'), sandbox);
  ready();
  return { calls, sha, iocs, sandbox };
}

test('Copy IOCs puts domains, URLs, IPs and hashes on the clipboard, a header per type', async () => {
  const { calls, iocs, sha } = runClient();
  await iocs.handlers.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.clipboard, ['# Domains\nevil.test\n\n# URLs\nhttp://evil.test/x\n\n# IP addresses\n192.0.2.1\n\n# Hashes\nabc123']);
  await sha.handlers.click();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.clipboard[1], 'a'.repeat(64));
});

test('Copy IOCs falls back to the textarea route when the clipboard API is unavailable (plain HTTP)', async () => {
  const { calls, iocs, sandbox } = runClient();
  sandbox.navigator.clipboard = undefined;
  let executed = 0;
  sandbox.document.execCommand = (c) => { if (c === 'copy') executed++; return true; };
  await iocs.handlers.click();
  await new Promise((r) => setImmediate(r));
  assert.equal(executed, 1);
  assert.deepEqual(calls.clipboard, []);
});

test('a saved view of inspect redirects to the Inspect tab', () => {
  const { calls } = runClient({ saved: 'inspect' });
  assert.deepEqual(calls.replaced, ['/mail/9?view=inspect']);
  const none = runClient({ saved: 'something-removed' });
  assert.deepEqual(none.calls.replaced, [], 'an unknown saved view falls back to the server default');
});

test('a message page still loads for a view the message does not support, and for junk', async (t) => {
  const lab = await withWeb(t);
  const m = await seed(lab, { html: null });
  for (const view of ['html', 'bogus', 'inspect', 'text', 'source', '']) {
    const res = await lab.app.inject({ url: `/mail/${m.id}?view=${view}`, headers: asAlice });
    assert.equal(res.statusCode, 200, view);
  }
});

test('the existing tabs are unchanged', async (t) => {
  const lab = await withWeb(t);
  const m = await seed(lab, { html: '<p>x</p>' });
  const html = (await lab.app.inject({ url: `/mail/${m.id}?view=html`, headers: asAlice })).body;
  assert.match(html, /<iframe class="html-body"/);
  assert.match(html, /data-view="html">HTML<\/a>/);
  assert.match(html, /data-view="text">Plain text<\/a>/);
  assert.match(html, /data-view="source">Source<\/a>/);
  assert.match((await lab.app.inject({ url: `/mail/${m.id}?view=source`, headers: asAlice })).body, /data-source-for/);
  const frame = await lab.app.inject({ url: `/mail/${m.id}/html`, headers: asAlice });
  assert.match(frame.headers['content-security-policy'], /^default-src 'none'; img-src data:;/);
});

// ------------------------------------------------------------- 8: nothing to inspect

test('sections with nothing to inspect say so instead of failing', async (t) => {
  const lab = await withWeb(t);
  const bare = await lab.delivery.deliverRaw(eml(['From: bob@corp.test', 'To: alice@lab.local', 'Subject: bare', '', 'just text', '']), {
    envelopeRecipients: ['alice@lab.local'],
  });
  const res = await inspectView(lab, bare.id);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Nothing to inspect: the message has no HTML part/);
  assert.match(res.body, /Nothing to inspect: the message has no attachments/);
  const json = await jsonOf(lab, bare.id);
  assert.deepEqual(json.links, []);
  assert.deepEqual(json.attachments, []);
  assert.equal(json.sender.length >= 2, true);
});

test('truncated MIME, non-UTF8 bytes and a huge header block never produce a 500', async (t) => {
  const lab = await withWeb(t);
  const truncated = await lab.delivery.deliverRaw(
    Buffer.from('From: bob@corp.test\r\nTo: alice@lab.local\r\nSubject: cut\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/html\r\n\r\n<a href="http://x.te'),
    { envelopeRecipients: ['alice@lab.local'] },
  );
  const latin = await lab.delivery.deliverRaw(
    Buffer.concat([Buffer.from('From: bob@corp.test\r\nTo: alice@lab.local\r\nSubject: caf\xe9 \xff\xfe\r\nContent-Type: text/html; charset=iso-8859-1\r\n\r\n<a href="http://caf\xe9.test/">caf\xe9</a>\r\n', 'latin1')]),
    { envelopeRecipients: ['alice@lab.local'] },
  );
  const lines = ['From: bob@corp.test', 'To: alice@lab.local', 'Subject: many'];
  for (let i = 0; i < 10000; i++) lines.push(`Received: from h${i}.test by m.test; Thu, 26 Nov 2026 09:00:00 +0000`);
  lines.push('', 'x', '');
  const many = await lab.delivery.deliverRaw(eml(lines), { envelopeRecipients: ['alice@lab.local'] });
  for (const m of [truncated, latin, many]) {
    assert.equal((await inspectView(lab, m.id)).statusCode, 200);
    assert.equal((await lab.app.inject({ url: `/mail/${m.id}/inspect.json`, headers: asAlice })).statusCode, 200);
  }
});

test('a 5 MB HTML body with 100,000 anchors is inspected in reasonable time', async (t) => {
  const lab = await withWeb(t);
  const html = '<a name=x>t</a>'.repeat(100000) + '<a href="https://x.test/">l</a>'.repeat(10) + 'x'.repeat(3_500_000);
  const m = await seed(lab, { html });
  const start = Date.now();
  const res = await inspectView(lab, m.id);
  assert.equal(res.statusCode, 200);
  assert.ok(Date.now() - start < 8000, `took ${Date.now() - start} ms`);
});

// ------------------------------------------------------------------ access control

test('the new routes use the same guard as the other message routes', async (t) => {
  const lab = await withWeb(t);
  const m = await seed(lab);
  const other = { cookie: 'mb_addr=dave@lab.local' };

  for (const url of [`/mail/${m.id}?view=inspect`, `/mail/${m.id}/inspect.json`]) {
    const noCookie = await lab.app.inject({ url });
    assert.equal(noCookie.statusCode, 302, url);
    assert.equal(noCookie.headers.location, '/');

    const outsider = await lab.app.inject({ url, headers: other });
    const reference = await lab.app.inject({ url: `/mail/${m.id}/raw`, headers: other });
    assert.equal(outsider.statusCode, 404, url);
    assert.equal(outsider.statusCode, reference.statusCode);
    assert.equal(outsider.body, reference.body);
  }
  assert.equal((await lab.app.inject({ url: '/mail/99999/inspect.json', headers: asAlice })).statusCode, 404);
});
