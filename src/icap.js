import net from 'node:net';

/**
 * A small ICAP client (RFC 3507), enough to ask an ICAP server whether a piece of
 * content is allowed through.
 *
 * Tinpost uses it for one job: hand each attachment to a scanning service and wait
 * for a verdict before a message is accepted. So the client supports the parts of
 * the protocol that job needs and nothing more —
 *
 *   - `OPTIONS`, to discover a service and to let the admin page prove the address
 *     and port are right,
 *   - `RESPMOD` and `REQMOD`, each carrying the content inside a synthetic HTTP
 *     message as the spec requires,
 *   - `Preview` with the `100 Continue` / `204` early exit, because a scanner that
 *     only wants the first kilobyte should not be sent a 20 MB file,
 *   - `Allow: 204`, so a clean verdict costs one short response and no body.
 *
 * One connection per request, closed afterwards. Persistent connections would save
 * a handshake per attachment, and buy nothing in a lab.
 */

const CRLF = '\r\n';
const TERMINATOR = Buffer.from('\r\n\r\n');
const DEFAULT_PORT = 1344;

/** Neither an `icap://` URL nor a bare service path is a complete address on its own. */
export function parseService(service, { host, port } = {}) {
  const raw = String(service ?? '').trim();

  if (/^icaps?:\/\//i.test(raw)) {
    // A full URL in the service field carries its own host and port, which win: an
    // admin who typed one meant it.
    const url = new URL(raw.replace(/^icaps:/i, 'icap:'));
    return {
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : DEFAULT_PORT,
      path: url.pathname === '/' ? '/' : url.pathname,
      query: url.search ?? '',
    };
  }

  const [path, query = ''] = raw.split('?');
  return {
    host: host || '127.0.0.1',
    port: port || DEFAULT_PORT,
    path: path.startsWith('/') ? path : `/${path}`,
    query: query ? `?${query}` : '',
  };
}

/** The `icap://host:port/service` URI that goes on the request line. */
export function serviceUri(target) {
  return `icap://${hostForUri(target.host)}:${target.port}${target.path}${target.query}`;
}

