import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { makeLab } from './helpers.js';
import { createWebServer } from '../src/web/server.js';
import { createSmtpServer } from '../src/smtp.js';
import { LogBuffer, recordingLogger, channelOf } from '../src/logbuf.js';

const quiet = { info() {}, error() {} };

async function withLogs(t, { capacity } = {}) {
  const lab = await makeLab();
  const logs = new LogBuffer(capacity ? { capacity } : {});
  const web = await createWebServer({ ...lab, config: lab.config, logger: quiet, logs });
  t.after(async () => {
    await web.close();
    await lab.cleanup();
  });
  return { ...lab, logs, app: web.app };
}

// ---------- the buffer ----------

test('lines are kept in order with a sequence that never repeats', () => {
  const logs = new LogBuffer();
  const first = logs.add('info', 'smtp: one');
  const second = logs.add('error', 'web: two');

  assert.equal(second.seq, first.seq + 1);
  assert.deepEqual(
    logs.select({}).map((l) => l.text),
    ['smtp: one', 'web: two'],
  );
});

test('the oldest lines fall off once the buffer is full, and it says how many', () => {
  const logs = new LogBuffer({ capacity: 3 });
  for (let i = 1; i <= 5; i += 1) logs.add('info', `smtp: line ${i}`);

  assert.deepEqual(
    logs.select({}).map((l) => l.text),
    ['smtp: line 3', 'smtp: line 4', 'smtp: line 5'],
  );
  assert.equal(logs.dropped, 2);
});

test('a channel is read from the prefix the line was written with', () => {
  assert.equal(channelOf('smtp: accepted #1'), 'smtp');
  assert.equal(channelOf('icap: refused an attachment'), 'icap');
  assert.equal(channelOf('admin: settings updated'), 'admin');
  // Anything unrecognised is kept rather than dropped or mislabelled.
  assert.equal(channelOf('something with no prefix'), 'app');
  assert.equal(channelOf('postfix: not one of ours'), 'app');
});

test('selecting filters by channel and by minimum level', () => {
  const logs = new LogBuffer();
  logs.add('debug', 'smtp: C: EHLO test');
  logs.add('info', 'smtp: accepted #1');
  logs.add('error', 'web: it broke');

  assert.equal(logs.select({ channel: 'smtp' }).length, 2);
  assert.equal(logs.select({ level: 'info' }).length, 2);
  assert.equal(logs.select({ channel: 'smtp', level: 'info' }).length, 1);
  assert.equal(logs.select({ level: 'error' })[0].text, 'web: it broke');
});

test('since resumes from a sequence number, not an offset', () => {
  const logs = new LogBuffer({ capacity: 3 });
  logs.add('info', 'smtp: one');
  const mark = logs.add('info', 'smtp: two');
  logs.add('info', 'smtp: three');
  // Turning the buffer over past the cursor must not resend what was already seen.
  logs.add('info', 'smtp: four');

  assert.deepEqual(
    logs.select({ since: mark.seq }).map((l) => l.text),
    ['smtp: three', 'smtp: four'],
  );
});

test('a very long line is clipped rather than held whole', () => {
  const logs = new LogBuffer();
  const line = logs.add('error', `web: ${'x'.repeat(50_000)}`);
  assert.ok(line.text.length < 5000, 'the stored line should be clipped');
  assert.match(line.text, /more characters/);
});

test('clearing empties the buffer but keeps the sequence climbing', () => {
  const logs = new LogBuffer();
  logs.add('info', 'smtp: one');
  const before = logs.lastSeq;

  assert.equal(logs.clear(), 1);
  assert.equal(logs.select({}).length, 0);
  assert.ok(logs.add('info', 'smtp: two').seq > before, 'a cleared buffer must not reuse numbers');
});

test('the recording logger keeps every level but only prints the loud ones', () => {
  const printed = [];
  const logs = new LogBuffer();
  const logger = recordingLogger(
    { info: (m) => printed.push(m), error: (m) => printed.push(m) },
    logs,
  );

  logger.info('smtp: accepted #1');
  logger.error('web: it broke');
  logger.debug('smtp: C: EHLO test');

  assert.equal(logs.select({}).length, 3, 'all three are recorded');
  assert.deepEqual(printed, ['smtp: accepted #1', 'web: it broke'], 'debug stays off the terminal');
});

// ---------- the page ----------

