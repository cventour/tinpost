import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  inspectMessage, domainFindings, parseReceived, extractLinks, classifyLink, detectType, parseHeaders,
  extractAddresses, iocsToText, vis,
} from '../src/inspect.js';

const head = (lines) => Buffer.from(lines.join('\r\n') + '\r\n\r\nbody\r\n');
const codes = (list) => list.flatMap((r) => (r.findings ?? [r]).map((f) => f.code));
const find = (rows, code) => rows.flatMap((r) => r.findings).find((f) => f.code === code);

function run(over = {}) {
  return inspectMessage({
    rawHead: head(['From: bob@corp.test', 'To: alice@lab.local', 'Subject: x']),
    from: { address: 'bob@corp.test', name: null },
    html: null,
    attachments: [],
    message: { origin: 'smtp', received_at: '2026-11-26T10:00:00Z', date_utc: '1999-01-01T00:00:00Z' },
    events: [],
    ...over,
  });
}

/** A ZIP-shaped buffer: a local header per name, then a central directory entry per name. */
function zip(names, { encrypted = false } = {}) {
  const flags = encrypted ? 1 : 0;
  const locals = names.map((n) => {
    const h = Buffer.alloc(30);
    h.write('PK\x03\x04', 0, 'latin1');
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(Buffer.byteLength(n), 26);
    return Buffer.concat([h, Buffer.from(n)]);
  });
  const centrals = names.map((n) => {
    const h = Buffer.alloc(46);
    h.write('PK\x01\x02', 0, 'latin1');
    h.writeUInt16LE(flags, 8);
    h.writeUInt16LE(Buffer.byteLength(n), 28);
    return Buffer.concat([h, Buffer.from(n)]);
  });
  return Buffer.concat([...locals, ...centrals]);
}

const MZ_BYTES = Buffer.from('MZ\x90\x00\x03\x00');

const att = (filename, headBytes, extra = {}) => ({
  id: 1, filename, contentType: 'application/octet-stream', size: headBytes.length, sha256: 'a'.repeat(64),
  isInline: false, head: headBytes, tail: Buffer.alloc(0), ...extra,
});

// ---------------------------------------------------------------- the offline rule