function hostForUri(host) {
  // A bare IPv6 literal has to be bracketed inside a URI.
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Ask the service what it can do. Also the honest way to answer "is the ICAP server
 * reachable at all?", which is what the admin page's test button needs.
 *
 * @param {{ host?: string, port?: number, service: string, timeout?: number }} opts
 */
export async function options({ host, port, service, timeout = 10_000 }) {
  const target = parseService(service, { host, port });
  const head =
    `OPTIONS ${serviceUri(target)} ICAP/1.0${CRLF}` +
    `Host: ${hostForUri(target.host)}:${target.port}${CRLF}` +
    `User-Agent: ${userAgent()}${CRLF}` +
    `Encapsulated: null-body=0${CRLF}${CRLF}`;

  const conn = await connect(target, timeout);
  try {
    conn.write(Buffer.from(head, 'utf8'));
    const response = await conn.readHead();
    const methods = splitList(response.headers['methods']);
    const previewRaw = Number.parseInt(response.headers['preview'] ?? '', 10);
    return {
      ok: response.statusCode === 200,
      statusCode: response.statusCode,
      statusText: response.statusText,
      headers: response.headers,
      service: response.headers['service'] ?? null,
      istag: response.headers['istag'] ?? null,
      methods,
      preview: Number.isInteger(previewRaw) && previewRaw >= 0 ? previewRaw : null,
      allow204: splitList(response.headers['allow']).includes('204'),
      target,
    };
  } finally {
    conn.end();
  }
}

/**
 * Send one piece of content for a verdict.
 *
 * The result is deliberately a verdict and not an exception: "the scanner said no"
 * and "the scanner could not be reached" are different decisions for the caller to
 * make, and flattening both into a thrown error loses that.
 *
 * @param {{
 *   host?: string, port?: number, service: string, method?: 'respmod'|'reqmod',
 *   content: Buffer, filename?: string, contentType?: string,
 *   preview?: number, timeout?: number, headers?: Record<string,string>,
 * }} opts
 * @returns {Promise<{ verdict: 'clean'|'blocked'|'error', statusCode: number|null,
 *                     threat: string|null, detail: string, permanent?: boolean,
 *                     modified?: boolean, headers: Record<string,string> }>}
 */
export async function scan(opts) {
  const {
    host,
    port,
    service,
    method = 'respmod',
    content,
    filename = 'attachment',
    contentType = 'application/octet-stream',
    preview = 0,
    timeout = 10_000,
    headers: extraHeaders = {},
  } = opts;

  const body = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
  const target = parseService(service, { host, port });
  const httpHead = method === 'reqmod' ? httpRequestHead(filename, contentType, body.length) : httpResponseHead(filename, contentType, body.length);

  // Preview only makes sense when there is more body than preview: offering a
  // preview as long as the file just adds a round trip.
  const usePreview = Number.isInteger(preview) && preview > 0 && body.length > preview;
  const previewLength = usePreview ? Math.min(preview, body.length) : 0;

  const bodyLabel = method === 'reqmod' ? 'req-body' : 'res-body';
  const headerLabel = method === 'reqmod' ? 'req-hdr' : 'res-hdr';

  let head =
    `${method.toUpperCase()} ${serviceUri(target)} ICAP/1.0${CRLF}` +
    `Host: ${hostForUri(target.host)}:${target.port}${CRLF}` +
    `User-Agent: ${userAgent()}${CRLF}` +
    `Allow: 204${CRLF}`;
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === undefined || value === null || value === '') continue;
    // These are operator- and sender-derived, and a newline in one would forge a
    // header, so they are sanitised rather than trusted.
    head += `${name}: ${String(value).replace(/[\r\n]+/g, ' ').slice(0, 300)}${CRLF}`;
  }
  if (usePreview) head += `Preview: ${previewLength}${CRLF}`;
  head += `Encapsulated: ${headerLabel}=0, ${bodyLabel}=${httpHead.length}${CRLF}${CRLF}`;

  let conn;
  try {
    conn = await connect(target, timeout);
  } catch (err) {
    return errorVerdict(err);
  }

  try {
    conn.write(Buffer.from(head, 'utf8'));
    conn.write(httpHead);

    if (usePreview) {
      conn.write(chunk(body.subarray(0, previewLength)));
      // `ieof` says "that was the whole body" — not the case here, since preview is
      // only used when the body is longer than the preview.
      conn.write(Buffer.from(`0${CRLF}${CRLF}`, 'utf8'));

      const first = await conn.readHead();
      if (first.statusCode !== 100) return verdictFrom(first);

      conn.write(chunk(body.subarray(previewLength)));
      conn.write(Buffer.from(`0${CRLF}${CRLF}`, 'utf8'));
      return verdictFrom(await conn.readHead());
    }

    if (body.length) conn.write(chunk(body));
    conn.write(Buffer.from(`0${CRLF}${CRLF}`, 'utf8'));
    return verdictFrom(await conn.readHead());
  } catch (err) {
    return errorVerdict(err);
  } finally {
    conn.end();
  }
}

function userAgent() {
  return 'Tinpost-ICAP/1.0';
}

/**
 * The synthetic HTTP response an attachment is wrapped in for RESPMOD. Scanners key
 * off `Content-Type` and the filename, so both are carried even though nothing here
 * ever spoke HTTP.
 */
function httpResponseHead(filename, contentType, length) {
  return Buffer.from(
    `HTTP/1.1 200 OK${CRLF}` +
      `Content-Type: ${headerSafe(contentType)}${CRLF}` +
      `Content-Disposition: attachment; filename="${quotedFilename(filename)}"${CRLF}` +
      `Content-Length: ${length}${CRLF}${CRLF}`,
    'utf8',
  );
}

/** The REQMOD equivalent: the attachment as the body of an upload. */
function httpRequestHead(filename, contentType, length) {
  return Buffer.from(
    `POST /${encodeURIComponent(filename)} HTTP/1.1${CRLF}` +
      `Host: tinpost.invalid${CRLF}` +
      `Content-Type: ${headerSafe(contentType)}${CRLF}` +
      `Content-Length: ${length}${CRLF}${CRLF}`,
    'utf8',
  );
}

function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200) || 'application/octet-stream';
}

