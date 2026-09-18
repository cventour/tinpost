import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { makeLab } from './helpers.js';
import { createWebServer } from '../src/web/server.js';
import { createSmtpServer } from '../src/smtp.js';
import { start } from '../src/index.js';
import {
  SMTP_SETTINGS,
  readSetting,
  readDisplayValue,
  validateSetting,
  saveSettings,
  pendingRestart,
  checkPortAvailable,
} from '../src/settings.js';

const quiet = { info() {}, error() {} };
const form = { 'content-type': 'application/x-www-form-urlencoded' };

const BASE = {
  smtp_max_size: 25,
  smtp_max_clients: 50,
  smtp_max_recipients: 100,
  smtp_socket_timeout: 60,
  smtp_name: 'tinpost',
  smtp_banner: 'Tinpost lab mail server',
};

/**
 * A full form submission. The port fields carry whatever this lab actually bound,
 * so an unchanged port is never probed and the test does not depend on 8025 or 2525
 * being free on the machine running it.
 */
function formBody(lab, overrides = {}) {
  return new URLSearchParams({
    ...BASE,
    http_port: String(lab.ports.http),
    smtp_port: String(lab.ports.smtp),
    ...overrides,
  }).toString();
}

async function withAdmin(t) {
  const lab = await makeLab();
  const smtp = createSmtpServer({ ...lab, config: lab.config, logger: quiet });
  await smtp.listen();
  const web = await createWebServer({ ...lab, config: lab.config, smtp, logger: quiet });
  // Bind for real, so the routes see the ports this process actually holds.
  await web.app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await web.close();
    await smtp.close();
    await lab.cleanup();
  });

  return {
    ...lab,
    app: web.app,
    smtp,
    admin: { ...form },
    ports: { http: web.app.server.address().port, smtp: smtp.address().port },
  };
}

// ---------- the settings model ----------

test('an unset setting reads as its default', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  assert.equal(readDisplayValue(lab.db, 'smtp_max_clients'), 50);
  assert.equal(readSetting(lab.db, 'smtp_max_size'), 25 * 1024 * 1024, 'MB are stored as bytes');
  assert.equal(readSetting(lab.db, 'smtp_socket_timeout'), 60_000, 'seconds are stored as milliseconds');
  assert.equal(readSetting(lab.db, 'smtp_name'), 'tinpost');
});

test('a corrupt or out-of-range stored value falls back rather than breaking the server', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  for (const bad of ['', 'abc', '-5', '999999999']) {
    lab.db.setSetting('smtp_max_clients', bad);
    assert.equal(readDisplayValue(lab.db, 'smtp_max_clients'), 50, `"${bad}" should fall back`);
  }
});

test('validation names the bound instead of just refusing', () => {
  assert.equal(validateSetting('smtp_max_clients', '60').ok, true);
  assert.match(validateSetting('smtp_max_clients', '0').error, /between 1 and 1000/);
  assert.match(validateSetting('smtp_max_size', 'lots').error, /whole number/);
  assert.match(validateSetting('smtp_max_size', '9999').error, /between 1 and 512 MB/);
});

test('the server name and banner cannot break out of a protocol response', () => {
  // Both are echoed into SMTP responses, so a newline would inject a second line.
  assert.equal(validateSetting('smtp_name', 'mail.corp.test').ok, true);
  assert.match(validateSetting('smtp_name', 'evil\r\n250 OK').error, /may only contain/);
  assert.match(validateSetting('smtp_name', 'has spaces').error, /may only contain/);
  assert.match(validateSetting('smtp_name', '').error, /cannot be empty/);

  assert.equal(validateSetting('smtp_banner', 'Corp Mail Gateway').ok, true);
  assert.match(validateSetting('smtp_banner', 'x\r\n220 fake').error, /line breaks or control characters/);
  assert.match(validateSetting('smtp_banner', 'x'.repeat(200)).error, /120 characters or fewer/);
});

test('a form is stored whole or not at all', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const bad = saveSettings(lab.db, { smtp_max_clients: '80', smtp_max_size: '99999' });
  assert.equal(bad.ok, false);
  assert.equal(readDisplayValue(lab.db, 'smtp_max_clients'), 50, 'the valid field was not written either');

  const good = saveSettings(lab.db, { smtp_max_clients: '80', smtp_max_size: '10' });
  assert.equal(good.ok, true);
  assert.equal(readDisplayValue(lab.db, 'smtp_max_clients'), 80);
});

// ---------- applied to the live listener ----------

test('a saved size limit applies without a restart', async (t) => {
  const lab = await withAdmin(t);
  const port = lab.smtp.address().port;
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false });
  t.after(() => transport.close());

  // 5 MB is fine under the 25 MB default.
  const before = await transport.sendMail({
    from: 'a@x.test',
    to: 'b@lab.local',
    subject: 'under the default',
    text: 'x',
    attachments: [{ filename: 'f.bin', content: Buffer.alloc(5 * 1024 * 1024) }],
  });
  assert.equal(before.accepted.length, 1);

  await lab.app.inject({
    method: 'POST',
    url: '/admin/smtp',
    headers: lab.admin,
    payload: formBody(lab, { smtp_max_size: '1' }),
  });

  // The same message is now too big, with nothing restarted in between.
  await assert.rejects(() =>
    transport.sendMail({
      from: 'a@x.test',
      to: 'b@lab.local',
      subject: 'over the new limit',
      text: 'x',
      attachments: [{ filename: 'f.bin', content: Buffer.alloc(5 * 1024 * 1024) }],
    }),
  );
  assert.equal(lab.db.stats().messages, 1, 'only the first one was stored');
});

