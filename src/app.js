'use strict';
// The Express application. createApp() is used by server.js and by the tests.

const path = require('node:path');
const express = require('express');
const { validateBody, toApi, ID_RE } = require('./packets');
const { PacketService } = require('./packet-service');
const { SseHub } = require('./sse');
const auth = require('./auth');
const csv = require('./csv');
const { buildOpenApi } = require('./openapi');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

const ENDPOINTS = [
  'GET /health',
  'POST /api/packet',
  'GET /api/packet',
  'GET /api/packet/:id',
  'GET /api/packet-stream',
  'GET /api/export.csv?id=<id>  (login required)',
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/me',
  'GET /docs',
  'GET /openapi.json',
];

class HttpError extends Error {
  constructor(status, message, errors) { super(message); this.status = status; this.errors = errors || [message]; }
}

const sendError = (res, status, message, errors, extra = {}) =>
  res.status(status).json({ status: 'error', message, errors: errors || [message], ...extra });

function parseIntParam(value, name, { min, max, fallback }) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new HttpError(400, `${name} must be a whole number`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new HttpError(400, `${name} must be at least ${min}`);
  return Math.min(n, max);
}

function trackerParam(value, name = 'id') {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new HttpError(400, `${name} must be 1-64 characters: letters, digits, ".", "_" or "-"`);
  return value;
}

/**
 * @param {object} opts
 * @param {object} opts.store       MongoStore (or MemoryStore in tests)
 * @param {object} opts.config      from loadConfig()
 * @param {object} [opts.log]
 */
