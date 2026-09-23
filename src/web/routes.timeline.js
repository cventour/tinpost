import { ADDR_COOKIE, setMailboxCookie } from './routes.mail.js';
import { EVENT_CATEGORIES } from '../db.js';

/**
 * The Timeline page: every message and every refused or empty connection the
 * instance has seen, across all mailboxes, newest first, with a small activity
 * chart above it.
 *
 * Like the admin area it has no gate: every mailbox it points into is already
 * readable by anyone who can reach this port.
 */

/** The fixed windows, in milliseconds. */
export const RANGES = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/**
 * The switchable categories, in the chart's order. They do not overlap, so switching
 * one off removes exactly its rows and its colour from the chart.
 */
export const CATEGORIES = [
  ['delivered', 'Delivered locally'],
  ['relayed', 'Relayed to gateway'],
  ['returned', 'Returned by gateway'],
  ['failed', 'Relay failed'],
  ['refused', 'Refused'],
  ['connection', 'Connections'],
];
const ALL = CATEGORIES.map(([id]) => id);

const BUCKETS = 30;
const PAGE = 200;

const KIND_LABEL = {
  delivered: 'Delivered',
  relayed: 'Relayed',
  returned: 'Returned',
  failed: 'Relay failed',
  refused: 'Refused',
  connection: 'Connection',
};

const RELAY_LABEL = {
  outbound: 'Outbound → gateway',
  inbound: 'Inbound → gateway',
  returned: 'Back from gateway',
  upstream: 'Via gateway',
};

const VIA_LABEL = { smtp: 'SMTP', webmail: 'Webmail', gateway: 'Gateway' };

/**
 * The chart's series: one per category. A relay failure (the gateway said no, or
 * could not be reached) and a refusal (Tinpost itself said no) are kept apart, so
 * "everything that touched the gateway" is a set of switches that means exactly that.
 */
const SERIES = [
  ['delivered', 'Delivered locally'],
  ['relayed', 'Relayed to gateway'],
  ['returned', 'Returned by gateway'],
  ['failed', 'Relay failed'],
  ['refused', 'Refused'],
  ['connection', 'Connections'],
];