test('a saved recipient cap applies without a restart', async (t) => {
  const lab = await withAdmin(t);
  const port = lab.smtp.address().port;
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false });
  t.after(() => transport.close());

  await lab.app.inject({
    method: 'POST',
    url: '/admin/smtp',
    headers: lab.admin,
    payload: formBody(lab, { smtp_max_recipients: '2' }),
  });

  const info = await transport.sendMail({
    from: 'a@x.test',
    to: 'r1@lab.local, r2@lab.local, r3@lab.local, r4@lab.local',
    subject: 'fan out',
    text: 'x',
  });

  assert.equal(info.accepted.length, 2, 'the first two are taken');
  assert.equal(info.rejected.length, 2, 'the rest are refused');
  assert.match(info.rejectedErrors[0].response, /452.*Too many recipients/);
});

test('a saved server name reaches the greeting without a restart', async (t) => {
  const lab = await withAdmin(t);

  await lab.app.inject({
    method: 'POST',
    url: '/admin/smtp',
    headers: lab.admin,
    payload: formBody(lab, { smtp_name: 'mail.corp.test', smtp_banner: 'Corp Mail Gateway' }),
  });

  const greeting = await new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: lab.smtp.address().port });
    sock.setEncoding('utf8');
    sock.once('data', (d) => {
      sock.destroy();
      resolve(d);
    });
  });

  assert.match(greeting, /mail\.corp\.test/);
  assert.match(greeting, /Corp Mail Gateway/);
});

test('a rejected form keeps what was typed rather than discarding it', async (t) => {
  const lab = await withAdmin(t);

  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/smtp',
    headers: lab.admin,
    payload: formBody(lab, { smtp_max_clients: '99999' }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /between 1 and 1000/);
  assert.match(res.body, /value="99999"/, 'the rejected value is still in the field');
});

// ---------- ports ----------

test('a port already in use is refused before it can be saved', async (t) => {
  const lab = await withAdmin(t);

  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  t.after(() => blocker.close());

  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/smtp',
    headers: lab.admin,
    payload: formBody(lab, { http_port: String(taken) }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /already in use/);
  assert.equal(readDisplayValue(lab.db, 'http_port'), 8025, 'nothing was written, so it is still the default');
});

test('an out-of-range port is refused', async (t) => {
  const lab = await withAdmin(t);
  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/smtp',
    headers: lab.admin,
    payload: formBody(lab, { smtp_port: '70000' }),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /between 1 and 65535/);
});

test('a free port saves, and is reported as waiting for a restart', async (t) => {
  const lab = await withAdmin(t);

  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));

  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/smtp',
    headers: lab.admin,
    payload: formBody(lab, { http_port: String(free) }),
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /applies the next time Tinpost starts/);
  assert.equal(readDisplayValue(lab.db, 'http_port'), free);

  const pending = pendingRestart(lab.db, { http_port: lab.ports.http, smtp_port: lab.ports.smtp });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].key, 'http_port');
});

test('a port a Tinpost listener already holds is not treated as taken', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mine = server.address().port;

  const blind = await checkPortAvailable(mine, '127.0.0.1');
  assert.equal(blind.ok, false, 'it really is bound');

  const aware = await checkPortAvailable(mine, '127.0.0.1', { ignorePorts: [mine] });
  assert.equal(aware.ok, true, 'but it frees up when this process restarts');

  await new Promise((r) => server.close(r));
});

test('a saved port is used at the next start, and a flag still overrides it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mb-ports-'));

  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const chosen = probe.address().port;
  await new Promise((r) => probe.close(r));

  const first = await start({ dataDir, smtpPort: 0, httpPort: 0 }, { logger: quiet });
  first.db.setSetting('http_port', String(chosen));
  await first.stop();

  const second = await start({ dataDir, smtpPort: 0 }, { logger: quiet });
  assert.equal(second.ports.http, chosen, 'the stored port is honoured');
  await second.stop();

  const third = await start({ dataDir, smtpPort: 0, httpPort: 0 }, { logger: quiet });
  assert.notEqual(third.ports.http, chosen, 'an explicit flag still wins');
  await third.stop();

  await rm(dataDir, { recursive: true, force: true });
});

test('every setting has a label, a hint and a default', () => {
  // The form renders straight from this table, so a missing field would ship a
  // control nobody can interpret.
  for (const [key, spec] of Object.entries(SMTP_SETTINGS)) {
    assert.ok(spec.label, `${key} needs a label`);
    assert.ok(spec.hint && spec.hint.length > 20, `${key} needs a hint that explains it`);
    assert.notEqual(spec.default, undefined, `${key} needs a default`);
  }
});
