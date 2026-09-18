import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLab, eml } from './helpers.js';
import { createWebServer } from '../src/web/server.js';

const quiet = { info() {}, error() {} };

async function withWeb(t) {
  const lab = await makeLab();
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet });
  t.after(async () => {
    await web.close();
    await lab.cleanup();
  });
  return { ...lab, app: web.app };
}

const asAlice = { cookie: 'mb_addr=alice@lab.local' };

async function seed(lab, overrides = {}) {
  return lab.delivery.deliverRaw(
    eml([
      `From: ${overrides.from ?? 'bob@corp.test'}`,
      `To: ${overrides.to ?? 'alice@lab.local'}`,
      `Subject: ${overrides.subject ?? 'Seeded'}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      overrides.html ?? '<p>Seeded <b>body</b></p>',
      '',
    ]),
    { envelopeRecipients: [overrides.to ?? 'alice@lab.local'] },
  );
}

test('the entry page asks for an address', async (t) => {
  const lab = await withWeb(t);
  const res = await lab.app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Which mailbox do you want to read/);
});

test('choosing a mailbox sets a cookie and normalises the address', async (t) => {
  const lab = await withWeb(t);
  const res = await lab.app.inject({
    method: 'POST',
    url: '/',
    payload: 'address=Alice%40Lab.Local',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/mail');
  assert.match(res.headers['set-cookie'], /mb_addr=alice@lab\.local/);
});

test('a junk address is rejected', async (t) => {
  const lab = await withWeb(t);
  const res = await lab.app.inject({
    method: 'POST',
    url: '/',
    payload: 'address=not-an-address',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /does not look like an email address/);
});

test('the inbox shows only mail for that mailbox', async (t) => {
  const lab = await withWeb(t);
  await seed(lab, { subject: 'For Alice' });
  await seed(lab, { to: 'dave@lab.local', subject: 'For Dave' });

  const alice = await lab.app.inject({ url: '/mail', headers: asAlice });
  assert.match(alice.body, /For Alice/);
  assert.doesNotMatch(alice.body, /For Dave/);

  const dave = await lab.app.inject({ url: '/mail', headers: { cookie: 'mb_addr=dave@lab.local' } });
  assert.match(dave.body, /For Dave/);
  assert.doesNotMatch(dave.body, /For Alice/);
});

test('sent mail appears in the sent folder of its author', async (t) => {
  const lab = await withWeb(t);
  await lab.delivery.deliverComposed({
    from: 'alice@lab.local',
    to: ['bob@corp.test'],
    subject: 'Outbound note',
    text: 'x',
  });

  const inbox = await lab.app.inject({ url: '/mail?folder=inbox', headers: asAlice });
  assert.doesNotMatch(inbox.body, /Outbound note/);

  const sent = await lab.app.inject({ url: '/mail?folder=sent', headers: asAlice });
  assert.match(sent.body, /Outbound note/);
});

test('without a mailbox chosen, mail routes redirect to the entry page', async (t) => {
  const lab = await withWeb(t);
  const { id } = await seed(lab);

  for (const url of ['/mail', `/mail/${id}`, `/mail/${id}/raw`, '/compose']) {
    const res = await lab.app.inject({ url });
    assert.equal(res.statusCode, 302, `${url} should redirect`);
    assert.equal(res.headers.location, '/');
  }
});

test('one mailbox cannot read another mailbox mail', async (t) => {
  const lab = await withWeb(t);
  const { id } = await seed(lab);
  const mallory = { cookie: 'mb_addr=mallory@evil.test' };

  for (const url of [`/mail/${id}`, `/mail/${id}/raw`, `/mail/${id}/html`, `/mail/${id}/attachment/1`]) {
    const res = await lab.app.inject({ url, headers: mallory });
    assert.equal(res.statusCode, 404, `${url} must not leak`);
  }
});

test('a doubly encoded cookie does not slip past validation', async (t) => {
  const lab = await withWeb(t);
  await seed(lab);
  // The cookie plugin decodes once; decoding again here would accept this.
  const res = await lab.app.inject({ url: '/mail', headers: { cookie: 'mb_addr=alice%2540lab.local' } });
  assert.equal(res.statusCode, 302);
});

test('the html part is served sandboxed with a CSP that blocks the network', async (t) => {
  const lab = await withWeb(t);
  const { id } = await seed(lab);

  const page = await lab.app.inject({ url: `/mail/${id}?view=html`, headers: asAlice });
  assert.match(page.body, /sandbox/, 'the frame must be sandboxed');

  const frame = await lab.app.inject({ url: `/mail/${id}/html`, headers: asAlice });
  assert.equal(frame.statusCode, 200);
  const csp = frame.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/, 'no script source may be allowed');
  assert.match(frame.headers['referrer-policy'], /no-referrer/);
  assert.match(frame.body, /Seeded/);
});

test('an inline image is embedded as a data uri, not fetched', async (t) => {
  const lab = await withWeb(t);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const { id } = await lab.delivery.deliverRaw(
    eml([
      'From: bob@corp.test',
      'To: alice@lab.local',
      'Subject: inline',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="B"',
      '',
      '--B',
      'Content-Type: text/html',
      '',
      '<img src="cid:logo@x"><img src="cid:missing@x">',
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
    { envelopeRecipients: ['alice@lab.local'] },
  );

  const frame = await lab.app.inject({ url: `/mail/${id}/html`, headers: asAlice });
  assert.match(frame.body, /src="data:image\/png;base64,/, 'the known cid is inlined');
  assert.match(frame.body, /src="about:blank"/, 'an unresolvable cid is neutralised');
  assert.doesNotMatch(frame.body, /cid:/, 'no cid reference is left for the browser to resolve');
});

test('an attachment always downloads and never renders', async (t) => {
  const lab = await withWeb(t);
  const stored = await lab.blobs.putBuffer('<script>alert(1)</script>');
  const { id } = await lab.delivery.deliverComposed({
    from: 'bob@corp.test',
    to: ['alice@lab.local'],
    subject: 'hostile',
    text: 'x',
    attachments: [{ ...stored, filename: 'payload.html', contentType: 'text/html' }],
  });

  const [att] = lab.db.getAttachments(id, { includeInline: false });
  const res = await lab.app.inject({ url: `/mail/${id}/attachment/${att.id}`, headers: asAlice });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.match(res.headers['content-disposition'], /^attachment;/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.rawPayload.toString(), '<script>alert(1)</script>');
});

test('the raw message downloads as a .eml', async (t) => {
  const lab = await withWeb(t);
  const { id } = await seed(lab);

  const inline = await lab.app.inject({ url: `/mail/${id}/raw`, headers: asAlice });
  assert.match(inline.headers['content-type'], /text\/plain/);
  assert.match(inline.body, /^From: bob@corp\.test/m);

  const download = await lab.app.inject({ url: `/mail/${id}/raw?download`, headers: asAlice });
  assert.match(download.headers['content-type'], /message\/rfc822/);
  assert.match(download.headers['content-disposition'], /filename="message-\d+\.eml"/);
});

test('composing delivers internally and threads a reply', async (t) => {
  const lab = await withWeb(t);
  const original = await seed(lab, { subject: 'Original' });

  const form = await lab.app.inject({ url: `/compose?reply=${original.id}`, headers: asAlice });
  assert.match(form.body, /Re: Original/);
  assert.match(form.body, /bob@corp\.test/);

  const res = await lab.app.inject({
    method: 'POST',
    url: '/compose',
    headers: { ...asAlice, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      to: 'bob@corp.test',
      cc: '',
      subject: 'Re: Original',
      format: 'text',
      text: 'my reply',
    }).toString(),
  });

  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/mail\/\d+\?sent=1$/);

  const bob = lab.db.listInbox('bob@corp.test');
  assert.equal(bob.length, 1);
  assert.equal(bob[0].subject, 'Re: Original');
  assert.equal(bob[0].thread_key, 'original', 'the reply threads with the original');
});

test('compose refuses a domain the accept policy excludes', async (t) => {
  const lab = await withWeb(t);
  lab.db.setAcceptPolicy('allowlist');
  lab.db.addDomain('lab.local');

  const res = await lab.app.inject({
    method: 'POST',
    url: '/compose',
    headers: { ...asAlice, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ to: 'dave@other.test', subject: 'x', format: 'text', text: 'x' }).toString(),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Delivery refused for dave@other\.test/);
  assert.equal(lab.db.stats().messages, 0, 'the webmail form cannot bypass the SMTP policy');
});

test('compose rejects an empty or malformed recipient list', async (t) => {
  const lab = await withWeb(t);

  const empty = await lab.app.inject({
    method: 'POST',
    url: '/compose',
    headers: { ...asAlice, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ to: '', subject: 'x', format: 'text', text: 'x' }).toString(),
  });
  assert.match(empty.body, /At least one recipient/);

  const bad = await lab.app.inject({
    method: 'POST',
    url: '/compose',
    headers: { ...asAlice, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ to: 'not-an-address', subject: 'x', format: 'text', text: 'x' }).toString(),
  });
  assert.match(bad.body, /Not a valid address/);
});

test('the since endpoint returns only newer messages', async (t) => {
  const lab = await withWeb(t);
  const first = await seed(lab, { subject: 'First' });
  await seed(lab, { subject: 'Second' });

  const res = await lab.app.inject({ url: `/api/mail/since?since=${first.id}`, headers: asAlice });
  const body = res.json();

  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].subject, 'Second');
  assert.equal(body.unread, 2);
});

test('the live stream pushes new mail to an open inbox', async (t) => {
  const lab = await withWeb(t);

  const anonymous = await lab.app.inject({ url: '/api/stream' });
  assert.equal(anonymous.statusCode, 401);

  // inject() would never resolve on an endpoint that holds the connection open,
  // so this one runs against a real socket.
  await lab.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = lab.app.server.address();
  const controller = new AbortController();
  t.after(() => controller.abort());

  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, {
    headers: { cookie: 'mb_addr=alice@lab.local' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // Mail for a different mailbox must not wake this stream; mail for Alice must.
  await seed(lab, { to: 'dave@lab.local', subject: 'Not hers' });
  const hers = await seed(lab, { subject: 'Hers' });

  let buffered = '';
  const deadline = Date.now() + 5000;
  while (!buffered.includes('event: mail') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }

  assert.match(buffered, /event: mail/, 'the stream should announce the new message');
  const announced = buffered
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)).id);
  assert.deepEqual(announced, [hers.id], 'only mail for this mailbox is announced');

  controller.abort();
});

test('the admin area is open, by design', async (t) => {
  const lab = await withWeb(t);

  // Mailboxes are readable by anyone who can reach the port, so gating the settings
  // beside them would protect nothing. This asserts the decision rather than
  // assuming it.
  for (const url of ['/admin', '/admin/domains', '/admin/mailboxes', '/admin/storage']) {
    const res = await lab.app.inject({ url });
    assert.equal(res.statusCode, 200, `${url} should be reachable`);
  }
});

test('the settings can be changed without signing in', async (t) => {
  const lab = await withWeb(t);
  await seed(lab);

  await lab.app.inject({
    method: 'POST',
    url: '/admin/policy',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'policy=allowlist',
  });
  assert.equal(lab.db.getAcceptPolicy(), 'allowlist');

  await lab.app.inject({
    method: 'POST',
    url: '/admin/domains/add',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'domain=lab.local, corp.test',
  });
  assert.deepEqual(lab.db.listDomains(), ['corp.test', 'lab.local']);
});

test('purging still needs the typed confirmation', async (t) => {
  const lab = await withWeb(t);
  await seed(lab);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };

  // Losing the password does not make the destructive control casual.
  const refused = await lab.app.inject({ method: 'POST', url: '/admin/purge', headers: form, payload: 'confirm=yes' });
  assert.equal(refused.statusCode, 400);
  assert.equal(lab.db.stats().messages, 1, 'nothing deleted without the confirmation');

  await lab.app.inject({ method: 'POST', url: '/admin/purge', headers: form, payload: 'confirm=PURGE' });
  assert.equal(lab.db.stats().messages, 0);
  assert.equal((await lab.blobs.totalSize()).count, 0, 'purge reclaims the disk too');
});

test('an invalid domain is refused rather than stored', async (t) => {
  const lab = await withWeb(t);
  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/domains/add',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'domain=not a domain',
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(lab.db.listDomains(), []);
});

test('an unknown route renders the error page rather than a stack trace', async (t) => {
  const lab = await withWeb(t);
  const res = await lab.app.inject({ url: '/no/such/page' });
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /Not found/);
  assert.doesNotMatch(res.body, /at Object|node_modules/, 'internals must not leak');
});

// ---------- mailbox autocomplete ----------

test('the mailbox suggestions list every match, prefixes first', async (t) => {
  const lab = await withWeb(t);
  for (const to of ['alice@lab.local', 'alan@lab.local', 'albert@corp.test', 'bob@corp.test']) {
    await seed(lab, { to });
  }

  const prefix = (await lab.app.inject({ url: '/api/mailboxes?q=al' })).json();
  assert.deepEqual(
    prefix.addresses,
    ['alan@lab.local', 'albert@corp.test', 'alice@lab.local'],
    'every match is offered, so the operator can choose rather than be guessed at',
  );

  // A substring that is not a prefix still matches, but ranks below one that is.
  const substring = (await lab.app.inject({ url: '/api/mailboxes?q=corp' })).json();
  assert.ok(substring.addresses.includes('albert@corp.test'));
  assert.ok(substring.addresses.includes('bob@corp.test'));

  const mixed = (await lab.app.inject({ url: '/api/mailboxes?q=bob' })).json();
  assert.equal(mixed.addresses[0], 'bob@corp.test', 'a prefix match leads');
});

test('the suggestions are case-insensitive and cope with nothing typed', async (t) => {
  const lab = await withWeb(t);
  await seed(lab, { to: 'Alice@Lab.Local' });

  const upper = (await lab.app.inject({ url: '/api/mailboxes?q=ALICE' })).json();
  assert.deepEqual(upper.addresses, ['alice@lab.local']);

  const empty = (await lab.app.inject({ url: '/api/mailboxes' })).json();
  assert.ok(Array.isArray(empty.addresses));
});

test('the suggestion list is capped so a big lab cannot flood the field', async (t) => {
  const lab = await withWeb(t);
  for (let i = 0; i < 30; i += 1) await seed(lab, { to: `user${i}@lab.local` });

  const res = (await lab.app.inject({ url: '/api/mailboxes?q=user' })).json();
  assert.equal(res.addresses.length, 20);
});

test('the entry field is a text input, because completion needs selection', async (t) => {
  const lab = await withWeb(t);
  const res = await lab.app.inject({ url: '/' });

  // An email input forbids setSelectionRange, which silently breaks inline completion.
  assert.match(res.body, /name="address"/);
  assert.doesNotMatch(res.body, /type="email" name="address"/);
  assert.match(res.body, /role="combobox"/);
});
