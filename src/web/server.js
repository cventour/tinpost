import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import { registerMailRoutes } from './routes.mail.js';
import { registerAdminRoutes } from './routes.admin.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function createWebServer({ db, blobs, delivery, config, smtp = null, logger = console }) {
  const app = Fastify({ logger: false, bodyLimit: config.maxSize });

  await app.register(fastifyCookie, { secret: db.getSetting('session_secret') });
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxSize, files: 20 },
  });
  await app.register(fastifyView, {
    engine: { ejs },
    root: join(here, 'views'),
    viewExt: 'ejs',
    defaultContext: { fmtBytes, fmtDate, escapeHtml },
  });

  app.decorate('mb', { db, blobs, delivery, config, smtp, logger });

  // Two static assets only. Serving them as explicit routes rather than pulling in
  // a static-file plugin keeps the path-traversal surface at exactly zero.
  const assets = {
    '/static/app.css': ['text/css; charset=utf-8', readFileSync(join(here, 'public', 'app.css'))],
    '/static/app.js': ['text/javascript; charset=utf-8', readFileSync(join(here, 'public', 'app.js'))],
  };
  for (const [url, [type, body]] of Object.entries(assets)) {
    app.get(url, (req, reply) => reply.type(type).header('cache-control', 'no-cache').send(body));
  }

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).view('error', { title: 'Not found', message: `No route for ${req.url}`, addr: currentAddr(req) });
  });

  app.setErrorHandler((err, req, reply) => {
    logger.error?.(`web: ${err.stack || err.message}`);
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(code).view('error', {
      title: code === 413 ? 'Too large' : 'Something went wrong',
      message: code < 500 ? err.message : 'Internal error — see the server log.',
      addr: currentAddr(req),
    });
  });

  await registerMailRoutes(app);
  await registerAdminRoutes(app);

  return {
    app,
    async listen() {
      await app.listen({ port: config.httpPort, host: config.host });
      return app.server.address();
    },
    close() {
      return app.close();
    },
  };
}

function currentAddr(req) {
  // Already decoded by @fastify/cookie; only used for the nav bar on error pages.
  return req.cookies?.mb_addr || null;
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  // 24-hour, fixed format: the server and the browser both render times into the
  // same list, so they must agree regardless of each one's locale.
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return time;
  const month = d.toLocaleDateString('en', { month: 'short' });
  return `${month} ${d.getDate()} ${time}`;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
