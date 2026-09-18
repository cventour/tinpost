import { normaliseAddress } from './db.js';

/**
 * The tunable SMTP settings, in one place.
 *
 * Each is stored as a row in `settings` and read back through here so the schema,
 * the defaults, the bounds and the wording all live together. The listener reads
 * these live on every connection, which is why changing one takes effect without a
 * restart.
 */
export const SMTP_SETTINGS = {
  smtp_max_size: {
    label: 'Maximum message size',
    hint: 'Anything larger is refused with 552 and never written to disk.',
    unit: 'MB',
    type: 'int',
    // Stored in bytes, shown in MB.
    scale: 1024 * 1024,
    default: 25,
    min: 1,
    max: 512,
  },
  smtp_max_clients: {
    label: 'Maximum concurrent connections',
    hint: 'Over the limit, senders are told 421 and retry. Guards against a client that opens connections and never closes them.',
    unit: '',
    type: 'int',
    default: 50,
    min: 1,
    max: 1000,
  },
  smtp_max_recipients: {
    label: 'Maximum recipients per message',
    hint: 'Recipients beyond this are refused with 452, so one message cannot fan out to thousands of mailboxes.',
    unit: '',
    type: 'int',
    default: 100,
    min: 1,
    max: 10000,
  },
  smtp_socket_timeout: {
    label: 'Idle connection timeout',
    hint: 'How long a silent connection is held before it is dropped.',
    unit: 'seconds',
    type: 'int',
    scale: 1000,
    default: 60,
    min: 5,
    max: 3600,
  },
  http_port: {
    label: 'Web interface port',
    hint: 'Where the webmail and this admin page listen. Applied the next time MailButler starts, because a listening port cannot be moved without dropping the page you are reading.',
    type: 'port',
    default: 8025,
    min: 1,
    max: 65535,
    restart: true,
  },
  smtp_port: {
    label: 'SMTP port',
    hint: 'Where senders connect. Port 25 is the standard, but binding it needs root on macOS and Linux.',
    type: 'port',
    default: 2525,
    min: 1,
    max: 65535,
    restart: true,
  },
  smtp_name: {
    label: 'Server name',
    hint: 'What the server calls itself in greetings and in Received headers. A scenario reads better when this matches the domain it is pretending to be.',
    type: 'hostname',
    default: 'mailbutler',
    maxLength: 253,
  },
  smtp_banner: {
    label: 'Greeting banner',
    hint: 'Extra text on the 220 greeting line, which is the first thing a connecting client sees.',
    type: 'line',
    default: 'MailButler lab mail server',
    maxLength: 120,
  },
};

/**
 * Read one setting in its stored form: bytes and milliseconds where the spec says
 * so, plain values otherwise. Falls back to the default when unset or corrupt.
 */
export function readSetting(db, key) {
  const spec = SMTP_SETTINGS[key];
  if (!spec) throw new Error(`unknown setting: ${key}`);

  const raw = db.getSetting(key);
  if (raw === null || raw === '') return scaleUp(spec, spec.default);

  if (spec.type === 'int' || spec.type === 'port') {
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) return scaleUp(spec, spec.default);
    return scaleUp(spec, n);
  }
  return raw;
}

/** MB to bytes, seconds to milliseconds; a plain value passes through. */
function scaleUp(spec, value) {
  return spec.scale ? value * spec.scale : value;
}

/** The display value, i.e. MB and seconds rather than bytes and milliseconds. */
export function readDisplayValue(db, key) {
  const spec = SMTP_SETTINGS[key];
  const stored = readSetting(db, key);
  return spec.scale ? Math.round(stored / spec.scale) : stored;
}

/** Every setting in display form, for rendering the form. */
export function readAllDisplay(db) {
  const out = {};
  for (const key of Object.keys(SMTP_SETTINGS)) out[key] = readDisplayValue(db, key);
  return out;
}

/** Every setting in stored form, for handing to the listener. */
export function readAllEffective(db) {
  const out = {};
  for (const key of Object.keys(SMTP_SETTINGS)) out[key] = readSetting(db, key);
  return out;
}

/**
 * Validate a submitted form value. Returns `{ ok, value }` or `{ ok: false, error }`
 * with a message that names the bound rather than just rejecting.
 */
