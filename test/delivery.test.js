import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLab, eml } from './helpers.js';

test('a message received over the wire lands in the recipient mailbox', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  await lab.delivery.deliverRaw(
    eml(['From: bob@corp.test', 'To: alice@lab.local', 'Subject: Hello', '', 'Hi Alice', '']),
    { envelopeRecipients: ['alice@lab.local'] },
  );

  const inbox = lab.db.listInbox('alice@lab.local');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].subject, 'Hello');
  assert.equal(lab.db.listInbox('someone@else.test').length, 0);
});

test('an envelope-only recipient still receives the mail, recorded as bcc', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  // This is how bcc works on the wire: the address appears in RCPT TO but in no header.
  const { id } = await lab.delivery.deliverRaw(
    eml(['From: bob@corp.test', 'To: alice@lab.local', 'Subject: Quiet copy', '', 'body', '']),
    { envelopeRecipients: ['alice@lab.local', 'watcher@lab.local'] },
  );

  assert.equal(lab.db.listInbox('watcher@lab.local').length, 1);
  const kinds = Object.fromEntries(lab.db.getRecipients(id).map((r) => [r.address, r.kind]));
  assert.equal(kinds['alice@lab.local'], 'to');
  assert.equal(kinds['watcher@lab.local'], 'bcc');
});

test('composing and receiving produce the same stored shape', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const composed = await lab.delivery.deliverComposed({
    from: 'alice@lab.local',
    to: ['bob@corp.test'],
    subject: 'Same shape',
    text: 'body text',
  });

  const received = await lab.delivery.deliverRaw(
    eml([
      'From: alice@lab.local',
      'To: bob@corp.test',
      'Subject: Same shape',
      '',
      'body text',
      '',
    ]),
    { envelopeRecipients: ['bob@corp.test'] },
  );

  const a = lab.db.getMessage(composed.id);
  const b = lab.db.getMessage(received.id);

  for (const field of ['from_addr', 'subject', 'body_text']) {
    assert.equal(a[field].trim(), b[field].trim(), `${field} should match`);
  }
  assert.equal(a.origin, 'webmail');
  assert.equal(b.origin, 'smtp');

  // Both are visible to the same mailboxes, which is what "one delivery path" buys.
  assert.equal(lab.db.listInbox('bob@corp.test').length, 2);
  assert.equal(lab.db.listSent('alice@lab.local').length, 2);
});

test('a composed message is a real RFC822 message that parses back', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const att = await lab.blobs.putBuffer('report,bytes\n');
  const { id } = await lab.delivery.deliverComposed({
    from: 'alice@lab.local',
    to: ['bob@corp.test'],
    cc: ['carol@corp.test'],
    subject: 'Quarterly',
    html: '<p>Please see <b>attached</b>.</p>',
    attachments: [{ ...att, filename: 'report.csv', contentType: 'text/csv' }],
  });

  const raw = (await lab.blobs.read(lab.db.getMessage(id).raw_hash)).toString();
  assert.match(raw, /^From: alice@lab\.local/m);
  assert.match(raw, /^Cc: carol@corp\.test/m);
  assert.match(raw, /Content-Type: multipart\//);
  assert.match(raw, /filename=.?report\.csv/);

  const stored = lab.db.getAttachments(id, { includeInline: false });
  assert.equal(stored.length, 1);
  assert.equal((await lab.blobs.read(stored[0].content_hash)).toString(), 'report,bytes\n');
});

test('an html-only message still has readable text', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const { id } = await lab.delivery.deliverRaw(
    eml([
      'From: a@x.test',
      'To: b@y.test',
      'Subject: html only',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<h1>Notice</h1><p>Read <b>this</b>.</p>',
      '',
    ]),
    { envelopeRecipients: ['b@y.test'] },
  );

  const m = lab.db.getMessage(id);
  assert.ok(m.html_hash, 'the html part is stored');
  assert.match(m.body_text, /Notice/i); // the generated text uppercases headings
  assert.match(m.body_text, /Read this/);
});

test('delivery emits an event naming every affected mailbox', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const seen = [];
  lab.delivery.on('message', (m) => seen.push(m));

  await lab.delivery.deliverComposed({
    from: 'alice@lab.local',
    to: ['bob@corp.test'],
    cc: ['carol@corp.test'],
    subject: 'ping',
    text: 'x',
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(
    [...seen[0].addresses].sort(),
    ['alice@lab.local', 'bob@corp.test', 'carol@corp.test'],
  );
});

test('a mailbox can only see its own mail', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const { id } = await lab.delivery.deliverRaw(
    eml(['From: bob@corp.test', 'To: alice@lab.local', 'Subject: private', '', 'x', '']),
    { envelopeRecipients: ['alice@lab.local'] },
  );

  assert.equal(lab.db.canAccess('alice@lab.local', id), true, 'the recipient can read it');
  assert.equal(lab.db.canAccess('bob@corp.test', id), true, 'the sender can read it');
  assert.equal(lab.db.canAccess('mallory@evil.test', id), false, 'nobody else can');
});

test('unread counts track what has been opened', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const first = await lab.delivery.deliverRaw(
    eml(['From: b@x.test', 'To: a@y.test', 'Subject: one', '', 'x', '']),
    { envelopeRecipients: ['a@y.test'] },
  );
  await lab.delivery.deliverRaw(
    eml(['From: b@x.test', 'To: a@y.test', 'Subject: two', '', 'x', '']),
    { envelopeRecipients: ['a@y.test'] },
  );

  assert.equal(lab.db.unreadCount('a@y.test'), 2);
  lab.db.markSeen('a@y.test', first.id);
  assert.equal(lab.db.unreadCount('a@y.test'), 1);
});

test('deleting a mailbox removes its mail and frees the blobs', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const att = await lab.blobs.putBuffer('some attachment bytes');
  await lab.delivery.deliverComposed({
    from: 'alice@lab.local',
    to: ['bob@corp.test'],
    subject: 'goes away',
    text: 'x',
    attachments: [{ ...att, filename: 'a.txt', contentType: 'text/plain' }],
  });

  assert.ok((await lab.blobs.totalSize()).count > 0);

  lab.db.deleteMailbox('bob@corp.test');
  const gc = await lab.blobs.gc(lab.db.referencedHashes());

  assert.equal(lab.db.listInbox('bob@corp.test').length, 0);
  assert.ok(gc.removed > 0, 'orphaned blobs are reclaimed');
  assert.equal((await lab.blobs.totalSize()).count, 0, 'nothing is left on disk');
});

test('purge empties everything', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  for (const s of ['a', 'b', 'c']) {
    await lab.delivery.deliverRaw(
      eml(['From: x@x.test', 'To: y@y.test', `Subject: ${s}`, '', 'body', '']),
      { envelopeRecipients: ['y@y.test'] },
    );
  }

  assert.equal(lab.db.stats().messages, 3);
  lab.db.purgeAll();
  await lab.blobs.gc(lab.db.referencedHashes());

  assert.equal(lab.db.stats().messages, 0);
  assert.equal(lab.db.getRecipients(1).length, 0, 'cascade removed the recipient rows');
  assert.equal((await lab.blobs.totalSize()).count, 0);
});
