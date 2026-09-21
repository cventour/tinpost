import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scanner, ScanRejected, scanDecision, icapConfig, icapAddress, testConnection } from '../src/scan.js';
import { makeLab, useIcap } from './helpers.js';
import { startIcapStub } from './icap-stub.js';

const quiet = { info() {}, error() {} };

/** A client that answers however the test says, and records what it was asked. */
function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    async scan(opts) {
      calls.push(opts);
      return typeof answer === 'function' ? answer(opts) : answer;
    },
    async options() {
      return { ok: true, statusCode: 200, statusText: 'OK', methods: ['respmod'], preview: 0, istag: null, headers: {} };
    },
    describe: (err) => err.message,
  };
}

const clean = { verdict: 'clean', statusCode: 204, threat: null, detail: 'clean', headers: {} };
const infected = { verdict: 'blocked', statusCode: 200, threat: 'EICAR-Test-File', detail: 'blocked: EICAR-Test-File', headers: {} };
const broken = { verdict: 'error', statusCode: null, threat: null, detail: 'nothing is listening on that address and port', headers: {} };

const oneAttachment = [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') }];

async function lab(t, setup) {
  const l = await makeLab();
  t.after(() => l.cleanup());
  setup?.(l);
  return l;
}

test('nothing is scanned while ICAP is off', async (t) => {
  const l = await lab(t);
  const decision = scanDecision(l.db, { from: 'bob@corp.test', recipients: ['alice@lab.local'], attachmentCount: 1 });
  assert.equal(decision.scan, false);
  assert.match(decision.reason, /off/);
});

test('a message with no attachment is never scanned', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  const decision = scanDecision(l.db, { from: 'bob@corp.test', recipients: ['alice@lab.local'], attachmentCount: 0 });
  assert.equal(decision.scan, false);
  assert.equal(decision.reason, 'no attachments');
});

test('with scanning on, an attachment is scanned by default', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  const decision = scanDecision(l.db, { from: 'bob@corp.test', recipients: ['alice@lab.local'], attachmentCount: 1 });
  assert.equal(decision.scan, true);
  assert.deepEqual(decision.asked.sort(), ['corp.test', 'lab.local']);
});

test('a domain can opt out, and is only exempt if the other side is too', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  l.db.setDomainIcap('lab.local', false);

  const stillScanned = scanDecision(l.db, {
    from: 'bob@corp.test',
    recipients: ['alice@lab.local'],
    attachmentCount: 1,
  });
  assert.equal(stillScanned.scan, true, 'the sender domain still asks for it');
  assert.deepEqual(stillScanned.exempt, ['lab.local']);

  l.db.setDomainIcap('corp.test', false);
  const exempt = scanDecision(l.db, {
    from: 'bob@corp.test',
    recipients: ['alice@lab.local'],
    attachmentCount: 1,
  });
  assert.equal(exempt.scan, false);
});

test('one domain can opt in while the default is off', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344, icap_default: '0' }));
  assert.equal(
    scanDecision(l.db, { from: 'bob@corp.test', recipients: ['alice@lab.local'], attachmentCount: 1 }).scan,
    false,
  );

  l.db.setDomainIcap('lab.local', true);
  const decision = scanDecision(l.db, {
    from: 'bob@corp.test',
    recipients: ['alice@lab.local'],
    attachmentCount: 1,
  });
  assert.equal(decision.scan, true);
  assert.deepEqual(decision.asked, ['lab.local']);
});

test('clearing a domain override puts it back on the default', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  l.db.setDomainIcap('lab.local', false);
  assert.equal(l.db.getDomainIcap('lab.local'), false);
  l.db.setDomainIcap('lab.local', null);
  assert.equal(l.db.getDomainIcap('lab.local'), null);
  assert.deepEqual(l.db.listDomainSettings(), [{ domain: 'lab.local', icapScan: null }]);
});

test('a clean verdict lets the message through', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  const client = fakeClient(clean);
  const scanner = new Scanner({ db: l.db, logger: quiet, client });

  const result = await scanner.check({
    attachments: oneAttachment,
    from: 'bob@corp.test',
    recipients: ['alice@lab.local'],
  });

  assert.equal(result.scanned, true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].filename, 'invoice.pdf');
  assert.equal(client.calls[0].headers['X-Mail-From'], 'bob@corp.test');
});

test('a blocked attachment stops the message, permanently', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  const scanner = new Scanner({ db: l.db, logger: quiet, client: fakeClient(infected) });

  const err = await scanner
    .check({ attachments: oneAttachment, from: 'bob@corp.test', recipients: ['alice@lab.local'] })
    .then(() => null, (e) => e);

  assert.ok(err instanceof ScanRejected);
  assert.equal(err.temporary, false, 'a virus is not a try-again');
  assert.equal(err.threat, 'EICAR-Test-File');
  assert.match(err.message, /invoice\.pdf/);
});

test('an unreachable scanner refuses the message by default', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  const scanner = new Scanner({ db: l.db, logger: quiet, client: fakeClient(broken) });

  const err = await scanner
    .check({ attachments: oneAttachment, from: 'bob@corp.test', recipients: ['alice@lab.local'] })
    .then(() => null, (e) => e);

  assert.ok(err instanceof ScanRejected);
  assert.equal(err.temporary, true, 'a scanner that is down is a try-again');
  assert.match(err.message, /unavailable/);
});