export async function registerTimelineRoutes(app) {
  const { db, timeline } = app.mb;

  app.get('/timeline', async (req, reply) => {
    const query = req.query ?? {};
    const window = resolveRange(query);
    const shown = parseShow(query.show);
    const q = String(query.q ?? '').slice(0, 200);
    const before = Number.parseInt(query.before, 10) || null;

    const from = window.from.toISOString();
    const to = window.to.toISOString();
    const span = window.to - window.from;

    const show = shown.length === ALL.length ? null : shown;
    const rows = db.listEvents({ from, to, show, q, before, limit: PAGE }).map((e) => eventRow(e, span));
    const total = db.countEvents({ from, to, show, q });
    // Each switch links to the set with it flipped, so the page works as plain links.
    const toggles = CATEGORIES.map(([id, label]) => {
      const on = shown.includes(id);
      const next = on ? shown.filter((c) => c !== id) : ALL.filter((c) => c === id || shown.includes(c));
      return { id, label, on, count: db.countEvents({ from, to, show: [id], q }), href: hrefFor(query, { show: showParam(next), before: null }) };
    });

    return reply.view('timeline', {
      title: 'Timeline — Tinpost',
      addr: req.cookies?.[ADDR_COOKIE] || null,
      full: true,
      navTimeline: true,
      window,
      windowLabel: `${fmtAxis(window.from, span, true)} – ${fmtAxis(window.to, span, true)} UTC`,
      ranges: [
        ['15m', '15 min'],
        ['1h', '1 hour'],
        ['24h', '24 hours'],
        ['7d', '7 days'],
        ['custom', 'Custom'],
      ],
      chart: chartModel(db.eventMarks({ from, to, show, q }), window.from, window.to),
      toggles,
      allOn: shown.length === ALL.length,
      allHref: hrefFor(query, { show: null, before: null }),
      allCount: db.countEvents({ from, to, q }),
      noneOn: shown.length === 0,
      showValue: showParam(shown),
      // What the live counter should count: only what this view would show.
      liveShow: shown.join(','),
      q,
      rows,
      total,
      shownCount: rows.length,
      olderHref: rows.length === PAGE ? hrefFor(query, { before: rows[rows.length - 1].id }) : null,
      newestHref: before ? hrefFor(query, { before: null }) : null,
      hrefFor: (changes) => hrefFor(query, changes),
    });
  });

  /**
   * Open a message from the timeline: switch to a mailbox that can see it, then show
   * it in the ordinary message view, where it can be replied to and its attachments
   * downloaded. The mailbox recorded with the event comes first; if that one has lost
   * it (deleted since), any other mailbox that still holds it will do.
   */
  app.get('/timeline/open/:id', (req, reply) => {
    const event = db.getEvent(Number.parseInt(req.params.id, 10));
    const messageId = event?.message_id;
    const message = messageId ? db.getMessage(messageId) : null;
    if (!message) {
      return reply.code(404).view('error', {
        title: 'Message not stored',
        message: messageId
          ? 'That message is no longer stored. Its mailbox was deleted, or the lab was purged, after it arrived.'
          : 'That event is a connection, not a message, so there is nothing to open.',
        addr: req.cookies?.[ADDR_COOKIE] || null,
      });
    }

    const candidates = [
      event.open_as,
      ...db.getRecipients(messageId).filter((r) => r.delivered).map((r) => r.address),
      message.from_addr,
    ].filter(Boolean);
    const mailbox = candidates.find((a) => db.canAccess(a, messageId));
    if (!mailbox) {
      return reply.code(404).view('error', {
        title: 'Message not in any mailbox',
        message: 'That message is stored, but no mailbox can open it yet. It is probably still with the upstream gateway.',
        addr: req.cookies?.[ADDR_COOKIE] || null,
      });
    }

    setMailboxCookie(reply, mailbox);
    return reply.redirect(`/mail/${messageId}?from=timeline`);
  });

  /** Tells an open Timeline page that something new has happened. */
  app.get('/timeline/stream', (req, reply) => {
    if (!timeline) return reply.code(404).send();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');

    // The fields the page's search reads, so an open page can count only the events
    // it would actually show.
    const onEvent = (e) => {
      const text = [e.fromAddr, e.toAddrs, e.sourceIp, e.subject, e.response].filter(Boolean).join(' ');
      reply.raw.write(`event: timeline\ndata: ${JSON.stringify({ id: e.id, kind: e.kind, text })}\n\n`);
    };
    timeline.on('event', onEvent);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    const cleanup = () => {
      clearInterval(ping);
      timeline.off('event', onEvent);
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    return reply;
  });
}

/**
 * The window being shown. A fixed range ends now; a custom one is read as UTC, the
 * way every time on the page is shown. A custom range that makes no sense falls back
 * to the last hour and says why, rather than showing an empty page.
 */
export function resolveRange(query, now = new Date()) {
  const range = query.range === 'custom' || query.range in RANGES ? query.range : '1h';
  const fixed = (r) => ({ range: r, from: new Date(now - RANGES[r]), to: now, live: true, fromInput: '', toInput: '', error: null });
  if (range !== 'custom') return fixed(range);

  const fromInput = String(query.from ?? '');
  const toInput = String(query.to ?? '');
  const from = parseUtc(fromInput);
  const to = parseUtc(toInput);
  if (!fromInput && !toInput) {
    // Custom chosen, nothing entered yet: show the last hour with the fields filled
    // in from it, ready to be adjusted.
    const base = fixed('1h');
    return { ...base, range: 'custom', fromInput: toInputValue(base.from), toInput: toInputValue(base.to) };
  }
  if (!from || !to) {
    return { ...fixed('1h'), range: 'custom', fromInput, toInput, error: 'Choose both a start and an end for the custom range.' };
  }
  if (from >= to) {
    return { ...fixed('1h'), range: 'custom', fromInput, toInput, error: 'The start of the custom range must be before its end.' };
  }
  return { range: 'custom', from, to, live: to > now, fromInput, toInput, error: null };
}

/** A date as a datetime-local field holds it, in UTC. */
function toInputValue(d) {
  return d.toISOString().slice(0, 16);
}

/** `2026-09-23T11:00` (what a datetime-local field sends), read as UTC. */
function parseUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const d = new Date(`${value}${value.length === 16 ? ':00' : ''}Z`);
  return Number.isNaN(d.valueOf()) ? null : d;
}