export function validateSetting(key, input) {
  const spec = SMTP_SETTINGS[key];
  if (!spec) return { ok: false, error: `Unknown setting ${key}.` };

  const raw = String(input ?? '').trim();

  if (spec.type === 'int' || spec.type === 'port') {
    if (!/^\d+$/.test(raw)) return { ok: false, error: `${spec.label} must be a whole number.` };
    const n = Number.parseInt(raw, 10);
    if (n < spec.min || n > spec.max) {
      return {
        ok: false,
        error: `${spec.label} must be between ${spec.min} and ${spec.max}${spec.unit ? ' ' + spec.unit : ''}.`,
      };
    }
    return { ok: true, value: String(n) };
  }

  if (spec.type === 'hostname') {
    if (!raw) return { ok: false, error: `${spec.label} cannot be empty.` };
    if (raw.length > spec.maxLength) return { ok: false, error: `${spec.label} is too long.` };
    // The name goes into protocol responses, so anything that could break a line out
    // of its response is refused rather than escaped.
    if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
      return { ok: false, error: `${spec.label} may only contain letters, digits, dots, dashes and underscores.` };
    }
    return { ok: true, value: raw };
  }

  // A free-text line. Control characters would let it inject a second response line.
  if (raw.length > spec.maxLength) return { ok: false, error: `${spec.label} must be ${spec.maxLength} characters or fewer.` };
  if (/[\r\n\x00-\x1f\x7f]/.test(raw)) {
    return { ok: false, error: `${spec.label} cannot contain line breaks or control characters.` };
  }
  return { ok: true, value: raw };
}

/** The settings that only take effect at the next start. */
export function restartOnlyKeys() {
  return Object.keys(SMTP_SETTINGS).filter((k) => SMTP_SETTINGS[k].restart);
}

/**
 * Which restart-only settings differ from what the running process actually bound.
 * Used to tell the operator that a saved port is not the port they are talking to.
 */
export function pendingRestart(db, running) {
  const pending = [];
  for (const key of restartOnlyKeys()) {
    const saved = readSetting(db, key);
    if (running[key] !== undefined && running[key] !== saved) {
      pending.push({ key, label: SMTP_SETTINGS[key].label, saved, running: running[key] });
    }
  }
  return pending;
}

/** Validate and store a whole submitted form. Nothing is written unless all of it passes. */
export function saveSettings(db, body) {
  const staged = [];
  for (const key of Object.keys(SMTP_SETTINGS)) {
    if (!(key in body)) continue;
    const result = validateSetting(key, body[key]);
    if (!result.ok) return { ok: false, error: result.error };
    staged.push([key, result.value]);
  }
  for (const [key, value] of staged) db.setSetting(key, value);
  return { ok: true, changed: staged.length };
}

export { normaliseAddress };

/**
 * Can this process actually bind that port on that host?
 *
 * A port is the one setting that can stop MailButler from starting at all, so it is
 * checked before being saved rather than discovered at the next start. Two failures
 * are worth naming precisely: the port is taken, and the port needs privileges we do
 * not have.
 */
export async function checkPortAvailable(port, host, { ignorePorts = [] } = {}) {
  // A port this process already holds will be free by the time it restarts.
  if (ignorePorts.includes(port)) return { ok: true, note: 'in use by MailButler itself' };

  const net = await import('node:net');
  return new Promise((resolve) => {
    const probe = net.createServer();
    const done = (result) => {
      probe.removeAllListeners();
      probe.close(() => resolve(result));
    };
    probe.once('error', (err) => {
      probe.removeAllListeners();
      if (err.code === 'EADDRINUSE') {
        return resolve({ ok: false, error: `Port ${port} is already in use by something else.` });
      }
      if (err.code === 'EACCES') {
        return resolve({
          ok: false,
          error: `Port ${port} needs root privileges on this system. Ports below 1024 are reserved; start MailButler with sudo if you need one.`,
        });
      }
      return resolve({ ok: false, error: `Port ${port} cannot be used: ${err.code || err.message}.` });
    });
    probe.once('listening', () => done({ ok: true }));
    probe.listen(port, host);
  });
}
