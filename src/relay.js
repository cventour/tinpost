import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { readSetting, splitList } from './settings.js';
import { domainOf } from './db.js';

/**
 * The upstream relay: hands mail that crosses a local domain's boundary to a smart
 * host — in practice a security gateway such as OPSWAT MetaDefender Email Security —
 * which scans it and sends it back to Tinpost's SMTP port, where it is delivered
 * like any other message.
 *
 * Three rules shape everything here:
 *
 *   - Mail goes through the gateway when it crosses a local domain's boundary, in
 *     either direction: out of a local domain to any other, or into a local domain
 *     from any other. Mail that stays inside one domain is delivered directly, and so
 *     is mail between two domains neither of which is local.
 *   - Mail that arrives from the gateway is never relayed again. It is recognised by
 *     the address it connects from, which is the one thing a sender cannot forge.
 *   - There is no queue. When the gateway cannot take the message, it is delivered
 *     locally without being scanned, with a footnote in its body saying so and why.
 */

/** Stamped on every message handed to the gateway, so a loop can be recognised. */
export const HOP_HEADER = 'X-Tinpost-Relayed';

/** The relay settings in the shape the rest of this module wants. */
export function relayConfig(db) {
  const host = readSetting(db, 'relay_host');
  const returnHosts = splitList(readSetting(db, 'relay_return_hosts'));
  return {
    enabled: readSetting(db, 'relay_enabled'),
    host,
    port: readSetting(db, 'relay_port'),
    auth: readSetting(db, 'relay_auth'),
    user: readSetting(db, 'relay_user'),
    pass: readSetting(db, 'relay_pass'),
    // Stored in milliseconds, which is what nodemailer takes.
    timeout: readSetting(db, 'relay_timeout'),
    localDomains: splitList(readSetting(db, 'relay_local_domains')),
    // With nothing listed, the gateway is assumed to send back from where it listens.
    returnHosts: returnHosts.length ? returnHosts : [host.toLowerCase()],
    name: readSetting(db, 'smtp_name'),
  };
}

/** Where the gateway lives, as one string, for logs and for the admin page. */
export function relayAddress(config) {
  return `${config.host}:${config.port}`;
}

/** Is this sender's domain one Tinpost relays outbound mail for? */
export function isLocalSender(config, from) {
  if (!config.enabled) return false;
  const domain = domainOf(from ?? '');
  return !!domain && config.localDomains.includes(domain);
}

/**
 * Split a message's recipients into those delivered here and those relayed.
 *
 * A recipient is relayed when the message crosses a local domain's boundary to reach
 * them: the sender is local and the recipient is in another domain (outbound), or the
 * recipient is local and the sender is in another domain (inbound). A recipient in
 * the sender's own domain is always delivered directly, and so is one where neither
 * side is local.
 *
 * @returns {{ local: string[], relay: string[] }}
 */
export function planRoute(config, { from, recipients = [] }) {
  if (!config.enabled) return { local: [...recipients], relay: [] };
  const senderDomain = domainOf(from ?? '');
  const senderLocal = !!senderDomain && config.localDomains.includes(senderDomain);
  const local = [];
  const relay = [];
  for (const address of recipients) {
    const domain = domainOf(address);
    const crosses = domain !== senderDomain && (senderLocal || config.localDomains.includes(domain));
    (crosses ? relay : local).push(address);
  }
  return { local, relay };
}

/**
 * Did this connection come from the gateway? Host names are resolved on every call,
 * so a gateway whose address changes is still recognised without a restart.
 */
export async function isFromGateway(config, remoteAddress, { resolve = lookup } = {}) {
  if (!config.enabled || !remoteAddress) return false;
  const remote = normaliseIp(remoteAddress);

  for (const entry of config.returnHosts) {
    const candidate = entry.replace(/^\[|\]$/g, '');
    if (isIP(candidate)) {
      if (normaliseIp(candidate) === remote) return true;
      continue;
    }
    try {
      const addresses = await resolve(candidate, { all: true });
      if (addresses.some((a) => normaliseIp(a.address) === remote)) return true;
    } catch {
      // A name that does not resolve simply is not this connection.
    }
  }
  return false;
}

/** An IPv4 client on a dual-stack socket reads as ::ffff:1.2.3.4. */
function normaliseIp(address) {
  return String(address).toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
}

/** True when this message has already been through a Tinpost relay once. */
export function hasBeenRelayed(headerLines = []) {
  const prefix = `${HOP_HEADER.toLowerCase()}:`;
  return headerLines.some((line) => String(line).toLowerCase().startsWith(prefix));
}