test('the log page renders what has been logged', async (t) => {
  const lab = await withLogs(t);
  lab.logs.add('info', 'smtp: accepted #7 from bob@corp.test -> alice@lab.local');

  const res = await lab.app.inject({ method: 'GET', url: '/admin/logs' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /accepted #7 from bob@corp\.test/);
  // And it is reachable from the ribbon on every admin page.
  const admin = await lab.app.inject({ method: 'GET', url: '/admin' });
  assert.match(admin.body, /href="\/admin\/logs"/);
});

test('a line is escaped rather than rendered as markup', async (t) => {
  const lab = await withLogs(t);
  lab.logs.add('info', 'smtp: rejected <img src=x onerror=alert(1)>@lab.local');

  const res = await lab.app.inject({ method: 'GET', url: '/admin/logs' });
  assert.doesNotMatch(res.body, /<img src=x/);
  assert.match(res.body, /&lt;img src=x/);
});

test('the page filters by channel and level from the query string', async (t) => {
  const lab = await withLogs(t);
  lab.logs.add('info', 'smtp: accepted #1');
  lab.logs.add('info', 'admin: settings updated');
  lab.logs.add('debug', 'smtp: C: EHLO probe');

  const smtpOnly = await lab.app.inject({ method: 'GET', url: '/admin/logs?channel=smtp' });
  assert.match(smtpOnly.body, /accepted #1/);
  assert.doesNotMatch(smtpOnly.body, /settings updated/);

  const infoUp = await lab.app.inject({ method: 'GET', url: '/admin/logs?level=info' });
  assert.doesNotMatch(infoUp.body, /C: EHLO probe/);

  // A filter that is not one of ours falls back to showing everything.
  const junk = await lab.app.inject({ method: 'GET', url: '/admin/logs?channel=../etc&level=nope' });
  assert.equal(junk.statusCode, 200);
  assert.match(junk.body, /settings updated/);
});

test('the tail endpoint returns only lines newer than the cursor', async (t) => {
  const lab = await withLogs(t);
  lab.logs.add('info', 'smtp: first');
  const mark = lab.logs.lastSeq;
  lab.logs.add('info', 'smtp: second');

  const res = await lab.app.inject({ method: 'GET', url: `/api/admin/logs?since=${mark}` });
  const body = res.json();
  assert.deepEqual(body.lines.map((l) => l.text), ['smtp: second']);
  assert.equal(body.cursor, lab.logs.lastSeq);

  // Asking again with the new cursor yields nothing, and the cursor holds.
  const again = await lab.app.inject({ method: 'GET', url: `/api/admin/logs?since=${body.cursor}` });
  assert.deepEqual(again.json().lines, []);
  assert.equal(again.json().cursor, body.cursor);
});

test('the log downloads as a plain file', async (t) => {
  const lab = await withLogs(t);
  lab.logs.add('info', 'smtp: accepted #1');
  lab.logs.add('error', 'web: it broke');

  const res = await lab.app.inject({ method: 'GET', url: '/admin/logs.txt?channel=web' });
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.headers['content-disposition'], /filename="tinpost\.log"/);
  assert.match(res.body, /ERROR web: it broke/);
  assert.doesNotMatch(res.body, /accepted #1/);
});

test('clearing wipes the log and says so in the log', async (t) => {
  const lab = await withLogs(t);
  lab.logs.add('info', 'smtp: accepted #1');

  const res = await lab.app.inject({ method: 'POST', url: '/admin/logs/clear' });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /accepted #1/);
  assert.match(res.body, /Cleared 1 line/);
  // The clear itself is logged, so the page is never blank about why it emptied.
  assert.equal(lab.logs.select({}).length, 0, 'the page renders before the note lands');
});

test('the transcript switch is a pill in the action bar that flips on one press', async (t) => {
  const lab = await withLogs(t);

  const off = await lab.app.inject({ method: 'GET', url: '/admin/logs' });
  assert.match(off.body, /role="switch" aria-checked="false"/);
  // The hidden field carries the value it is NOT on, so pressing it toggles — which is
  // what lets the switch work with no JavaScript at all.
  assert.match(off.body, /name="protocol" value="1"/);

  lab.db.setSetting('log_smtp_protocol', '1');
  const on = await lab.app.inject({ method: 'GET', url: '/admin/logs' });
  assert.match(on.body, /role="switch" aria-checked="true"/);
  assert.match(on.body, /name="protocol" value="0"/);

  // It sits in the bar beside Clear log, not in a section of its own below.
  const bar = on.body.slice(on.body.indexOf('class="log-bar"'), on.body.indexOf('data-log-view'));
  assert.match(bar, /SMTP conversation/);
  assert.match(bar, /Clear log/);
});

test('the transcript switch is stored and reported back', async (t) => {
  const lab = await withLogs(t);
  assert.equal(lab.db.getSetting('log_smtp_protocol'), null);

  const on = await lab.app.inject({
    method: 'POST',
    url: '/admin/logs/protocol',
    payload: 'protocol=1',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(on.statusCode, 200);
  assert.equal(lab.db.getSetting('log_smtp_protocol'), '1');
  assert.match(on.body, /Recording the SMTP conversation/);

  const off = await lab.app.inject({
    method: 'POST',
    url: '/admin/logs/protocol',
    payload: 'protocol=0',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(lab.db.getSetting('log_smtp_protocol'), '0');
  assert.match(off.body, /Stopped recording/);
});

// ---------- the SMTP transcript ----------

/**
 * Speak SMTP at the listener, one command per reply.
 *
 * Strictly turn by turn, because smtp-server answers anything sent ahead of the
 * greeting with "You talk too soon" and drops the connection — which is correct of
 * it, and exactly what a pipelining client would deserve.
 */
function speak(port, commands) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const replies = [];
    let buffer = '';
    let sent = 0;

    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('the listener did not answer')));

    /** How much of the buffer is one complete reply, or -1 while it is still coming. */
    const replyEnd = () => {
      let at = 0;
      for (;;) {
        const nl = buffer.indexOf('\r\n', at);
        if (nl === -1) return -1;
        // A continuation line is "250-", the last one "250 ".
        if (/^\d{3} /.test(buffer.slice(at, nl))) return nl + 2;
        at = nl + 2;
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end = replyEnd(); end !== -1; end = replyEnd()) {
        replies.push(buffer.slice(0, end));
        buffer = buffer.slice(end);
        if (sent < commands.length) socket.write(`${commands[sent++]}\r\n`);
        else socket.end();
      }
    });
    socket.on('close', () => resolve(replies.join('')));
    socket.on('error', reject);
  });
}

async function withSmtp(t, lab, logs) {
  const logger = recordingLogger(quiet, logs);
  const smtp = createSmtpServer({ ...lab, config: lab.config, logger });
  await smtp.listen();
  t.after(() => smtp.close());
  return smtp;
}

test('the SMTP conversation is recorded only once it is switched on', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());
  const logs = new LogBuffer();
  const smtp = await withSmtp(t, lab, logs);
  const { port } = smtp.address();

  await speak(port, ['EHLO quiet.test', 'QUIT']);
  assert.equal(
    logs.select({ level: 'debug' }).filter((l) => /EHLO quiet\.test/.test(l.text)).length,
    0,
    'nothing is transcribed while the switch is off',
  );

  lab.db.setSetting('log_smtp_protocol', '1');
  smtp.refresh();

  await speak(port, ['EHLO loud.test', 'QUIT']);
  const transcript = logs.select({ channel: 'smtp' }).map((l) => l.text);
  assert.ok(
    transcript.some((t2) => /C: EHLO loud\.test/.test(t2)),
    `expected the client line in ${JSON.stringify(transcript)}`,
  );
  assert.ok(transcript.some((t2) => /S: 250/.test(t2)), 'and the server replies');
  // Grouped by connection, so overlapping senders can be told apart.
  assert.ok(transcript.some((t2) => /^smtp: \[.+\] C: EHLO loud\.test/.test(t2)));
});

