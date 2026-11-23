'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PACKET, post, getJson } = require('./helpers');
const { validateBody } = require('../src/packets');
const { parseDeviceTime } = require('../src/time');

describe('validation (unit)', () => {
  test('sample packet is valid', () => {
    const v = validateBody(PACKET);
    assert.equal(v.ok, true);
    assert.deepEqual(v.packets[0], { trackerId: '1005', lat: 23.078143, lon: 72.531243, alt: 16.5, altRef: 'AGL', dx: 0.32, dy: -0.18, dz: 0.19, timestamp: null, deviceTime: null });
  });

  test('aliases, case, spaces, numbers as text, numeric id', () => {
    const v = validateBody({ TrackerId: 1005, Latitude: '23.5', Longitude: ' 72.25 ', Altitude: '10', 'Altitude Reference': 'MSL', delta_x: '1', deltaY: 2, 'D-Z': -3 });
    assert.equal(v.ok, true, v.errors?.join());
    const p = v.packets[0];
    assert.equal(p.trackerId, '1005');
    assert.equal(p.lat, 23.5); assert.equal(p.lon, 72.25); assert.equal(p.alt, 10);
    assert.equal(p.altRef, 'MSL'); assert.equal(p.dx, 1); assert.equal(p.dy, 2); assert.equal(p.dz, -3);
    assert.equal(validateBody({ id: 'a', lat: 1, long: 2 }).packets[0].lon, 2);
    assert.equal(validateBody({ id: 'a', lat: 1, lon: 2, altr: 7 }).packets[0].altRef, '7');
    assert.equal(validateBody({ id: 'a', lat: 1, lon: 2, AltR: 'AGL' }).packets[0].altRef, 'AGL');
  });

  test('required fields, ranges and the 0,0 rule', () => {
    const errs = b => validateBody(b).errors;
    assert.deepEqual(errs({ lat: 1, lon: 2 }), ['id is required']);
    assert.deepEqual(errs({ id: 'x', lat: 1 }), ['lon is required']);
    assert.match(errs({ id: 'x', lat: 91, lon: 2 })[0], /lat must be between -90 and 90/);
    assert.match(errs({ id: 'x', lat: 1, lon: -181 })[0], /lon must be between/);
    assert.match(errs({ id: 'x', lat: 0, lon: 0 })[0], /no GPS fix/);
    assert.match(errs({ id: 'x', lat: 1, lon: 2, Alt: 'high' })[0], /Alt must be a number/);
    assert.match(errs({ id: 'x', lat: 1, lon: 2, Alt: 100001 })[0], /Alt must be between/);
    assert.match(errs({ id: 'bad id!', lat: 1, lon: 2 })[0], /id must be/);
    assert.match(errs({ id: 'x'.repeat(65), lat: 1, lon: 2 })[0], /id must be/);
    assert.match(errs({ id: 'x', lat: 1, lon: 2, Alt_R: 'a'.repeat(41) })[0], /at most 40/);
    assert.match(errs({ id: 'x', lat: 1, lon: 2, Timestamp: 'yesterday' })[0], /Timestamp must be/);
    assert.equal(validateBody({ id: 'x', lat: 0, lon: 5 }).ok, true);
  });

  test('device time formats', () => {
    assert.equal(parseDeviceTime('2026-11-23 15:00:00').toISOString(), '2026-11-23T09:30:00.000Z');
    assert.equal(parseDeviceTime('2026-11-23T09:30:00Z').toISOString(), '2026-11-23T09:30:00.000Z');
    assert.equal(parseDeviceTime('2026-11-23T15:00:00+05:30').toISOString(), '2026-11-23T09:30:00.000Z');
    assert.equal(parseDeviceTime(1795426200).toISOString(), '2026-11-23T09:30:00.000Z');
    assert.equal(parseDeviceTime('1795426200').toISOString(), '2026-11-23T09:30:00.000Z');
    assert.equal(parseDeviceTime('2026-02-30 10:00:00'), null);
    assert.equal(parseDeviceTime('2026-11-23T15:00:00').toISOString(), '2026-11-23T09:30:00.000Z', 'no zone = IST');
    assert.equal(parseDeviceTime('23/11/2026 15:00'), null);
  });
});

