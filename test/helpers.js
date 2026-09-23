import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { BlobStore } from '../src/blobstore.js';
import { Delivery } from '../src/delivery.js';
import { Scanner } from '../src/scan.js';
import { Timeline } from '../src/timeline.js';

/** A throwaway instance on its own temp data dir, for one test. */
export async function makeLab(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tinpost-test-'));
  const config = loadConfig({ dataDir, smtpPort: 0, httpPort: 0, ...overrides });
  const db = new Db(config.dbPath);

  // Mirror what start() does, so a test that asks for a size limit gets one.
  if (config.maxSizeExplicit) {
    db.setSetting('smtp_max_size', String(Math.max(1, Math.round(config.maxSize / (1024 * 1024)))));
  }
  const blobs = new BlobStore(config);
  // Built the way start() builds it. ICAP scanning is off by default, so this does
  // nothing until a test turns it on with useIcap().
  const scanner = new Scanner({ db, logger: { info() {}, error() {} } });
  const timeline = new Timeline(db);
  const delivery = new Delivery({ db, blobs, maxSize: config.maxSize, scanner, logger: { info() {}, error() {} }, timeline });

  return {
    config,
    db,
    blobs,
    delivery,
    scanner,
    timeline,
    async cleanup() {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Point this lab's scanner at a (stub) ICAP server and switch scanning on. */
export function useIcap(db, { host = '127.0.0.1', port, service = '/avscan', ...rest } = {}) {
  db.setSetting('icap_enabled', '1');
  db.setSetting('icap_host', host);
  db.setSetting('icap_port', String(port));
  db.setSetting('icap_service', service);
  for (const [key, value] of Object.entries(rest)) db.setSetting(key, String(value));
}

export function eml(lines) {
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
