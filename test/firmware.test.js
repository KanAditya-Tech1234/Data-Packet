'use strict';
// Thrust-bench firmware service: the acceptance tests of SERVER_OTA_HANDOFF.md §10, plus roles, tokens and installs.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer } = require('./helpers');
const fw = require('../src/firmware');
const { readZip, createZip } = require('../src/zip');

const ADMIN = { name: 'Firmware Admin', phone: '9000000001', email: 'admin@example.test', password: 'Secret123' };
const ENG = { name: 'Field Engineer', phone: '9000000002', email: 'eng@example.test', password: 'Secret123' };
const NOBODY = { name: 'Packets Viewer', phone: '9000000003', email: 'viewer@example.test', password: 'Secret123' };
const MANIFEST_KEYS = ['schema', 'product', 'target', 'version', 'proto', 'requires', 'channel', 'file', 'size', 'md5',
  'sha256', 'chip_id', 'built_with', 'notes', 'published_at', 'release_id'];

/** A fake ESP32 app image: 0xE9, chip ID at offset 12, random body. */
function image(chipId, size = 4096, seed = '') {
  const b = Buffer.alloc(size);
  crypto.createHash('sha512').update(String(seed)).digest().copy(b, 24);
  for (let i = 88; i < size; i++) b[i] = (i * 31 + seed.length) & 0xff;
  b[0] = 0xE9;
  b.writeUInt16LE(chipId, 12);
  return b;
}
const MAIN_CHIP = 0x0000, C3 = 0x0005;
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

async function register(base, user) {
  const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) });
  assert.equal(res.status, 201);
  return res.headers.getSetCookie().find(c => c.startsWith('dtp_session=')).split(';')[0];
}

