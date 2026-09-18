import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLab } from './helpers.js';
import { createWebServer } from '../src/web/server.js';
import { start } from '../src/index.js';

const quiet = { info() {}, error() {} };
const form = { 'content-type': 'application/x-www-form-urlencoded' };

/** A lab whose admin password is the temporary one, as after a first start. */
async function withFirstRun(t, { temporary = true } = {}) {
  const lab = await makeLab();
  lab.db.setAdminPassword('temp-generated', { mustChange: temporary });
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet });
  t.after(async () => {
    await web.close();
    await lab.cleanup();
  });
  return { ...lab, app: web.app };
}

async function signIn(app, password) {
  const res = await app.inject({ method: 'POST', url: '/admin/login', headers: form, payload: `password=${password}` });
  return { res, cookie: res.headers['set-cookie']?.split(';')[0] };
}

test('nobody is asked to invent a password at first start', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mb-first-'));
  const instance = await start({ dataDir, smtpPort: 0, httpPort: 0 }, { logger: quiet });

  // The server chooses one itself and hands it back for the log; there is no prompt.
  assert.equal(typeof instance.generatedPassword, 'string');
  assert.ok(instance.generatedPassword.length >= 12);
  assert.equal(instance.db.verifyAdminPassword(instance.generatedPassword), true);
  assert.equal(instance.db.adminPasswordMustChange(), true, 'and it is marked temporary');

  await instance.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test('the generated password survives a restart and is not regenerated', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mb-restart-'));

  const first = await start({ dataDir, smtpPort: 0, httpPort: 0 }, { logger: quiet });
  const generated = first.generatedPassword;
  await first.stop();

  const second = await start({ dataDir, smtpPort: 0, httpPort: 0 }, { logger: quiet });
  assert.equal(second.generatedPassword, null, 'a restart must not mint a new password');
  assert.equal(second.db.verifyAdminPassword(generated), true, 'the stored one still works');

  // And a password chosen by the operator also survives.
  second.db.setAdminPassword('ChosenByTheOperator');
  await second.stop();

  const third = await start({ dataDir, smtpPort: 0, httpPort: 0 }, { logger: quiet });
  assert.equal(third.db.verifyAdminPassword('ChosenByTheOperator'), true);
  assert.equal(third.db.verifyAdminPassword(generated), false, 'the old one is gone');
  assert.equal(third.db.adminPasswordMustChange(), false, 'and it no longer nags');
  await third.stop();

  await rm(dataDir, { recursive: true, force: true });
});

test('--admin-password overrides a stored password and says so', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mb-override-'));

  const first = await start({ dataDir, smtpPort: 0, httpPort: 0 }, { logger: quiet });
  first.db.setAdminPassword('ChosenByTheOperator');
  await first.stop();

  const second = await start(
    { dataDir, smtpPort: 0, httpPort: 0, adminPassword: 'FromTheFlag' },
    { logger: quiet },
  );
  assert.equal(second.db.verifyAdminPassword('FromTheFlag'), true);
  assert.equal(second.passwordOverridden, true, 'the operator has to be told this happened');
  await second.stop();

  await rm(dataDir, { recursive: true, force: true });
});

test('signing in with the temporary password lands on the change form', async (t) => {
  const lab = await withFirstRun(t);

  const { res } = await signIn(lab.app, 'temp-generated');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/password');
});

test('the temporary password unlocks nothing but the change form', async (t) => {
  const lab = await withFirstRun(t);
  const { cookie } = await signIn(lab.app, 'temp-generated');

  for (const url of ['/admin', '/admin/policy', '/admin/purge', '/admin/gc', '/admin/domains/add']) {
    const res = await lab.app.inject({
      method: url === '/admin' ? 'GET' : 'POST',
      url,
      headers: { cookie, ...form },
      payload: 'policy=allowlist',
    });
    assert.equal(res.statusCode, 302, `${url} should divert`);
    assert.equal(res.headers.location, '/admin/password', `${url} should divert to the change form`);
  }
  assert.equal(lab.db.getAcceptPolicy(), 'any', 'and nothing was actually changed');

  const change = await lab.app.inject({ url: '/admin/password', headers: { cookie } });
  assert.equal(change.statusCode, 200);
  assert.match(change.body, /Choose your admin password/);
});

test('the login page points at the server log on a first start', async (t) => {
  const lab = await withFirstRun(t);
  const res = await lab.app.inject({ url: '/admin/login' });
  assert.match(res.body, /printed it to the server log/);

  // Once a real password is set, that wording goes away.
  lab.db.setAdminPassword('RealPassword1');
  const after = await lab.app.inject({ url: '/admin/login' });
  assert.doesNotMatch(after.body, /printed it to the server log/);
});

test('changing the password requires knowing the current one', async (t) => {
  const lab = await withFirstRun(t);
  const { cookie } = await signIn(lab.app, 'temp-generated');

  // A valid session alone must not be enough to take the instance over.
  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/password',
    headers: { cookie, ...form },
    payload: new URLSearchParams({ current: 'wrong', next: 'NewPassword1', confirm: 'NewPassword1' }).toString(),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /not the current password/);
  assert.equal(lab.db.verifyAdminPassword('temp-generated'), true, 'unchanged');
});

test('a new password must be long enough, confirmed, and actually new', async (t) => {
  const lab = await withFirstRun(t);
  const { cookie } = await signIn(lab.app, 'temp-generated');

  const attempt = (next, confirm) =>
    lab.app.inject({
      method: 'POST',
      url: '/admin/password',
      headers: { cookie, ...form },
      payload: new URLSearchParams({ current: 'temp-generated', next, confirm }).toString(),
    });

  assert.match((await attempt('short', 'short')).body, /at least 8 characters/);
  assert.match((await attempt('LongEnough1', 'DifferentOne1')).body, /do not match/);
  assert.match((await attempt('temp-generated', 'temp-generated')).body, /different from the current/);
  assert.equal(lab.db.verifyAdminPassword('temp-generated'), true, 'still unchanged');
});

test('a successful change clears the flag and retires every session', async (t) => {
  const lab = await withFirstRun(t);
  const { cookie } = await signIn(lab.app, 'temp-generated');

  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/password',
    headers: { cookie, ...form },
    payload: new URLSearchParams({
      current: 'temp-generated',
      next: 'ChosenByTheOperator',
      confirm: 'ChosenByTheOperator',
    }).toString(),
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Sign in with your new password/);
  assert.equal(lab.db.verifyAdminPassword('ChosenByTheOperator'), true);
  assert.equal(lab.db.verifyAdminPassword('temp-generated'), false);
  assert.equal(lab.db.adminPasswordMustChange(), false);

  // The session the change was made from no longer works.
  const after = await lab.app.inject({ url: '/admin', headers: { cookie } });
  assert.equal(after.statusCode, 302);
  assert.equal(after.headers.location, '/admin/login');

  // Signing in again goes to the dashboard, not the change form.
  const again = await signIn(lab.app, 'ChosenByTheOperator');
  assert.equal(again.res.headers.location, '/admin');
});

test('an operator-set password can still be changed voluntarily', async (t) => {
  const lab = await withFirstRun(t, { temporary: false });
  const { res, cookie } = await signIn(lab.app, 'temp-generated');
  assert.equal(res.headers.location, '/admin', 'no diversion when the password is not temporary');

  const page = await lab.app.inject({ url: '/admin/password', headers: { cookie } });
  assert.match(page.body, /Admin password/);

  const dash = await lab.app.inject({ url: '/admin', headers: { cookie } });
  assert.match(dash.body, /\/admin\/password/, 'the dashboard links to it');
});
