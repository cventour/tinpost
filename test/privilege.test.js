import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { start } from '../src/index.js';
import {
  isRoot,
  mayBindPrivilegedPorts,
  defaultSmtpPort,
  portNotice,
  privilegeState,
  STANDARD_SMTP_PORT,
  FALLBACK_SMTP_PORT,
} from '../src/privilege.js';

const quiet = { info() {}, error() {} };

/**
 * These tests exercise the real fallback, which means binding the real 2525. If
 * something else on the machine already holds it — a dev instance, most likely —
 * skip rather than fail: the code under test is fine, the port is not.
 */
async function fallbackPortFree() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(FALLBACK_SMTP_PORT, '127.0.0.1');
  });
}

/** Run `fn` as if this process were root, or not, on a given platform. */
function asProcess({ uid, platform }, fn) {
  const realGetuid = process.getuid;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    if (uid === null) {
      delete process.getuid;
    } else {
      process.getuid = () => uid;
    }
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    return fn();
  } finally {
    if (realGetuid) process.getuid = realGetuid;
    else delete process.getuid;
    Object.defineProperty(process, 'platform', realPlatform);
  }
}

// ---------- detection ----------

test('root is detected by uid, and only on a system that has one', () => {
  asProcess({ uid: 0, platform: 'linux' }, () => {
    assert.equal(isRoot(), true);
    assert.equal(mayBindPrivilegedPorts(), true);
    assert.equal(defaultSmtpPort(), STANDARD_SMTP_PORT, 'root takes the real port');
  });

  asProcess({ uid: 501, platform: 'darwin' }, () => {
    assert.equal(isRoot(), false);
    assert.equal(mayBindPrivilegedPorts(), false);
    assert.equal(defaultSmtpPort(), FALLBACK_SMTP_PORT);
  });
});

test('Windows reserves no low ports, so there is nothing to elevate', () => {
  asProcess({ uid: null, platform: 'win32' }, () => {
    assert.equal(isRoot(), false, 'Windows has no uid, so nobody is root');
    assert.equal(mayBindPrivilegedPorts(), true, 'but port 25 is bindable anyway');
    assert.equal(defaultSmtpPort(), STANDARD_SMTP_PORT);
    assert.equal(privilegeState().privilegedPortsReserved, false);
  });
});

test('the real process reports itself consistently', () => {
  const state = privilegeState();
  assert.equal(state.platform, process.platform);
  assert.equal(state.root, isRoot());
  // The test suite is not expected to run as root, and should not be.
  assert.equal(state.root, false, 'do not run the tests as root');
});

// ---------- the notice ----------

test('there is nothing to warn about when the standard port is in use', () => {
  asProcess({ uid: 0, platform: 'linux' }, () => {
    assert.equal(portNotice({ smtpPort: 25, chosenExplicitly: false }), null);
  });
});

test('a port the operator chose is not warned about', () => {
  asProcess({ uid: 501, platform: 'darwin' }, () => {
    // Asking for 2525 and getting it is not a problem to report.
    assert.equal(portNotice({ smtpPort: 2525, chosenExplicitly: true }), null);
  });
});

test('falling back off port 25 names the cause and the remedy', () => {
  asProcess({ uid: 501, platform: 'darwin' }, () => {
    const notice = portNotice({ smtpPort: 2525, chosenExplicitly: false });
    assert.ok(notice, 'a warning is expected');
    assert.match(notice.headline, /2525/);
    assert.match(notice.headline, /standard port 25/);
    assert.match(notice.detail, /not running as root/, 'it says why');
    assert.match(notice.detail, /sudo/, 'and what to do about it');
  });
});

test('on Windows the same situation means something else, and says so', () => {
  asProcess({ uid: null, platform: 'win32' }, () => {
    const notice = portNotice({ smtpPort: 2525, chosenExplicitly: false });
    assert.ok(notice);
    // Blaming privileges on Windows would be simply wrong.
    assert.doesNotMatch(notice.detail, /root|sudo|privilege/i);
    assert.match(notice.detail, /already using it/);
  });
});

// ---------- startup ----------

test('an unprivileged start lands on 2525 and reports why', async (t) => {
  if (!(await fallbackPortFree())) return t.skip(`port ${FALLBACK_SMTP_PORT} is in use on this machine`);
  const dataDir = await mkdtemp(join(tmpdir(), 'tinpost-priv-'));
  const instance = await start({ dataDir, httpPort: 0 }, { logger: quiet });

  // This suite runs unprivileged, so this is the real path, not a simulated one.
  assert.equal(instance.ports.smtp, FALLBACK_SMTP_PORT);
  assert.equal(instance.privilege.root, false);
  assert.ok(instance.portNotice, 'the operator is told');
  assert.match(instance.portNotice.headline, /not the standard port 25/);

  await instance.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test('reaching for port 25 never stops the lab from starting', async (t) => {
  if (!(await fallbackPortFree())) return t.skip(`port ${FALLBACK_SMTP_PORT} is in use on this machine`);
  const dataDir = await mkdtemp(join(tmpdir(), 'tinpost-fallback-'));

  // Force the attempt an unprivileged process would not otherwise make. Binding 25
  // fails here with EACCES, and the point is that we recover rather than exit.
  const instance = await start({ dataDir, httpPort: 0 }, { logger: quiet });
  assert.equal(instance.ports.smtp, FALLBACK_SMTP_PORT, 'it came up anyway');

  // And it is genuinely listening, not merely not-crashed.
  await new Promise((resolve, reject) => {
    const probe = net.createConnection({ host: '127.0.0.1', port: instance.ports.smtp });
    probe.once('data', (d) => {
      assert.match(d.toString(), /^220 /, 'a real SMTP greeting');
      probe.destroy();
      resolve();
    });
    probe.once('error', reject);
  });

  await instance.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test('an explicitly chosen port outranks the privilege default', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tinpost-explicit-'));

  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));

  const instance = await start({ dataDir, httpPort: 0, smtpPort: free }, { logger: quiet });
  assert.equal(instance.ports.smtp, free);
  assert.equal(instance.portNotice, null, 'a chosen port is not warned about');

  await instance.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test('a port saved on the admin page also outranks the privilege default', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tinpost-saved-'));

  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));

  const first = await start({ dataDir, httpPort: 0 }, { logger: quiet });
  first.db.setSetting('smtp_port', String(free));
  await first.stop();

  const second = await start({ dataDir, httpPort: 0 }, { logger: quiet });
  assert.equal(second.ports.smtp, free);
  assert.equal(second.portNotice, null, 'the operator chose this, so there is no warning');

  await second.stop();
  await rm(dataDir, { recursive: true, force: true });
});