/** Attachment names are sender-chosen: no quotes, no line breaks, no header forging. */
function quotedFilename(name) {
  return String(name ?? 'attachment')
    .replace(/[\r\n"\\]/g, '_')
    .slice(0, 200) || 'attachment';
}

function chunk(buf) {
  return Buffer.concat([Buffer.from(`${buf.length.toString(16)}${CRLF}`, 'utf8'), buf, Buffer.from(CRLF, 'utf8')]);
}

/**
 * Turn an ICAP response into a decision.
 *
 * The status line alone is not enough, because the products disagree about it. A
 * scanner that refuses a file may answer `403`, or it may answer `200` and hand back
 * a replacement page — MetaDefender ICAP Server does the latter, and reserves `403`
 * for its FILEMOD method, which is not the one used here. So the headers are read
 * first: `X-Response-Info` carries one word, `Allowed` or `Blocked`, and where it is
 * present it is the answer. The status line is the fallback for the servers that do
 * not set it.
 *
 * That header also settles a case the status line cannot express: content that was
 * sanitised or redacted rather than refused comes back as `200` and `Allowed`. It is
 * approved, and reading it as a refusal would reject a clean attachment.
 */
function verdictFrom(response) {
  const { statusCode, statusText, headers } = response;
  const threat = threatName(headers);
  const stated = (headers['x-response-info'] ?? '').trim().toLowerCase();
  // Why it was refused, in the server's own words: "Infected", "Encrypted Archive".
  const reason = (headers['x-response-desc'] || headers['x-blocked-reason'] || '').trim() || null;

  if (stated === 'blocked') return blockedVerdict(statusCode, statusText, threat, reason, headers);

  if (stated === 'allowed') {
    // A 200 means a payload came back with the approval: the file was sanitised or
    // redacted, and what the scanner approved is that copy rather than the original.
    // Tinpost stores the message as it arrived and has nowhere to put a rewritten
    // part, so the caller is told, and says so in the log.
    return {
      verdict: 'clean',
      statusCode,
      threat: null,
      modified: statusCode === 200,
      detail: statusCode === 200 ? 'approved, with the attachment rewritten by the scanner' : 'clean',
      headers,
    };
  }

  if (statusCode === 204) {
    return { verdict: 'clean', statusCode, threat: null, modified: false, detail: 'clean', headers };
  }

  if (statusCode === 200) {
    // No header to go by, and a body came back. Every scanner that does this is
    // handing over a replacement notice, which is not something to deliver as mail.
    return blockedVerdict(statusCode, statusText, threat, reason, headers);
  }

  // 403 is the one refusal the spec spells out. Every other 4xx is this client's
  // fault rather than the scanner's — the wrong service path, a request it will not
  // accept — and no amount of retrying fixes that, which is why it is separated from
  // a scanner that is merely down.
  if (statusCode === 403) return blockedVerdict(statusCode, statusText, threat, reason, headers);

  if (statusCode >= 400 && statusCode < 500) {
    return {
      verdict: 'error',
      statusCode,
      threat: null,
      permanent: true,
      detail: configDetail(statusCode, statusText),
      headers,
    };
  }

  return {
    verdict: 'error',
    statusCode,
    threat: null,
    permanent: false,
    detail: `the scanner answered ICAP ${statusCode}${statusText ? ' ' + statusText : ''}`,
    headers,
  };
}

function blockedVerdict(statusCode, statusText, threat, reason, headers) {
  const named = threat || reason;
  return {
    verdict: 'blocked',
    statusCode,
    threat,
    reason,
    detail: named
      ? `blocked: ${named}`
      : `blocked by the scanner (ICAP ${statusCode}${statusText ? ' ' + statusText : ''})`,
    headers,
  };
}

/** A misconfiguration, named so the fix is obvious from the message. */
function configDetail(statusCode, statusText) {
  if (statusCode === 404) return 'the scanner has no service at that path (ICAP 404 Not found)';
  if (statusCode === 405) {
    return 'the scanner does not accept this ICAP method (ICAP 405) — try the other one';
  }
  if (statusCode === 400) return 'the scanner rejected the request as malformed (ICAP 400 Bad request)';
  return `the scanner refused the request with ICAP ${statusCode}${statusText ? ' ' + statusText : ''}`;
}

/**
 * The threat's name, according to whichever header this vendor uses. The wording
 * differs per product — MetaDefender sets `X-Virus-ID` and `X-Infection-Found`,
 * others only one of them — but the shape is stable enough to pick out a name.
 */
function threatName(headers) {
  const direct = headers['x-virus-id'] || headers['x-threat-name'] || headers['x-virus-name'];
  if (direct) return direct.trim();

  const found = headers['x-infection-found'] || headers['x-violations-found'];
  if (!found) return null;
  // e.g. "Type=0; Resolution=2; Threat=EICAR-Test-File;"
  const threat = /threat=([^;]+)/i.exec(found);
  if (threat) return threat[1].trim();
  const lines = found.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 1 ? lines[1] : found.trim();
}

function errorVerdict(err) {
  return {
    verdict: 'error',
    statusCode: null,
    threat: null,
    // A refused connection or a timeout may well work on the next message.
    permanent: false,
    detail: describe(err),
    headers: {},
  };
}

/** Connection failures are what an operator sees most, so they are named plainly. */
export function describe(err) {
  const code = err?.code;
  if (code === 'ECONNREFUSED') return 'nothing is listening on that address and port';
  if (code === 'ETIMEDOUT' || code === 'ICAP_TIMEOUT') return 'the scanner did not answer in time';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'that host name does not resolve';
  if (code === 'ECONNRESET') return 'the scanner closed the connection';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'that host is unreachable';
  if (code === 'ICAP_EOF') return 'the scanner closed the connection without answering';
  if (code === 'ICAP_BAD_RESPONSE') return 'the answer was not ICAP';
  return err?.message || String(err);
}

/**
 * One connection, with a promise-returning read of the next ICAP head.
 *
 * ICAP heads are `\r\n\r\n`-terminated like HTTP's, and a single response can be
 * preceded by a `100 Continue` on the same connection, so the buffer is kept across
 * reads rather than a fresh read per response.
 */
function connect(target, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    let buffer = Buffer.alloc(0);
    let pending = null;
    let failure = null;
    let finished = false;

    const fail = (err) => {
      if (failure) return;
      failure = err;
      if (pending) {
        const { reject: rejectPending } = pending;
        pending = null;
        rejectPending(err);
      }
      socket.destroy();
      if (!finished) {
        finished = true;
        reject(err);
      }
    };

    const drain = () => {
      if (!pending) return;
      const end = buffer.indexOf(TERMINATOR);
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString('latin1');
      buffer = buffer.subarray(end + TERMINATOR.length);
      const { resolve: resolvePending, reject: rejectPending } = pending;
      pending = null;
      try {
        resolvePending(parseHead(head));
      } catch (err) {
        rejectPending(err);
      }
    };

    socket.setTimeout(timeout, () => {
      const err = new Error('ICAP timeout');
      err.code = 'ICAP_TIMEOUT';
      fail(err);
    });
    socket.on('error', fail);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      drain();
    });
    socket.on('end', () => {
      drain();
      if (pending) {
        const err = new Error('ICAP connection closed');
        err.code = 'ICAP_EOF';
        fail(err);
      }
    });

    socket.once('connect', () => {
      finished = true;
      resolve({
        socket,
        write(buf) {
          if (!socket.destroyed) socket.write(buf);
        },
        readHead() {
          if (failure) return Promise.reject(failure);
          return new Promise((resolveHead, rejectHead) => {
            pending = { resolve: resolveHead, reject: rejectHead };
            drain();
            if (socket.readableEnded && pending) {
              pending = null;
              const err = new Error('ICAP connection closed');
              err.code = 'ICAP_EOF';
              rejectHead(err);
            }
          });
        },
        end() {
          socket.destroy();
        },
      });
    });
  });
}

/** `ICAP/1.0 204 No Content` plus folded headers, lower-cased for lookup. */
export function parseHead(head) {
  const lines = unfold(head.split(/\r?\n/));
  const statusLine = lines.shift() ?? '';
  const match = /^ICAP\/(\d\.\d)\s+(\d{3})\s*(.*)$/i.exec(statusLine.trim());
  if (!match) {
    const err = new Error(`not an ICAP response: ${JSON.stringify(statusLine.slice(0, 60))}`);
    err.code = 'ICAP_BAD_RESPONSE';
    throw err;
  }

  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // A repeated header (X-Violations-Found does this) keeps both values.
    headers[name] = headers[name] === undefined ? value : `${headers[name]}\n${value}`;
  }

  return {
    version: match[1],
    statusCode: Number.parseInt(match[2], 10),
    statusText: match[3].trim(),
    headers,
  };
}

/** A header line beginning with whitespace continues the one before it. */
function unfold(lines) {
  const out = [];
  for (const line of lines) {
    if (out.length && /^[ \t]/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
  }
  return out;
}

function splitList(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export { DEFAULT_PORT };
