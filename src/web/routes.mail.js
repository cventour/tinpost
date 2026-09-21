import { Readable } from 'node:stream';
import { normaliseAddress, domainOf } from '../db.js';
import { htmlToText } from '../parse.js';
import { ScanRejected } from '../scan.js';

const ADDR_COOKIE = 'mb_addr';
const ADDR_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerMailRoutes(app) {
  const { db, blobs, delivery, config, portNotice } = app.mb;

  /**
   * The address in the cookie. Identity, not authentication — by design.
   *
   * @fastify/cookie already percent-decodes the value, so it is used as-is: a
   * second decode here would unescape a value twice and let a doubly-encoded
   * cookie through.
   */
  function addrOf(req) {
    const a = normaliseAddress(req.cookies?.[ADDR_COOKIE]);
    return ADDR_RE.test(a) ? a : null;
  }

  function requireAddr(req, reply) {
    const a = addrOf(req);
    if (!a) {
      reply.redirect('/');
      return null;
    }
    return a;
  }

  // ---------- entry ----------

  app.get('/', (req, reply) => {
    const addr = addrOf(req);
    if (addr && req.query.switch === undefined) return reply.redirect('/mail');
    return reply.view('login', {
      addr,
      error: null,
      policy: db.getAcceptPolicy(),
      domains: db.listDomains(),
      portNotice,
      smtpPort: config.smtpPort,
    });
  });

  app.post('/', (req, reply) => {
    const addr = normaliseAddress(req.body?.address);
    if (!ADDR_RE.test(addr)) {
      return reply.code(400).view('login', {
        addr: null,
        error: 'That does not look like an email address.',
        policy: db.getAcceptPolicy(),
        domains: db.listDomains(),
        portNotice,
        smtpPort: config.smtpPort,
      });
    }
    reply.setCookie(ADDR_COOKIE, addr, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
    });
    return reply.redirect('/mail');
  });

  /**
   * Every address this instance has seen, for completing the entry field.
   *
   * There is nothing to withhold here: a mailbox is readable by anyone who can reach
   * this port, so listing the names costs nothing and saves the operator retyping an
   * address they invented three scenarios ago.
   */
  app.get('/api/mailboxes', (req, reply) => {
    const q = normaliseAddress(req.query.q ?? '');
    const all = db.listMailboxes().map((m) => m.address);
    const matches = q
      ? all
          .filter((a) => a.includes(q))
          // An address starting with what was typed is the better guess, so it leads.
          .sort((a, b) => Number(b.startsWith(q)) - Number(a.startsWith(q)) || a.localeCompare(b))
      : all;
    return reply.send({ addresses: matches.slice(0, 20) });
  });

  app.post('/signout', (req, reply) => {
    reply.clearCookie(ADDR_COOKIE, { path: '/' });
    return reply.redirect('/');
  });

  // ---------- mailbox ----------

  app.get('/mail', (req, reply) => {
    const addr = requireAddr(req, reply);
    if (!addr) return reply;
    const folder = req.query.folder === 'sent' ? 'sent' : 'inbox';
    const messages = folder === 'sent' ? db.listSent(addr) : db.listInbox(addr);
    return reply.view('inbox', {
      addr,
      folder,
      messages: messages.map((m) => decorate(m, db)),
      unread: db.unreadCount(addr),
      maxId: messages.length ? Math.max(...messages.map((m) => m.id)) : 0,
    });
  });

  /** Rows newer than `sinceId`, as JSON. Used by the live client and its fallback poll. */
  app.get('/api/mail/since', (req, reply) => {
    const addr = addrOf(req);
    if (!addr) return reply.code(401).send({ error: 'no mailbox selected' });
    const folder = req.query.folder === 'sent' ? 'sent' : 'inbox';
    const sinceId = Number.parseInt(req.query.since ?? '0', 10) || 0;
    const rows = folder === 'sent' ? db.listSent(addr, { sinceId }) : db.listInbox(addr, { sinceId });
    return reply.send({
      unread: db.unreadCount(addr),
      messages: rows.map((m) => summary(decorate(m, db))),
    });
  });

  /**
   * Live updates. An in-process event from delivery.js is forwarded here to
   * whoever is looking at an affected mailbox — the inbox updates without a
   * reload, the way a real webmail client behaves.
   */
  app.get('/api/stream', (req, reply) => {
    const addr = addrOf(req);
    if (!addr) return reply.code(401).send({ error: 'no mailbox selected' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');

    const onMessage = (msg) => {
      if (!msg.addresses.includes(addr)) return;
      reply.raw.write(`event: mail\ndata: ${JSON.stringify({ id: msg.id })}\n\n`);
    };
    delivery.on('message', onMessage);

    // Keeps intermediaries from closing an idle connection.
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);

    const cleanup = () => {
      clearInterval(ping);
      delivery.off('message', onMessage);
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    return reply;
  });

  // ---------- one message ----------

  app.get('/mail/:id', (req, reply) => {
    const addr = requireAddr(req, reply);
    if (!addr) return reply;
    const id = Number.parseInt(req.params.id, 10);
    if (!db.canAccess(addr, id)) return notFound(reply, addr);

    const m = db.getMessage(id);
    db.markSeen(addr, id);

    const view = ['html', 'text', 'source'].includes(req.query.view)
      ? req.query.view
      : m.html_hash
        ? 'html'
        : 'text';

    return reply.view('message', {
      addr,
      m: decorate(m, db),
      recipients: db.getRecipients(id),
      attachments: db.getAttachments(id, { includeInline: false }),
      view,
      folder: m.from_addr === addr ? 'sent' : 'inbox',
    });
  });

  /**
   * The HTML part, served into a sandboxed iframe.
   *
   * A sandboxed frame has an opaque origin, so it can make no same-origin request
   * and 'self' in a CSP can never match it. Inline (cid:) images are therefore
   * embedded as data: URIs at serve time: the message document then needs no
   * subresource requests at all, and the CSP can deny every network source
   * outright. Lab mail is deliberately hostile, so nothing in it may run script
   * or reach the network.
   */
  app.get('/mail/:id/html', async (req, reply) => {
    const addr = requireAddr(req, reply);
    if (!addr) return reply;
    const id = Number.parseInt(req.params.id, 10);
    if (!db.canAccess(addr, id)) return notFound(reply, addr);
    const m = db.getMessage(id);
    if (!m?.html_hash) return reply.code(404).send('no html part');

    const html = await inlineCids((await blobs.read(m.html_hash)).toString('utf8'), id);

    return reply
      .type('text/html; charset=utf-8')
      .header(
        'content-security-policy',
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
      )
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .send(html);
  });

  /**
   * Replace cid: references with data: URIs read from the blob store. Anything
   * that is not a resolvable inline image becomes about:blank, so a remote URL
   * smuggled in where a cid was expected never survives.
   */
  async function inlineCids(html, messageId) {
    const MAX_INLINE = 4 * 1024 * 1024;
    const CID_RE = /(["'(])cid:([^"')\s]+)(["')])/gi;
    const found = [...html.matchAll(CID_RE)];
    if (!found.length) return html;

    const resolved = new Map();
    for (const [, , cid] of found) {
      const clean = safeDecode(cid).replace(/^<|>$/g, '');
      if (resolved.has(clean)) continue;
      const att = db.findInlineByCid(messageId, clean);
      if (!att || !/^image\//i.test(att.content_type || '') || att.size_bytes > MAX_INLINE) {
        resolved.set(clean, null);
        continue;
      }
      const content = await blobs.read(att.content_hash);
      resolved.set(clean, `data:${att.content_type};base64,${content.toString('base64')}`);
    }

    return html.replace(CID_RE, (match, open, cid, close) => {
      const uri = resolved.get(safeDecode(cid).replace(/^<|>$/g, ''));
      return `${open}${uri ?? 'about:blank'}${close}`;
    });
  }

  /**
   * Attachment download. Always a download, never a render: a neutral content type
   * plus an attachment disposition means a hostile attachment in a phishing lab
   * cannot execute in the reader's browser.
   */
  app.get('/mail/:id/attachment/:attId', (req, reply) => {
    const addr = requireAddr(req, reply);
    if (!addr) return reply;
    const id = Number.parseInt(req.params.id, 10);
    if (!db.canAccess(addr, id)) return notFound(reply, addr);
    const att = db.getAttachment(id, Number.parseInt(req.params.attId, 10));
    if (!att) return notFound(reply, addr);

    return reply
      .type('application/octet-stream')
      .header('content-disposition', contentDisposition(att.filename))
      .header('content-length', att.size_bytes)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(blobs.openRead(att.content_hash));
  });

  /** The original message, for reading headers or feeding another tool. */
  app.get('/mail/:id/raw', async (req, reply) => {
    const addr = requireAddr(req, reply);
    if (!addr) return reply;
    const id = Number.parseInt(req.params.id, 10);
    if (!db.canAccess(addr, id)) return notFound(reply, addr);
    const m = db.getMessage(id);
    const download = req.query.download !== undefined;

    if (download) {
      return reply
        .type('message/rfc822')
        .header('content-disposition', contentDisposition(`message-${id}.eml`))
        .send(blobs.openRead(m.raw_hash));
    }
    return reply.type('text/plain; charset=utf-8').send(await blobs.read(m.raw_hash));
  });

  // ---------- compose ----------

  app.get('/compose', (req, reply) => {
    const addr = requireAddr(req, reply);
    if (!addr) return reply;

    const replyTo = req.query.reply ? Number.parseInt(req.query.reply, 10) : null;
    const all = req.query.all !== undefined;
    let draft = { to: '', cc: '', subject: '', text: '', inReplyTo: null, references: null };

    if (replyTo && db.canAccess(addr, replyTo)) {
      const m = db.getMessage(replyTo);
      const rcpts = db.getRecipients(replyTo);
      const others = all
        ? rcpts.map((r) => r.address).filter((a) => a !== addr && a !== m.from_addr)
        : [];
      draft = {
        to: m.from_addr,
        cc: others.join(', '),
        subject: /^re:/i.test(m.subject ?? '') ? m.subject : `Re: ${m.subject ?? ''}`.trim(),
        text: quote(m),
        inReplyTo: m.message_id,
        references: [m.refs, m.message_id].filter(Boolean).map((r) => `<${r}>`).join(' '),
      };
    }

    return reply.view('compose', { addr, draft, error: null, policy: db.getAcceptPolicy() });
  });

  app.post('/compose', async (req, reply) => {
    const addr = requireAddr(req, reply);
    if (!addr) return reply;

    let fields = {};
    const attachments = [];

    if (req.isMultipart()) {
      // Multipart parts stream straight into the blob store, so an attached file
      // is never held in memory in full.
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (!part.filename) {
            await part.toBuffer().catch(() => {});
            continue;
          }
          const { hash, size } = await blobs.put(part.file, { maxSize: config.maxSize });
          if (part.file.truncated) {
            return renderComposeError(reply, addr, fields, `"${part.filename}" exceeds the size limit.`);
          }
          if (size > 0) {
            attachments.push({
              filename: sanitiseUploadName(part.filename),
              contentType: part.mimetype || 'application/octet-stream',
              hash,
              size,
            });
          }
        } else {
          fields[part.fieldname] = part.value;
        }
      }
    } else {
      // A plain form post carries no files, but scripts driving the lab often send
      // one, so it has to work rather than fail as "not multipart".
      fields = req.body ?? {};
    }

    const to = splitAddresses(fields.to);
    const cc = splitAddresses(fields.cc);
    if (!to.length) return renderComposeError(reply, addr, fields, 'At least one recipient is required.');

    const bad = [...to, ...cc].filter((a) => !ADDR_RE.test(a));
    if (bad.length) return renderComposeError(reply, addr, fields, `Not a valid address: ${bad.join(', ')}`);

    // The same policy the SMTP listener enforces, so the UI cannot be used to
    // sidestep the domain rules the admin set.
    const blocked = [...to, ...cc].filter((a) => !db.isDomainAccepted(domainOf(a)));
    if (blocked.length) {
      return renderComposeError(
        reply,
        addr,
        fields,
        `Delivery refused for ${blocked.join(', ')} — the accept policy is set to allowlist and those domains are not on it.`,
      );
    }

    const asHtml = fields.format === 'html';
    const body = fields.text ?? '';
    let summaryMsg;
    try {
      summaryMsg = await delivery.deliverComposed({
        from: addr,
        to,
        cc,
        subject: fields.subject ?? '',
        text: asHtml ? htmlToText(body) : body,
        html: asHtml ? body : null,
        attachments,
        inReplyTo: fields.inReplyTo || null,
        references: fields.references || null,
      });
    } catch (err) {
      // Outbound mail goes through the same scanner as inbound, so a blocked
      // attachment comes back as an error on the form the draft was typed into
      // rather than as a 500 that loses it.
      if (err instanceof ScanRejected) {
        return renderComposeError(
          reply,
          addr,
          fields,
          err.temporary
            ? `${err.message}. The message was not sent; try again once the scanner is back.`
            : `${err.message}. The message was not sent.`,
        );
      }
      throw err;
    }

    return reply.redirect(`/mail/${summaryMsg.id}?sent=1`);
  });

  function renderComposeError(reply, addr, fields, error) {
    return reply.code(400).view('compose', {
      addr,
      draft: {
        to: fields.to ?? '',
        cc: fields.cc ?? '',
        subject: fields.subject ?? '',
        text: fields.text ?? '',
        inReplyTo: fields.inReplyTo ?? null,
        references: fields.references ?? null,
      },
      error,
      policy: db.getAcceptPolicy(),
    });
  }

  function notFound(reply, addr) {
    return reply.code(404).view('error', {
      title: 'Not found',
      message: 'That message does not exist, or is not addressed to this mailbox.',
      addr,
    });
  }
}

