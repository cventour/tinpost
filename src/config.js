import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULTS = {
  smtpPort: 2525,
  httpPort: 8025,
  host: '127.0.0.1',
  maxSize: 25 * 1024 * 1024,
};

/** Where the DB and blob store live when the user does not say. */
function defaultDataDir() {
  if (process.env.MAILBUTLER_DATA_DIR) return process.env.MAILBUTLER_DATA_DIR;
  // Respect the platform convention rather than dropping a dotfile in $HOME on Windows.
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'MailButler');
  }
  return join(homedir(), '.mailbutler');
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
    dbPath: join(dataDir, 'mailbutler.db'),
    blobDir: join(dataDir, 'blobs'),
    tmpDir: join(dataDir, 'tmp'),
    smtpPort: flags.smtpPort ?? intFromEnv('MAILBUTLER_SMTP_PORT', DEFAULTS.smtpPort),
    httpPort: flags.httpPort ?? intFromEnv('MAILBUTLER_HTTP_PORT', DEFAULTS.httpPort),
    host: flags.host || process.env.MAILBUTLER_HOST || DEFAULTS.host,
    maxSize: flags.maxSize ?? intFromEnv('MAILBUTLER_MAX_SIZE', DEFAULTS.maxSize),
    adminPassword: flags.adminPassword || process.env.MAILBUTLER_ADMIN_PASSWORD || null,
  };

  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(cfg.blobDir, { recursive: true });
  mkdirSync(cfg.tmpDir, { recursive: true });

  return Object.freeze(cfg);
}

/** A readable password for first-run bootstrap: no ambiguous characters. */
export function generatePassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export { DEFAULTS };
