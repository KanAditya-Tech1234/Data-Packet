'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, getJson } = require('./helpers');
const { parseVersion, compareVersions, cleanFileName, slugify, validateSensor, makeConfigDoc } = require('../src/config-files');
const { MemoryStore } = require('../src/store/memory');
const { createApp } = require('../src/app');

const USER = { name: 'Config Admin', phone: '9123456780', email: 'config@example.test', password: 'Secret123' };
const FIVE = ['status', 'updateAvailable', 'version', 'fileName', 'contentType'];

async function login(base) {
  const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(USER) });
  assert.equal(res.status, 201);
  return res.headers.getSetCookie().find(c => c.startsWith('dtp_session=')).split(';')[0];
}

async function addSensor(base, cookie, body) {
  const res = await fetch(`${base}/api/sensors`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function upload(base, cookie, sensorId, { version, fileName = 'drone.json', notes, body }) {
  const q = new URLSearchParams({ fileName });
  if (version !== undefined) q.set('version', version);
  if (notes) q.set('notes', notes);
  const res = await fetch(`${base}/api/sensors/${sensorId}/config?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(cookie ? { Cookie: cookie } : {}) }, body,
  });
  return { status: res.status, body: await res.json() };
}

describe('version numbers, file names and sensor IDs', () => {
  test('versions parse and compare', () => {
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
  test('sensor IDs', () => {
    assert.equal(slugify('Node Sensor #2'), 'node-sensor-2');
    assert.deepEqual(validateSensor({ name: '  Separate   Sensor ' }).sensor, { _id: 'separate-sensor', name: 'Separate Sensor', description: '' });
    assert.equal(validateSensor({ name: 'Node', id: 'NODE_1' }).sensor._id, 'node_1');
    assert.equal(validateSensor({ name: 'Node', id: 'bad id!' }).errors.length, 1);
    assert.equal(validateSensor({ name: 'x' }).errors[0], 'name must be 2-60 characters');
    assert.equal(validateSensor({ name: '###' }).errors.length, 1);
  });
});

describe('sensors', () => {
  let srv, cookie;
  before(async () => { srv = await startServer(); cookie = await login(srv.base); });
  after(async () => { await srv.close(); });

  test('adding a sensor needs a login and a valid, unique name/ID', async () => {
    assert.equal((await addSensor(srv.base, null, { name: 'Node sensor' })).status, 401);
    let r = await addSensor(srv.base, cookie, { name: 'x' });
    assert.equal(r.status, 400);
    r = await addSensor(srv.base, cookie, { name: 'Node sensor', description: 'On the drone body' });
    assert.equal(r.status, 201);
    assert.equal(r.body.sensor.id, 'node-sensor');
    assert.equal(r.body.sensor.createdBy, USER.name);
    assert.equal(r.body.sensor.latestVersion, null);
    r = await addSensor(srv.base, cookie, { name: 'Node Sensor' });
    assert.equal(r.status, 409, 'same ID again');
    r = await addSensor(srv.base, cookie, { name: 'Separate sensor', id: 'sep-1' });
    assert.equal(r.status, 201);
    assert.equal(r.body.sensor.id, 'sep-1');
  });

  test('the sensor list is public and in the order they were added', async () => {
    const r = await getJson(srv.base, '/api/sensors');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sensors.map(x => x.id), ['node-sensor', 'sep-1']);
  });

  test('each sensor has its own files and version numbers', async () => {
    assert.equal((await upload(srv.base, null, 'node-sensor', { version: '1.0', body: '{}' })).status, 401);
    let r = await upload(srv.base, cookie, 'node-sensor', { version: 'one', body: '{}' });
    assert.equal(r.status, 400);
    r = await upload(srv.base, cookie, 'node-sensor', { version: '1.0', body: '' });
    assert.equal(r.status, 400);
    r = await upload(srv.base, cookie, 'node-sensor', { version: '1.0', body: Buffer.alloc(1024 * 1024 + 1, 65) });
    assert.equal(r.status, 413);

    // nothing uploaded yet for this sensor
    r = await getJson(srv.base, '/api/sensors/node-sensor/config/version');
    assert.equal(r.status, 404);
    assert.match(r.body.message, /has no configuration file yet/);

    const nodeText = JSON.stringify({ rateHz: 10, mode: 'node' });
    r = await upload(srv.base, cookie, 'node-sensor', { version: '1.0', fileName: 'node.json', notes: 'first', body: nodeText });
    assert.equal(r.status, 201);
    assert.equal(r.body.sensorId, 'node-sensor');
    assert.equal(r.body.sha256, crypto.createHash('sha256').update(nodeText).digest('hex'));
    assert.equal(r.body.downloadUrl, '/api/sensors/node-sensor/config/download?version=1.0');

    // the other sensor can use the same version number: versions are per sensor
    const bin = crypto.randomBytes(2000);
    r = await upload(srv.base, cookie, 'sep-1', { version: '1.0', fileName: 'sep.bin', body: bin });
    assert.equal(r.status, 201);
    r = await upload(srv.base, cookie, 'sep-1', { version: '2.5', fileName: 'sep.bin', body: bin });
    assert.equal(r.status, 201);

    // a new version must be newer than that sensor's current one
    r = await upload(srv.base, cookie, 'node-sensor', { version: '0.9', body: 'x' });
    assert.equal(r.status, 409);
    assert.equal(r.body.currentVersion, '1.0');

    // unknown sensor
    r = await upload(srv.base, cookie, 'nope', { version: '1.0', body: 'x' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body.sensors, ['node-sensor', 'sep-1']);
  });

  test('version check: exactly five fields, per sensor', async () => {
    let v = await getJson(srv.base, '/api/sensors/node-sensor/config/version?current=0.9');
    assert.equal(v.status, 200);
    assert.deepEqual(Object.keys(v.body), FIVE);
    assert.deepEqual(v.body, { status: 'ok', updateAvailable: true, version: '1.0', fileName: 'node.json', contentType: 'application/json' });
    v = await getJson(srv.base, '/api/sensors/node-sensor/config/version?current=1.0');
    assert.equal(v.body.updateAvailable, false);
    v = await getJson(srv.base, '/api/sensors/SEP-1/config/version?current=1.0');   // sensor ID is not case-sensitive
    assert.deepEqual(v.body, { status: 'ok', updateAvailable: true, version: '2.5', fileName: 'sep.bin', contentType: 'application/octet-stream' });
    v = await getJson(srv.base, '/api/sensors/sep-1/config/version');
    assert.equal(v.body.updateAvailable, true, 'without current');
    assert.equal((await getJson(srv.base, '/api/sensors/sep-1/config/version?current=x')).status, 400);
    v = await getJson(srv.base, '/api/sensors/unknown/config/version');
    assert.equal(v.status, 404);
    assert.match(v.body.message, /no sensor with ID "unknown"/);
  });

  test('download: exact bytes of that sensor, latest or a given version', async () => {
    let d = await fetch(`${srv.base}/api/sensors/node-sensor/config/download`);
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-type'), /^application\/json/);
    assert.equal(d.headers.get('x-sensor-id'), 'node-sensor');
    assert.equal(d.headers.get('x-config-version'), '1.0');
    assert.match(d.headers.get('content-disposition'), /filename="node.json"/);
    assert.equal(await d.text(), JSON.stringify({ rateHz: 10, mode: 'node' }));

    d = await fetch(`${srv.base}/api/sensors/sep-1/config/download?version=1.0`);
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('x-config-version'), '1.0');
    assert.equal(d.headers.get('content-length'), '2000');
    assert.equal((await getJson(srv.base, '/api/sensors/sep-1/config/download?version=9')).status, 404);
  });

  test('versions list (login), newest first, and the list shows the latest version', async () => {
    assert.equal((await getJson(srv.base, '/api/sensors/sep-1/config/versions')).status, 401);
    const r = await getJson(srv.base, '/api/sensors/sep-1/config/versions', { Cookie: cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.versions.map(x => x.version), ['2.5', '1.0']);
    assert.equal(r.body.sensor.latestVersion, '2.5');
    const list = await getJson(srv.base, '/api/sensors');
    assert.deepEqual(list.body.sensors.map(x => x.latestVersion), ['1.0', '2.5']);
  });

  test('only the newest 20 versions of a sensor are kept; other sensors are not touched', async () => {
    for (let i = 3; i <= 23; i++) assert.equal((await upload(srv.base, cookie, 'sep-1', { version: String(i), body: `v${i}` })).status, 201);
    const r = await getJson(srv.base, '/api/sensors/sep-1/config/versions', { Cookie: cookie });
    assert.equal(r.body.versions.length, 20);
    assert.equal(r.body.versions[0].version, '23');
    assert.equal((await getJson(srv.base, '/api/sensors/node-sensor/config/version')).body.version, '1.0');
  });

  test('deleting a sensor deletes its files (login required)', async () => {
    assert.equal((await fetch(`${srv.base}/api/sensors/sep-1`, { method: 'DELETE' })).status, 401);
    const res = await fetch(`${srv.base}/api/sensors/sep-1`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal((await getJson(srv.base, '/api/sensors/sep-1/config/version')).status, 404);
    assert.deepEqual((await getJson(srv.base, '/api/sensors')).body.sensors.map(x => x.id), ['node-sensor']);
    assert.equal((await srv.store.listConfigs('sep-1')).length, 0);
  });
});

describe('files uploaded before sensors existed', () => {
  test('are moved to sensor "default" and the old URLs still work', async () => {
    const store = new MemoryStore();
    const old = makeConfigDoc({ version: '1.0.1', fileName: 'Testing.txt', data: Buffer.from('hello') });
    delete old.sensorId;
    store.configs.push(old);
    const quiet = { log() {}, warn() {}, error() {} };
    const { app } = await createApp({ store, config: { sessionSecret: 's', maxPackets: 500 }, log: quiet });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const list = await getJson(base, '/api/sensors');
      assert.deepEqual(list.body.sensors.map(x => [x.id, x.latestVersion]), [['default', '1.0.1']]);
      const v = await getJson(base, '/api/config/version?current=1.0');
      assert.deepEqual(v.body, { status: 'ok', updateAvailable: true, version: '1.0.1', fileName: 'Testing.txt', contentType: 'text/plain' });
      const d = await fetch(`${base}/api/config/download`);
      assert.equal(await d.text(), 'hello');
      assert.deepEqual((await getJson(base, '/api/sensors/default/config/version')).body.version, '1.0.1');
    } finally {
      server.closeAllConnections?.();
      await new Promise(r => server.close(r));
    }
  });
});
