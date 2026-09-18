import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { BlobStore } from '../src/blobstore.js';
import { Delivery } from '../src/delivery.js';

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
  const delivery = new Delivery({ db, blobs, maxSize: config.maxSize });

  return {
    config,
    db,
    blobs,
    delivery,
    async cleanup() {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function eml(lines) {
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