describe('firmware rules (unit)', () => {
  test('strict semver', () => {
    assert.equal(fw.parseSemver('2.1.0').version, '2.1.0');
    for (const bad of ['2.1', 'v2.1.0', '02.1.0', '2.1.0-beta', '1.2.3.4', '']) assert.equal(fw.parseSemver(bad), null, bad);
    assert.ok(fw.compareSemver('2.10.0', '2.9.9') > 0);
  });
  test('requires', () => {
    assert.deepEqual(fw.parseRequires('n1', { n2: '2.0.0', main: '>=2.1.0' }).requires, { main: '>=2.1.0', n2: '>=2.0.0' });
    assert.match(fw.parseRequires('n1', { n1: '1.0.0' }).error, /cannot require n1/);
    assert.match(fw.parseRequires('n1', { main: '<2.0.0' }).error, /only ">="/);
    assert.deepEqual(fw.parseRequires('main', { n1: '' }).requires, {});
  });
  test('zip round trip', () => {
    const z = createZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b.bin', data: Buffer.from([1, 2, 3]) }], '2026-11-25T05:30:00Z');
    assert.deepEqual(readZip(z).map(e => e.name), ['a.txt', 'b.bin']);
    assert.equal(readZip(z)[0].data.toString(), 'hello');
    assert.deepEqual(z, createZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b.bin', data: Buffer.from([1, 2, 3]) }], '2026-11-25T05:30:00Z'), 'reproducible');
  });
});

describe('firmware service', () => {
  let srv, admin, eng, nobody, engToken;
  const ids = {};

  before(async () => {
    srv = await startServer({ adminPhones: [ADMIN.phone], maxAppSize: { main: 2 * 1024 * 1024, n1: 1024 * 1024, n2: 1024 * 1024 } });
    admin = await register(srv.base, ADMIN);
    eng = await register(srv.base, ENG);
    nobody = await register(srv.base, NOBODY);
  });
  after(async () => { await srv.close(); });

  const call = async (path, { method = 'GET', cookie, token, json, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (token) h.Authorization = `Bearer ${token}`;
    if (json !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${srv.base}/api/tb/v1${path}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, headers: res.headers };
  };

  async function upload(fields, file, fileName, { cookie = admin, token } = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (file) form.append('file', new Blob([file]), fileName);
    const h = {};
    if (cookie) h.Cookie = cookie;
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(`${srv.base}/api/tb/v1/firmware`, { method: 'POST', headers: h, body: form });
    return { status: res.status, body: await res.json() };
  }
  const base = (target, version, extra = {}) => ({ target, version, proto: 1, notes: `Release ${target} ${version}`, built_with: 'arduino-esp32 3.3.12', ...extra });

  test('8. no login = 401; account without a firmware role = 403', async () => {
    assert.equal((await call('/firmware')).status, 401);
    const r = await call('/firmware', { cookie: nobody });
    assert.equal(r.status, 403);
    assert.deepEqual(Object.keys(r.body), ['error', 'message']);
    assert.equal((await call('/firmware', { token: 'tbt_this-is-not-a-real-token-at-all' })).status, 401);
  });

  test('admin makes the engineer an engineer; tokens are hashed and work', async () => {
    assert.equal((await call(`/users/${ENG.phone}`, { method: 'PATCH', cookie: eng, json: { role: 'engineer' } })).status, 403);
    let r = await call(`/users/${ENG.phone}`, { method: 'PATCH', cookie: admin, json: { role: 'engineer' } });
    assert.equal(r.status, 200);
    assert.equal((await call(`/users/${ADMIN.phone}`, { method: 'PATCH', cookie: admin, json: { role: 'none' } })).status, 409);
    r = await call('/me', { cookie: eng });
    assert.equal(r.body.role, 'engineer');
    r = await call('/tokens', { method: 'POST', cookie: eng, json: { label: 'Field laptop' } });
    assert.equal(r.status, 201);
    engToken = r.body.token;
    assert.match(engToken, /^tbt_/);
    const stored = srv.store.tokens ? JSON.stringify(await srv.store.listTokens(null)) : '';
    assert.ok(!stored.includes(engToken), 'the token itself is not stored');
    r = await call('/me', { token: engToken });
    assert.deepEqual([r.body.role, r.body.auth], ['engineer', 'token']);
    assert.equal((await call('/tokens', { token: engToken })).status, 403, 'tokens cannot manage tokens');
  });

  test('1. wrong kinds of file are rejected', async () => {
    let r = await upload(base('main', '2.1.0'), image(MAIN_CHIP), 'tb.ino.merged.bin');
    assert.equal(r.status, 400); assert.equal(r.body.error, 'not_ota_image');
    r = await upload(base('main', '2.1.0'), image(MAIN_CHIP), 'tb.ino.bootloader.bin');
    assert.equal(r.body.error, 'not_ota_image');
    r = await upload(base('main', '2.1.0'), image(MAIN_CHIP), 'tb.ino.partitions.bin');
    assert.equal(r.body.error, 'not_ota_image');
    r = await upload(base('main', '2.1.0'), image(MAIN_CHIP), 'tb.bin');
    assert.equal(r.body.error, 'bad_file_name');
    const notImage = image(MAIN_CHIP); notImage[0] = 0x7F;
    r = await upload(base('main', '2.1.0'), notImage, 'tb.ino.bin');
    assert.equal(r.body.error, 'bad_magic');
    assert.match(r.body.message, /0xE9/);
  });

  test('2. chip ID must match the target', async () => {
    let r = await upload(base('main', '2.1.0'), image(C3), 'tb.ino.bin');
    assert.equal(r.status, 400); assert.equal(r.body.error, 'chip_mismatch');
    assert.match(r.body.message, /ESP32-C3/);
    r = await upload(base('n1', '2.1.0'), image(MAIN_CHIP), 'tb.ino.bin');
    assert.equal(r.body.error, 'chip_mismatch');
  });

  test('form rules: semver, proto, requires, notes, size; engineers cannot upload', async () => {
    assert.equal((await upload(base('main', '2.1'), image(MAIN_CHIP), 'tb.ino.bin')).body.error, 'invalid_version');
    assert.equal((await upload(base('main', '2.1.0', { proto: 0 }), image(MAIN_CHIP), 'tb.ino.bin')).body.error, 'invalid_proto');
    assert.equal((await upload(base('main', '2.1.0', { requires_n1: '2.x' }), image(MAIN_CHIP), 'tb.ino.bin')).body.error, 'invalid_requires');
    assert.equal((await upload(base('main', '2.1.0', { notes: '' }), image(MAIN_CHIP), 'tb.ino.bin')).body.error, 'notes_required');
    assert.equal((await upload(base('main', '2.1.0', { notes: 'x'.repeat(4001) }), image(MAIN_CHIP), 'tb.ino.bin')).body.error, 'notes_too_long');
    const r = await upload(base('n1', '2.1.0'), image(C3, 1024 * 1024 + 1), 'tb.ino.bin');
    assert.equal(r.status, 413); assert.equal(r.body.error, 'too_large');
    assert.equal((await upload(base('main', '2.1.0'), image(MAIN_CHIP), 'tb.ino.bin', { cookie: eng })).status, 403);
    assert.equal((await upload(base('main', '2.1.0'), image(MAIN_CHIP), 'tb.ino.bin', { cookie: null, token: engToken })).status, 403, '8. engineer token cannot call admin endpoints');
  });

  test('upload creates a draft with server-computed values; drafts are hidden from engineers', async () => {
    const bin = image(MAIN_CHIP, 300000, 'main-2.1.0');
    const r = await upload({ ...base('main', '2.1.0', { requires_n1: '>=2.1.0', requires_n2: '2.0.0', channel: 'stable' }), size: 1, md5: 'f'.repeat(32) }, bin, 'thrust_bench.ino.bin');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.meta.status, 'draft');
    assert.equal(r.body.size, bin.length, 'size is computed, never taken from the form');
    assert.equal(r.body.md5, md5(bin));
    assert.equal(r.body.sha256, sha(bin));
    assert.equal(r.body.chip_id, 0);
    assert.equal(r.body.file, 'tb-main-2.1.0.ino.bin');
    assert.deepEqual(r.body.requires, { n1: '>=2.1.0', n2: '>=2.0.0' });
    assert.equal(r.body.published_at, null);
    ids.main210 = r.body.release_id;
    assert.equal((await call(`/firmware/${ids.main210}`, { cookie: eng })).status, 404);
    assert.equal((await call('/firmware?include_drafts=true', { cookie: eng })).body.length, 0);
    assert.equal((await call('/firmware?include_drafts=true', { cookie: admin })).body.length, 1);
  });

  test('3. the same (target, version) cannot be uploaded twice; the same file warns', async () => {
    let r = await upload(base('main', '2.1.0'), image(MAIN_CHIP, 300000, 'other'), 'tb.ino.bin');
    assert.equal(r.status, 409); assert.equal(r.body.error, 'duplicate_version');
    r = await upload(base('main', '2.0.9'), image(MAIN_CHIP, 300000, 'main-2.1.0'), 'tb.ino.bin');
    assert.equal(r.status, 201);
    assert.match(r.body.warnings[0], /already uploaded as main 2\.1\.0/);
    // a draft can be deleted (its file stays: 2.1.0 uses the same bytes)
    assert.equal((await call(`/firmware/${r.body.release_id}`, { method: 'DELETE', cookie: admin })).status, 200);
    assert.equal((await call(`/firmware/${ids.main210}/bin`, { cookie: admin })).status, 200);
  });

  test('publish (target must be confirmed when given), then it is immutable', async () => {
    let r = await call(`/firmware/${ids.main210}/publish`, { method: 'POST', cookie: admin, json: { confirm_target: 'n1' } });
    assert.equal(r.body.error, 'target_not_confirmed');
    r = await call(`/firmware/${ids.main210}/publish`, { method: 'POST', cookie: admin, json: { confirm_target: 'main' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.status, 'published');
    assert.match(r.body.published_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal((await call(`/firmware/${ids.main210}/publish`, { method: 'POST', cookie: admin })).body.error, 'not_draft');
    r = await call(`/firmware/${ids.main210}`, { method: 'PATCH', cookie: admin, json: { version: '2.2.0' } });
    assert.equal(r.body.error, 'immutable_field');
    r = await call(`/firmware/${ids.main210}`, { method: 'PATCH', cookie: admin, json: { notes: 'Fix RPM debounce at low PPR.' } });
    assert.equal(r.status, 200); assert.equal(r.body.notes, 'Fix RPM debounce at low PPR.');
    assert.equal((await call(`/firmware/${ids.main210}`, { method: 'DELETE', cookie: admin })).body.error, 'not_draft');
  });

  test('4 + 5. manifest MD5 = md5 of the .bin; .tbfw has exactly manifest.json + one .ino.bin', async () => {
    const bin = await call(`/firmware/${ids.main210}/bin`, { token: engToken });
    assert.equal(bin.status, 200);
    assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
    assert.equal(bin.headers.get('etag'), `"${sha(bin.body)}"`);
    assert.equal(bin.headers.get('content-length'), String(bin.body.length));
    assert.equal(bin.headers.get('content-disposition'), 'attachment; filename="tb-main-2.1.0.ino.bin"');
    const man = await call(`/firmware/${ids.main210}/manifest`, { token: engToken });
    assert.equal(man.status, 200);
    const manifest = man.body;
    assert.deepEqual(Object.keys(manifest), MANIFEST_KEYS);
    assert.equal(manifest.md5, md5(bin.body));
    assert.match(manifest.md5, /^[0-9a-f]{32}$/);
    assert.equal(manifest.product, 'thrust-bench');
    assert.equal(manifest.schema, 1);

    const pkg = await call(`/firmware/${ids.main210}/package`, { token: engToken });
    assert.equal(pkg.status, 200);
    assert.equal(pkg.headers.get('content-disposition'), 'attachment; filename="tb-main-2.1.0.tbfw"');
    const entries = readZip(pkg.body);
    assert.deepEqual(entries.map(e => e.name), ['manifest.json', 'tb-main-2.1.0.ino.bin']);
    const inner = JSON.parse(entries[0].data.toString());
    assert.equal(inner.size, entries[1].data.length);
    assert.equal(inner.md5, md5(entries[1].data));
    assert.equal(inner.sha256, sha(entries[1].data));
    assert.deepEqual(entries[1].data, bin.body);
  });

  test('9. a resumed Range download gives the correct sha256', async () => {
    const whole = await call(`/firmware/${ids.main210}/bin`, { token: engToken });
    const etag = whole.headers.get('etag');
    const first = await call(`/firmware/${ids.main210}/bin`, { token: engToken, headers: { Range: 'bytes=0-99999' } });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get('content-range'), `bytes 0-99999/${whole.body.length}`);
    const rest = await call(`/firmware/${ids.main210}/bin`, { token: engToken, headers: { Range: 'bytes=100000-', 'If-Range': etag } });
    assert.equal(rest.status, 206);
    const joined = Buffer.concat([first.body, rest.body]);
    assert.equal(`"${sha(joined)}"`, etag);
    const bad = await call(`/firmware/${ids.main210}/bin`, { token: engToken, headers: { Range: `bytes=${whole.body.length}-` } });
    assert.equal(bad.status, 416);
    const pkg = await call(`/firmware/${ids.main210}/package`, { token: engToken, headers: { Range: 'bytes=0-9' } });
    assert.equal(pkg.status, 206); assert.equal(pkg.body.length, 10);
  });

  test('every download is logged (resumed parts once)', async () => {
    const logs = (await call('/downloads', { cookie: admin })).body;
    const mine = logs.filter(d => d.user.phone === ENG.phone);
    assert.ok(mine.length >= 4);
    assert.ok(mine.every(d => d.at && d.release_id && d.ip !== undefined));
    assert.equal((await call('/downloads', { cookie: eng })).status, 403);
    const audit = (await call('/audit', { cookie: admin })).body;
    for (const a of ['upload', 'publish', 'download', 'role_change', 'token_create']) assert.ok(audit.some(x => x.action === a), a);
  });

  test('7. compatible-set: same proto, every requires met both ways', async () => {
    const pub = async (fields, chip, seed) => {
      const r = await upload(fields, image(chip, 2048, seed), 'x.ino.bin');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const p = await call(`/firmware/${r.body.release_id}/publish`, { method: 'POST', cookie: admin });
      assert.equal(p.status, 200);
      return r.body.release_id;
    };
    // main 2.1.0 (published above) requires n1 >= 2.1.0, n2 >= 2.0.0, proto 1
    ids.n1_220 = await pub(base('n1', '2.2.0', { channel: 'stable', proto: 2 }), C3, 'n1-220');                   // proto differs
    ids.n1_210 = await pub(base('n1', '2.1.0', { channel: 'stable', requires_n2: '2.0.5' }), C3, 'n1-210');       // needs n2 >= 2.0.5
    ids.n1_200 = await pub(base('n1', '2.0.0', { channel: 'stable' }), C3, 'n1-200');                            // too old for main
    ids.n2_201 = await pub(base('n2', '2.0.1', { channel: 'stable' }), C3, 'n2-201');
    let r = await call('/firmware/compatible-set', { token: engToken });
    assert.equal(r.status, 404, 'n1 2.1.0 needs n2 >= 2.0.5, n1 2.2.0 has proto 2, n1 2.0.0 is too old for main');
    ids.n2_206 = await pub(base('n2', '2.0.6', { channel: 'stable', requires_main: '2.1.0' }), C3, 'n2-206');
    ids.n2_300 = await pub(base('n2', '3.0.0', { channel: 'beta' }), C3, 'n2-300');                              // beta only
    r = await call('/firmware/compatible-set?channel=stable', { token: engToken });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.main.version, r.body.n1.version, r.body.n2.version], ['2.1.0', '2.1.0', '2.0.6']);
    const set = [r.body.main, r.body.n1, r.body.n2];
    for (const a of set) for (const b of set) if (a !== b) assert.ok(fw.compatible(
      { ...a, requires: a.requires }, { ...b, requires: b.requires }), `${a.target}-${b.target}`);

    const zip = await call('/firmware/compatible-set/package', { token: engToken });
    assert.equal(zip.status, 200);
    const names = readZip(zip.body).map(e => e.name);
    assert.deepEqual(names, ['tb-main-2.1.0.tbfw', 'tb-n1-2.1.0.tbfw', 'tb-n2-2.0.6.tbfw']);
    assert.deepEqual(readZip(readZip(zip.body)[1].data).map(e => e.name), ['manifest.json', 'tb-n1-2.1.0.ino.bin']);

    // latest: stable by default, beta on request
    assert.equal((await call('/firmware/latest?target=n2', { token: engToken })).body.version, '2.0.6');
    assert.equal((await call('/firmware/latest?target=n2&channel=beta', { token: engToken })).body.version, '3.0.0');
    assert.equal((await call('/firmware/latest?target=n4', { token: engToken })).body.error, 'invalid_target');
    const list = (await call('/firmware?target=n1', { token: engToken })).body;
    assert.deepEqual(list.map(m => m.version), ['2.2.0', '2.1.0', '2.0.0'], 'newest first');
  });

  test('6. a yanked release leaves latest and compatible-set but stays downloadable by ID', async () => {
    let r = await call(`/firmware/${ids.n2_206}/yank`, { method: 'POST', cookie: admin, json: {} });
    assert.equal(r.body.error, 'reason_required');
    r = await call(`/firmware/${ids.n2_206}/yank`, { method: 'POST', cookie: admin, json: { reason: 'Current sensor reads 2x high' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.status, 'yanked');
    assert.equal(r.body.meta.yank_reason, 'Current sensor reads 2x high');
    assert.equal((await call('/firmware/latest?target=n2', { token: engToken })).body.version, '2.0.1');
    assert.equal((await call('/firmware/compatible-set', { token: engToken })).status, 404);
    assert.ok(!(await call('/firmware?target=n2', { token: engToken })).body.some(m => m.release_id === ids.n2_206));
    assert.ok((await call('/firmware?target=n2&include_yanked=true', { token: engToken })).body.some(m => m.release_id === ids.n2_206));
    const bin = await call(`/firmware/${ids.n2_206}/bin`, { token: engToken });
    assert.equal(bin.status, 200);
    assert.equal(bin.headers.get('x-release-status'), 'yanked');
    assert.equal((await call(`/firmware/${ids.n2_206}/yank`, { method: 'POST', cookie: admin, json: { reason: 'again' } })).body.error, 'already_yanked');
  });

  test('install reports are idempotent and give a per-bench view', async () => {
    const report = {
      bench_mac: '80:b5:4e:c2:a6:1c', release_id: ids.n1_210, target: 'n1', result: 'ok',
      versions_after: { main: '2.1.0', n1: '2.1.0', n2: '2.0.1' }, engineer: 'user-id',
      flashed_at: '2026-11-25T08:10:00Z', dashboard_version: '1.4.0',
    };
    let r = await call('/installs', { method: 'POST', token: engToken, json: report });
    assert.equal(r.status, 201); assert.equal(r.body.duplicate, false);
    const id = r.body.install_id;
    r = await call('/installs', { method: 'POST', token: engToken, json: report });
    assert.equal(r.status, 200); assert.equal(r.body.duplicate, true); assert.equal(r.body.install_id, id);
    r = await call('/installs', { method: 'POST', token: engToken, json: { ...report, target: 'n2' } });
    assert.equal(r.body.error, 'target_mismatch');
    r = await call('/installs', { method: 'POST', token: engToken, json: { ...report, result: 'great' } });
    assert.equal(r.body.error, 'invalid_result');
    r = await call('/installs', { method: 'POST', token: engToken, json: { ...report, flashed_at: '2026-11-25T09:00:00Z', result: 'verify_failed' } });
    assert.equal(r.status, 201);
    const benches = (await call('/benches', { token: engToken })).body;
    assert.equal(benches.length, 1);
    assert.equal(benches[0].bench_mac, '80:B5:4E:C2:A6:1C');
    assert.deepEqual(benches[0].versions, { main: '2.1.0', n1: '2.1.0', n2: '2.0.1' });
    assert.equal(benches[0].reports, 2);
    assert.equal(benches[0].last_report.result, 'verify_failed');
  });

  test('revoking a token and removing the role close access', async () => {
    const mine = (await call('/tokens', { cookie: eng })).body;
    assert.equal(mine.length, 1);
    assert.ok(mine[0].last_used_at);
    let r = await call(`/tokens/${mine[0].id}`, { method: 'DELETE', cookie: admin });
    assert.equal(r.status, 200);
    assert.equal((await call('/firmware', { token: engToken })).status, 401);
    r = await call(`/users/${ENG.phone}`, { method: 'PATCH', cookie: admin, json: { role: 'none' } });
    assert.equal(r.status, 200);
    assert.equal((await call('/firmware', { cookie: eng })).status, 403);
    assert.equal((await call('/firmware/latest?target=main', { cookie: admin })).status, 200);
  });

  test('HTTPS only: a plain-HTTP request through the proxy is refused', async () => {
    const r = await call('/firmware', { cookie: admin, headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'https_required');
    const page = await fetch(`${srv.base}/firmware`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    const me = await fetch(`${srv.base}/api/auth/me`, { headers: { Cookie: admin } });
    assert.equal((await me.json()).user.role, 'admin');
  });
});