function decorate(m, db) {
  return {
    ...m,
    snippet: (m.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
    hasHtml: !!m.html_hash,
    seen: m.seen === undefined ? 1 : m.seen,
    toLine: db
      .getRecipients(m.id)
      .filter((r) => r.kind !== 'bcc')
      .map((r) => r.address)
      .join(', '),
  };
}

function summary(m) {
  return {
    id: m.id,
    from: m.from_addr,
    fromName: m.from_name,
    subject: m.subject,
    snippet: m.snippet,
    date: m.date_utc,
    seen: m.seen,
    hasAttachments: !!m.has_attachments,
    toLine: m.toLine,
  };
}

/** A malformed percent-escape in a cid must not throw and blank the whole message. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function quote(m) {
  const when = new Date(m.date_utc).toLocaleString();
  const body = (m.body_text ?? '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\nOn ${when}, ${m.from_addr} wrote:\n${body}\n`;
}

function splitAddresses(value) {
  return String(value ?? '')
    .split(/[,;]/)
    .map((s) => normaliseAddress(s.replace(/^.*<|>.*$/g, '')))
    .filter(Boolean);
}

function sanitiseUploadName(name) {
  return String(name ?? 'attachment')
    .replace(/[\r\n\t\0]/g, '')
    .split(/[\\/]/)
    .pop()
    .replace(/^\.+/, '')
    .slice(0, 200) || 'attachment';
}

/**
 * RFC 6266 disposition. The plain filename is stripped to ASCII and quoted, with the
 * real name carried in filename* — so a crafted name cannot inject a header.
 */
function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16));
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
