import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, mkdir, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { makeLab } from './helpers.js';
import { createWebServer } from '../src/web/server.js';
import {
  checkDataDir,
  hasExistingData,
  moveNotice,
  pointerPath,
  platformDefaultDataDir,
} from '../src/datadir.js';

const quiet = { info() {}, error() {} };
const form = { 'content-type': 'application/x-www-form-urlencoded' };

async function tmp(prefix = 'tinpost-dd-') {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------- where the pointer lives ----------

test('the pointer sits outside the data directory it names', () => {
  // The whole point: the database is inside the directory, so the setting that says
  // where the directory is cannot itself live there.
  const pointer = pointerPath();
  assert.ok(pointer.length > 0);
  assert.equal(
    pointer.startsWith(platformDefaultDataDir()),
    false,
    'the pointer must not live inside the data directory',
  );
  assert.ok(pointer.startsWith(homedir()), 'but it is still per-user');
});

// ---------- validation ----------

test('a relative path is refused, because it depends on where the server was started', async () => {
  const res = await checkDataDir('some/relative/path');
  assert.equal(res.ok, false);
  assert.match(res.error, /absolute path/);
});

test('an empty path is refused', async () => {
  assert.match((await checkDataDir('')).error, /cannot be empty/);
  assert.match((await checkDataDir('   ')).error, /cannot be empty/);
});

test('a path with a line break is refused', async () => {
  const res = await checkDataDir('/tmp/one\ntwo');
  assert.equal(res.ok, false);
  assert.match(res.error, /line breaks/);
});

test('a path that is a file, not a directory, is refused', async () => {
  const dir = await tmp();
  const file = join(dir, 'a-file');
  await writeFile(file, 'not a directory');

  const res = await checkDataDir(file);
  assert.equal(res.ok, false);
  assert.match(res.error, /not a directory/);

  await rm(dir, { recursive: true, force: true });
});

test('a directory that does not exist yet is created', async () => {
  const dir = await tmp();
  const target = join(dir, 'nested', 'lab-data');

  const res = await checkDataDir(target);
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(res.occupied, false, 'and it is empty');
  assert.ok((await stat(target)).isDirectory(), 'it really exists now');

  await rm(dir, { recursive: true, force: true });
});

test('a directory this process cannot write to is refused before it is saved', async () => {
  const dir = await tmp();
  const locked = join(dir, 'locked');
  await mkdir(locked);
  await chmod(locked, 0o500);

  try {
    const res = await checkDataDir(locked);
    assert.equal(res.ok, false, 'a read-only directory is not usable');
    assert.match(res.error, /cannot write to/);
    assert.match(res.error, /sudo/, 'and it names the usual cause');
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('the write check leaves nothing behind', async () => {
  const dir = await tmp();
  const res = await checkDataDir(dir);
  assert.equal(res.ok, true);

  const { readdir } = await import('node:fs/promises');
  const left = await readdir(dir);
  assert.deepEqual(left, [], 'the probe file is cleaned up');

  await rm(dir, { recursive: true, force: true });
});

test('a directory that already holds a lab is recognised as occupied', async () => {
  const dir = await tmp();
  assert.equal(await hasExistingData(dir), false);

  await writeFile(join(dir, 'tinpost.db'), 'pretend database');
  assert.equal(await hasExistingData(dir), true);

  const res = await checkDataDir(dir);
  assert.equal(res.ok, true);
  assert.equal(res.occupied, true, 'so the operator can be warned it will be used as is');

  await rm(dir, { recursive: true, force: true });
});

test('an empty zero-byte database does not count as existing data', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'tinpost.db'), '');
  assert.equal(await hasExistingData(dir), false);
  await rm(dir, { recursive: true, force: true });
});

// ---------- what the operator is told ----------

test('moving somewhere empty says the mail is not coming with it', () => {
  const notice = moveNotice({ current: '/a', pending: '/b', occupied: false });
  assert.ok(notice);
  assert.match(notice.detail, /start with no mail/);
  assert.match(notice.detail, /Nothing is copied/);
});

test('moving somewhere already occupied says that instead', () => {
  const notice = moveNotice({ current: '/a', pending: '/b', occupied: true });
  assert.match(notice.detail, /already contains a Tinpost database/);
});

test('staying put is not a move and says nothing', () => {
  assert.equal(moveNotice({ current: '/a', pending: '/a', occupied: false }), null);
  assert.equal(moveNotice({ current: '/a', pending: null, occupied: false }), null);
});

// ---------- the admin page ----------

async function withStorage(t) {
  const lab = await makeLab();
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet });
  t.after(async () => {
    await web.close();
    await lab.cleanup();
  });
  return { ...lab, app: web.app };
}

test('the storage page shows where the data actually is', async (t) => {
  const lab = await withStorage(t);
  const res = await lab.app.inject({ url: '/admin/storage' });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Data directory/);
  assert.ok(res.body.includes(lab.config.dataDir), 'the directory in use is named');
  assert.ok(res.body.includes(pointerPath()), 'and so is where the choice is remembered');
});

test('a bad location is refused by the page and never saved', async (t) => {
  const lab = await withStorage(t);

  const res = await lab.app.inject({
    method: 'POST',
    url: '/admin/storage/location',
    headers: form,
    payload: new URLSearchParams({ dataDir: 'not/absolute' }).toString(),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /absolute path/);
});

test('a run started with --data-dir says the setting is being overridden', async (t) => {
  const lab = await makeLab({ dataDir: await tmp('tinpost-explicit-') });
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet });
  t.after(async () => {
    await web.close();
    await lab.cleanup();
  });

  assert.equal(lab.config.dataDirExplicit, true);
  const res = await web.app.inject({ url: '/admin/storage' });
  assert.match(res.body, /started with an explicit data directory/);
});
