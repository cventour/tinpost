import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { makeLab, useIcap } from './helpers.js';
import { startIcapStub } from './icap-stub.js';
import { createSmtpServer } from '../src/smtp.js';
import { createWebServer } from '../src/web/server.js';

/**
 * The scanner in place, end to end: a message only reaches a mailbox if the ICAP
 * server approved its attachments, whether it arrived over SMTP or was sent from
 * the webmail. There is no real ICAP server here, so these run against the stub in
 * icap-stub.js, which speaks the protocol back.
 */

const quiet = { info() {}, error() {} };

async function withSmtp(t, stubOptions, settings = {}) {
  const lab = await makeLab();
  const stub = stubOptions === null ? null : await startIcapStub(stubOptions);
  const smtp = createSmtpServer({ ...lab, config: lab.config, logger: quiet });
  await smtp.listen();
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.address().port, secure: false });

  useIcap(lab.db, { port: stub ? stub.port : await deadPort(), ...settings });

  t.after(async () => {
    transport.close();
    await smtp.close();
    if (stub) await stub.close();
    await lab.cleanup();
  });

  return { ...lab, stub, transport };
}

/** A port nothing is listening on, for the scanner-is-down cases. */
async function deadPort() {
  const net = await import('node:net');
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const attachment = { filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4 not really'), contentType: 'application/pdf' };

test('an attachment the scanner approves is delivered', async (t) => {
  const lab = await withSmtp(t, { verdict: 'clean' });

  await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'Approved',
    text: 'see attached',
    attachments: [attachment],
  });

  assert.equal(lab.db.listInbox('alice@lab.local').length, 1);
  assert.equal(lab.stub.requests.length, 1, 'the attachment was scanned');
  assert.deepEqual(lab.stub.requests[0].body, attachment.content);
});

test('an infected attachment is refused with a 550 and never stored', async (t) => {
  const lab = await withSmtp(t, { verdict: 'infected', threat: 'EICAR-Test-File' });

  const err = await lab.transport
    .sendMail({
      from: 'bob@corp.test',
      to: 'alice@lab.local',
      subject: 'Bad news',
      text: 'see attached',
      attachments: [{ ...attachment, filename: 'payload.exe' }],
    })
    .then(() => null, (e) => e);

  assert.ok(err, 'the send should fail');
  assert.equal(err.responseCode, 550);
  assert.match(err.response, /EICAR-Test-File/);
  assert.match(err.response, /payload\.exe/);
  assert.equal(lab.db.listInbox('alice@lab.local').length, 0, 'nothing reached the mailbox');
  assert.equal(lab.db.stats().messages, 0);
});

test('a message with no attachment is accepted without asking the scanner', async (t) => {
  const lab = await withSmtp(t, { verdict: 'infected' });

  await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'Just text',
    text: 'nothing attached',
  });

  assert.equal(lab.db.listInbox('alice@lab.local').length, 1);
  assert.equal(lab.stub.requests.length, 0, 'there was nothing to scan');
});

test('a scanner that cannot be reached holds the message with a 451', async (t) => {
  const lab = await withSmtp(t, null, { icap_timeout: 1 });

  const err = await lab.transport
    .sendMail({
      from: 'bob@corp.test',
      to: 'alice@lab.local',
      subject: 'Unscannable',
      text: 'see attached',
      attachments: [attachment],
    })
    .then(() => null, (e) => e);

  assert.ok(err);
  assert.equal(err.responseCode, 451, 'a scanner that is down is a try-again, not a rejection');
  assert.equal(lab.db.stats().messages, 0);
});

test('fail-open delivers when the scanner is down', async (t) => {
  const lab = await withSmtp(t, null, { icap_fail_mode: 'open', icap_timeout: 1 });

  await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'Unscanned but delivered',
    text: 'see attached',
    attachments: [attachment],
  });

  assert.equal(lab.db.listInbox('alice@lab.local').length, 1);
});

test('a domain excused from scanning is not held up by a blocking scanner', async (t) => {
  const lab = await withSmtp(t, { verdict: 'infected' });
  lab.db.setDomainIcap('corp.test', false);
  lab.db.setDomainIcap('lab.local', false);

  await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'Exempt',
    text: 'see attached',
    attachments: [attachment],
  });

  assert.equal(lab.db.listInbox('alice@lab.local').length, 1);
  assert.equal(lab.stub.requests.length, 0);
});

test('the preview handshake works through the whole SMTP path', async (t) => {
  const lab = await withSmtp(t, { verdict: 'clean', wantAll: true }, { icap_preview: 16 });
  const content = Buffer.alloc(4096, 0x41);

  await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'Big enough to preview',
    text: 'see attached',
    attachments: [{ filename: 'big.bin', content }],
  });

  assert.equal(lab.db.listInbox('alice@lab.local').length, 1);
  assert.equal(lab.stub.requests[0].previewLength, 16);
  assert.deepEqual(lab.stub.requests[0].body, content);
});

// ---------- the webmail side ----------

async function withWeb(t, stubOptions, settings = {}) {
  const lab = await makeLab();
  const stub = await startIcapStub(stubOptions);
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet });
  useIcap(lab.db, { port: stub.port, ...settings });

  t.after(async () => {
    await web.close();
    await stub.close();
    await lab.cleanup();
  });

  return { ...lab, stub, app: web.app };
}

const asAlice = { cookie: 'mb_addr=alice@lab.local' };