/**
 * The activity chart: the window cut into equal buckets, each a stack of counts by
 * series. Heights are relative to the busiest bucket, so a quiet window still shows
 * its shape.
 */
export function chartModel(marks, from, to) {
  const size = (to - from) / BUCKETS;
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
    start: new Date(from.getTime() + i * size),
    counts: { delivered: 0, relayed: 0, returned: 0, failed: 0, refused: 0, connection: 0 },
  }));
  const totals = { delivered: 0, relayed: 0, returned: 0, failed: 0, refused: 0, connection: 0 };

  for (const mark of marks) {
    const series = mark.kind;
    if (!(series in totals)) continue;
    const index = Math.min(BUCKETS - 1, Math.max(0, Math.floor((new Date(mark.at) - from) / size)));
    buckets[index].counts[series] += 1;
    totals[series] += 1;
  }

  const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  const peak = Math.max(1, ...buckets.map((b) => sum(b.counts)));
  const span = to - from;

  return {
    bars: buckets.map((b) => {
      const all = sum(b.counts);
      const messages = all - b.counts.connection;
      return {
        tip: `${fmtAxis(b.start, span, true)} · ${messages} message${messages === 1 ? '' : 's'}, ${b.counts.connection} connection${b.counts.connection === 1 ? '' : 's'}`,
        segs: SERIES.filter(([k]) => b.counts[k]).map(([k]) => ({ kind: k, pct: (b.counts[k] / peak) * 100 })),
        spark: Math.max(2, Math.round((all / peak) * 18)),
        hasMail: messages > 0,
      };
    }),
    ticks: Array.from({ length: 7 }, (_, i) => fmtAxis(new Date(from.getTime() + (span * i) / 6), span)),
    legend: SERIES.map(([k, label]) => ({ kind: k, label, count: totals[k] })),
    messages: totals.delivered + totals.relayed + totals.returned + totals.failed + totals.refused,
    connections: totals.connection,
  };
}

/** One table row, ready to print. */
export function eventRow(e, span) {
  return {
    id: e.id,
    kind: e.kind,
    time: fmtRowTime(e.at, span),
    iso: e.at,
    source: e.source_ip || '—',
    via: VIA_LABEL[e.via] ?? '',
    from: e.from_addr || '',
    to: e.to_addrs || '',
    subject: e.subject || '',
    result: KIND_LABEL[e.kind] ?? e.kind,
    relay: RELAY_LABEL[e.relay] ?? (e.kind === 'connection' || e.kind === 'refused' ? '—' : 'None · local'),
    relayed: !!e.relay,
    response: e.response || '—',
    // Only a stored message can be opened; a connection or a refusal left nothing behind.
    href: e.message_id ? `/timeline/open/${e.id}` : null,
    msg: e.message_id ? `#${e.message_id}` : '',
    openAs: e.open_as || '',
  };
}

/** Time of day to the millisecond; a date in front once the window spans days. */
function fmtRowTime(iso, span) {
  const d = new Date(iso);
  const time = d.toISOString().slice(11, 23);
  return span > RANGES['24h'] ? `${fmtDay(d)} ${time.slice(0, 8)}` : time;
}

function fmtAxis(d, span, precise = false) {
  const hm = d.toISOString().slice(11, 16);
  if (span > RANGES['24h']) return precise ? `${fmtDay(d)} ${hm}` : fmtDay(d);
  return hm;
}

function fmtDay(d) {
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

/**
 * The categories switched on, from `?show=`. Absent means all of them; `none` means
 * none, which is a real state — every switch turned off — not a mistake to correct.
 */
export function parseShow(value) {
  if (value === undefined || value === null || value === '') return [...ALL];
  if (value === 'none') return [];
  const asked = String(value).split(',');
  return ALL.filter((c) => asked.includes(c));
}

function showParam(list) {
  if (list.length === ALL.length) return null;
  return list.length ? list.join(',') : 'none';
}

/** This page's URL with some parameters changed, the rest kept. */
function hrefFor(query, changes) {
  const params = new URLSearchParams();
  const merged = { ...query, ...changes };
  for (const key of ['range', 'from', 'to', 'show', 'q', 'before']) {
    const value = merged[key];
    if (value === null || value === undefined || value === '') continue;
    if ((key === 'from' || key === 'to') && merged.range !== 'custom') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `/timeline?${s}` : '/timeline';
}
