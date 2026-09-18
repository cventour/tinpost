import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, threadKeyFor, htmlToText } from '../src/parse.js';
import { eml } from './helpers.js';

test('a plain message yields sender, recipients and body', async () => {
  const parsed = await parseMessage(
    eml([
      'From: Bob Smith <bob@corp.test>',
      'To: alice@lab.local, carol@lab.local',
      'Subject: Status update',
      'Message-ID: <abc123@corp.test>',
      'Date: Tue, 01 Sep 2026 10:00:00 +0000',
      '',
      'All good here.',
      '',
    ]),
  );

  assert.equal(parsed.fromAddr, 'bob@corp.test');
  assert.equal(parsed.fromName, 'Bob Smith');
  assert.equal(parsed.subject, 'Status update');
  assert.equal(parsed.messageId, 'abc123@corp.test');
  assert.deepEqual(
    parsed.recipients.map((r) => r.address),
    ['alice@lab.local', 'carol@lab.local'],
  );
  assert.match(parsed.bodyText, /All good here/);
  assert.equal(parsed.html, null);
});

test('addresses are lower-cased so a mailbox is found however it was typed', async () => {
  const parsed = await parseMessage(
    eml(['From: BOB@CORP.TEST', 'To: Alice@Lab.Local', 'Subject: x', '', 'y', '']),
  );
  assert.equal(parsed.fromAddr, 'bob@corp.test');
  assert.equal(parsed.recipients[0].address, 'alice@lab.local');
});

test('cc and bcc keep their kind', async () => {
  const parsed = await parseMessage(
    eml([
      'From: a@x.test',
      'To: b@y.test',
      'Cc: c@y.test',
      'Bcc: d@y.test',
      'Subject: kinds',
      '',
      'body',
      '',
    ]),
  );
  assert.deepEqual(
    parsed.recipients.map((r) => [r.address, r.kind]),
    [
      ['b@y.test', 'to'],
      ['c@y.test', 'cc'],
      ['d@y.test', 'bcc'],
    ],
  );
});

test('RFC2047-encoded headers are decoded', async () => {
  const parsed = await parseMessage(
    eml([
      'From: =?UTF-8?B?Q2hyaXN0b3M=?= <c@x.test>',
      'To: a@y.test',
      'Subject: =?UTF-8?Q?Caf=C3=A9_meeting?=',
      '',
      'body',
      '',
    ]),
  );
  assert.equal(parsed.subject, 'Café meeting');
  assert.equal(parsed.fromName, 'Christos');
});

test('multipart/alternative gives both a text and an html part', async () => {
  const parsed = await parseMessage(
    eml([
      'From: a@x.test',
      'To: b@y.test',
      'Subject: both',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain version',
      '--B',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>rich version</p>',
      '--B--',
      '',
    ]),
  );
  assert.match(parsed.bodyText, /plain version/);
  assert.match(parsed.html, /rich version/);
});

test('attachments are extracted with their bytes intact', async () => {
  const payload = Buffer.from('id,name\n1,alice\n');
  const parsed = await parseMessage(
    eml([
      'From: a@x.test',
      'To: b@y.test',
      'Subject: with file',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'see attached',
      '--B',
      'Content-Type: text/csv; name="people.csv"',
      'Content-Disposition: attachment; filename="people.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      payload.toString('base64'),
      '--B--',
      '',
    ]),
  );

  assert.equal(parsed.attachments.length, 1);
  const [att] = parsed.attachments;
  assert.equal(att.filename, 'people.csv');
  assert.equal(att.contentType, 'text/csv');
  assert.equal(att.isInline, false);
  assert.deepEqual(att.content, payload);
});

test('an inline cid part is marked inline and keeps its content id', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const parsed = await parseMessage(
    eml([
      'From: a@x.test',
      'To: b@y.test',
      'Subject: inline image',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="B"',
      '',
      '--B',
      'Content-Type: text/html',
      '',
      '<img src="cid:logo@x">',
      '--B',
      'Content-Type: image/png',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-ID: <logo@x>',
      'Content-Transfer-Encoding: base64',
      '',
      png.toString('base64'),
      '--B--',
      '',
    ]),
  );

  const [att] = parsed.attachments;
  assert.equal(att.isInline, true);
  assert.equal(att.contentId, 'logo@x');
  assert.equal(att.contentType, 'image/png');
});

test('thread keys strip reply and forward prefixes', () => {
  assert.equal(threadKeyFor('Re: Q3 numbers'), 'q3 numbers');
  assert.equal(threadKeyFor('RE: Fwd: Q3 numbers'), 'q3 numbers');
  assert.equal(threadKeyFor('Re[2]: Q3 numbers'), 'q3 numbers');
  assert.equal(threadKeyFor(''), '(no subject)');
  assert.equal(threadKeyFor('Q3   numbers '), 'q3 numbers');
});

test('html is reduced to readable text for the plain-text view', () => {
  const text = htmlToText(
    '<style>p{color:red}</style><script>evil()</script><h1>Title</h1><p>Hello <b>you</b></p><br><ul><li>one</li></ul>',
  );
  assert.doesNotMatch(text, /evil\(\)/, 'script contents must not leak into the text view');
  assert.doesNotMatch(text, /color:red/, 'stylesheet contents must not leak either');
  assert.match(text, /Title/);
  assert.match(text, /Hello you/);
  assert.match(text, /- one/);
});

test('html entities are decoded rather than shown raw', () => {
  assert.equal(htmlToText('<p>Tom &amp; Jerry &lt;tag&gt; &quot;q&quot;</p>'), 'Tom & Jerry <tag> "q"');
});
