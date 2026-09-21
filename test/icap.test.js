import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { options, scan, parseService, serviceUri, parseHead } from '../src/icap.js';
import { startIcapStub } from './icap-stub.js';

async function withStub(t, opts) {
  const stub = await startIcapStub(opts);
  t.after(() => stub.close());
  return stub;
}

test('OPTIONS reports what the service supports', async (t) => {
  const stub = await withStub(t);

  const result = await options({ host: stub.host, port: stub.port, service: '/avscan' });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.methods, ['respmod', 'reqmod']);
  assert.equal(result.preview, 128);
  assert.equal(result.allow204, true);
  assert.equal(result.istag, '"tinpost-stub-1"');
  assert.equal(stub.requests[0].method, 'OPTIONS');
  assert.equal(stub.requests[0].uri, `icap://127.0.0.1:${stub.port}/avscan`);
});

test('a clean attachment comes back clean, and the whole file is sent', async (t) => {
  const stub = await withStub(t, { verdict: 'clean' });
  const content = Buffer.from('a harmless text file\n'.repeat(50));

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/avscan',
    content,
    filename: 'notes.txt',
    contentType: 'text/plain',
  });

  assert.equal(result.verdict, 'clean');
  assert.equal(result.statusCode, 204);
  const seen = stub.requests[0];
  assert.equal(seen.method, 'RESPMOD');
  assert.deepEqual(seen.body, content, 'the scanner should receive the attachment byte for byte');
  assert.equal(seen.headers.allow, '204');
  assert.match(seen.headers.encapsulated, /^res-hdr=0, res-body=\d+$/);
});

test('an infected attachment comes back blocked, with the threat named', async (t) => {
  const stub = await withStub(t, { verdict: 'infected', threat: 'EICAR-Test-File' });

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/avscan',
    content: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR'),
    filename: 'invoice.exe',
  });

  assert.equal(result.verdict, 'blocked');
  assert.equal(result.statusCode, 200);
  assert.equal(result.threat, 'EICAR-Test-File');
  assert.match(result.detail, /EICAR-Test-File/);
});

test('a 403 is a refusal, not an error', async (t) => {
  const stub = await withStub(t, { verdict: 'blocked' });

  const result = await scan({ host: stub.host, port: stub.port, service: '/avscan', content: Buffer.from('x') });

  assert.equal(result.verdict, 'blocked');
  assert.equal(result.statusCode, 403);
});

test('preview sends the first bytes, then the rest on 100 Continue', async (t) => {
  const stub = await withStub(t, { verdict: 'clean', wantAll: true });
  const content = Buffer.alloc(500, 0x41);

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/avscan',
    content,
    preview: 64,
  });

  assert.equal(result.verdict, 'clean');
  const seen = stub.requests[0];
  assert.equal(seen.preview, 64, 'the request should offer a preview');
  assert.equal(seen.previewLength, 64, 'the first phase should carry exactly the preview');
  assert.equal(seen.continued, true, 'the rest should follow the 100 Continue');
  assert.deepEqual(seen.body, content, 'both phases together are the whole file');
});

test('a preview the scanner can decide on early needs no second phase', async (t) => {
  const stub = await withStub(t, { verdict: 'infected', wantAll: false });

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/avscan',
    content: Buffer.alloc(500, 0x42),
    preview: 32,
  });

  assert.equal(result.verdict, 'blocked');
  assert.equal(stub.requests[0].continued, false);
  assert.equal(stub.requests[0].body.length, 32, 'only the preview was ever sent');
});

test('an attachment no longer than the preview is sent in one go', async (t) => {
  const stub = await withStub(t, { verdict: 'clean' });

  await scan({ host: stub.host, port: stub.port, service: '/avscan', content: Buffer.alloc(10), preview: 64 });

  assert.equal(stub.requests[0].preview, null, 'no point offering a preview as long as the file');
});

