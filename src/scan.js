import * as icap from './icap.js';
import { readSetting } from './settings.js';
import { domainOf } from './db.js';

/**
 * The policy layer over the ICAP client: decides whether a message needs scanning,
 * asks the scanner about each attachment, and turns the answers into one decision.
 *
 * Two rules shape everything here:
 *
 *   - A message with no attachment is never scanned. There is nothing to scan, and
 *     a round trip per plain-text message would tax the whole lab for no verdict.
 *   - A message that should have been scanned and was not is not an approved
 *     message. When the scanner cannot be reached, the default is to refuse — the
 *     operator can choose to deliver anyway, which is then said plainly in the log.
 */

/** Refused by policy: the scanner blocked it, or could not be asked. */
export class ScanRejected extends Error {
  /**
   * @param {string} message
   * @param {{ temporary?: boolean, threat?: string|null, filename?: string|null, detail?: string }} [info]
   */
  constructor(message, { temporary = false, threat = null, filename = null, detail = '' } = {}) {
    super(message);
    this.name = 'ScanRejected';
    // A scanner that is down is a "try again later"; a virus is not.
    this.temporary = temporary;
    this.threat = threat;
    this.filename = filename;
    this.detail = detail;
  }
}

/** The ICAP settings in the shape the client wants. */
export function icapConfig(db) {
  return {
    enabled: readSetting(db, 'icap_enabled'),
    host: readSetting(db, 'icap_host'),
    port: readSetting(db, 'icap_port'),
    service: readSetting(db, 'icap_service'),
    method: readSetting(db, 'icap_method'),
    preview: readSetting(db, 'icap_preview'),
    // Stored in milliseconds, which is what the client takes.
    timeout: readSetting(db, 'icap_timeout'),
    failMode: readSetting(db, 'icap_fail_mode'),
    scanByDefault: readSetting(db, 'icap_default'),
  };
}

/** Where the scanner lives, as one string, for logs and for the admin page. */
export function icapAddress(config) {
  const target = icap.parseService(config.service, { host: config.host, port: config.port });
  return icap.serviceUri(target);
}

/**
 * Every domain this message touches: the sender's and each recipient's. Scanning is
 * configured per domain and a message crosses two sides, so either side asking for
 * a scan is enough to get one — which is also what makes one switch cover both
 * inbound and outbound mail for a domain.
 */
export function domainsInvolved({ from, recipients = [] }) {
  const out = new Set();
  for (const address of [from, ...recipients]) {
    const domain = domainOf(address ?? '');
    if (domain) out.add(domain);
  }
  return [...out];
}

/**
 * Should this message be scanned? Returns the reason as well as the answer, because
 * the log line is more useful than the boolean.
 *
 * @param {import('./db.js').Db} db
 * @param {{ from?: string, recipients?: string[], attachmentCount?: number }} message
 */
export function scanDecision(db, { from, recipients = [], attachmentCount = 0 } = {}) {
  const config = icapConfig(db);
  if (!config.enabled) return { scan: false, reason: 'ICAP scanning is off', config, domains: [] };
  if (!attachmentCount) return { scan: false, reason: 'no attachments', config, domains: [] };

  const domains = domainsInvolved({ from, recipients });
  const asked = [];
  const exempt = [];
  for (const domain of domains) {
    const override = db.getDomainIcap(domain);
    const on = override === null ? config.scanByDefault : override;
    (on ? asked : exempt).push(domain);
  }

  if (!asked.length) {
    return {
      scan: false,
      reason: `no domain involved asks for scanning (${exempt.join(', ') || 'none'})`,
      config,
      domains,
    };
  }

  return { scan: true, reason: `${asked.join(', ')} ask for scanning`, config, domains, asked, exempt };
}

/**
 * Holds the ICAP settings and the verdict rules. One per instance; it reads the
 * settings fresh on every message, so changing them on the admin page takes effect
 * on the next message rather than at the next restart.
 */
export class Scanner {
  #db;
  #logger;
  #client;

  constructor({ db, logger = console, client = icap } = {}) {
    this.#db = db;
    this.#logger = logger;
    // Injected so the protocol client can be swapped in tests.
    this.#client = client;
  }

