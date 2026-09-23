import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import nodemailer from 'nodemailer';
import { makeLab } from './helpers.js';
import { createSmtpServer } from '../src/smtp.js';
import { LogBuffer, recordingLogger } from '../src/logbuf.js';

const quiet = { info() {}, error() {} };

async function withSmtp(t, { auth } = {}) {
  const lab = await makeLab();
  const logs = new LogBuffer();
  if (auth !== undefined) lab.db.setSetting('smtp_auth', auth ? '1' : '0');
  const smtp = createSmtpServer({ ...lab, config: lab.config, logger: recordingLogger(quiet, logs) });
  await smtp.listen();
  t.after(async () => {
    await smtp.close();
    await lab.cleanup();
  });
  return { ...lab, logs, smtp, port: smtp.address().port };
}

/** One command at a time, because the server refuses anything sent before its greeting. */
function speak(port, commands) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const replies = [];
    let buffer = '';
    let sent = 0;

    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('the listener did not answer')));

    const replyEnd = () => {
      let at = 0;
      for (;;) {
        const nl = buffer.indexOf('\r\n', at);
        if (nl === -1) return -1;
        if (/^\d{3}[ ]/.test(buffer.slice(at, nl)) || /^\d{3}$/.test(buffer.slice(at, nl))) return nl + 2;
        at = nl + 2;
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end = replyEnd(); end !== -1; end = replyEnd()) {
        replies.push(buffer.slice(0, end));
        buffer = buffer.slice(end);
        if (sent < commands.length) socket.write(`${commands[sent++]}\r\n`);
        else socket.end();
      }
    });
    socket.on('close', () => resolve(replies.join('')));
    socket.on('error', reject);
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('AUTH is advertised, with every mechanism a client might ask for', async (t) => {
  const lab = await withSmtp(t);
  const wire = await speak(lab.port, ['EHLO client.test', 'QUIT']);

  assert.match(wire, /250[- ]AUTH /, `no AUTH line in ${JSON.stringify(wire)}`);
  for (const method of ['PLAIN', 'LOGIN', 'CRAM-MD5', 'XOAUTH2']) {
    assert.match(wire, new RegExp(`AUTH[^\\r\\n]*${method}`), `${method} should be offered`);
  }
  // Still no TLS: a lab sender must never be asked for a certificate it cannot have.
  assert.doesNotMatch(wire, /STARTTLS/);
});

test('any password at all is accepted over AUTH LOGIN', async (t) => {
  const lab = await withSmtp(t);
  const wire = await speak(lab.port, [
    'EHLO client.test',
    'AUTH LOGIN',
    b64('anyone@nowhere.test'),
    b64('not-a-real-password'),
    'QUIT',
  ]);

  assert.match(wire, /235 .*[Aa]uthenticat/, `expected acceptance in ${JSON.stringify(wire)}`);
  const lines = lab.logs.select({ channel: 'smtp' }).map((l) => l.text);
  assert.ok(
    lines.some((t2) => /authenticated anyone@nowhere\.test via LOGIN/.test(t2)),
    `the username should be logged; got ${JSON.stringify(lines)}`,
  );
});

test('AUTH PLAIN is accepted, and mail then delivers', async (t) => {
  const lab = await withSmtp(t);
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: lab.port,
    secure: false,
    auth: { user: 'whoever@corp.test', pass: 'anything' },
    tls: { rejectUnauthorized: false },
  });

  const info = await transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'Authenticated',
    text: 'body',
  });
  assert.match(info.response, /250 Message queued/);
});

test('authentication stays optional — a sender that skips it is still accepted', async (t) => {
  const lab = await withSmtp(t);
  const wire = await speak(lab.port, [
    'EHLO client.test',
    'MAIL FROM:<bob@corp.test>',
    'RCPT TO:<alice@lab.local>',
    'DATA',
    ['From: bob@corp.test', 'To: alice@lab.local', 'Subject: Unauthenticated', '', 'body', '.'].join('\r\n'),
    'QUIT',
  ]);
  assert.match(wire, /250 Message queued as \d+/);
});

test('the offer can be withdrawn, and then AUTH is refused outright', async (t) => {
  const lab = await withSmtp(t, { auth: false });
  const wire = await speak(lab.port, ['EHLO client.test', 'AUTH LOGIN', 'QUIT']);

  assert.doesNotMatch(wire, /AUTH/);
  assert.match(wire, /500 Error: command not recognized/);
});

test('switching the offer on reaches the listener without a restart', async (t) => {
  const lab = await withSmtp(t, { auth: false });
  assert.doesNotMatch(await speak(lab.port, ['EHLO client.test', 'QUIT']), /AUTH/);

  lab.db.setSetting('smtp_auth', '1');
  lab.smtp.refresh();

  assert.match(await speak(lab.port, ['EHLO client.test', 'QUIT']), /250[- ]AUTH /);
});
