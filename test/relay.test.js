import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import nodemailer from 'nodemailer';
import { makeLab, eml } from './helpers.js';
import { Delivery, RelayLoop } from '../src/delivery.js';
import { relayConfig, planRoute, isFromGateway, HOP_HEADER } from '../src/relay.js';
import { validateSetting, readDisplayValue } from '../src/settings.js';
import { createSmtpServer } from '../src/smtp.js';
import { createWebServer } from '../src/web/server.js';

/**
 * The upstream relay, end to end. There is no OPSWAT gateway here, so a stub SMTP
 * server stands in for it: it records what it was handed and, when asked to, sends
 * it back to Tinpost the way the real gateway does after scanning.
 */

const quiet = { info() {}, error() {}, debug() {} };

/** A stand-in gateway. `reject` refuses every recipient; `auth` demands a login. */
async function startGateway({ reject = false, auth = null, forwardTo = null } = {}) {
  const received = [];
  const server = new SMTPServer({
    disabledCommands: auth ? ['STARTTLS'] : ['AUTH', 'STARTTLS'],
    authOptional: !auth,
    allowInsecureAuth: true,
    logger: false,
    onAuth(a, session, cb) {
      if (a.username === auth.user && a.password === auth.pass) return cb(null, { user: a.username });
      return cb(new Error('Authentication credentials invalid'));
    },
    onRcptTo(address, session, cb) {
      if (!reject) return cb();
      const err = new Error('5.7.1 Relaying denied by policy');
      err.responseCode = 550;
      return cb(err);
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks);
        const message = {
          from: session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
          user: session.user,
        };
        received.push(message);
        // The gateway's second half: scanned, and sent back inside.
        if (forwardTo) {
          const back = nodemailer.createTransport({ host: '127.0.0.1', port: forwardTo(), secure: false, ignoreTLS: true });
          await back.sendMail({ envelope: { from: message.from, to: message.to }, raw });
          back.close();
        }
        cb();
      });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.server.address().port,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A port nothing is listening on. */
async function deadPort() {
  const net = await import('node:net');
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function useRelay(db, { port, localDomains = 'lab.local', ...rest }) {
  db.setSetting('relay_enabled', '1');
  db.setSetting('relay_host', '127.0.0.1');
  db.setSetting('relay_port', String(port));
  db.setSetting('relay_local_domains', localDomains);
  db.setSetting('relay_timeout', '5');
  for (const [key, value] of Object.entries(rest)) db.setSetting(key, String(value));
}

async function labWithGateway(t, gatewayOptions = {}, relaySettings = {}) {
  const lab = await makeLab();
  const gateway = await startGateway(gatewayOptions);
  useRelay(lab.db, { port: gateway.port, ...relaySettings });
  t.after(async () => {
    await gateway.close();
    await lab.cleanup();
  });
  return { ...lab, gateway };
}

// ---------- routing rules ----------

test('only a local sender writing outside their own domain is relayed', () => {
  const config = { enabled: true, localDomains: ['lab.local', 'corp.test'] };
  assert.deepEqual(planRoute(config, { from: 'a@lab.local', recipients: ['b@lab.local', 'c@gmail.com', 'd@corp.test'] }), {
    local: ['b@lab.local'],
    relay: ['c@gmail.com', 'd@corp.test'],
  });
  assert.deepEqual(planRoute(config, { from: 'x@elsewhere.test', recipients: ['a@lab.local'] }), {
    local: ['a@lab.local'],
    relay: [],
  });
  assert.deepEqual(planRoute({ ...config, enabled: false }, { from: 'a@lab.local', recipients: ['c@gmail.com'] }), {
    local: ['c@gmail.com'],
    relay: [],
  });
});

test('the gateway is recognised by IP or by host name, and defaults to the upstream address', async () => {
  const config = { enabled: true, returnHosts: ['10.0.0.5', 'gw.lab.local'] };
  const resolve = async (name) => (name === 'gw.lab.local' ? [{ address: '10.0.0.9' }] : []);
  assert.equal(await isFromGateway(config, '10.0.0.5', { resolve }), true);
  assert.equal(await isFromGateway(config, '::ffff:10.0.0.9', { resolve }), true);
  assert.equal(await isFromGateway(config, '10.0.0.6', { resolve }), false);
  assert.equal(await isFromGateway({ ...config, enabled: false }, '10.0.0.5', { resolve }), false);

  const lab = await makeLab();
  try {
    useRelay(lab.db, { port: 25 });
    assert.deepEqual(relayConfig(lab.db).returnHosts, ['127.0.0.1']);
  } finally {
    await lab.cleanup();
  }
});

test('the list settings are validated and tidied, and the password is never displayed', async () => {
  assert.deepEqual(validateSetting('relay_local_domains', 'Lab.Local,  corp.test\nlab.local'), {
    ok: true,
    value: 'lab.local, corp.test',
  });
  assert.equal(validateSetting('relay_local_domains', 'not a domain!').ok, false);
  assert.equal(validateSetting('relay_return_hosts', '10.0.0.5 gw.lab.local').ok, true);

  const lab = await makeLab();
  try {
    lab.db.setSetting('relay_pass', 'hunter2');
    assert.equal(readDisplayValue(lab.db, 'relay_pass'), '');
  } finally {
    await lab.cleanup();
  }
});

// ---------- delivery ----------

test('mail within one domain is delivered directly and never reaches the gateway', async (t) => {
  const lab = await labWithGateway(t);
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['bob@lab.local'], subject: 'Inside', text: 'hi' });

  assert.equal(lab.gateway.received.length, 0);
  assert.equal(lab.db.listInbox('bob@lab.local').length, 1);
  assert.equal(lab.db.listInbox('bob@lab.local')[0].relay_status, null);
});

