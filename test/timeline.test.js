import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import nodemailer from 'nodemailer';
import { makeLab } from './helpers.js';
import { Db } from '../src/db.js';
import { createSmtpServer } from '../src/smtp.js';
import { createWebServer } from '../src/web/server.js';
import { resolveRange, chartModel, parseShow } from '../src/web/routes.timeline.js';

const quiet = { info() {}, error() {}, debug() {} };
const HOUR = { from: new Date(Date.now() - 3600e3).toISOString(), to: new Date(Date.now() + 1000).toISOString() };

async function webLab(t) {
  const lab = await makeLab();
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet });
  t.after(async () => {
    await web.close();
    await lab.cleanup();
  });
  return { ...lab, app: web.app };
}

/** A stand-in gateway that takes everything. */
async function startGateway() {
  const server = new SMTPServer({
    disabledCommands: ['AUTH', 'STARTTLS'],
    authOptional: true,
    logger: false,
    onData(stream, session, cb) {
      stream.resume();
      stream.on('end', () => cb());
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function useRelay(db, port) {
  db.setSetting('relay_enabled', '1');
  db.setSetting('relay_host', '127.0.0.1');
  db.setSetting('relay_port', String(port));
  db.setSetting('relay_local_domains', 'lab.local');
  db.setSetting('relay_timeout', '5');
}

// ---------- recording ----------

test('a delivered message becomes an event that opens as its recipient', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());
  const sent = await lab.delivery.deliverComposed(
    { from: 'alice@lab.local', to: ['bob@lab.local'], subject: 'Hello', text: 'hi' },
    { sourceIp: '::ffff:10.0.0.7' },
  );

  const [e] = lab.db.listEvents(HOUR);
  assert.equal(e.kind, 'delivered');
  assert.equal(e.via, 'webmail');
  assert.equal(e.source_ip, '10.0.0.7');
  assert.equal(e.from_addr, 'alice@lab.local');
  assert.equal(e.to_addrs, 'bob@lab.local');
  assert.equal(e.message_id, sent.id);
  assert.equal(e.open_as, 'bob@lab.local');
  assert.equal(e.relay, null);
});

test('relayed, returned and failed messages record direction and the relay response', async (t) => {
  const lab = await makeLab();
  const gateway = await startGateway();
  t.after(async () => {
    await gateway.close();
    await lab.cleanup();
  });
  useRelay(lab.db, gateway.port);

  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['carol@partner.test'], subject: 'Out', text: 'x' });
  await lab.delivery.deliverComposed({ from: 'mallory@phish.test', to: ['alice@lab.local'], subject: 'In', text: 'x' });
  await lab.delivery.deliverRaw(Buffer.from('From: carol@partner.test\r\nTo: alice@lab.local\r\nSubject: Back\r\n\r\nscanned'), {
    envelopeRecipients: ['alice@lab.local'],
    envelopeFrom: 'carol@partner.test',
    fromGateway: true,
    sourceIp: '127.0.0.1',
  });
  lab.db.setSetting('relay_port', '1');
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['dave@partner.test'], subject: 'Down', text: 'x' });

  const events = lab.db.listEvents(HOUR).reverse();
  assert.deepEqual(events.map((e) => [e.kind, e.relay]), [
    ['relayed', 'outbound'],
    ['relayed', 'inbound'],
    ['returned', 'returned'],
    ['failed', 'outbound'],
  ]);
  assert.match(events[0].response, /^250/);
  assert.equal(events[0].open_as, 'alice@lab.local', 'a message waiting on the gateway opens as its sender');
  assert.equal(events[2].via, 'gateway');
  assert.equal(events[2].open_as, 'alice@lab.local');
  assert.match(events[3].response, /ECONNREFUSED|ECONNECTION|ESOCKET/);
});