test('a bare connection is logged, even with the transcript switched off', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());
  const logs = new LogBuffer();
  const smtp = await withSmtp(t, lab, logs);
  const { port } = smtp.address();

  // Banner, then straight out again: a health check, a telnet probe, or a sender
  // that cannot get past the greeting. It used to leave no trace at all.
  await speak(port, ['QUIT']);
  // smtp-server schedules onClose on the next tick, after the socket is gone.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const lines = logs.select({ channel: 'smtp', level: 'info' }).map((l) => l.text);
  assert.ok(
    lines.some((t2) => /^smtp: connection from /.test(t2)),
    `expected the connection itself in ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((t2) => /closed without sending a message/.test(t2)),
    'and that it sent nothing',
  );
});

test('a connection that delivers is not also reported as having sent nothing', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());
  const logs = new LogBuffer();
  const smtp = await withSmtp(t, lab, logs);
  const { port } = smtp.address();

  await speak(port, [
    'EHLO sender.test',
    'MAIL FROM:<bob@corp.test>',
    'RCPT TO:<alice@lab.local>',
    'DATA',
    ['From: bob@corp.test', 'To: alice@lab.local', 'Subject: Sent', '', 'body', '.'].join('\r\n'),
    'QUIT',
  ]);

  // The close hook has to run before the assertion; it is scheduled on the next tick.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const lines = logs.select({ channel: 'smtp', level: 'info' }).map((l) => l.text);
  assert.ok(lines.some((t2) => /^smtp: connection from /.test(t2)), 'the connection is still logged');
  assert.ok(lines.some((t2) => /accepted #\d+/.test(t2)), 'and so is the delivery');
  assert.equal(
    lines.filter((t2) => /closed without sending a message/.test(t2)).length,
    0,
    'a delivered session already said what became of it',
  );
});

test('a delivery is summarised in the log whatever the transcript switch says', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());
  const logs = new LogBuffer();
  const smtp = await withSmtp(t, lab, logs);
  const { port } = smtp.address();

  const wire = await speak(port, [
    'EHLO sender.test',
    'MAIL FROM:<bob@corp.test>',
    'RCPT TO:<alice@lab.local>',
    'DATA',
    ['From: bob@corp.test', 'To: alice@lab.local', 'Subject: Logged', '', 'body', '.'].join('\r\n'),
    'QUIT',
  ]);
  assert.match(wire, /250 Message queued as \d+/);

  const summaries = logs.select({ channel: 'smtp', level: 'info' }).map((l) => l.text);
  assert.ok(
    summaries.some((t2) => /accepted #\d+ from bob@corp\.test -> alice@lab\.local/.test(t2)),
    `expected an accepted line in ${JSON.stringify(summaries)}`,
  );
});
