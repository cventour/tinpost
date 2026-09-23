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
    hint: 'Where the webmail and this admin page listen. Applied the next time Tinpost starts, because a listening port cannot be moved without dropping the page you are reading.',
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
  smtp_auth: {
    label: 'Advertise AUTH and accept any credentials',
    hint: 'Some senders refuse to talk to a server that offers no way to authenticate, and close the connection rather than send. With this on, Tinpost advertises AUTH (PLAIN, LOGIN, CRAM-MD5 and XOAUTH2) and accepts whatever is offered — any username, any password, any token. It proves nothing and is not meant to: it exists so a client that insists on authenticating can. Authentication stays optional either way, so a sender that does not authenticate is still accepted.',
    type: 'bool',
    default: 1,
  },
  smtp_name: {
    label: 'Server name',
    hint: 'What the server calls itself in greetings and in Received headers. A scenario reads better when this matches the domain it is pretending to be.',
    type: 'hostname',
    default: 'tinpost',
    maxLength: 253,
  },
  smtp_banner: {
    label: 'Greeting banner',
    hint: 'Extra text on the 220 greeting line, which is the first thing a connecting client sees.',
    type: 'line',
    default: 'Tinpost lab mail server',
    maxLength: 120,
  },
};

/**
 * The ICAP scanning settings: where the scanner is, how patient to be with it, and
 * what to do when it cannot be reached.
 *
 * Kept as its own group because it is its own admin page, but it goes through the
 * same validate-and-store machinery as the SMTP limits below.
 */
export const ICAP_SETTINGS = {
  icap_enabled: {
    label: 'Scan attachments with ICAP',
    hint: 'While this is off, nothing is sent to a scanner and no message is held up. Messages with no attachment are never scanned either way.',
    type: 'bool',
    default: 0,
  },
  icap_host: {
    label: 'ICAP server address',
    hint: 'The host name or IP address of the scanning service.',
    type: 'host',
    default: '127.0.0.1',
    maxLength: 253,
  },
  icap_port: {
    label: 'ICAP port',
    hint: 'The standard ICAP port is 1344.',
    type: 'port',
    default: 1344,
    min: 1,
    max: 65535,
  },
  icap_service: {
    label: 'Service path',
    hint: 'The service to ask, as the server names it — c-icap calls one "/avscan", others "/virus_scan" or "/respmod". A full icap://host:port/service URL works too, and its host and port then win over the fields above.',
    type: 'service',
    default: '/avscan',
    maxLength: 300,
  },
  icap_method: {
    label: 'ICAP method',
    hint: 'RESPMOD presents each attachment as a download, which is what virus scanners expect. REQMOD presents it as an upload; use it only if your service handles that method alone.',
    type: 'choice',
    choices: [
      ['respmod', 'RESPMOD'],
      ['reqmod', 'REQMOD'],
    ],
    default: 'respmod',
  },
  icap_preview: {
    label: 'Preview size',
    hint: 'Send this many bytes first and let the scanner ask for the rest only if it needs them. 0 sends the whole attachment straight away, which every server accepts.',
    unit: 'bytes',
    type: 'int',
    default: 0,
    min: 0,
    max: 1024 * 1024,
  },
  icap_timeout: {
    label: 'Scan timeout',
    hint: 'How long to wait for a verdict on one attachment before treating the scan as failed.',
    unit: 'seconds',
    type: 'int',
    scale: 1000,
    default: 10,
    min: 1,
    max: 300,
  },
  icap_fail_mode: {
    label: 'If no verdict comes back',
    hint: 'Covers a scanner that is down, one that does not answer in time, and one that answers with an error. Refuse is the safe answer: an unscanned message is not an approved message. Deliver anyway keeps the lab moving, and says so in the log. A message the scanner actually refuses is always rejected, whichever of these is set.',
    type: 'choice',
    choices: [
      ['closed', 'Refuse the message'],
      ['open', 'Deliver it anyway'],
    ],
    default: 'closed',
  },
  icap_default: {
    label: 'Domains with no setting of their own',
    hint: 'Applies to every sender and recipient domain that has no entry below — which, with the accept policy set to any domain, is most of them.',
    type: 'bool',
    default: 1,
  },
};

/**
 * The upstream relay: a smart host that outbound mail is handed to — in practice a
 * security gateway such as OPSWAT MetaDefender Email Security — which scans it and
 * sends it back to Tinpost for delivery.
 *
 * "Outbound" is defined by the local domains below: mail from one of them to any
 * other domain goes through the gateway, and mail that stays inside one domain never
 * does.
 */