test('SMTP refusals and empty connections are recorded; nothing is lost when a message arrives', async (t) => {
  const lab = await makeLab();
  const smtp = createSmtpServer({ ...lab, config: lab.config, logger: quiet });
  await smtp.listen();
  t.after(async () => {
    await smtp.close();
    await lab.cleanup();
  });
  lab.db.setAcceptPolicy('allowlist');
  lab.db.addDomain('lab.local');

  const client = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.address().port, secure: false });
  await client.sendMail({ from: 'x@corp.test', to: 'alice@lab.local', subject: 'Fine', text: 'x' });
  await client.sendMail({ from: 'x@corp.test', to: 'bob@nowhere.test', subject: 'No', text: 'x' }).catch(() => {});
  client.close();

  // A client that connects and leaves.
  const net = await import('node:net');
  await new Promise((resolve) => {
    const sock = net.connect(smtp.address().port, '127.0.0.1');
    sock.once('data', () => sock.end('QUIT\r\n'));
    sock.on('close', resolve);
  });
  await new Promise((r) => setTimeout(r, 50));

  const kinds = lab.db.listEvents(HOUR).map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['connection', 'delivered', 'refused']);
  const refused = lab.db.listEvents({ ...HOUR, show: ['refused'] })[0];
  assert.match(refused.response, /^550 Relay denied for nowhere\.test/);
  assert.equal(refused.to_addrs, 'bob@nowhere.test');
  assert.equal(refused.source_ip, '127.0.0.1');
});

test('mail stored before the timeline existed is filled in once', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['bob@lab.local'], subject: 'Old', text: 'x' });
  lab.db.raw.exec('DELETE FROM events');
  lab.db.setSetting('events_backfilled', '0');

  const again = new Db(lab.config.dbPath);
  try {
    const events = again.listEvents(HOUR);
    assert.equal(events.length, 1);
    assert.equal(events[0].subject, 'Old');
    assert.equal(events[0].open_as, 'bob@lab.local');
    const third = new Db(lab.config.dbPath);
    assert.equal(third.listEvents(HOUR).length, 1, 'and only once');
    third.close();
  } finally {
    again.close();
  }
});

test('purging the lab empties the timeline too', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['bob@lab.local'], subject: 'x', text: 'x' });
  lab.db.purgeAll();
  assert.equal(lab.db.countEvents(HOUR), 0);
});

// ---------- the page ----------

test('the Timeline page lists events, filters them, and links messages to their mailbox', async (t) => {
  const lab = await webLab(t);
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['bob@lab.local'], subject: 'Quarterly numbers', text: 'x' });
  lab.timeline.record({ kind: 'connection', sourceIp: '192.168.1.204', via: 'gateway', response: 'Connected and closed without sending a message' });

  const page = await lab.app.inject({ method: 'GET', url: '/timeline' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Quarterly numbers/);
  assert.match(page.body, /192\.168\.1\.204/);
  assert.match(page.body, /href="\/timeline\/open\/\d+"/);
  assert.match(page.body, /Showing 2 of 2 events/);
  assert.match(page.body, /href="\/timeline"[^>]*aria-current="page"/);

  const onlyConnections = await lab.app.inject({ method: 'GET', url: '/timeline?show=connection' });
  assert.doesNotMatch(onlyConnections.body, /Quarterly numbers/);
  assert.match(onlyConnections.body, /Showing 1 of 1 event /);

  const searched = await lab.app.inject({ method: 'GET', url: '/timeline?q=quarterly' });
  assert.match(searched.body, /Showing 1 of 1 event /);

  const [e] = lab.db.listEvents({ ...HOUR, show: ['delivered'] });
  const open = await lab.app.inject({ method: 'GET', url: `/timeline/open/${e.id}` });
  assert.equal(open.statusCode, 302);
  assert.equal(open.headers.location, `/mail/${e.message_id}?from=timeline`);
  assert.match(String(open.headers['set-cookie']), /mb_addr=bob(@|%40)lab\.local/);

  const shown = await lab.app.inject({ method: 'GET', url: open.headers.location, headers: { cookie: 'mb_addr=bob@lab.local' } });
  assert.match(shown.body, /Opened from the timeline/);

  const conn = lab.db.listEvents({ ...HOUR, show: ['connection'] })[0];
  const nothing = await lab.app.inject({ method: 'GET', url: `/timeline/open/${conn.id}` });
  assert.equal(nothing.statusCode, 404);
});