/** The transport for one send. Built per message, because the settings are live. */
function transportFor(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
    // Plain SMTP by decision: never upgrade, even when the gateway offers STARTTLS.
    ignoreTLS: true,
    name: config.name,
    auth: config.auth ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: config.timeout,
    greetingTimeout: config.timeout,
    socketTimeout: config.timeout,
  });
}

/**
 * Hand a message to the gateway. Never throws: the outcome is returned, because a
 * failure is a delivery decision rather than an error.
 *
 * @param {{ from: string, to: string[], raw: Buffer }} message
 * @returns {Promise<{ ok: boolean, accepted: string[], rejected: string[], response?: string, error?: string }>}
 */
export async function relayMessage(config, { from, to, raw }) {
  const transport = transportFor(config);
  const stamped = Buffer.concat([
    Buffer.from(`${HOP_HEADER}: ${config.name}; ${new Date().toUTCString()}\r\n`),
    raw,
  ]);
  try {
    const info = await transport.sendMail({ envelope: { from, to }, raw: stamped });
    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);
    const rejectedDetail = (info.rejectedErrors ?? []).map(describeError).join('; ');
    return {
      ok: rejected.length === 0,
      accepted,
      rejected,
      response: info.response,
      error: rejected.length ? rejectedDetail || `The gateway refused ${rejected.join(', ')}` : undefined,
    };
  } catch (err) {
    return { ok: false, accepted: [], rejected: [...to], error: describeError(err) };
  } finally {
    transport.close();
  }
}

/**
 * Everything the failure says, in one line: the message, the SMTP reply if there
 * was one, the command it answered, and the error code. The reply is what an
 * operator actually needs — "550 5.7.1 Relaying denied" says what to fix.
 */
export function describeError(err) {
  if (!err) return 'Unknown error';
  const parts = [err.message || String(err)];
  if (err.response && !parts[0].includes(err.response)) parts.push(`server said: ${err.response}`);
  if (err.command) parts.push(`after ${err.command}`);
  if (err.code) parts.push(`code ${err.code}`);
  return parts.join(' — ');
}

/**
 * Prove the gateway answers, and accepts the credentials if there are any. Connects,
 * greets and logs in, and sends no mail.
 */
export async function testRelay(db) {
  const config = relayConfig(db);
  const where = relayAddress(config);
  const transport = transportFor(config);
  try {
    await transport.verify();
    return {
      ok: true,
      where,
      detail: `${where} answered${config.auth ? ` and accepted the login for ${config.user}` : ''}. No mail was sent.`,
    };
  } catch (err) {
    return { ok: false, where, error: `Could not use ${where}: ${describeError(err)}` };
  } finally {
    transport.close();
  }
}

/**
 * Rebuild a message with a footnote saying it could not be relayed. Its body is the
 * one place every reader looks, so that is where the failure is written.
 *
 * @param {object} parsed  what parseMessage returned for the original
 */
export async function withRelayFootnote(parsed, { where, recipients, error }) {
  const lines = [
    '',
    '-- ',
    `Tinpost could not deliver this message through the upstream gateway (${where}).`,
    'It was delivered locally instead, without being scanned.',
    `Recipients affected: ${recipients.join(', ')}`,
    `Error: ${error}`,
  ];
  const note = lines.join('\n');

  const text = `${parsed.bodyText ?? ''}\n${note}\n`;
  let html;
  if (parsed.html) {
    const block =
      '<hr><p style="font:12px/1.5 sans-serif;color:#a33">' +
      lines.slice(2).map(escapeHtml).join('<br>') +
      '</p>';
    html = /<\/body>/i.test(parsed.html) ? parsed.html.replace(/<\/body>/i, `${block}</body>`) : parsed.html + block;
  }

  const byKind = (kind) => parsed.recipients.filter((r) => r.kind === kind).map((r) => ({ name: r.name ?? '', address: r.address }));
  const mail = new MailComposer({
    from: { name: parsed.fromName ?? '', address: parsed.fromAddr || 'unknown@invalid' },
    to: byKind('to'),
    cc: byKind('cc'),
    subject: parsed.subject ?? '',
    date: parsed.date ?? new Date(),
    messageId: parsed.messageId ? `<${parsed.messageId}>` : undefined,
    inReplyTo: parsed.inReplyTo ? `<${parsed.inReplyTo}>` : undefined,
    references: parsed.references || undefined,
    text,
    html,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      cid: a.contentId || undefined,
      contentDisposition: a.isInline ? 'inline' : 'attachment',
    })),
    headers: { 'X-Tinpost-Relay-Failed': error.replace(/[\r\n]+/g, ' ') },
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return new Promise((resolve, reject) => {
    mail.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
