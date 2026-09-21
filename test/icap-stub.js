import net from 'node:net';

/**
 * A stand-in ICAP server, enough to hold the client to the protocol.
 *
 * There is no ICAP server in this repository and none is assumed on the machine, so
 * the client is tested against this: it parses the request the client actually
 * writes — head, `Encapsulated` offsets, chunked body, `Preview` and its
 * `100 Continue` handshake — and records what arrived, so a test can assert the
 * attachment bytes reached the far end rather than just that a verdict came back.
 *
 * Verdicts model the products as they actually answer: `infected` is the AV-vendor
 * shape (a 200 with a replacement page and the threat in a header), `mdblocked` and
 * `sanitized` are MetaDefender's (a 200 either way, with `X-Response-Info` saying
 * which), and `blocked` is the plain 403 the spec spells out.
 *
 * @param {{ verdict?: 'clean'|'infected'|'mdblocked'|'sanitized'|'blocked'|'error'|'silent',
 *           threat?: string, wantAll?: boolean, statusCode?: number,
 *           statusText?: string }} [options]
 */
export async function startIcapStub(options = {}) {
  const {
    verdict = 'clean',
    threat = 'EICAR-Test-File',
    // Whether a previewed request gets a "send me the rest" rather than a verdict
    // straight off the preview.
    wantAll = true,
    statusCode = 500,
    statusText = 'Server Error',
  } = options;

  /** Every request the stub saw, in order. */
  const requests = [];

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let request = null;
    let continued = false;
    let body = Buffer.alloc(0);
    let previewLength = null;

    const respond = (text) => {
      socket.write(text);
      socket.end();
    };

    const finish = () => {
      const record = {
        method: request.method,
        uri: request.uri,
        headers: request.headers,
        httpHead: request.httpHead ?? Buffer.alloc(0),
        body,
        previewLength,
        preview: request.headers.preview !== undefined ? Number.parseInt(request.headers.preview, 10) : null,
        continued,
      };
      requests.push(record);

      if (verdict === 'silent') return; // never answers: the timeout path
      if (verdict === 'error') return respond(`ICAP/1.0 ${statusCode} ${statusText}\r\n\r\n`);
      if (verdict === 'clean') {
        return respond('ICAP/1.0 204 No Content\r\nISTag: "tinpost-stub-1"\r\nEncapsulated: null-body=0\r\n\r\n');
      }
      if (verdict === 'blocked') {
        return respond(`ICAP/1.0 403 Forbidden\r\nISTag: "tinpost-stub-1"\r\nEncapsulated: null-body=0\r\n\r\n`);
      }

      // MetaDefender's two 200s: the verdict is in X-Response-Info, not the status.
      if (verdict === 'mdblocked' || verdict === 'sanitized') {
        const blocked = verdict === 'mdblocked';
        const payload = Buffer.from(
          blocked ? '<html><body>Blocked by MetaDefender</body></html>' : 'sanitised copy of the file',
          'utf8',
        );
        const httpHead = Buffer.from(
          `HTTP/1.1 200 OK\r\nContent-Type: ${blocked ? 'text/html' : 'application/octet-stream'}\r\n` +
            `Content-Length: ${payload.length}\r\n\r\n`,
          'utf8',
        );
        const icapHead = Buffer.from(
          'ICAP/1.0 200 OK\r\n' +
            'ISTag: "tinpost-stub-1"\r\n' +
            `X-Response-Info: ${blocked ? 'Blocked' : 'Allowed'}\r\n` +
            'X-ICAP-Profile: Proxy\r\n' +
            (blocked
              ? `X-Response-Desc: Infected\r\nX-Blocked-Reason: Infected\r\nX-Virus-ID: ${threat}\r\n` +
                `X-Infection-Found: Type=0; Resolution=0; Threat=${threat};\r\n`
              : '') +
            `Encapsulated: res-hdr=0, res-body=${httpHead.length}\r\n\r\n`,
          'utf8',
        );
        socket.write(
          Buffer.concat([
            icapHead,
            httpHead,
            Buffer.from(`${payload.length.toString(16)}\r\n`, 'utf8'),
            payload,
            Buffer.from('\r\n0\r\n\r\n', 'utf8'),
          ]),
        );
        return socket.end();
      }

      // Infected: what a real AV service sends back — a 200 carrying a replacement
      // page, with the threat named in a header.
      const page = Buffer.from('<html><body>Blocked</body></html>', 'utf8');
      const httpHead = Buffer.from(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: ${page.length}\r\n\r\n`,
        'utf8',
      );
      const icapHead = Buffer.from(
        'ICAP/1.0 200 OK\r\n' +
          'ISTag: "tinpost-stub-1"\r\n' +
          `X-Infection-Found: Type=0; Resolution=2; Threat=${threat};\r\n` +
          'X-Violations-Found: 1\r\n' +
          `Encapsulated: res-hdr=0, res-body=${httpHead.length}\r\n\r\n`,
        'utf8',
      );
      socket.write(
        Buffer.concat([
          icapHead,
          httpHead,
          Buffer.from(`${page.length.toString(16)}\r\n`, 'utf8'),
          page,
          Buffer.from('\r\n0\r\n\r\n', 'utf8'),
        ]),
      );
      socket.end();
    };

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      if (!request) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        request = parseRequest(buffer.subarray(0, end).toString('latin1'));
        buffer = buffer.subarray(end + 4);

        if (request.method === 'OPTIONS') {
          requests.push({ method: 'OPTIONS', uri: request.uri, headers: request.headers });
          return respond(
            'ICAP/1.0 200 OK\r\n' +
              'Methods: RESPMOD, REQMOD\r\n' +
              'Service: Tinpost test stub 1.0\r\n' +
              'ISTag: "tinpost-stub-1"\r\n' +
              'Allow: 204\r\n' +
              'Preview: 128\r\n' +
              'Encapsulated: null-body=0\r\n\r\n',
          );
        }

        // Skip the encapsulated HTTP head: the body offset says where it ends.
        const bodyOffset = encapsulatedBodyOffset(request.headers.encapsulated);
        if (bodyOffset === null) return respond('ICAP/1.0 400 Bad Request\r\n\r\n');
        request.httpHeadLength = bodyOffset;
        request.httpHeadSeen = 0;
      }

      // The encapsulated HTTP head comes before the chunked body and is not chunked.
      if (request.httpHeadSeen < request.httpHeadLength) {
        const want = request.httpHeadLength - request.httpHeadSeen;
        const take = Math.min(want, buffer.length);
        request.httpHead = Buffer.concat([request.httpHead ?? Buffer.alloc(0), buffer.subarray(0, take)]);
        request.httpHeadSeen += take;
        buffer = buffer.subarray(take);
        if (request.httpHeadSeen < request.httpHeadLength) return;
      }

      // Chunked body, one or two phases depending on Preview.
      for (;;) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const header = buffer.subarray(0, lineEnd).toString('latin1');
        const size = Number.parseInt(header.split(';')[0], 16);
        if (!Number.isInteger(size)) return respond('ICAP/1.0 400 Bad Request\r\n\r\n');

        if (size === 0) {
          const ieof = /;\s*ieof/i.test(header);
          buffer = buffer.subarray(lineEnd + 2);
          // Drop the trailing CRLF of the terminator if it arrived.
          if (buffer.subarray(0, 2).toString() === '\r\n') buffer = buffer.subarray(2);

          const previewing = request.headers.preview !== undefined && !continued;
          if (previewing && wantAll && !ieof) {
            previewLength = body.length;
            continued = true;
            socket.write('ICAP/1.0 100 Continue\r\n\r\n');
            continue;
          }
          if (previewing) previewLength = body.length;
          return finish();
        }

        if (buffer.length < lineEnd + 2 + size + 2) return; // the chunk is still arriving
        body = Buffer.concat([body, buffer.subarray(lineEnd + 2, lineEnd + 2 + size)]);
        buffer = buffer.subarray(lineEnd + 2 + size + 2);
      }
    });

    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    host: '127.0.0.1',
    requests,
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function parseRequest(head) {
  const lines = head.split(/\r?\n/);
  const [method, uri] = (lines.shift() ?? '').split(/\s+/);
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { method: (method ?? '').toUpperCase(), uri, headers };
}

function encapsulatedBodyOffset(value) {
  for (const part of String(value ?? '').split(',')) {
    const m = /(req-body|res-body)\s*=\s*(\d+)/i.exec(part);
    if (m) return Number.parseInt(m[2], 10);
  }
  return null;
}