test('a custom range is read as UTC, and a bad one falls back to the last hour with a reason', async (t) => {
  const now = new Date('2026-09-23T12:00:00Z');
  const ok = resolveRange({ range: 'custom', from: '2026-09-23T11:00', to: '2026-09-23T11:30' }, now);
  assert.equal(ok.from.toISOString(), '2026-09-23T11:00:00.000Z');
  assert.equal(ok.to.toISOString(), '2026-09-23T11:30:00.000Z');
  assert.equal(ok.live, false);
  assert.equal(ok.error, null);

  const blank = resolveRange({ range: 'custom' }, now);
  assert.equal(blank.error, null);
  assert.equal(blank.fromInput, '2026-09-23T11:00');

  const backwards = resolveRange({ range: 'custom', from: '2026-09-23T11:30', to: '2026-09-23T11:00' }, now);
  assert.match(backwards.error, /before its end/);
  assert.equal(backwards.to, now);

  assert.equal(resolveRange({ range: 'nonsense' }, now).range, '1h');

  const lab = await webLab(t);
  const page = await lab.app.inject({ method: 'GET', url: '/timeline?range=custom&from=2026-09-23T11:30&to=2026-09-23T11:00' });
  assert.match(page.body, /must be before its end/);
});

test('the chart buckets events by series across the window', () => {
  const from = new Date('2026-09-23T11:00:00Z');
  const to = new Date('2026-09-23T12:00:00Z');
  const chart = chartModel(
    [
      { at: '2026-09-23T11:00:30Z', kind: 'delivered' },
      { at: '2026-09-23T11:01:00Z', kind: 'refused' },
      { at: '2026-09-23T11:59:59Z', kind: 'connection' },
    ],
    from,
    to,
  );
  assert.equal(chart.bars.length, 30);
  assert.deepEqual(chart.bars[0].segs.map((s) => s.kind), ['delivered', 'refused']);
  assert.deepEqual(chart.bars[29].segs.map((s) => s.kind), ['connection']);
  assert.equal(chart.messages, 2);
  assert.equal(chart.connections, 1);
  assert.equal(chart.ticks[0], '11:00');
  assert.equal(chart.ticks[6], '12:00');
});

test('the category pills are switches: each hides its own rows, All turns every one back on', async (t) => {
  const lab = await webLab(t);
  await lab.delivery.deliverComposed({ from: 'alice@lab.local', to: ['bob@lab.local'], subject: 'Kept', text: 'x' });
  lab.timeline.record({ kind: 'refused', sourceIp: '10.0.0.9', fromAddr: 'x@corp.test', toAddrs: 'y@nowhere.test', response: '550 Relay denied for nowhere.test' });
  lab.timeline.record({ kind: 'connection', sourceIp: '10.0.0.9' });

  const all = await lab.app.inject({ method: 'GET', url: '/timeline' });
  assert.match(all.body, /role="button" aria-pressed="true" class="on">\s*All/);
  // Refused, switched on, links to every category but itself.
  assert.match(all.body, /href="\/timeline\?show=delivered%2Crelayed%2Creturned%2Cfailed%2Cconnection" role="button" aria-pressed="true"/);

  const noRefused = await lab.app.inject({ method: 'GET', url: '/timeline?show=delivered,relayed,returned,failed,connection' });
  assert.doesNotMatch(noRefused.body, /Relay denied/);
  assert.match(noRefused.body, /Kept/);
  assert.match(noRefused.body, /role="button" aria-pressed="false" class="">\s*All/);
  // Switching Refused back on restores the full set, which is the bare page.
  assert.match(noRefused.body, /href="\/timeline" role="button" aria-pressed="false" class=""\s+title="Show refused"/);
  // The live counter is told what this view shows.
  assert.match(noRefused.body, /data-show="delivered,relayed,returned,failed,connection"/);

  const none = await lab.app.inject({ method: 'GET', url: '/timeline?show=none' });
  assert.match(none.body, /Every category is switched off/);

  assert.deepEqual(parseShow(undefined), ['delivered', 'relayed', 'returned', 'failed', 'refused', 'connection']);
  assert.deepEqual(parseShow('connection,failed,bogus'), ['failed', 'connection']);
  assert.deepEqual(parseShow('none'), []);
});