test('the fail-open setting delivers an unscanned message instead', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344, icap_fail_mode: 'open' }));
  const scanner = new Scanner({ db: l.db, logger: quiet, client: fakeClient(broken) });

  const result = await scanner.check({
    attachments: oneAttachment,
    from: 'bob@corp.test',
    recipients: ['alice@lab.local'],
  });

  assert.equal(result.scanned, true);
  assert.equal(result.results[0].deliveredUnscanned, true);
});

test('every attachment is scanned, and the first refusal stops the rest', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  const client = fakeClient((opts) => (opts.filename === 'two.bin' ? infected : clean));
  const scanner = new Scanner({ db: l.db, logger: quiet, client });

  const err = await scanner
    .check({
      attachments: [
        { filename: 'one.bin', contentType: 'application/octet-stream', content: Buffer.from('a') },
        { filename: 'two.bin', contentType: 'application/octet-stream', content: Buffer.from('b') },
        { filename: 'three.bin', contentType: 'application/octet-stream', content: Buffer.from('c') },
      ],
      from: 'bob@corp.test',
      recipients: ['alice@lab.local'],
    })
    .then(() => null, (e) => e);

  assert.ok(err instanceof ScanRejected);
  assert.equal(client.calls.length, 2, 'no point asking about the rest');
});

test('the settings are read per message, not cached at startup', async (t) => {
  const l = await lab(t);
  const scanner = new Scanner({ db: l.db, logger: quiet, client: fakeClient(infected) });

  assert.equal((await scanner.check({ attachments: oneAttachment, from: 'bob@corp.test' })).scanned, false);

  useIcap(l.db, { port: 1344 });
  await assert.rejects(() => scanner.check({ attachments: oneAttachment, from: 'bob@corp.test' }), ScanRejected);
});

test('the configured address is reported as a single ICAP URI', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { host: '10.0.0.9', port: 1345, service: 'virus_scan' }));
  assert.equal(icapAddress(icapConfig(l.db)), 'icap://10.0.0.9:1345/virus_scan');
});

test('the connection test reports a real server, and a missing one', async (t) => {
  const stub = await startIcapStub();
  t.after(() => stub.close());
  const l = await lab(t, (l) => useIcap(l.db, { port: stub.port }));

  const ok = await testConnection(l.db);
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /RESPMOD/);

  l.db.setSetting('icap_port', '1');
  l.db.setSetting('icap_timeout', '1');
  const bad = await testConnection(l.db);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /could not be reached/);
});

test('the test warns when the service does not support the chosen method', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344, icap_method: 'reqmod' }));
  const client = {
    async options() {
      return { ok: true, statusCode: 200, statusText: 'OK', methods: ['respmod'], preview: 128, istag: null, headers: {} };
    },
  };

  const result = await testConnection(l.db, { client });
  assert.equal(result.ok, true);
  assert.match(result.detail, /does not advertise REQMOD/);
});

test('a database written before scanning existed gains the column it needs', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Db } = await import('../src/db.js');

  const dir = await mkdtemp(join(tmpdir(), 'tinpost-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'tinpost.db');

  // The domains table as version 1 wrote it: no icap_scan.
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE domains (domain TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
  old.exec("INSERT INTO domains (domain, created_at) VALUES ('corp.test', '2020-01-01T00:00:00Z')");
  old.exec('PRAGMA user_version = 1');
  old.close();

  const db = new Db(path);
  t.after(() => db.close());

  assert.deepEqual(db.listDomainSettings(), [{ domain: 'corp.test', icapScan: null }]);
  db.setDomainIcap('corp.test', true);
  assert.equal(db.getDomainIcap('corp.test'), true);
  assert.deepEqual(db.listDomains(), ['corp.test'], 'the existing allowlist survives');
});

test('a misconfigured scanner is refused permanently, not queued', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  const misconfigured = {
    verdict: 'error',
    statusCode: 404,
    threat: null,
    permanent: true,
    detail: 'the scanner has no service at that path (ICAP 404 Not found)',
    headers: {},
  };
  const scanner = new Scanner({ db: l.db, logger: quiet, client: fakeClient(misconfigured) });

  const err = await scanner
    .check({ attachments: oneAttachment, from: 'bob@corp.test', recipients: ['alice@lab.local'] })
    .then(() => null, (e) => e);

  assert.ok(err instanceof ScanRejected);
  assert.equal(err.temporary, false, 'a wrong service path will not fix itself on a retry');
  assert.match(err.message, /misconfigured/);
  assert.match(err.message, /no service at that path/);
});

test('fail-open still delivers when the scanner is misconfigured', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344, icap_fail_mode: 'open' }));
  const scanner = new Scanner({
    db: l.db,
    logger: quiet,
    client: fakeClient({ verdict: 'error', statusCode: 404, permanent: true, detail: 'no service', headers: {} }),
  });

  const result = await scanner.check({ attachments: oneAttachment, from: 'bob@corp.test' });
  assert.equal(result.results[0].deliveredUnscanned, true);
});

test('an approved-but-rewritten attachment is delivered, and the log says so', async (t) => {
  const l = await lab(t, (l) => useIcap(l.db, { port: 1344 }));
  const lines = [];
  const scanner = new Scanner({
    db: l.db,
    logger: { info() {}, error: (m) => lines.push(m) },
    client: fakeClient({
      verdict: 'clean',
      statusCode: 200,
      threat: null,
      modified: true,
      detail: 'approved, with the attachment rewritten by the scanner',
      headers: {},
    }),
  });

  const result = await scanner.check({ attachments: oneAttachment, from: 'bob@corp.test' });

  assert.equal(result.scanned, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /returned a rewritten copy/);
  assert.match(lines[0], /delivers the original/);
});