export const RELAY_SETTINGS = {
  relay_enabled: {
    label: 'Relay outbound mail through an upstream server',
    hint: 'While this is off, nothing leaves the machine and every message is delivered straight into its mailbox, exactly as before.',
    type: 'bool',
    default: 0,
  },
  relay_host: {
    label: 'Upstream server address',
    hint: 'The host name or IP address of the gateway that outbound mail is handed to.',
    type: 'host',
    default: '127.0.0.1',
    maxLength: 253,
  },
  relay_port: {
    label: 'Upstream port',
    hint: 'Plain SMTP, with no TLS. Port 25 is the usual one for server-to-server mail.',
    type: 'port',
    default: 25,
    min: 1,
    max: 65535,
  },
  relay_auth: {
    label: 'Authenticate to the upstream server',
    hint: 'Log in with the username and password below before sending. Leave off if the gateway accepts mail from this machine by its address.',
    type: 'bool',
    default: 0,
  },
  relay_user: {
    label: 'Username',
    hint: 'Only used when authentication is on.',
    type: 'line',
    default: '',
    maxLength: 256,
  },
  relay_pass: {
    label: 'Password',
    hint: 'Stored in the Tinpost database as typed, and never shown again. Leave the field empty to keep the one already saved.',
    type: 'secret',
    default: '',
    maxLength: 512,
  },
  relay_timeout: {
    label: 'Upstream timeout',
    hint: 'How long to wait for the gateway to connect or answer before treating the relay as failed and delivering locally.',
    unit: 'seconds',
    type: 'int',
    scale: 1000,
    default: 30,
    min: 1,
    max: 300,
  },
  relay_local_domains: {
    label: 'Local domains',
    hint: 'Mail from one of these domains to a different domain is relayed. Mail between two addresses in the same domain is delivered directly and never leaves. Mail from any other domain is treated as inbound and delivered directly.',
    type: 'domains',
    default: '',
    maxLength: 4000,
  },
  relay_return_hosts: {
    label: 'Gateway return addresses',
    hint: 'The IP addresses or host names the gateway sends scanned mail back from. Mail arriving from one of them is delivered, never relayed again. Leave empty to use the upstream server address.',
    type: 'hosts',
    default: '',
    maxLength: 4000,
  },
};

/** Every setting, whichever page edits it. */
export const SETTINGS = { ...SMTP_SETTINGS, ...ICAP_SETTINGS, ...RELAY_SETTINGS };

/**
 * Read one setting in its stored form: bytes and milliseconds where the spec says
 * so, plain values otherwise. Falls back to the default when unset or corrupt.
 */
export function readSetting(db, key) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`unknown setting: ${key}`);

  const raw = db.getSetting(key);
  if (raw === null || raw === '') return normalise(spec, spec.default);

  if (spec.type === 'int' || spec.type === 'port') {
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) return normalise(spec, spec.default);
    return scaleUp(spec, n);
  }
  if (spec.type === 'bool') return raw === '1' || raw === 'true' || raw === 'on';
  if (spec.type === 'choice') {
    return spec.choices.some(([value]) => value === raw) ? raw : spec.default;
  }
  return raw;
}

/** A default is written in the same shape a stored value reads back as. */
function normalise(spec, value) {
  if (spec.type === 'bool') return value === 1 || value === true || value === '1';
  return scaleUp(spec, value);
}

/** MB to bytes, seconds to milliseconds; a plain value passes through. */
function scaleUp(spec, value) {
  return spec.scale ? value * spec.scale : value;
}

/** The display value, i.e. MB and seconds rather than bytes and milliseconds. */
export function readDisplayValue(db, key) {
  const spec = SETTINGS[key];
  const stored = readSetting(db, key);
  if (spec.type === 'bool') return stored ? '1' : '0';
  // A password is written, never read back into a form.
  if (spec.type === 'secret') return '';
  return spec.scale ? Math.round(stored / spec.scale) : stored;
}

/** Every setting in display form, for rendering the form. */
export function readAllDisplay(db) {
  const out = {};
  for (const key of Object.keys(SETTINGS)) out[key] = readDisplayValue(db, key);
  return out;
}

/** Every setting in stored form, for handing to the listener. */
export function readAllEffective(db) {
  const out = {};
  for (const key of Object.keys(SETTINGS)) out[key] = readSetting(db, key);
  return out;
}

/**
 * Validate a submitted form value. Returns `{ ok, value }` or `{ ok: false, error }`
 * with a message that names the bound rather than just rejecting.
 */
