#!/usr/bin/env node
import { parseArgs } from 'node:util';

// node:sqlite is what lets Tinpost avoid a compiled dependency. If it is
// missing the user is on an older Node, and a stack trace would not explain that.
try {
  await import('node:sqlite');
} catch {
  console.error(
    `Tinpost needs Node 22.5 or newer (Node 24 LTS recommended) for its built-in SQLite support.\n` +
      `You are running ${process.version}. Install a newer Node and try again.`,
  );
  process.exit(1);
}

const { start } = await import('./index.js');

const USAGE = `Tinpost — a self-contained lab mail server with webmail.

Usage:
  tinpost serve [options]

Options:
  --smtp-port <n>        SMTP listen port (default 2525; port 25 needs root on Unix)
  --http-port <n>        Web listen port (default 8025)
  --host <addr>          Address to bind (default 127.0.0.1; use 0.0.0.0 to expose
                         on an isolated lab network — every mailbox becomes readable)
  --data-dir <path>      Where the database and stored files live
  --max-size <bytes>     Largest accepted message (default 26214400, i.e. 25 MB)
  -h, --help             Show this help
  -v, --version          Show the version

Every domain is accepted by default; switch to an allowlist on the admin page.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'smtp-port': { type: 'string' },
    'http-port': { type: 'string' },
    host: { type: 'string' },
    'data-dir': { type: 'string' },
    'max-size': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (values.version) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const command = positionals[0] ?? 'serve';
if (command !== 'serve') {
  console.error(`Unknown command "${command}".\n\n${USAGE}`);
  process.exit(1);
}

function intFlag(name) {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`--${name} must be a number between 0 and 65535, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

function sizeFlag() {
  const raw = values['max-size'];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--max-size must be a positive number of bytes, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

let instance;
try {
  instance = await start({
    smtpPort: intFlag('smtp-port'),
    httpPort: intFlag('http-port'),
    host: values.host,
    dataDir: values['data-dir'],
    maxSize: sizeFlag(),
  });
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(`Port already in use: ${err.port}. Pick another with --smtp-port / --http-port.`);
  } else if (err?.code === 'EACCES') {
    console.error(
      `Permission denied binding port ${err.port}. Ports below 1024 need root on macOS and Linux — ` +
        `use the default 2525, or run with elevated privileges.`,
    );
  } else {
    console.error(`Failed to start: ${err?.message ?? err}`);
  }
  process.exit(1);
}

const { config, ports } = instance;
const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;

console.log(`
  Tinpost is running.

  Webmail   http://${displayHost}:${ports.http}
  Admin     http://${displayHost}:${ports.http}/admin   (no password)
  SMTP      ${config.host}:${ports.smtp}   (no AUTH, no TLS)
  Data      ${config.dataDir}
`);

if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
  console.log(
    `  Warning: bound to ${config.host}, not loopback. Tinpost has no passwords at all:\n` +
      `  anyone who can reach this host can read every mailbox, change these settings and\n` +
      `  delete all mail. Only do this on an isolated lab network.\n`,
  );
}

console.log('  Press Ctrl+C to stop.\n');

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\nStopping (${signal})...`);
  try {
    await instance.stop();
  } catch (err) {
    console.error(`Error during shutdown: ${err?.message ?? err}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