  /** Is scanning configured at all? Cheap enough to call per message. */
  get enabled() {
    return icapConfig(this.#db).enabled;
  }

  /**
   * Scan a message's attachments and either return a summary or throw.
   *
   * @param {{ attachments: Array<{ filename: string, contentType: string, content: Buffer }>,
   *           from?: string, recipients?: string[], origin?: string, subject?: string }} message
   * @returns {Promise<{ scanned: boolean, reason: string, results?: Array<object> }>}
   * @throws {ScanRejected} when the message must not be delivered.
   */
  async check({ attachments = [], from, recipients = [], origin = 'smtp', subject = '' } = {}) {
    const decision = scanDecision(this.#db, {
      from,
      recipients,
      attachmentCount: attachments.length,
    });
    if (!decision.scan) return { scanned: false, reason: decision.reason };

    const { config } = decision;
    const where = icapAddress(config);
    const results = [];

    for (const attachment of attachments) {
      const name = attachment.filename || 'attachment';
      const result = await this.#client.scan({
        host: config.host,
        port: config.port,
        service: config.service,
        method: config.method,
        preview: config.preview,
        timeout: config.timeout,
        content: attachment.content,
        filename: name,
        contentType: attachment.contentType,
        // Context a scanning policy may well want, and which costs nothing to send.
        headers: {
          'X-Mail-From': from,
          'X-Rcpt-To': recipients.join(', '),
          'X-Tinpost-Origin': origin,
          'X-Tinpost-Subject': subject,
        },
      });
      results.push({ filename: name, size: attachment.content?.length ?? 0, ...result });

      // Approved, but the scanner handed back a rewritten copy — sanitised by a CDR
      // step, or redacted by a DLP one. Tinpost stores the message exactly as it
      // arrived, so what gets delivered is the original: approved by the scanner, but
      // not the copy the scanner made safe. Said plainly rather than passed over.
      if (result.verdict === 'clean' && result.modified) {
        this.#logger.error?.(
          `icap: ${where} approved "${name}" but returned a rewritten copy; Tinpost delivers the original, unmodified`,
        );
      }

      if (result.verdict === 'blocked') {
        this.#logger.info?.(
          `icap: ${where} blocked "${name}" from ${from || 'unknown'} (${result.detail})`,
        );
        throw new ScanRejected(
          result.threat
            ? `Rejected by virus scanner: ${result.threat} in "${name}"`
            : `Rejected by virus scanner: "${name}" was not approved`,
          { threat: result.threat, filename: name, detail: result.detail },
        );
      }

      if (result.verdict === 'error') {
        // The scan did not happen. Whether that stops the message is the operator's
        // call — the fail mode — and either way it is said out loud.
        if (config.failMode === 'open') {
          this.#logger.error?.(
            `icap: could not scan "${name}" (${result.detail}); delivering it anyway because the failure mode is open`,
          );
          results[results.length - 1].deliveredUnscanned = true;
          continue;
        }
        this.#logger.error?.(`icap: could not scan "${name}" (${result.detail}); refusing the message`);

        // A scanner that is down deserves a "come back later", because the next
        // attempt may well work. A misconfigured one does not: the service path is
        // wrong, or the method is, and retrying forever fixes neither. Telling the
        // sender to retry would be a lie, and it would hide the fault behind a queue.
        throw result.permanent
          ? new ScanRejected(`Virus scanner misconfigured: ${result.detail}`, {
              temporary: false,
              filename: name,
              detail: result.detail,
            })
          : new ScanRejected(`Virus scanner unavailable: ${result.detail}`, {
              temporary: true,
              filename: name,
              detail: result.detail,
            });
      }
    }

    this.#logger.info?.(
      `icap: ${where} passed ${results.length} attachment(s) for ${from || 'unknown'} (${decision.reason})`,
    );
    return { scanned: true, reason: decision.reason, results };
  }
}

/**
 * Prove the configured address, port and service actually answer ICAP. This is what
 * the admin page's test button calls, and the one honest way to check the setup
 * without sending a message through.
 *
 * @param {import('./db.js').Db} db
 * @param {{ client?: object }} [deps]
 */
export async function testConnection(db, { client = icap } = {}) {
  const config = icapConfig(db);
  const where = icapAddress(config);
  try {
    const result = await client.options({
      host: config.host,
      port: config.port,
      service: config.service,
      timeout: config.timeout,
    });

    if (!result.ok) {
      return {
        ok: false,
        where,
        error: `${where} answered ICAP ${result.statusCode}${result.statusText ? ' ' + result.statusText : ''}. The address and port are right, but that service is not.`,
      };
    }

    const methods = result.methods.length ? result.methods.join(', ').toUpperCase() : 'none advertised';
    const wanted = config.method.toUpperCase();
    const warning =
      result.methods.length && !result.methods.includes(config.method)
        ? ` It does not advertise ${wanted}, which is the method set here — scans will most likely be refused with ICAP 405.`
        : '';

    return {
      ok: true,
      where,
      istag: result.istag,
      methods: result.methods,
      preview: result.preview,
      detail:
        `${where} answered. Methods: ${methods}.` +
        (result.preview !== null ? ` It prefers a ${result.preview}-byte preview.` : '') +
        (result.istag ? ` Service tag ${result.istag}.` : '') +
        warning,
    };
  } catch (err) {
    return { ok: false, where, error: `${where} could not be reached: ${client.describe ? client.describe(err) : err.message}.` };
  }
}
