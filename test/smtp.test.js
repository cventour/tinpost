import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { makeLab } from './helpers.js';
import { createSmtpServer } from '../src/smtp.js';

const quiet = { info() {}, error() {} };

async function withSmtp(t, overrides) {
  const lab = await makeLab(overrides);
  const smtp = createSmtpServer({ ...lab, config: lab.config, logger: quiet });
  await smtp.listen();
  const port = smtp.address().port;
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false });

  t.after(async () => {
    transport.close();
    await smtp.close();
    await lab.cleanup();
  });

  return { ...lab, transport, port };
}

test('mail sent over SMTP is stored and readable', async (t) => {
  const lab = await withSmtp(t);

  await lab.transport.sendMail({
    from: '"Bob Smith" <bob@corp.test>',
    to: 'alice@lab.local',
    subject: 'Over the wire',
    text: 'hello from smtp',
  });

  const inbox = lab.db.listInbox('alice@lab.local');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].subject, 'Over the wire');
  assert.equal(inbox[0].from_name, 'Bob Smith');
  assert.equal(inbox[0].origin, 'smtp');
});

test('every recipient of one message gets it', async (t) => {
  const lab = await withSmtp(t);

  await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local, dave@lab.local',
    cc: 'carol@other.test',
    subject: 'Group note',
    text: 'x',
  });

  for (const who of ['alice@lab.local', 'dave@lab.local', 'carol@other.test']) {
    assert.equal(lab.db.listInbox(who).length, 1, `${who} should have it`);
  }
  assert.equal(lab.db.stats().messages, 1, 'stored once, not once per recipient');
});

test('the default policy accepts any domain', async (t) => {
  const lab = await withSmtp(t);

  assert.equal(lab.db.getAcceptPolicy(), 'any');
  const info = await lab.transport.sendMail({
    from: 'x@somewhere.invalid',
    to: 'anyone@never-heard-of.test',
    subject: 'catch all',
    text: 'x',
  });
  assert.deepEqual(info.accepted, ['anyone@never-heard-of.test']);
});

test('the allowlist policy refuses other domains with a 550', async (t) => {
  const lab = await withSmtp(t);
  lab.db.setAcceptPolicy('allowlist');
  lab.db.addDomain('lab.local');

  await assert.rejects(
    () =>
      lab.transport.sendMail({
        from: 'bob@corp.test',
        to: 'dave@other.test',
        subject: 'nope',
        text: 'x',
      }),
    (err) => {
      assert.equal(err.responseCode, 550);
      assert.match(err.response, /Relay denied for other\.test/);
      return true;
    },
  );

  // The allowlisted domain still works, so the refusal is selective.
  const ok = await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'yes',
    text: 'x',
  });
  assert.deepEqual(ok.accepted, ['alice@lab.local']);
  assert.equal(lab.db.stats().messages, 1, 'the refused message was never stored');
});

test('an allowlist entry is matched however it was typed', async (t) => {
  const lab = await withSmtp(t);
  lab.db.setAcceptPolicy('allowlist');
  lab.db.addDomain('  @LAB.Local  ');

  const ok = await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'Alice@Lab.Local',
    subject: 'case and stray @',
    text: 'x',
  });
  assert.equal(ok.accepted.length, 1);
});

test('an attachment survives the SMTP round trip byte for byte', async (t) => {
  const lab = await withSmtp(t);

  const payload = Buffer.alloc(120_000);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 13) % 256;

  await lab.transport.sendMail({
    from: 'bob@corp.test',
    to: 'alice@lab.local',
    subject: 'with payload',
    text: 'see attached',
    attachments: [{ filename: 'payload.bin', content: payload }],
  });

  const [msg] = lab.db.listInbox('alice@lab.local');
  const [att] = lab.db.getAttachments(msg.id, { includeInline: false });
  assert.equal(att.filename, 'payload.bin');
  assert.equal(att.size_bytes, payload.length);
  assert.deepEqual(await lab.blobs.read(att.content_hash), payload);
});

test('a message over the size limit is refused', async (t) => {
  const lab = await withSmtp(t, { maxSize: 20_000 });

  await assert.rejects(
    () =>
      lab.transport.sendMail({
        from: 'bob@corp.test',
        to: 'alice@lab.local',
        subject: 'too big',
        text: 'x',
        attachments: [{ filename: 'big.bin', content: Buffer.alloc(200_000) }],
      }),
    (err) => {
      assert.ok([552, 552.5, 500].includes(err.responseCode) || /size/i.test(err.message));
      return true;
    },
  );

  assert.equal(lab.db.stats().messages, 0);
  assert.equal((await lab.blobs.totalSize()).count, 0, 'no partial blob is kept');
});