test('outbound mail goes to the gateway, and the recipient gets it only when it comes back', async (t) => {
  const lab = await labWithGateway(t);
  const sent = await lab.delivery.deliverComposed({
    from: 'alice@lab.local',
    to: ['carol@partner.test'],
    subject: 'Quarterly numbers',
    text: 'attached',
  });

  assert.equal(lab.gateway.received.length, 1);
  const handed = lab.gateway.received[0];
  assert.equal(handed.from, 'alice@lab.local');
  assert.deepEqual(handed.to, ['carol@partner.test']);
  assert.match(handed.raw.toString(), new RegExp(`^${HOP_HEADER}: `));

  // The sender has their copy, marked as waiting on the gateway; the recipient has nothing yet.
  const sender = lab.db.listSent('alice@lab.local');
  assert.equal(sender.length, 1);
  assert.equal(sender[0].relay_status, 'relayed');
  assert.equal(lab.db.listInbox('carol@partner.test').length, 0);
  assert.equal(lab.db.canAccess('carol@partner.test', sent.id), false);
  assert.deepEqual(sent.addresses, ['alice@lab.local']);

  // The gateway sends back what it scanned.
  await lab.delivery.deliverRaw(handed.raw, {
    envelopeRecipients: handed.to,
    envelopeFrom: handed.from,
    fromGateway: true,
  });
  const inbox = lab.db.listInbox('carol@partner.test');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].relay_status, 'returned');
  assert.equal(lab.gateway.received.length, 1, 'the returned copy is not relayed again');
  assert.equal(lab.db.listSent('alice@lab.local').length, 1, 'the sender does not get a second copy');
});

test('a mixed message is split: same-domain recipients directly, the rest through the gateway', async (t) => {
  const lab = await labWithGateway(t);
  await lab.delivery.deliverComposed({
    from: 'alice@lab.local',
    to: ['bob@lab.local', 'carol@partner.test'],
    subject: 'Mixed',
    text: 'hi',
  });

  assert.deepEqual(lab.gateway.received[0].to, ['carol@partner.test']);
  assert.equal(lab.db.listInbox('bob@lab.local').length, 1);
  assert.equal(lab.db.listInbox('carol@partner.test').length, 0);

  // Returned for carol only, so bob does not get it twice.
  const handed = lab.gateway.received[0];
  await lab.delivery.deliverRaw(handed.raw, { envelopeRecipients: handed.to, envelopeFrom: handed.from, fromGateway: true });
  assert.equal(lab.db.listInbox('bob@lab.local').length, 1);
  assert.equal(lab.db.listInbox('carol@partner.test').length, 1);
});