async function createApp({ store, config, log = console }) {
  const hub = new SseHub();
  const service = new PacketService(store, hub, config.maxPackets);
  await service.init();
  const limiter = new auth.LoginLimiter();
  const startedAt = new Date().toISOString();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('etag', false);

  // ---------- security headers ----------
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "img-src 'self' data: https://cdnjs.cloudflare.com https://tile.openstreetmap.org https://server.arcgisonline.com",
        "connect-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // ---------- static (before the session lookup, so files cost no database call) ----------
  // CSS and JS are re-checked on every load (a cheap 304 when unchanged), so a new deploy shows at once.
  // Images may be cached for an hour.
  app.use(express.static(path.join(ROOT, 'public'), {
    index: false,
    maxAge: '1h',
    setHeaders: (res, file) => { if (/\.(css|js)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
  }));

  // ---------- session ----------
  app.use(async (req, res, next) => {
    req.user = null;
    const value = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    if (!value) return next();
    const data = auth.readSessionValue(config.sessionSecret, value);
    if (!data) return next();
    try {
      const user = await store.findUserByPhone(data.p);
      if (user) req.user = { name: user.name, phone: user.phone, email: user.email };
    } catch { /* database down: treat as logged out */ }
    next();
  });

  const requirePage = (req, res, next) => {
    if (req.user) return next();
    res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  };
  const requireApi = (req, res, next) => {
    if (req.user) return next();
    sendError(res, 401, 'log in to use this endpoint');
  };
  const page = name => (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(VIEWS, `${name}.html`));
  };

  // ---------- health ----------
  app.get('/health', async (req, res) => {
    const ok = await store.ping();
    res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({
      status: ok ? 'ok' : 'error',
      success: ok,
      message: ok ? 'Drone Packets API is running' : 'Drone Packets API is running but the database is unreachable',
      database: ok ? 'connected' : 'down',
      startedAt,
      serverTime: new Date().toISOString(),
    });
  });

  // ---------- packets: write ----------
  const rawBody = express.text({ type: () => true, limit: '1mb' });
  app.post('/api/packet', rawBody, async (req, res, next) => {
    try {
      const text = typeof req.body === 'string' ? req.body.replace(/^﻿/, '').trim() : '';
      if (!text) throw new HttpError(400, 'the body is empty: send a JSON packet');
      let body;
      try { body = JSON.parse(text); } catch { throw new HttpError(400, 'the body is not valid JSON'); }
      const v = validateBody(body);
      if (!v.ok) {
        return sendError(res, 400, v.errors.length === 1 ? v.errors[0] : `${v.errors.length} problems found; nothing was stored`, v.errors);
      }
      const docs = await service.insert(v.packets);
      const extra = v.ignoredFields.length ? { ignoredFields: v.ignoredFields } : {};
      if (v.isBatch) {
        res.status(201).json({ status: 'ok', count: docs.length, packetIds: docs.map(d => d._id), seq: docs[docs.length - 1].seq, ...extra });
      } else {
        res.status(201).json({ status: 'ok', packetId: docs[0]._id, seq: docs[0].seq, ...extra });
      }
    } catch (err) { next(err); }
  });

  // ---------- packets: read ----------
  async function listReply(req, res, trackerId) {
    const since = parseIntParam(req.query.since, 'since', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
    const limit = parseIntParam(req.query.limit, 'limit', { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
    const trackerLower = trackerId ? trackerId.toLowerCase() : null;
    const total = await service.count(trackerLower);
    if (trackerId && total === 0) {
      const trackers = service.trackerList();
      return sendError(res, 404, `no packets for drone "${trackerId}"`,
        [`no packets for drone "${trackerId}"`, `known drone IDs: ${trackers.join(', ') || '(none yet)'}`], { trackers });
    }
    const { head, docs } = await service.list({ trackerLower, since, limit });
    res.set('Cache-Control', 'no-store').json({
      status: 'ok',
      serverTime: new Date().toISOString(),
      seq: head,
      count: docs.length,
      total,
      trackers: service.trackerList(),
      packets: docs.map(toApi),
    });
  }
  app.get('/api/packet', (req, res, next) => listReply(req, res, null).catch(next));
  app.get('/api/packet/:id', (req, res, next) => {
    try { listReply(req, res, trackerParam(req.params.id)).catch(next); } catch (err) { next(err); }
  });

  // ---------- live stream ----------
  app.get('/api/packet-stream', (req, res, next) => {
    try {
      const trackerId = trackerParam(req.query.trackerId, 'trackerId');
      const lastEventId = req.get('Last-Event-ID');
      let since = null;
      if (lastEventId !== undefined && /^\d+$/.test(lastEventId.trim())) since = Number(lastEventId.trim());
      else if (req.query.since !== undefined && req.query.since !== '') {
        since = parseIntParam(req.query.since, 'since', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
      }
      hub.open(req, res, { service, trackerLower: trackerId ? trackerId.toLowerCase() : null, since }).catch(() => res.end());
    } catch (err) { next(err); }
  });

  // ---------- CSV export ----------
  app.get('/api/export.csv', requireApi, async (req, res, next) => {
    try {
      const trackerId = trackerParam(req.query.id);
      const trackerLower = trackerId ? trackerId.toLowerCase() : null;
      const stamp = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const name = `packets-${trackerId || 'all'}-${stamp}.csv`;
      res.status(200).set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      res.write('﻿' + csv.HEADER.join(',') + '\r\n');
      const head = service.head;
      let after = 0;
      for (;;) {
        const docs = await store.findPackets({ trackerLower, gt: after, lte: head, limit: 2000, order: 'asc' });
        if (!docs.length) break;
        res.write(docs.map(csv.row).join('\r\n') + '\r\n');
        after = docs[docs.length - 1].seq;
        if (docs.length < 2000) break;
      }
      res.end();
    } catch (err) {
      if (res.headersSent) { log.error('CSV export failed:', err.message); return res.end(); }
      next(err);
    }
  });

  // ---------- accounts ----------
  const jsonBody = express.json({ limit: '10kb', type: () => true });
  const setSession = (req, res, user) =>
    res.cookie(auth.COOKIE, auth.makeSessionValue(config.sessionSecret, user), auth.cookieOptions(req));

  app.post('/api/auth/register', jsonBody, async (req, res, next) => {
    try {
      const { errors, user } = auth.validateRegistration(req.body);
      if (errors.length) return sendError(res, 400, errors[0].replace(/^\w+: /, ''), errors);
      const doc = {
        name: user.name, phone: user.phone, email: user.email,
        passwordHash: await auth.hashPassword(user.password),
        createdAt: new Date(),
      };
      try { await store.createUser(doc); } catch (err) {
        if (err.code === 'DUPLICATE') return sendError(res, 409, 'this mobile number is already registered: log in instead');
        throw err;
      }
      setSession(req, res, doc);
      res.status(201).json({ status: 'ok', user: { name: doc.name, phone: doc.phone, email: doc.email } });
    } catch (err) { next(err); }
  });

  app.post('/api/auth/login', jsonBody, async (req, res, next) => {
    try {
      const ip = req.ip || 'unknown';
      const wait = limiter.blockedFor(ip);
      if (wait > 0) {
        res.set('Retry-After', String(Math.ceil(wait / 1000)));
        return sendError(res, 429, `too many failed attempts: try again in ${Math.ceil(wait / 60000)} minutes`);
      }
      const phone = auth.normalisePhone(req.body?.phone);
      const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
      const user = /^[6-9]\d{9}$/.test(phone) ? await store.findUserByPhone(phone) : null;
      const ok = user ? await auth.verifyPassword(password, user.passwordHash) : await auth.dummyVerify(password);
      if (!ok) {
        limiter.fail(ip);
        return sendError(res, 401, 'wrong mobile number or password');
      }
      limiter.success(ip);
      setSession(req, res, user);
      res.json({ status: 'ok', user: { name: user.name, phone: user.phone, email: user.email }, next: auth.safeNext(req.body?.next) });
    } catch (err) { next(err); }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(auth.COOKIE, { ...auth.cookieOptions(req), maxAge: undefined });
    res.json({ status: 'ok' });
  });

  app.get('/api/auth/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return sendError(res, 401, 'not logged in');
    res.json({ status: 'ok', user: req.user });
  });

  // ---------- API docs ----------
  app.get('/openapi.json', (req, res) => res.json(buildOpenApi(`${req.protocol}://${req.get('host')}`)));
  app.get('/docs', page('docs'));

  // ---------- unknown /api ----------
  app.use('/api', (req, res) => sendError(res, 404, `no such endpoint: ${req.method} ${req.originalUrl.split('?')[0]}`,
    undefined, { endpoints: ENDPOINTS }));

  // ---------- pages ----------
  app.get('/login', (req, res) => (req.user ? res.redirect(302, auth.safeNext(req.query.next)) : page('login')(req, res)));
  app.get('/register', (req, res) => (req.user ? res.redirect(302, '/') : page('register')(req, res)));
  app.get('/logout', (req, res) => {
    res.clearCookie(auth.COOKIE, { ...auth.cookieOptions(req), maxAge: undefined });
    res.redirect(302, '/login');
  });
  app.get('/', requirePage, page('packets'));
  app.get('/map', requirePage, page('map'));
  app.get('/help', requirePage, page('help'));

  app.use((req, res) => {
    if (req.accepts(['html', 'json']) === 'html') {
      res.status(404).set('Cache-Control', 'no-store').sendFile(path.join(VIEWS, '404.html'));
    } else sendError(res, 404, 'not found');
  });

  // ---------- errors: always JSON, never a stack trace ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) { res.end(); return; }
    if (err instanceof HttpError) return sendError(res, err.status, err.message, err.errors);
    if (err.type === 'entity.too.large') return sendError(res, 413, 'the body is too large (limit 1 MB)');
    if (err.type === 'entity.parse.failed') return sendError(res, 400, 'the body is not valid JSON');
    if (err.status >= 400 && err.status < 500) return sendError(res, err.status, 'the request could not be read');
    log.error('Request failed:', req.method, req.originalUrl, '-', err.message);
    sendError(res, 503, 'the server could not complete the request (database unavailable?); try again');
  });

  return { app, hub, service };
}

module.exports = { createApp, ENDPOINTS };
