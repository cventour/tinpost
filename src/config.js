import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readPointerSync, platformDefaultDataDir } from './datadir.js';

const DEFAULTS = {
  smtpPort: 2525,
  httpPort: 8025,
  host: '127.0.0.1',
  maxSize: 25 * 1024 * 1024,
};

/**
 * Where the DB and blob store live when no flag says otherwise: the location the
 * admin page last saved, and failing that the platform convention.
 */
function defaultDataDir() {
  if (process.env.TINPOST_DATA_DIR) return process.env.TINPOST_DATA_DIR;
  return readPointerSync() ?? platformDefaultDataDir();
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Merge defaults < environment < CLI flags into one frozen config object.
 * Also creates the data directory so every later component can assume it exists.
 */
export function loadConfig(flags = {}) {
  const dataDir = resolve(flags.dataDir || defaultDataDir());

  const cfg = {
    dataDir,
    // Whether this run's directory came from a flag or the environment, as opposed to
    // the saved pointer. The admin page needs to know, so it does not offer to change
    // something this run is overriding anyway.
    dataDirExplicit: flags.dataDir !== undefined || !!process.env.TINPOST_DATA_DIR,
    dbPath: join(dataDir, 'tinpost.db'),
    blobDir: join(dataDir, 'blobs'),
    tmpDir: join(dataDir, 'tmp'),
    smtpPort: flags.smtpPort ?? intFromEnv('TINPOST_SMTP_PORT', DEFAULTS.smtpPort),
    httpPort: flags.httpPort ?? intFromEnv('TINPOST_HTTP_PORT', DEFAULTS.httpPort),
    // A port given on the command line outranks the stored setting; without one, the
    // setting the admin page wrote is used.
    smtpPortExplicit: flags.smtpPort !== undefined || !!process.env.TINPOST_SMTP_PORT,
    httpPortExplicit: flags.httpPort !== undefined || !!process.env.TINPOST_HTTP_PORT,
    host: flags.host || process.env.TINPOST_HOST || DEFAULTS.host,
    maxSize: flags.maxSize ?? intFromEnv('TINPOST_MAX_SIZE', DEFAULTS.maxSize),
    // Whether a size was actually asked for, as opposed to defaulted. An explicit
    // one is an instruction and seeds the stored setting the admin page edits.
    maxSizeExplicit: flags.maxSize !== undefined || !!process.env.TINPOST_MAX_SIZE,
  };

  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(cfg.blobDir, { recursive: true });
  mkdirSync(cfg.tmpDir, { recursive: true });

  return Object.freeze(cfg);
}

export { DEFAULTS };