test('REQMOD wraps the attachment as an upload instead', async (t) => {
  const stub = await withStub(t, { verdict: 'clean' });
  const content = Buffer.from('payload');

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/virus_scan',
    method: 'reqmod',
    content,
    filename: 'thing.bin',
  });

  assert.equal(result.verdict, 'clean');
  assert.equal(stub.requests[0].method, 'REQMOD');
  assert.match(stub.requests[0].headers.encapsulated, /^req-hdr=0, req-body=\d+$/);
  assert.deepEqual(stub.requests[0].body, content);
});

test('a server error is an error, not a verdict', async (t) => {
  const stub = await withStub(t, { verdict: 'error', statusCode: 500 });

  const result = await scan({ host: stub.host, port: stub.port, service: '/avscan', content: Buffer.from('x') });

  assert.equal(result.verdict, 'error');
  assert.equal(result.statusCode, 500);
  assert.match(result.detail, /ICAP 500/);
});

test('an unreachable scanner is reported as unreachable', async (t) => {
  // A port that was listening and is now closed is reliably refused.
  const idle = net.createServer();
  await new Promise((resolve) => idle.listen(0, '127.0.0.1', resolve));
  const port = idle.address().port;
  await new Promise((resolve) => idle.close(resolve));

  const result = await scan({ host: '127.0.0.1', port, service: '/avscan', content: Buffer.from('x') });

  assert.equal(result.verdict, 'error');
  assert.equal(result.statusCode, null);
  assert.match(result.detail, /nothing is listening/);
});

test('a scanner that never answers times out rather than hanging', async (t) => {
  const stub = await withStub(t, { verdict: 'silent' });

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/avscan',
    content: Buffer.from('x'),
    timeout: 250,
  });

  assert.equal(result.verdict, 'error');
  assert.match(result.detail, /did not answer in time/);
});

test('the sender and recipients ride along as headers, sanitised', async (t) => {
  const stub = await withStub(t, { verdict: 'clean' });

  await scan({
    host: stub.host,
    port: stub.port,
    service: '/avscan',
    content: Buffer.from('x'),
    headers: { 'X-Mail-From': 'bob@corp.test', 'X-Tinpost-Subject': 'line one\r\nInjected: yes' },
  });

  const seen = stub.requests[0];
  assert.equal(seen.headers['x-mail-from'], 'bob@corp.test');
  assert.equal(seen.headers['injected'], undefined, 'a newline must not forge a header');
  assert.equal(seen.headers['x-tinpost-subject'], 'line one Injected: yes');
});

test('a quote in an attachment name cannot break out of the HTTP head', async (t) => {
  const stub = await withStub(t, { verdict: 'clean' });

  await scan({
    host: stub.host,
    port: stub.port,
    service: '/avscan',
    content: Buffer.from('x'),
    filename: 'bad"\r\nX-Evil: 1.txt',
  });

  // The name stays readable, but it is one line: the quotes and the line break that
  // would have ended the Content-Disposition header early are gone.
  const head = stub.requests[0].httpHead.toString('latin1');
  assert.match(head, /Content-Disposition: attachment; filename="bad___X-Evil: 1\.txt"\r\n/);
  assert.equal(
    head.split('\r\n').some((line) => /^X-Evil:/.test(line)),
    false,
    'no forged header line',
  );
});

test('a service field can carry a whole icap:// URL, which then wins', () => {
  const target = parseService('icap://scanner.lab:1345/respmod', { host: '127.0.0.1', port: 1344 });
  assert.deepEqual(target, { host: 'scanner.lab', port: 1345, path: '/respmod', query: '' });
  assert.equal(serviceUri(target), 'icap://scanner.lab:1345/respmod');
});

test('a bare service name is read as a path on the configured host', () => {
  assert.deepEqual(parseService('avscan', { host: '10.0.0.5', port: 1344 }), {
    host: '10.0.0.5',
    port: 1344,
    path: '/avscan',
    query: '',
  });
});

test('an IPv6 host is bracketed in the request URI', () => {
  assert.equal(serviceUri(parseService('/avscan', { host: '::1', port: 1344 })), 'icap://[::1]:1344/avscan');
});