test('inspect.js stays offline: no network modules, and it says so', () => {
  const src = readFileSync(new URL('../src/inspect.js', import.meta.url), 'utf8');
  assert.match(src, /MUST STAY OFFLINE/);
  for (const mod of ['net', 'dns', 'dns/promises', 'http', 'https', 'http2', 'tls', 'dgram', 'child_process']) {
    assert.doesNotMatch(src, new RegExp(`from\\s+['"](?:node:)?${mod}['"]`), mod);
    assert.doesNotMatch(src, new RegExp(`require\\(['"](?:node:)?${mod}['"]\\)`), mod);
  }
  assert.doesNotMatch(src, /from\s+['"]nodemailer/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

// ------------------------------------------------------------------------ sender

test('a domain with a digit for a letter is flagged as a lookalike', () => {
  assert.ok(find([{ findings: domainFindings('paypa1.com') }], 'lookalike'));
  assert.ok(find([{ findings: domainFindings('g00gle.com') }], 'lookalike'));
  assert.ok(find([{ findings: domainFindings('micr0soft-support.net') }], 'lookalike'));
  assert.equal(domainFindings('paypal.com').length, 0);
  assert.equal(domainFindings('example.org').length, 0);
  assert.equal(domainFindings('web3.io').length, 0);
});

test('punycode is flagged and shown decoded', () => {
  const f = domainFindings('xn--80ak6aa92e.com').find((x) => x.code === 'punycode');
  assert.ok(f);
  assert.ok(f.text.includes('аррӏе'), f.text);
  const bad = domainFindings('xn--zzzzzzzzzzzzzzzzzzzz-.com');
  assert.ok(Array.isArray(bad));
});

test('a label that mixes scripts is flagged', () => {
  const f = domainFindings('pаypal.com').find((x) => x.code === 'mixed_script');
  assert.ok(f, 'Cyrillic a inside a Latin word');
  assert.ok(!domainFindings('пример.рф').some((x) => x.code === 'mixed_script'), 'pure Cyrillic is not mixed');
});

test('Reply-To on another domain is high; Return-Path differing from From is a notice', () => {
  const r = run({
    rawHead: head(['From: Bob <bob@corp.test>', 'Reply-To: help@evil.test', 'Return-Path: <bounce@mailer.test>']),
    from: { address: 'bob@corp.test', name: 'Bob' },
  });
  assert.equal(find(r.sender, 'reply_to_mismatch').severity, 'high');
  assert.equal(find(r.sender, 'return_path_mismatch').severity, 'notice');
  assert.equal(r.summary.high, 1);
});

test('a Reply-To on the same domain is not high', () => {
  const r = run({ rawHead: head(['From: bob@corp.test', 'Reply-To: sales@corp.test']) });
  assert.equal(find(r.sender, 'reply_to_mismatch'), undefined);
  assert.equal(r.summary.high, 0);
});

test('with no Return-Path the envelope sender is reported as not recorded, as information', () => {
  const r = run();
  const row = r.sender.find((x) => x.field === 'Envelope sender');
  assert.equal(row.value, 'not recorded');
  assert.equal(row.findings[0].severity, 'info');
});

test('a display name carrying a different address is flagged', () => {
  const r = run({ from: { address: 'x@evil.test', name: 'support@paypal.com' } });
  assert.equal(find(r.sender, 'display_name_address').severity, 'high');
  const same = run({ from: { address: 'x@evil.test', name: 'x@evil.test' } });
  assert.equal(find(same.sender, 'display_name_address'), undefined);
});

test('header parsing unfolds, decodes encoded words and tolerates junk', () => {
  const h = parseHeaders(Buffer.from('Subject: a\r\n b\r\ngarbage line\r\nX-Y:  z \r\n\r\nBody: not a header'));
  assert.deepEqual(h, [{ name: 'subject', value: 'a b' }, { name: 'x-y', value: 'z' }]);
  const a = extractAddresses('=?UTF-8?B?Q2hyaXN0b3M=?= <C@X.test>, plain@y.test');
  assert.deepEqual(a, [{ name: 'Christos', address: 'c@x.test' }, { name: '', address: 'plain@y.test' }]);
});

// ------------------------------------------------------------------------- route

test('Received headers are read, ordered oldest first, and the delay between hops is computed', () => {
  const r = run({
    rawHead: head([
      'Received: from c.test (c.test [203.0.113.9]) by d.test with ESMTP; Thu, 26 Nov 2026 10:00:30 +0000',
      'Received: from b.test by c.test with SMTP; Thu, 26 Nov 2026 10:00:10 +0000',
      'Received: from a.test (a.test [198.51.100.7]) by b.test with ESMTP; Thu, 26 Nov 2026 10:00:00 +0000',
      'From: bob@corp.test',
    ]),
  });
  const hops = r.route.filter((x) => x.source === 'header');
  assert.equal(hops.length, 3);
  assert.match(hops[0].from, /^a\.test/);
  assert.equal(hops[0].time, '2026-11-26 10:00:00');
  assert.equal(hops[1].delaySeconds, 10);
  assert.equal(hops[2].delaySeconds, 20);
  assert.equal(hops[2].delay, '20s');
  assert.ok(r.iocs.ips.includes('198.51.100.7'));
  assert.ok(r.iocs.domains.includes('a.test'));
});

test('malformed and out-of-order Received headers do not throw', () => {
  const r = run({
    rawHead: head([
      'Received: from a.test by b.test; Thu, 26 Nov 2026 09:00:00 +0000',
      'Received: ;;;; ((( from',
      'Received: ',
      'Received: from x by y; not a date at all',
      'Received: from p.test by q.test; Thu, 26 Nov 2026 11:00:00 +0000',
      'From: bob@corp.test',
    ]),
  });
  assert.ok(r.route.length >= 4);
  assert.ok(codes(r.route).includes('time_backwards') || codes(r.route).includes('received_unreadable'));
  assert.deepEqual(parseReceived('').time, null);
  assert.equal(parseReceived('from a by b; Thu, 26 Nov 2026 09:00:00 +0000 (UTC)').time, Date.UTC(2026, 10, 26, 9));
});

test('Tinpost records become hops, labelled by where they came from', () => {
  const r = run({
    rawHead: head(['Received: from a.test by b.test; Thu, 26 Nov 2026 09:00:00 +0000', 'From: bob@corp.test']),
    events: [{ at: '2026-11-26T09:00:05.000Z', via: 'smtp', source_ip: '192.0.2.4', relay: 'outbound', response: 'ok' }],
  });
  assert.deepEqual(r.route.map((x) => x.source), ['header', 'tinpost record', 'tinpost record']);
  assert.equal(r.route[1].from, '192.0.2.4');
  assert.match(find(r.route, 'to_upstream_relay').text, /upstream relay/);
});

test('a webmail message says plainly that it has no inbound SMTP hop', () => {
  const r = run({ message: { origin: 'webmail', date_utc: '2026-11-26T09:00:00Z' } });
  assert.equal(r.route.length, 1);
  assert.ok(find(r.route, 'webmail_origin'));
});

test('the relay stamp header becomes a hop when no event describes the relay', () => {
  const r = run({
    rawHead: head(['X-Tinpost-Relayed: lab; Thu, 26 Nov 2026 09:00:00 GMT', 'From: bob@corp.test']),
    events: [{ at: '2026-11-26T09:00:30.000Z', via: 'gateway', source_ip: '10.0.0.5', relay: 'returned' }],
  });
  assert.ok(find(r.route, 'tinpost_relay_stamp'));
  assert.ok(find(r.route, 'returned_from_relay'));
});

test('10,000 Received headers are capped, not walked', () => {
  const lines = [];
  for (let i = 0; i < 10000; i++) lines.push(`Received: from h${i}.test by m${i}.test; Thu, 26 Nov 2026 09:00:00 +0000`);
  lines.push('From: bob@corp.test');
  const t = Date.now();
  const r = run({ rawHead: head(lines) });
  assert.ok(Date.now() - t < 3000);
  assert.ok(r.route.filter((x) => x.source === 'header').length <= 200);
  assert.ok(r.notes.some((n) => /Received/.test(n)));
});

// ------------------------------------------------------------------------- links

test('link text that names another host than the target is high', () => {
  const f = classifyLink('http://evil.test/login', 'https://paypal.com/signin').row.findings;
  assert.equal(f.find((x) => x.code === 'link_mismatch').severity, 'high');
  assert.equal(classifyLink('https://paypal.com/other', 'https://www.paypal.com/signin').row.findings.length, 0);
  assert.equal(classifyLink('https://evil.test/', 'Click here to sign in').row.findings.length, 0);
  assert.equal(classifyLink('https://evil.test/', 'Mr.Smith').row.findings.length, 0);
});

test('IP-literal targets are notices, in every spelling', () => {
  for (const href of ['https://192.168.1.5/x', 'https://3232235781/x', 'https://0xc0a80105/x', 'https://0300.0250.01.05/x', 'https://[::1]/x']) {
    const f = classifyLink(href, 'open').row.findings.find((x) => x.code === 'ip_host');
    assert.ok(f, href);
    assert.equal(f.severity, 'notice');
  }
  assert.equal(classifyLink('https://192.168.1.5/x', 'paypal.com').row.findings.find((x) => x.code === 'link_mismatch').severity, 'high');
});

test('punycode targets are notices and shown decoded', () => {
  const { row } = classifyLink('https://xn--80ak6aa92e.com/', 'open');
  assert.equal(row.findings.find((x) => x.code === 'punycode').severity, 'notice');
  assert.equal(row.hostDecoded, 'аррӏе.com');
});

test('http is a notice; javascript: and data: are high, even when disguised', () => {
  assert.equal(classifyLink('http://example.org/', 'x').row.findings.find((x) => x.code === 'insecure').severity, 'notice');
  for (const href of ['javascript:alert(1)', ' JaVa\nScRiPt:alert(1)', 'java&#x09;script:alert(1)', 'javascript&colon;alert(1)', 'data:text/html,<b>x</b>']) {
    const f = classifyLink(href, 'x').row.findings[0];
    assert.equal(f.severity, 'high', href);
  }
});

test('userinfo in front of the real host is called out; mailto is read sensibly', () => {
  assert.ok(classifyLink('https://paypal.com@evil.test/', 'x').row.findings.some((f) => f.code === 'userinfo'));
  const m = classifyLink('mailto:Help%40corp.test?subject=hi', 'mail us').row;
  assert.equal(m.host, 'corp.test');
  assert.equal(m.findings.length, 0);
});

test('the tokenizer finds a and area links, skips comments, and copes with odd quoting', () => {
  const html =
    '<A HREF="https://a.test/1">one</A><area href=https://b.test/2><!-- <a href="https://hidden.test/"> -->' +
    "<a class=x href='https://c.test/3?a=1&amp;b=2'><b>three</b></a><a name=nohref>n</a><a href=\"unterminated";
  const { links } = extractLinks(html);
  assert.deepEqual(links.map((l) => l.rawHref), ['https://a.test/1', 'https://b.test/2', 'https://c.test/3?a=1&amp;b=2']);
  assert.equal(links[2].text, 'three');
});

test('links are capped at 500 and the cap is reported', () => {
  const html = Array.from({ length: 700 }, (_, i) => `<a href="https://h${i}.test/">l${i}</a>`).join('');
  const r = run({ html });
  assert.equal(r.links.length, 500);
  assert.ok(r.notes.some((n) => /500/.test(n)));
});

test('5 MB of HTML with 100,000 anchor tokens finishes quickly', () => {
  const html = '<a name=x>t</a>'.repeat(100000) + 'x'.repeat(3_000_000) + '<a href="http://x.test">y</a>';
  const t = Date.now();
  const r = run({ html });
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
  assert.equal(r.links.length, 1);
});

test('a 100 KB href is analysed and shown truncated', () => {
  const html = `<a href="https://x.test/${'a'.repeat(100000)}">go</a>`;
  const r = run({ html });
  assert.equal(r.links.length, 1);
  assert.ok(r.links[0].target.length < 2300);
  assert.match(r.links[0].target, /characters in all/);
});

test('hostile pathological anchors do not backtrack forever', () => {
  const t = Date.now();
  run({ html: '<a href="' + '"\'= '.repeat(50000) + '>x', rawHead: head(['From: a@b.test']) });
  run({ html: '<a href="https://x.test">' + 'a.'.repeat(1500) + '</a>' });
  assert.ok(Date.now() - t < 3000);
});

// ------------------------------------------------------------------ attachments

test('the magic-byte table recognises common types', () => {
  const cases = [
    ['pe', Buffer.from('MZ\x90\x00')], ['elf', Buffer.from('\x7fELF\x02')], ['macho', Buffer.from('\xcf\xfa\xed\xfe', 'latin1')],
    ['pdf', Buffer.from('%PDF-1.7')], ['ole2', Buffer.from('d0cf11e0a1b11ae1', 'hex')], ['rar', Buffer.from('Rar!\x1a\x07\x00', 'latin1')],
    ['7z', Buffer.from('7z\xbc\xaf\x27\x1c', 'latin1')], ['gzip', Buffer.from('1f8b08', 'hex')], ['png', Buffer.from('\x89PNG\r\n', 'latin1')],
    ['jpeg', Buffer.from('ffd8ffe0', 'hex')], ['gif', Buffer.from('GIF89a')], ['script', Buffer.from('#!/bin/sh\n')],
    ['text', Buffer.from('hello world\n')], ['unknown', Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 1, 2])], ['empty', Buffer.alloc(0)],
  ];
  for (const [cat, buf] of cases) assert.equal(detectType(buf).cat, cat, cat);
});

test('ZIP flavours are told apart by their first entries', () => {
  assert.equal(detectType(zip(['[Content_Types].xml', 'word/document.xml'])).cat, 'ooxml');
  assert.equal(detectType(zip(['META-INF/MANIFEST.MF', 'A.class'])).cat, 'jar');
  assert.equal(detectType(zip(['AndroidManifest.xml', 'classes.dex'])).cat, 'apk');
  assert.equal(detectType(zip(['notes.txt'])).cat, 'zip');
  const odf = Buffer.concat([zip(['mimetype']).subarray(0, 38), Buffer.from('application/vnd.oasis.opendocument.text')]);
  assert.equal(detectType(odf).cat, 'odf');
});

test('a .pdf that starts with MZ is a high type mismatch', () => {
  const r = run({ attachments: [att('Invoice.pdf', Buffer.from('MZ\x90\x00\x03'))] });
  const f = find(r.attachments, 'type_mismatch');
  assert.equal(f.severity, 'high');
  assert.match(f.text, /Type mismatch/);
  assert.equal(r.attachments[0].detectedCode, 'pe');
});

test('a double extension is high, including padding and right-to-left tricks', () => {
  for (const name of ['x.pdf.exe', 'x.pdf      .exe', 'x.doc.scr   ', 'report.docx.js']) {
    const r = run({ attachments: [att(name, MZ_BYTES)] });
    assert.equal(find(r.attachments, 'double_extension')?.severity, 'high', name);
  }
  const rtl = run({ attachments: [att('invoice‮gpj.exe', MZ_BYTES)] });
  assert.equal(find(rtl.attachments, 'rtl_override').severity, 'high');
  assert.match(rtl.attachments[0].name, /\[U\+202E\]/, 'the control character is made visible');
  const fine = run({ attachments: [att('report.final.v2.txt', Buffer.from('plain text'))] });
  assert.equal(fine.summary.high, 0);
  assert.equal(fine.attachments[0].findings.length, 0);
});

test('executable content is high whatever the name, and an honest .exe is high too', () => {
  const honest = run({ attachments: [att('setup.exe', MZ_BYTES)] });
  assert.equal(find(honest.attachments, 'executable').severity, 'high');
  assert.equal(find(honest.attachments, 'type_mismatch'), undefined);
  const named = run({ attachments: [att('data.dat', MZ_BYTES)] });
  assert.equal(find(named.attachments, 'executable').severity, 'high');
  const asJs = run({ attachments: [att('run.js', MZ_BYTES)] });
  assert.equal(asJs.summary.high >= 1, true);
  assert.equal(find(asJs.attachments, 'executable').severity, 'high');
  for (const content of [Buffer.from('#!/bin/sh\necho hi\n'), Buffer.from('\x7fELF\x02\x01\x01\x00'), Buffer.from('\xcf\xfa\xed\xfe\x07\x00', 'latin1')]) {
    assert.equal(find(run({ attachments: [att('notes.bin', content)] }).attachments, 'executable').severity, 'high');
  }
});

test('extension-only executables and scripts are high even with plain text content', () => {
  for (const ext of ['exe', 'scr', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'hta', 'lnk', 'msi']) {
    const r = run({ attachments: [att(`thing.${ext}`, Buffer.from('just some readable text\n'))] });
    assert.equal(r.summary.high >= 1, true, ext);
    assert.ok(r.attachments[0].findings.some((f) => f.severity === 'high'), ext);
  }
  assert.equal(find(run({ attachments: [att('run.js', Buffer.from('alert(1)\n'))] }).attachments, 'executable_extension').severity, 'high');
  assert.equal(run({ attachments: [att('notes.txt', Buffer.from('alert(1)\n'))] }).summary.high, 0);
});

test('plain text that starts with MZ is text; a real DOS/PE header is an executable', () => {
  assert.equal(detectType(Buffer.from('MZ is my favourite file\n')).cat, 'text');
  assert.equal(detectType(Buffer.from('MZ')).cat, 'text');
  assert.equal(detectType(Buffer.from('MZ\x90\x00\x03')).cat, 'pe');
  const pe = Buffer.alloc(0x100);
  pe.write('MZ', 0, 'latin1');
  pe.fill('A', 2, 0x3c);
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'latin1');
  assert.equal(detectType(pe).cat, 'pe', 'PE signature at e_lfanew, even with readable bytes before it');
  assert.equal(run({ attachments: [att('Notes.pdf', Buffer.from('MZ is my favourite file\n'))] }).attachments[0].findings.some((f) => f.severity === 'high'), false);
});

test('macro-enabled extensions and hidden VBA projects are reported', () => {
  const macroDoc = run({ attachments: [att('budget.docm', zip(['[Content_Types].xml', 'word/vbaProject.bin']))] });
  assert.equal(find(macroDoc.attachments, 'macro_enabled').severity, 'notice');
  assert.equal(find(macroDoc.attachments, 'hidden_macro'), undefined);
  const hidden = run({ attachments: [att('budget.docx', zip(['[Content_Types].xml', 'word/vbaProject.bin']))] });
  assert.equal(find(hidden.attachments, 'hidden_macro').severity, 'high');
  const ext = run({ attachments: [att('old.xlsm', zip(['[Content_Types].xml', 'xl/workbook.xml']))] });
  assert.equal(find(ext.attachments, 'macro_enabled').severity, 'notice');
});

test('encrypted ZIP and RAR archives are noticed; a plain ZIP is not', () => {
  assert.equal(find(run({ attachments: [att('a.zip', zip(['secret.txt'], { encrypted: true }))] }).attachments, 'encrypted_archive').severity, 'notice');
  assert.equal(find(run({ attachments: [att('a.zip', zip(['plain.txt']))] }).attachments, 'encrypted_archive'), undefined);
  const rar4 = Buffer.concat([Buffer.from('Rar!\x1a\x07\x00', 'latin1'), Buffer.from([0, 0, 0x73, 0x80, 0x00, 0, 0])]);
  assert.ok(detectType(rar4).encrypted);
  const tail = zip(['secret.txt'], { encrypted: true });
  assert.ok(detectType(Buffer.from('PK\x03\x04'), tail).encrypted, 'central directory in the tail is read');
});

test('hashes are passed through, and the IOC list holds all of them', () => {
  const r = run({ attachments: [att('n.txt', Buffer.from('hi'), { sha1: 'b'.repeat(40), md5: 'c'.repeat(32) })] });
  assert.deepEqual(r.iocs.hashes, ['a'.repeat(64), 'b'.repeat(40), 'c'.repeat(32)]);
  assert.equal(r.summary.hashed, 1);
});

// ---------------------------------------------------------------------- the rest

test('the summary counts match the findings, and every finding has the three fields', () => {
  const r = run({
    rawHead: head(['From: bob@corp.test', 'Reply-To: x@evil.test']),
    html: '<a href="http://evil.test/">paypal.com</a>',
    attachments: [att('a.pdf.exe', MZ_BYTES)],
  });
  const all = [...r.sender, ...r.route, ...r.links, ...r.attachments].flatMap((x) => x.findings);
  for (const f of all) {
    assert.ok(['high', 'notice', 'info'].includes(f.severity));
    assert.equal(typeof f.code, 'string');
    assert.equal(typeof f.text, 'string');
  }
  assert.equal(r.summary.high, all.filter((f) => f.severity === 'high').length);
  assert.equal(r.summary.notice, all.filter((f) => f.severity === 'notice').length);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('IOCs are grouped under a header per type, and empty groups are left out', () => {
  const text = iocsToText({ domains: ['a.test'], urls: ['http://a.test/x'], ips: [], hashes: ['abc'] });
  assert.equal(text, '# Domains\na.test\n\n# URLs\nhttp://a.test/x\n\n# Hashes\nabc');
  assert.equal(iocsToText({ domains: [], urls: [], ips: [], hashes: [] }), '');
});

test('nothing to inspect: empty and garbage input never throws', () => {
  assert.doesNotThrow(() => inspectMessage({}));
  assert.doesNotThrow(() => inspectMessage({ rawHead: Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]), from: { address: '', name: null } }));
  const r = inspectMessage({ rawHead: Buffer.from('From: a@b.test\r\nSubject: cut off mid'), from: { address: 'a@b.test' }, html: '<a href="', attachments: [att('x', Buffer.alloc(0))] });
  assert.equal(r.links.length, 0);
});

test('vis makes control characters visible and caps length', () => {
  assert.equal(vis('a\nb‮c'), 'a[U+000A]b[U+202E]c');
  assert.match(vis('x'.repeat(5000)), /5000 characters in all/);
});

// ---------------------------------------------- review round 1: speed, severities, filters

const quickly = (label, fn, ms = 200) => {
  const t = process.hrtime.bigint();
  fn();
  const took = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(took < ms, `${label} took ${took.toFixed(0)} ms`);
};

test('pathological input stays fast: long runs of spaces, unterminated tags, and angle brackets', () => {
  const spaces = ' '.repeat(4000);
  quickly('Reply-To of spaces', () => run({ rawHead: head(['From: bob@corp.test', `Reply-To: a${spaces}b${spaces}<x@y.test`]) }));
  quickly('display name of spaces', () => run({ from: { address: 'bob@corp.test', name: `a${spaces}@${spaces}b` } }));
  quickly('extractAddresses of spaces', () => extractAddresses(`"${spaces}" ${spaces}<${spaces}`));
  quickly('100,000 unterminated anchors', () => extractLinks('<a href="'.repeat(100000)));
  quickly('30,000 unterminated anchors with a body', () => extractLinks('<a href="x'.repeat(30000) + 'z'.repeat(400000)));
  quickly('500 links of 3,000 angle brackets', () => {
    const html = Array.from({ length: 500 }, () => `<a href="https://h.test/">${'<'.repeat(3000)}</a>`).join('');
    const { links } = extractLinks(html);
    assert.equal(links.length, 500);
  });
  quickly('500 links of brackets with a far >', () => {
    extractLinks(Array.from({ length: 500 }, () => `<a href="https://h.test/">${'<'.repeat(2900)}></a>`).join(''));
  });
});

test('markup inside link text is removed, a stray < is kept', () => {
  const { links } = extractLinks('<a href="https://x.test/">a <b>bold</b> 1 < 2 <img src=y></a>');
  assert.equal(links[0].text, 'a bold 1 < 2');
});

test('rn and vv lookalikes of a brand are flagged without any digit', () => {
  assert.ok(find([{ findings: domainFindings('rnicrosoft.com') }], 'lookalike'));
  assert.ok(find([{ findings: domainFindings('vvikipedia.org') }], 'lookalike'));
  assert.equal(domainFindings('microsoft.com').length, 0);
  assert.equal(domainFindings('barnes.org').length, 0);
});

test('a protocol-relative link is checked like a web link', () => {
  const { row } = classifyLink('//evil.test/x', 'https://bank.com');
  assert.equal(row.host, 'evil.test');
  assert.equal(row.findings.find((f) => f.code === 'link_mismatch').severity, 'high');
  assert.equal(classifyLink('//partner.test/x', 'Open menu').row.findings.length, 0);
  const r = run({ html: '<a href="//evil.test/x">https://bank.com</a>' });
  assert.ok(r.iocs.urls.includes('https://evil.test/x'));
});

test('Reply-To on a subdomain relation is a notice; any other difference stays high', () => {
  const reply = (addr) => run({ rawHead: head(['From: bob@corp.test', `Reply-To: ${addr}`]) });
  assert.equal(find(reply('x@mail.corp.test').sender, 'reply_to_subdomain').severity, 'notice');
  assert.equal(reply('x@mail.corp.test').summary.high, 0);
  const up = run({ rawHead: head(['From: bob@mail.corp.test', 'Reply-To: x@corp.test']), from: { address: 'bob@mail.corp.test', name: null } });
  assert.equal(find(up.sender, 'reply_to_subdomain').severity, 'notice');
  assert.equal(find(reply('x@evilcorp.test').sender, 'reply_to_mismatch').severity, 'high');
  assert.equal(find(reply('x@corp.test.evil.test').sender, 'reply_to_mismatch').severity, 'high');
  assert.equal(find(reply('x@other.test').sender, 'reply_to_mismatch').severity, 'high');
});

test('invisible characters are made visible', () => {
  for (const c of ['\u2028', '\u2029', '\u2060', '\u2064', '\u061c', '\u180e', '\u200b', '\ufeff']) {
    assert.match(vis(`a${c}b`), /^a\[U\+[0-9A-F]{4}\]b$/, c.codePointAt(0).toString(16));
  }
  assert.equal(vis('plain text'), 'plain text');
});

test('the route uses the time Tinpost received the message, not the sender-supplied Date', () => {
  const r = run({ message: { origin: 'smtp', received_at: '2026-11-26T10:00:00Z', date_utc: '1999-01-01T00:00:00Z' } });
  assert.equal(r.route[0].time, '2026-11-26 10:00:00');
});

test('IOCs set aside the lab itself: loopback, lab.local and the configured domains', () => {
  const r = inspectMessage({
    rawHead: head([
      'Received: from mx.lab.local (mx.lab.local [127.0.0.1]) by mail.myorg.test; Thu, 26 Nov 2026 10:00:00 +0000',
      'Received: from out.evil.test (out.evil.test [203.0.113.9]) by mx.lab.local; Thu, 26 Nov 2026 09:59:00 +0000',
      'Received: from loop (loop [::ffff:127.0.0.5]) by x.test; Thu, 26 Nov 2026 09:58:00 +0000',
      'Received: from loop6 (loop6 [::1]) by x.test; Thu, 26 Nov 2026 09:57:00 +0000',
      'From: bob@corp.test',
    ]),
    from: { address: 'bob@corp.test', name: null },
    html: '<a href="http://shop.myorg.test/a">a</a><a href="https://evil.test/b">b</a><a href="http://127.0.0.1/c">c</a><a href="http://x.lab.local/d">d</a>',
    labDomains: ['myorg.test'],
    attachments: [att('f.txt', Buffer.from('hi'))],
    message: { origin: 'smtp', received_at: '2026-11-26T10:00:00Z' },
    events: [{ at: '2026-11-26T10:00:01Z', via: 'smtp', source_ip: '127.0.0.1' }],
  });
  assert.deepEqual(r.iocs.domains.sort(), ['corp.test', 'evil.test', 'out.evil.test', 'x.test'].sort());
  assert.deepEqual(r.iocs.ips.sort(), ['203.0.113.9']);
  assert.deepEqual(r.iocs.urls, ['https://evil.test/b']);
  assert.deepEqual(r.iocs.hashes, ['a'.repeat(64)]);
  assert.ok(r.iocsExcluded.domains.includes('mx.lab.local'));
  assert.ok(r.iocsExcluded.domains.includes('shop.myorg.test'));
  assert.ok(r.iocsExcluded.ips.includes('127.0.0.1'));
  assert.ok(r.iocsExcluded.ips.includes('::ffff:127.0.0.5'));
  assert.ok(r.iocsExcluded.ips.includes('::1'));
  assert.deepEqual(r.iocsExcluded.urls.sort(), ['http://127.0.0.1/c', 'http://shop.myorg.test/a', 'http://x.lab.local/d'].sort());
  // Route and Links still show everything.
  assert.ok(r.route.some((h) => h.from.includes('mx.lab.local')));
  assert.equal(r.links.length, 4);
  assert.ok(!iocsToText(r.iocs).includes('lab.local'));
});
