'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PACKET, post } = require('./helpers');
const { hashPassword, verifyPassword } = require('../src/auth');

const USER = { name: 'Asha Patel', phone: '9876543210', email: 'Asha@Example.com', password: 'Secret123' };

function cookieFrom(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const c = set.find(x => x && x.startsWith('dtp_session='));
  return c ? { header: c, value: c.split(';')[0] } : null;
}

async function send(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json(), res };
}

describe('passwords', () => {
  test('scrypt hash with random salt, never plain text', async () => {
    const a = await hashPassword('Secret123');
    const b = await hashPassword('Secret123');
    assert.match(a, /^scrypt\$16384\$8\$1\$/);
    assert.notEqual(a, b);
    assert.ok(!a.includes('Secret123'));
    assert.equal(await verifyPassword('Secret123', a), true);
    assert.equal(await verifyPassword('secret123', a), false);
  });
});

describe('accounts and sessions', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('pages redirect to /login when not logged in', async () => {
    for (const p of ['/', '/map', '/help', '/?id=1005', '/map?id=1005']) {
      const res = await fetch(`${srv.base}${p}`, { redirect: 'manual' });
      assert.equal(res.status, 302, p);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(p)}`);
    }
    const login = await fetch(`${srv.base}/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Log in to Drone Tag/);
    const reg = await fetch(`${srv.base}/register`);
    assert.equal(reg.status, 200);
  });

  test('register validates input', async () => {
    let r = await send(srv.base, '/api/auth/register', { ...USER, phone: '5876543210' });
    assert.equal(r.status, 400);
    r = await send(srv.base, '/api/auth/register', { ...USER, password: 'alllower1' });
    assert.equal(r.status, 400);
    r = await send(srv.base, '/api/auth/register', { ...USER, email: 'nope' });
    assert.equal(r.status, 400);
    r = await send(srv.base, '/api/auth/register', { ...USER, name: '' });
    assert.equal(r.status, 400);
    assert.equal(r.body.status, 'error');
  });

  test('register, session cookie, me, duplicate number', async () => {
    const r = await send(srv.base, '/api/auth/register', { ...USER, phone: '+91 98765 43210' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.phone, '9876543210');
    assert.equal(r.body.user.email, 'asha@example.com');
    const c = cookieFrom(r.res);
    assert.ok(c, 'cookie set');
    assert.match(c.header, /HttpOnly/i);
    assert.match(c.header, /SameSite=Lax/i);
    assert.match(c.header, /Max-Age=604800/);

    const me = await fetch(`${srv.base}/api/auth/me`, { headers: { Cookie: c.value } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.name, 'Asha Patel');

    const page = await fetch(`${srv.base}/`, { headers: { Cookie: c.value }, redirect: 'manual' });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Data packets/);

    const mapPage = await fetch(`${srv.base}/map?id=1005`, { headers: { Cookie: c.value }, redirect: 'manual' });
    assert.equal(mapPage.status, 200);
    assert.match(await mapPage.text(), /id="map"/);

    // CSS and JS are re-checked on every load, so a new deploy is never hidden by a cached old file
    for (const f of ['/css/app.css?v=3', '/js/map.js?v=3']) {
      const asset = await fetch(`${srv.base}${f}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('cache-control'), 'no-cache');
    }

    const dup = await send(srv.base, '/api/auth/register', USER);
    assert.equal(dup.status, 409);

    // the password is stored as a hash
    const stored = await srv.store.findUserByPhone('9876543210');
    assert.match(stored.passwordHash, /^scrypt\$/);
    assert.equal(stored.password, undefined);
  });

  test('login: same message for unknown number and wrong password', async () => {
    const h = { 'X-Forwarded-For': '10.0.0.1' };
    const a = await send(srv.base, '/api/auth/login', { phone: '9000000000', password: 'Secret123' }, h);
    const b = await send(srv.base, '/api/auth/login', { phone: USER.phone, password: 'Wrong1234' }, h);
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.body.message, 'wrong mobile number or password');
    assert.equal(b.body.message, a.body.message);

    const ok = await send(srv.base, '/api/auth/login', { phone: USER.phone, password: USER.password, next: '/?id=1005' }, h);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.next, '/?id=1005');
    assert.ok(cookieFrom(ok.res));

    const evil = await send(srv.base, '/api/auth/login', { phone: USER.phone, password: USER.password, next: '//evil.example' }, h);
    assert.equal(evil.body.next, '/');
  });

  test('tampered or missing cookie is not accepted', async () => {
    const ok = await send(srv.base, '/api/auth/login', { phone: USER.phone, password: USER.password }, { 'X-Forwarded-For': '10.0.0.2' });
    const c = cookieFrom(ok.res).value;
    const [name, val] = c.split('=');
    const [payload, sig] = val.split('.');
    const forged = Buffer.from(JSON.stringify({ p: USER.phone, exp: Date.now() + 1e12 })).toString('base64url');
    for (const bad of [`${name}=${forged}.${sig}`, `${name}=${payload}.AAAA`, `${name}=garbage`]) {
      const me = await fetch(`${srv.base}/api/auth/me`, { headers: { Cookie: bad } });
      assert.equal(me.status, 401);
    }
  });

  test('lockout after 10 failed attempts from one IP', async () => {
    const h = { 'X-Forwarded-For': '10.9.9.9' };
    for (let i = 0; i < 10; i++) {
      const r = await send(srv.base, '/api/auth/login', { phone: USER.phone, password: 'Wrong1234' }, h);
      assert.equal(r.status, 401);
    }
    const blocked = await send(srv.base, '/api/auth/login', { phone: USER.phone, password: USER.password }, h);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /15 minutes/);
    // another IP is not affected
    const other = await send(srv.base, '/api/auth/login', { phone: USER.phone, password: USER.password }, { 'X-Forwarded-For': '10.9.9.10' });
    assert.equal(other.status, 200);
  });

  test('logout clears the cookie', async () => {
    const res = await fetch(`${srv.base}/api/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.match(cookieFrom(res).header, /dtp_session=;/);
  });

  test('CSV export needs login; numbers unquoted; formula injection blocked; IST times', async () => {
    const anon = await fetch(`${srv.base}/api/export.csv`);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).status, 'error');

    await post(srv.base, { ...PACKET, id: 'csv-1', Alt_R: '=HYPERLINK("http://x")', Timestamp: '2020-01-01 10:00:00' });
    await post(srv.base, { ...PACKET, id: 'csv-1', d_x: -5, Alt_R: '+cmd' });
    await post(srv.base, { ...PACKET, id: 'other' });
    const login = await send(srv.base, '/api/auth/login', { phone: USER.phone, password: USER.password }, { 'X-Forwarded-For': '10.0.0.3' });
    const c = cookieFrom(login.res).value;
    const res = await fetch(`${srv.base}/api/export.csv?id=CSV-1`, { headers: { Cookie: c } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="packets-CSV-1-\d+\.csv"/);
    const text = (await res.text()).replace(/^﻿/, '');
    const lines = text.trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^Time \(IST\),ID,Latitude,Longitude/);
    assert.match(lines[1], /^"\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2} IST","csv-1",23\.078143,72\.531243,16\.5,"'=HYPERLINK\(""http:\/\/x""\)",0\.32,-0\.18,0\.19,"server","2020-01-01 10:00:00"/);
    assert.match(lines[2], /,"'\+cmd",-5,/);
    assert.ok(!text.includes('"other"'));

    const all = await fetch(`${srv.base}/api/export.csv`, { headers: { Cookie: c } });
    assert.ok((await all.text()).includes('"other"'));
  });
});