export function validateSetting(key, input) {
  const spec = SETTINGS[key];
  if (!spec) return { ok: false, error: `Unknown setting ${key}.` };

  const raw = String(input ?? '').trim();

  if (spec.type === 'bool') {
    const on = raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
    const off = raw === '0' || raw === 'false' || raw === 'off' || raw === 'no' || raw === '';
    if (!on && !off) return { ok: false, error: `${spec.label} must be on or off.` };
    return { ok: true, value: on ? '1' : '0' };
  }

  if (spec.type === 'choice') {
    if (!spec.choices.some(([value]) => value === raw)) {
      return { ok: false, error: `${spec.label} must be one of ${spec.choices.map(([v]) => v).join(', ')}.` };
    }
    return { ok: true, value: raw };
  }

  if (spec.type === 'host') {
    if (!raw) return { ok: false, error: `${spec.label} cannot be empty.` };
    if (raw.length > spec.maxLength) return { ok: false, error: `${spec.label} is too long.` };
    // A host name, an IPv4 address, or an IPv6 literal. It ends up in a protocol
    // header, so anything that could break the line out of it is refused.
    if (!/^[A-Za-z0-9._:\[\]-]+$/.test(raw)) {
      return { ok: false, error: `${spec.label} is not a valid host name or IP address.` };
    }
    return { ok: true, value: raw };
  }

  if (spec.type === 'domains' || spec.type === 'hosts') {
    if (raw.length > spec.maxLength) return { ok: false, error: `${spec.label} is too long.` };
    const items = splitList(raw);
    const pattern = spec.type === 'domains' ? /^[a-z0-9-]+(\.[a-z0-9-]+)+$/ : /^[a-z0-9._:\[\]-]+$/;
    const bad = items.filter((item) => !pattern.test(item));
    if (bad.length) {
      return {
        ok: false,
        error: `${spec.label}: "${bad[0]}" is not a valid ${spec.type === 'domains' ? 'domain' : 'host name or IP address'}.`,
      };
    }
    return { ok: true, value: [...new Set(items)].join(', ') };
  }

  if (spec.type === 'secret') {
    if (raw.length > spec.maxLength) return { ok: false, error: `${spec.label} is too long.` };
    if (/[\r\n\x00]/.test(raw)) return { ok: false, error: `${spec.label} cannot contain line breaks.` };
    return { ok: true, value: raw };
  }

  if (spec.type === 'service') {
    if (!raw) return { ok: false, error: `${spec.label} cannot be empty.` };
    if (raw.length > spec.maxLength) return { ok: false, error: `${spec.label} is too long.` };
    if (/[\s\r\n]/.test(raw)) return { ok: false, error: `${spec.label} cannot contain spaces.` };
    if (/^icaps?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw.replace(/^icaps:/i, 'icap:'));
        if (!url.hostname) throw new Error('no host');
      } catch {
        return { ok: false, error: `${spec.label} looks like a URL but is not a valid one.` };
      }
      return { ok: true, value: raw };
    }
    return { ok: true, value: raw.startsWith('/') ? raw : `/${raw}` };
  }

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

/**
 * A comma, space or newline separated list, lower-cased and trimmed. How the list
 * settings are typed on the admin page and how they are read back.
 */
export function splitList(value) {
  return String(value ?? '')
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/** The settings that only take effect at the next start. */
export function restartOnlyKeys() {
  return Object.keys(SETTINGS).filter((k) => SETTINGS[k].restart);
}

/**
 * Which restart-only settings differ from what the running process actually bound.
 * Used to tell the operator that a saved port is not the port they are talking to.
 *
 * Two cases look like a difference but are not, and saying "restart to move it" in
 * either of them is false advice:
 *
 * - Nothing has ever been saved for that key. The built-in default is then not a
 *   choice anyone made, and the process may well have resolved a different port from
 *   a flag or from its privileges. Whatever it bound is the right answer.
 * - A flag or an environment variable fixed the port for this run. It will fix it
 *   again at the next start, so a restart changes nothing. `overridden` names those.
 */
export function pendingRestart(db, running, { overridden = {} } = {}) {
  const pending = [];
  for (const key of restartOnlyKeys()) {
    const stored = db.getSetting(key);
    if (stored === null || stored === '') continue;
    if (overridden[key]) continue;

    const saved = readSetting(db, key);
    if (running[key] !== undefined && running[key] !== saved) {
      pending.push({ key, label: SETTINGS[key].label, saved, running: running[key] });
    }
  }
  return pending;
}

/** Validate and store a whole submitted form. Nothing is written unless all of it passes. */
export function saveSettings(db, body) {
  const staged = [];
  for (const key of Object.keys(SETTINGS)) {
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
 * A port is the one setting that can stop Tinpost from starting at all, so it is
 * checked before being saved rather than discovered at the next start. Two failures
 * are worth naming precisely: the port is taken, and the port needs privileges we do
 * not have.
 */
export async function checkPortAvailable(port, host, { ignorePorts = [] } = {}) {
  // A port this process already holds will be free by the time it restarts.
  if (ignorePorts.includes(port)) return { ok: true, note: 'in use by Tinpost itself' };

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
          error: `Port ${port} needs root privileges on this system. Ports below 1024 are reserved; start Tinpost with sudo if you need one.`,
        });
      }
      return resolve({ ok: false, error: `Port ${port} cannot be used: ${err.code || err.message}.` });
    });
    probe.once('listening', () => done({ ok: true }));
    probe.listen(port, host);
  });
}