describe('packet API', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('health', async () => {
    const r = await getJson(srv.base, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.success, true);
    assert.equal(r.body.database, 'connected');
    assert.equal(r.body.message, 'Drone Packets API is running');
    assert.ok(r.body.startedAt && r.body.serverTime);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  test('POST one packet, then read it back', async () => {
    const r = await post(srv.base, PACKET);
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'ok');
    assert.match(r.body.packetId, /^[0-9a-f]{24}$/);
    assert.equal(typeof r.body.seq, 'number');
    assert.equal(r.body.ignoredFields, undefined);

    const list = await getJson(srv.base, '/api/packet');
    assert.equal(list.status, 200);
    const p = list.body.packets.find(x => x.id === r.body.packetId);
    assert.ok(p);
    assert.equal(p.trackerId, '1005');
    assert.equal(p.lat, 23.078143); assert.equal(p.lon, 72.531243); assert.equal(p.alt, 16.5); assert.equal(p.altRef, 'AGL');
    assert.equal(p.dx, 0.32); assert.equal(p.dy, -0.18); assert.equal(p.dz, 0.19);
    assert.equal(p.timestamp, null); assert.equal(p.timeSource, 'server');
    assert.equal(p.recordedAt, p.receivedAt);
    assert.ok(list.body.trackers.includes('1005'));
    assert.equal(list.body.seq, r.body.seq);
  });

  test('no Content-Type, text numbers, ignored fields, optional nulls', async () => {
    const res = await fetch(`${srv.base}/api/packet`, { method: 'POST', body: JSON.stringify({ ID: 'Tag-7', LAT: '12.5', Lon: '77.5', battery: 88 }) });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.deepEqual(body.ignoredFields, ['battery']);
    const one = await getJson(srv.base, '/api/packet/tag-7');
    assert.equal(one.status, 200);
    const p = one.body.packets[0];
    assert.equal(p.trackerId, 'Tag-7');
    assert.equal(p.alt, null); assert.equal(p.altRef, null); assert.equal(p.dx, null);
    assert.equal(p.battery, undefined);
  });

  test('device time: believable is used, too old falls back to server time', async () => {
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 3600e3 - 60e3).toISOString().slice(0, 19).replace('T', ' ');
    let r = await post(srv.base, { ...PACKET, id: 'time-1', Timestamp: ist });
    assert.equal(r.status, 201);
    let p = (await getJson(srv.base, '/api/packet/time-1')).body.packets[0];
    assert.equal(p.timeSource, 'device');
    assert.equal(p.timestamp, ist);
    assert.ok(Math.abs(new Date(p.recordedAt) - (now - 60e3)) < 2000);

    r = await post(srv.base, { ...PACKET, id: 'time-2', Timestamp: '2020-01-01 00:00:00' });
    p = (await getJson(srv.base, '/api/packet/time-2')).body.packets[0];
    assert.equal(p.timeSource, 'server');
    assert.equal(p.recordedAt, p.receivedAt);

    r = await post(srv.base, { ...PACKET, id: 'time-3', Timestamp: Math.floor(Date.now() / 1000) + 3600 });
    p = (await getJson(srv.base, '/api/packet/time-3')).body.packets[0];
    assert.equal(p.timeSource, 'server', 'an hour ahead is not believable');
  });

  test('batch is all-or-nothing', async () => {
    const before = (await getJson(srv.base, '/api/packet?limit=5000')).body.total;
    const bad = await post(srv.base, [PACKET, { id: '1005', lat: 23 }, { id: '1005', lat: 95, lon: 72 }]);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.status, 'error');
    assert.deepEqual(bad.body.errors, ['packet 2: lon is required', 'packet 3: lat must be between -90 and 90']);
    assert.equal((await getJson(srv.base, '/api/packet?limit=5000')).body.total, before, 'nothing stored');

    const ok = await post(srv.base, [PACKET, { ...PACKET, lat: 23.1 }, { ...PACKET, lat: 23.2 }]);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.count, 3);
    assert.equal(ok.body.packetIds.length, 3);
    const list = (await getJson(srv.base, `/api/packet?since=${ok.body.seq - 3}`)).body;
    assert.deepEqual(list.packets.map(p => p.lat), [23.078143, 23.1, 23.2]);
    assert.deepEqual(list.packets.map(p => p.seq), [ok.body.seq - 2, ok.body.seq - 1, ok.body.seq]);
  });

  test('bad bodies', async () => {
    let r = await post(srv.base, '{not json');
    assert.equal(r.status, 400); assert.match(r.body.message, /not valid JSON/);
    r = await post(srv.base, '');
    assert.equal(r.status, 400);
    r = await post(srv.base, '[]');
    assert.equal(r.status, 400);
    r = await post(srv.base, '"text"');
    assert.equal(r.status, 400);
    r = await post(srv.base, Array.from({ length: 101 }, () => PACKET));
    assert.equal(r.status, 400); assert.match(r.body.message, /at most 100/);
    r = await post(srv.base, JSON.stringify({ ...PACKET, pad: 'x'.repeat(1100 * 1024) }));
    assert.equal(r.status, 413); assert.equal(r.body.status, 'error');
  });

  test('since and limit', async () => {
    const first = await post(srv.base, { ...PACKET, id: 'lim' });
    for (let i = 0; i < 4; i++) await post(srv.base, { ...PACKET, id: 'lim', Alt: i });
    let r = await getJson(srv.base, '/api/packet/LIM?limit=2');
    assert.equal(r.body.count, 2);
    assert.equal(r.body.total, 5);
    assert.deepEqual(r.body.packets.map(p => p.alt), [2, 3], 'newest two, oldest first');
    r = await getJson(srv.base, `/api/packet/lim?since=${first.body.seq + 2}`);
    assert.deepEqual(r.body.packets.map(p => p.alt), [2, 3]);
    r = await getJson(srv.base, '/api/packet?limit=abc');
    assert.equal(r.status, 400);
    r = await getJson(srv.base, '/api/packet?limit=999999');
    assert.equal(r.status, 200);
  });

  test('unknown drone gives 404 with the known IDs', async () => {
    const r = await getJson(srv.base, '/api/packet/nobody');
    assert.equal(r.status, 404);
    assert.equal(r.body.status, 'error');
    assert.ok(r.body.trackers.includes('1005'));
    assert.ok(r.body.errors.some(e => e.includes('1005')));
  });

  test('unknown /api endpoint gives a JSON 404 listing the endpoints', async () => {
    const r = await getJson(srv.base, '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.status, 'error');
    assert.ok(r.body.endpoints.includes('POST /api/packet'));
  });

  test('openapi and docs', async () => {
    const r = await getJson(srv.base, '/openapi.json');
    assert.equal(r.status, 200);
    assert.equal(r.body.openapi, '3.0.3');
    for (const p of ['/health', '/api/packet', '/api/packet/{id}', '/api/packet-stream', '/api/export.csv']) assert.ok(r.body.paths[p], p);
    const d = await getJson(srv.base, '/docs');
    assert.equal(d.status, 200);
    assert.match(d.body, /swagger-ui\/5\.17\.14/);
  });
});

describe('pruning', () => {
  let srv;
  before(async () => { srv = await startServer({ maxPackets: 5 }); });
  after(async () => { await srv.close(); });

  test('keeps at most MAX_PACKETS, deleting the oldest', async () => {
    for (let i = 0; i < 8; i++) await post(srv.base, { ...PACKET, Alt: i });
    const r = await getJson(srv.base, '/api/packet');
    assert.equal(r.body.total, 5);
    assert.deepEqual(r.body.packets.map(p => p.alt), [3, 4, 5, 6, 7]);
  });
});