function multipart(fields, file) {
  const boundary = '----tinpostTEST';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
        'utf8',
      ),
      file.content,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('mail sent from the webmail is scanned too, and blocked mail is not sent', async (t) => {
  const lab = await withWeb(t, { verdict: 'infected', threat: 'EICAR-Test-File' });
  const form = multipart(
    { to: 'bob@corp.test', subject: 'Outbound', text: 'see attached', format: 'text' },
    { filename: 'payload.exe', contentType: 'application/octet-stream', content: Buffer.from('MZ bad') },
  );

  const res = await lab.app.inject({
    method: 'POST',
    url: '/compose',
    headers: { ...asAlice, ...form.headers },
    payload: form.body,
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /EICAR-Test-File/);
  assert.match(res.body, /was not sent/);
  assert.equal(lab.db.stats().messages, 0, 'a blocked message is not filed in Sent either');
  assert.equal(lab.stub.requests.length, 1);
});

test('mail sent from the webmail goes out once the scanner approves it', async (t) => {
  const lab = await withWeb(t, { verdict: 'clean' });
  const form = multipart(
    { to: 'bob@corp.test', subject: 'Outbound', text: 'see attached', format: 'text' },
    { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('all fine') },
  );

  const res = await lab.app.inject({
    method: 'POST',
    url: '/compose',
    headers: { ...asAlice, ...form.headers },
    payload: form.body,
  });

  assert.equal(res.statusCode, 302);
  assert.equal(lab.db.listSent('alice@lab.local').length, 1);
  assert.deepEqual(lab.stub.requests[0].body, Buffer.from('all fine'));
});

test('a plain webmail message is sent without a scan', async (t) => {
  const lab = await withWeb(t, { verdict: 'infected' });

  const res = await lab.app.inject({
    method: 'POST',
    url: '/compose',
    headers: asAlice,
    payload: { to: 'bob@corp.test', subject: 'No files', text: 'hello', format: 'text' },
  });

  assert.equal(res.statusCode, 302);
  assert.equal(lab.stub.requests.length, 0);
});

test('the admin page saves the scanner settings and tests the connection', async (t) => {
  const lab = await withWeb(t, { verdict: 'clean' });

  const saved = await lab.app.inject({
    method: 'POST',
    url: '/admin/icap',
    payload: {
      icap_enabled: '1',
      icap_host: '127.0.0.1',
      icap_port: String(lab.stub.port),
      icap_service: '/avscan',
      icap_method: 'respmod',
      icap_fail_mode: 'closed',
      icap_preview: '0',
      icap_timeout: '10',
      icap_default: '1',
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.match(saved.body, new RegExp(`icap://127.0.0.1:${lab.stub.port}/avscan`));

  const tested = await lab.app.inject({ method: 'POST', url: '/admin/icap/test' });
  assert.equal(tested.statusCode, 200);
  assert.match(tested.body, /RESPMOD/);
});

test('the admin page refuses a host that could forge a protocol header', async (t) => {
  const lab = await withWeb(t, { verdict: 'clean' });

  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/icap',
    payload: { icap_host: 'scanner\r\nX-Evil: 1' },
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /not a valid host name/);
});

test('the admin page sets scanning per domain', async (t) => {
  const lab = await withWeb(t, { verdict: 'clean' });

  const off = await lab.app.inject({
    method: 'POST',
    url: '/admin/icap/domain',
    payload: { domain: 'corp.test', scan: 'off' },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(lab.db.getDomainIcap('corp.test'), false);

  const back = await lab.app.inject({
    method: 'POST',
    url: '/admin/icap/domain',
    payload: { domain: 'corp.test', scan: 'inherit' },
  });
  assert.equal(back.statusCode, 200);
  assert.equal(lab.db.getDomainIcap('corp.test'), null);

  const bad = await lab.app.inject({
    method: 'POST',
    url: '/admin/icap/domain',
    payload: { domain: 'not a domain', scan: 'on' },
  });
  assert.equal(bad.statusCode, 400);
});

test('a wrong service path refuses with a 550, not a 451 that hides the fault', async (t) => {
  const lab = await withSmtp(t, { verdict: 'error', statusCode: 404, statusText: 'Not found' });

  const err = await lab.transport
    .sendMail({
      from: 'bob@corp.test',
      to: 'alice@lab.local',
      subject: 'Misconfigured',
      text: 'see attached',
      attachments: [attachment],
    })
    .then(() => null, (e) => e);

  assert.ok(err);
  assert.equal(err.responseCode, 550, 'a retry would never fix a wrong service path');
  assert.match(err.response, /misconfigured/);
  assert.match(err.response, /no service at that path/);
});

test('a MetaDefender-shaped block is refused with its threat name', async (t) => {
  const lab = await withSmtp(t, { verdict: 'mdblocked', threat: 'EICAR Test String' });

  const err = await lab.transport
    .sendMail({
      from: 'bob@corp.test',
      to: 'alice@lab.local',
      subject: 'Bad news',
      text: 'see attached',
      attachments: [{ ...attachment, filename: 'eicar.com' }],
    })
    .then(() => null, (e) => e);

  assert.equal(err.responseCode, 550);
  assert.match(err.response, /EICAR Test String/);
  assert.equal(lab.db.stats().messages, 0);
});

test('a sanitised attachment is delivered rather than refused', async (t) => {
  const lab = await withSmtp(t, { verdict: 'sanitized' });

  await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'Cleaned up',
    text: 'see attached',
    attachments: [attachment],
  });

  assert.equal(lab.db.listInbox('alice@lab.local').length, 1);
});