test('ICAP is skipped for relayed mail and still runs for mail within a domain', async (t) => {
  const lab = await labWithGateway(t);
  const calls = [];
  const scanner = { check: async (m) => calls.push(m.recipients) };
  const delivery = new Delivery({ db: lab.db, blobs: lab.blobs, maxSize: lab.config.maxSize, scanner, logger: quiet });

  await delivery.deliverComposed({ from: 'alice@lab.local', to: ['carol@partner.test'], subject: 'Out', text: 'x' });
  assert.equal(calls.length, 0);

  await delivery.deliverComposed({ from: 'alice@lab.local', to: ['bob@lab.local', 'carol@partner.test'], subject: 'Both', text: 'x' });
  assert.deepEqual(calls, [['bob@lab.local']]);

  const handed = lab.gateway.received.at(-1);
  await delivery.deliverRaw(handed.raw, { envelopeRecipients: handed.to, envelopeFrom: handed.from, fromGateway: true });
  assert.equal(calls.length, 1, 'the returned copy is not scanned again');
});

test('when the gateway is unreachable, the message is delivered locally with the error in a footnote', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());
  useRelay(lab.db, { port: await deadPort() });

  await lab.delivery.deliverComposed({
    from: 'alice@lab.local',
    to: ['carol@partner.test'],
    subject: 'Nobody home',
    text: 'Original body.',
    html: '<html><body><p>Original body.</p></body></html>',
  });

  const inbox = lab.db.listInbox('carol@partner.test');
  assert.equal(inbox.length, 1);
  const m = inbox[0];
  assert.equal(m.relay_status, 'failed');
  assert.match(m.relay_detail, /ECONNECTION|ECONNREFUSED/);
  assert.match(m.body_text, /Original body\./);
  assert.match(m.body_text, /could not deliver this message through the upstream gateway/);
  assert.match(m.body_text, /Recipients affected: carol@partner\.test/);
  assert.match(m.body_text, /Error: .*(ECONNECTION|ECONNREFUSED)/);

  const html = (await lab.blobs.read(m.html_hash)).toString();
  assert.match(html, /could not deliver this message through the upstream gateway.*<\/p><\/body>/s);
  const raw = (await lab.blobs.read(m.raw_hash)).toString();
  assert.match(raw, /X-Tinpost-Relay-Failed:/);
});

test('a refusal from the gateway is quoted in the footnote, reply code and all', async (t) => {
  const lab = await labWithGateway(t, { reject: true });
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['carol@partner.test'], subject: 'Denied', text: 'x' });

  const m = lab.db.listInbox('carol@partner.test')[0];
  assert.equal(m.relay_status, 'failed');
  assert.match(m.body_text, /550/);
  assert.match(m.body_text, /Relaying denied by policy/);
});

test('authentication: the right login relays, the wrong one fails with the reason in the footnote', async (t) => {
  const lab = await labWithGateway(t, { auth: { user: 'tinpost', pass: 's3cret' } }, {
    relay_auth: '1',
    relay_user: 'tinpost',
    relay_pass: 's3cret',
  });
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['carol@partner.test'], subject: 'Good', text: 'x' });
  assert.equal(lab.gateway.received.length, 1);
  assert.equal(lab.gateway.received[0].user, 'tinpost');

  lab.db.setSetting('relay_pass', 'wrong');
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['dave@partner.test'], subject: 'Bad', text: 'x' });
  const m = lab.db.listInbox('dave@partner.test')[0];
  assert.equal(m.relay_status, 'failed');
  assert.match(m.body_text, /EAUTH/);
});

test('a message that has already been relayed and did not come from the gateway is refused as a loop', async (t) => {
  const lab = await labWithGateway(t);
  const looped = eml([
    `${HOP_HEADER}: tinpost; Wed, 23 Sep 2026 10:00:00 GMT`,
    'From: alice@lab.local',
    'To: carol@partner.test',
    'Subject: Round and round',
    '',
    'again',
  ]);
  await assert.rejects(
    lab.delivery.deliverRaw(looped, { envelopeRecipients: ['carol@partner.test'], envelopeFrom: 'alice@lab.local' }),
    RelayLoop,
  );
  assert.equal(lab.gateway.received.length, 0);
});