test('folded headers and repeats are read the way the spec writes them', () => {
  const parsed = parseHead(
    'ICAP/1.0 200 OK\r\nX-Infection-Found: Type=0;\r\n Threat=Worm;\r\nX-Violations-Found: 1\r\nX-Violations-Found: 2',
  );
  assert.equal(parsed.statusCode, 200);
  assert.equal(parsed.headers['x-infection-found'], 'Type=0; Threat=Worm;');
  assert.equal(parsed.headers['x-violations-found'], '1\n2');
});

test('something that is not ICAP is rejected rather than half-understood', () => {
  assert.throws(() => parseHead('HTTP/1.1 200 OK\r\nContent-Length: 0'), /not an ICAP response/);
});

// ---------- the shapes MetaDefender ICAP Server answers with ----------
//
// It reserves 403 for its FILEMOD method and answers RESPMOD with a 200 whether the
// file was refused or merely rewritten, putting the verdict in X-Response-Info. So
// the status line cannot be read on its own.

test('a MetaDefender block is a 200 with X-Response-Info: Blocked', async (t) => {
  const stub = await withStub(t, { verdict: 'mdblocked', threat: 'EICAR Test String' });

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/respmod',
    content: Buffer.from('X5O!P%@AP'),
    filename: 'eicar.com',
  });

  assert.equal(result.verdict, 'blocked');
  assert.equal(result.statusCode, 200);
  assert.equal(result.threat, 'EICAR Test String');
  assert.equal(result.reason, 'Infected');
  assert.match(result.detail, /EICAR Test String/);
});

test('a sanitised file is approved, not refused, though it is also a 200', async (t) => {
  const stub = await withStub(t, { verdict: 'sanitized' });

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/respmod',
    content: Buffer.from('%PDF-1.4 with something stripped out'),
    filename: 'report.pdf',
  });

  assert.equal(result.verdict, 'clean', 'Allowed means allowed, whatever the status line says');
  assert.equal(result.statusCode, 200);
  assert.equal(result.modified, true, 'the caller has to know a rewritten copy came back');
  assert.match(result.detail, /rewritten/);
});

test('a wrong service path is a permanent fault, not a scanner that is down', async (t) => {
  const stub = await withStub(t, { verdict: 'error', statusCode: 404, statusText: 'Not found' });

  const result = await scan({ host: stub.host, port: stub.port, service: '/nope', content: Buffer.from('x') });

  assert.equal(result.verdict, 'error');
  assert.equal(result.permanent, true);
  assert.match(result.detail, /no service at that path/);
});

test('a method the service will not accept says which method to try', async (t) => {
  const stub = await withStub(t, { verdict: 'error', statusCode: 405, statusText: 'Method Not Allowed' });

  const result = await scan({
    host: stub.host,
    port: stub.port,
    service: '/avscan',
    method: 'reqmod',
    content: Buffer.from('x'),
  });

  assert.equal(result.verdict, 'error');
  assert.equal(result.permanent, true);
  assert.match(result.detail, /does not accept this ICAP method/);
});

test('a malformed request is reported as malformed', async (t) => {
  const stub = await withStub(t, { verdict: 'error', statusCode: 400, statusText: 'Bad request' });

  const result = await scan({ host: stub.host, port: stub.port, service: '/avscan', content: Buffer.from('x') });

  assert.equal(result.permanent, true);
  assert.match(result.detail, /malformed/);
});

test('a server-side failure stays worth retrying', async (t) => {
  const stub = await withStub(t, { verdict: 'error', statusCode: 503, statusText: 'Service Unavailable' });

  const result = await scan({ host: stub.host, port: stub.port, service: '/avscan', content: Buffer.from('x') });

  assert.equal(result.verdict, 'error');
  assert.equal(result.permanent, false);
});

test('a connection failure stays worth retrying too', async (t) => {
  const result = await scan({ host: '127.0.0.1', port: 9, service: '/avscan', content: Buffer.from('x'), timeout: 250 });
  assert.equal(result.verdict, 'error');
  assert.equal(result.permanent, false);
});
