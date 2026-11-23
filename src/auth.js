'use strict';
// Dashboard accounts: scrypt password hashes, signed session cookies, login lockout.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'dtp_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// ---------- passwords ----------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(key, expected);
}

// A fixed hash so an unknown number costs the same time as a wrong password.
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-Password-1');
  await verifyPassword(password, dummyHash);
  return false;
}

// ---------- input rules ----------
function normalisePhone(raw) {
  let s = String(raw ?? '').replace(/[\s()-]/g, '');
  if (/^\+91\d{10}$/.test(s)) s = s.slice(3);
  else if (/^91\d{10}$/.test(s)) s = s.slice(2);
  else if (/^0\d{10}$/.test(s)) s = s.slice(1);
  return s;
}
const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

function validateRegistration(body) {
  const errors = [];
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const phone = normalisePhone(body?.phone);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (name.length < 2 || name.length > 80) errors.push('name: enter your name (2-80 characters)');
  else if (/[\u0000-\u001f<>]/.test(name)) errors.push('name: contains characters that are not allowed');
  if (!PHONE_RE.test(phone)) errors.push('phone: enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9');
  if (email.length > 254 || !EMAIL_RE.test(email)) errors.push('email: enter a valid email address');
  if (password.length < 8 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    errors.push('password: use at least 8 characters with an upper-case letter, a lower-case letter and a digit');
  }
  return { errors, user: { name, phone, email, password } };
}

// ---------- sessions ----------
function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function makeSessionValue(secret, user, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ p: user.phone, exp: now + SESSION_MS })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

function readSessionValue(secret, value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const good = Buffer.from(sign(secret, payload));
  if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.p !== 'string' || typeof data.exp !== 'number' || data.exp < now) return null;
    return data;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  return out;
}

function cookieOptions(req) {
  return { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: SESSION_MS };
}

// ---------- lockout (per IP, in memory) ----------
class LoginLimiter {
  constructor({ max = LOCK_AFTER, windowMs = LOCK_MS } = {}) {
    this.max = max; this.windowMs = windowMs; this.map = new Map();
  }
  blockedFor(ip, now = Date.now()) {
    const e = this.map.get(ip);
    if (!e) return 0;
    if (e.until && e.until > now) return e.until - now;
    if (e.until && e.until <= now) this.map.delete(ip);
    return 0;
  }
  fail(ip, now = Date.now()) {
    const e = this.map.get(ip) || { count: 0, until: 0 };
    e.count += 1;
    if (e.count >= this.max) e.until = now + this.windowMs;
    this.map.set(ip, e);
    if (this.map.size > 10000) this.map.delete(this.map.keys().next().value);
  }
  success(ip) { this.map.delete(ip); }
}

/** Safe redirect target after login: a local path only. */
function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f]/.test(next) || next.length > 500) return '/';
  return next;
}

module.exports = {
  COOKIE, SESSION_MS, hashPassword, verifyPassword, dummyVerify, validateRegistration, normalisePhone,
  makeSessionValue, readSessionValue, parseCookies, cookieOptions, LoginLimiter, safeNext,
};
