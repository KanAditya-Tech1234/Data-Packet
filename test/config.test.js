'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, getJson } = require('./helpers');
const { parseVersion, compareVersions, cleanFileName } = require('../src/config-files');

const USER = { name: 'Config Admin', phone: '9123456780', email: 'config@example.test', password: 'Secret123' };

async function login(base) {
  const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(USER) });
  assert.equal(res.status, 201);
  return res.headers.getSetCookie().find(c => c.startsWith('dtp_session=')).split(';')[0];
}

async function upload(base, cookie, { version, fileName = 'drone.json', notes, body }) {
  const q = new URLSearchParams({ fileName });
  if (version !== undefined) q.set('version', version);
  if (notes) q.set('notes', notes);
  const res = await fetch(`${base}/api/config?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(cookie ? { Cookie: cookie } : {}) }, body,
  });
  return { status: res.status, body: await res.json() };
}

describe('version numbers', () => {
  test('parse and compare', () => {
    assert.equal(parseVersion('1.2').version, '1.2');
    assert.equal(parseVersion('v01.02.3').version, '1.2.3');
    assert.equal(parseVersion('1.2').key, parseVersion('1.2.0').key);
    for (const bad of ['', 'abc', '1..2', '1.2.3.4.5', '-1', '1.2-beta']) assert.equal(parseVersion(bad), null, bad);
    assert.ok(compareVersions('1.10', '1.9') > 0);
    assert.ok(compareVersions('2', '1.99.99') > 0);
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
  });
  test('file names are cleaned', () => {
    assert.equal(cleanFileName('C:\\fakepath\\drone config.json'), 'drone config.json');
    assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
    assert.equal(cleanFileName('a"b<c>.json'), 'a_b_c_.json');
    assert.equal(cleanFileName(''), 'config.txt');
  });
});

describe('configuration file APIs', () => {
  let srv, cookie;
  before(async () => { srv = await startServer(); cookie = await login(srv.base); });
  after(async () => { await srv.close(); });

  test('nothing uploaded yet: 404 for the drone APIs', async () => {
    assert.equal((await getJson(srv.base, '/api/config/version')).status, 404);
    const r = await getJson(srv.base, '/api/config/download');
    assert.equal(r.status, 404);
    assert.match(r.body.message, /no configuration file/);
  });

  test('uploading needs a login and a valid version and file', async () => {
    assert.equal((await upload(srv.base, null, { version: '1.0', body: '{}' })).status, 401);
    let r = await upload(srv.base, cookie, { version: 'one', body: '{}' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /version must be numbers/);
    r = await upload(srv.base, cookie, { version: '1.0', body: '' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /empty/);
    r = await upload(srv.base, cookie, { version: '1.0', body: Buffer.alloc(1024 * 1024 + 1, 65) });
    assert.equal(r.status, 413);
  });

  test('upload, check the version, download the exact bytes', async () => {
    const text = JSON.stringify({ interval: 5, server: 'https://example.test', geofence: [23.07, 72.53] });
    const r = await upload(srv.base, cookie, { version: '1.0', notes: 'first config', body: text });
    assert.equal(r.status, 201);
    assert.equal(r.body.version, '1.0');
    assert.equal(r.body.fileName, 'drone.json');
    assert.equal(r.body.size, Buffer.byteLength(text));
    assert.equal(r.body.sha256, crypto.createHash('sha256').update(text).digest('hex'));
    assert.equal(r.body.uploadedBy, USER.name);

    let v = await getJson(srv.base, '/api/config/version');
    assert.equal(v.status, 200);
    // exactly these five fields, in this order, nothing else
    assert.deepEqual(Object.keys(v.body), ['status', 'updateAvailable', 'version', 'fileName', 'contentType']);
    assert.deepEqual(v.body, { status: 'ok', updateAvailable: true, version: '1.0', fileName: 'drone.json', contentType: 'application/json' });

    v = await getJson(srv.base, '/api/config/version?current=0.9');
    assert.equal(v.body.updateAvailable, true);
    v = await getJson(srv.base, '/api/config/version?current=1.0.0');
    assert.equal(v.body.updateAvailable, false);
    assert.deepEqual(Object.keys(v.body), ['status', 'updateAvailable', 'version', 'fileName', 'contentType']);
    v = await getJson(srv.base, '/api/config/version?current=2');
    assert.equal(v.body.updateAvailable, false, 'a drone that is ahead does not download');
    assert.equal((await getJson(srv.base, '/api/config/version?current=x')).status, 400);

    const d = await fetch(`${srv.base}/api/config/download`);
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-type'), /^application\/json/);
    assert.equal(d.headers.get('content-length'), String(Buffer.byteLength(text)));
    assert.equal(d.headers.get('x-config-version'), '1.0');
    assert.equal(d.headers.get('x-config-sha256'), r.body.sha256);
    assert.match(d.headers.get('content-disposition'), /attachment; filename="drone.json"/);
    assert.equal(await d.text(), text);
  });

  test('a new version must be newer; old versions stay downloadable', async () => {
    let r = await upload(srv.base, cookie, { version: '1.0.0', body: 'x' });
    assert.equal(r.status, 409);
    assert.equal(r.body.currentVersion, '1.0');
    r = await upload(srv.base, cookie, { version: '0.5', body: 'x' });
    assert.equal(r.status, 409);

    const bin = crypto.randomBytes(3000);
    r = await upload(srv.base, cookie, { version: '1.10', fileName: 'C:\\fakepath\\params.bin', body: bin });
    assert.equal(r.status, 201);
    assert.equal(r.body.fileName, 'params.bin');

    const v = await getJson(srv.base, '/api/config/version?current=1.0');
    assert.equal(v.body.version, '1.10');
    assert.equal(v.body.updateAvailable, true);

    const latest = await fetch(`${srv.base}/api/config/download`);
    assert.equal(latest.headers.get('content-type'), 'application/octet-stream');
    assert.ok(Buffer.from(await latest.arrayBuffer()).equals(bin), 'binary file comes back unchanged');

    const old = await fetch(`${srv.base}/api/config/download?version=1.0.0`);
    assert.equal(old.status, 200);
    assert.equal(old.headers.get('x-config-version'), '1.0');
    assert.equal((await getJson(srv.base, '/api/config/download?version=7.7')).status, 404);
  });

  test('version list is for logged-in users, newest first', async () => {
    assert.equal((await getJson(srv.base, '/api/config/versions')).status, 401);
    const r = await getJson(srv.base, '/api/config/versions', { Cookie: cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.versions.map(x => x.version), ['1.10', '1.0']);
    assert.ok(!('data' in r.body.versions[0]));
  });

  test('only the newest 20 versions are kept', async () => {
    for (let i = 2; i <= 22; i++) assert.equal((await upload(srv.base, cookie, { version: String(i), body: `v${i}` })).status, 201);
    const r = await getJson(srv.base, '/api/config/versions', { Cookie: cookie });
    assert.equal(r.body.versions.length, 20);
    assert.equal(r.body.versions[0].version, '22');
    assert.equal((await getJson(srv.base, '/api/config/download?version=1.0')).status, 404);
  });
});