// ---------- over the wire ----------

test('SMTP from a local sender is relayed, even to a domain not on the allowlist', async (t) => {
  const lab = await makeLab();
  const smtp = createSmtpServer({ ...lab, config: lab.config, logger: quiet });
  await smtp.listen();
  const gateway = await startGateway();
  // The test client connects from loopback too, so the gateway is placed elsewhere.
  useRelay(lab.db, { port: gateway.port, relay_return_hosts: '10.9.9.9' });
  lab.db.setAcceptPolicy('allowlist');
  lab.db.addDomain('lab.local');

  const client = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.address().port, secure: false });
  t.after(async () => {
    client.close();
    await gateway.close();
    await smtp.close();
    await lab.cleanup();
  });

  await client.sendMail({ from: 'alice@lab.local', to: 'carol@partner.test', subject: 'Over the wire', text: 'hello' });
  assert.equal(gateway.received.length, 1);
  assert.deepEqual(gateway.received[0].to, ['carol@partner.test']);
  assert.equal(lab.db.listSent('alice@lab.local')[0].relay_status, 'relayed');
  assert.equal(lab.db.listInbox('carol@partner.test').length, 0);

  // An outsider writing to another outsider is still refused by the allowlist.
  await assert.rejects(
    client.sendMail({ from: 'mallory@evil.test', to: 'carol@partner.test', subject: 'No', text: 'x' }),
    (err) => err.responseCode === 550,
  );
});

test('the full round trip: webmail out to the gateway, and back over SMTP to the recipient', async (t) => {
  const lab = await makeLab();
  const smtp = createSmtpServer({ ...lab, config: lab.config, logger: quiet });
  await smtp.listen();
  // The gateway sends back from 127.0.0.1, which is the relay host, so it is trusted.
  const gateway = await startGateway({ forwardTo: () => smtp.address().port });
  useRelay(lab.db, { port: gateway.port });
  t.after(async () => {
    await gateway.close();
    await smtp.close();
    await lab.cleanup();
  });

  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['carol@partner.test'], subject: 'Round trip', text: 'hello' });

  assert.equal(gateway.received.length, 1, 'relayed once, not again when it came back');
  assert.equal(lab.db.listSent('alice@lab.local').length, 1);
  const inbox = lab.db.listInbox('carol@partner.test');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].relay_status, 'returned');
});

// ---------- admin page ----------

test('the relay page saves settings, keeps the password when left blank, and never shows it', async (t) => {
  const lab = await makeLab();
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet, logs: null });
  t.after(async () => {
    await web.close();
    await lab.cleanup();
  });

  const post = (url, form) =>
    web.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    });

  const page = await web.app.inject({ method: 'GET', url: '/admin/relay' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Upstream relay/);

  const form = {
    relay_enabled: '1',
    relay_host: 'gw.lab.local',
    relay_port: '25',
    relay_timeout: '30',
    relay_auth: '1',
    relay_user: 'tinpost',
    relay_pass: 'hunter2',
    relay_local_domains: 'lab.local corp.test',
    relay_return_hosts: '',
  };
  const saved = await post('/admin/relay', form);
  assert.equal(saved.statusCode, 200);
  assert.match(saved.body, /Mail from lab\.local, corp\.test to any other domain is now relayed/);
  assert.doesNotMatch(saved.body, /hunter2/);
  assert.equal(lab.db.getSetting('relay_pass'), 'hunter2');

  await post('/admin/relay', { ...form, relay_pass: '' });
  assert.equal(lab.db.getSetting('relay_pass'), 'hunter2', 'an empty field keeps the saved password');

  const missingUser = await post('/admin/relay', { ...form, relay_user: '' });
  assert.equal(missingUser.statusCode, 400);
  assert.match(missingUser.body, /username is required/);
});
