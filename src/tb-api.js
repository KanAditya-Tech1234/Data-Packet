'use strict';
// Thrust-bench firmware API, base path /api/tb/v1 (SERVER_OTA_HANDOFF.md §7).
// Login required for everything: a session cookie (web) or "Authorization: Bearer <token>" (dashboard).
// Roles: admin (upload, publish, yank, manage users) and engineer (read and download).
// Errors are always {"error":"<code>","message":"…"}.

const crypto = require('node:crypto');
const express = require('express');
const Busboy = require('busboy');
const fw = require('./firmware');
const { createZip } = require('./zip');
const { sendBytes } = require('./send-bytes');

const ROLES = ['admin', 'engineer', 'none'];
const ID_RE = /^[0-9a-f]{24}$/;
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const RESULTS = ['ok', 'verify_failed', 'aborted', 'timeout'];
const MAX_TOKENS_PER_USER = 20;
const FREE_TIER_BYTES = 512 * 1024 * 1024;

/** The role a user has: ADMIN_PHONES are always admin; otherwise what an admin set (default none). */
function roleOf(user, config) {
  if (!user) return 'none';
  if ((config.adminPhones || []).includes(user.phone)) return 'admin';
  return user.role === 'admin' || user.role === 'engineer' ? user.role : 'none';
}

const hashToken = token => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

class TbError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const tbError = (res, status, code, message) => res.status(status).set('Cache-Control', 'no-store').json({ error: code, message });

function createTbRouter({ store, config: appConfig, log = console }) {
  const config = { ...appConfig, maxAppSize: appConfig.maxAppSize || { main: 0x1E0000, n1: 0x140000, n2: 0x140000 } };
  const router = express.Router();
  const maxUpload = Math.max(...Object.values(config.maxAppSize));
  const lastTouch = new Map();

  // HTTPS only: a request that reached the proxy over plain HTTP is refused (Render redirects pages itself).
  router.use((req, res, next) => {
    if (String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'http') {
      return tbError(res, 403, 'https_required', 'use https:// for the firmware API');
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  // ---------- who is calling ----------
  router.use(async (req, res, next) => {
    try {
      const authz = req.get('authorization');
      if (authz) {
        const m = /^Bearer\s+(\S{20,200})$/i.exec(authz.trim());
        if (!m) return tbError(res, 401, 'unauthorized', 'the Authorization header must be "Bearer <token>"');
        const tok = await store.findTokenByHash(hashToken(m[1]));
        const user = tok ? await store.findUserByPhone(tok.phone) : null;
        if (!tok || !user) return tbError(res, 401, 'unauthorized', 'this API token is not valid or was revoked');
        req.tb = { name: user.name, phone: user.phone, role: roleOf(user, config), via: 'token', tokenId: tok._id };
        const now = Date.now();
        if ((lastTouch.get(tok._id) || 0) < now - 60000) {
          lastTouch.set(tok._id, now);
          store.touchToken(tok._id, new Date(now)).catch(() => {});
        }
      } else if (req.user) {
        req.tb = { name: req.user.name, phone: req.user.phone, role: req.user.role, via: 'session' };
      } else {
        return tbError(res, 401, 'unauthorized', 'log in, or send "Authorization: Bearer <token>"');
      }
      if (req.tb.role === 'none') {
        return tbError(res, 403, 'forbidden', 'your account has no firmware access: ask an admin to make you an engineer');
      }
      next();
    } catch (err) { next(err); }
  });

  const adminOnly = (req, res, next) => (req.tb.role === 'admin' ? next()
    : tbError(res, 403, 'forbidden', 'only an admin can do this'));
  const sessionOnly = (req, res, next) => (req.tb.via === 'session' ? next()
    : tbError(res, 403, 'forbidden', 'API tokens cannot manage tokens or users: log in on the website'));
  const isAdmin = req => req.tb.role === 'admin';
  const who = req => ({ name: req.tb.name, phone: req.tb.phone });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  async function audit(req, action, releaseId, details = {}) {
    try {
      await store.insertAudit({
        _id: crypto.randomBytes(12).toString('hex'), at: new Date(), action, releaseId: releaseId || null,
        user: who(req), via: req.tb.via, ip: req.ip || '', details,
      });
    } catch (err) { log.error('audit log write failed:', err.message); }
  }

  // ---------- helpers ----------
  const boolParam = v => v === 'true' || v === '1' || v === 'yes';
  function channelParam(v, fallback) {
    if (v === undefined || v === '') return fallback;
    if (!fw.CHANNELS.includes(v)) throw new TbError(400, 'invalid_channel', 'channel must be stable or beta');
    return v;
  }
  function targetParam(v, required) {
    if (v === undefined || v === '') {
      if (required) throw new TbError(400, 'invalid_target', 'target is required: main, n1 or n2');
      return null;
    }
    if (!fw.TARGETS.includes(v)) throw new TbError(400, 'invalid_target', 'target must be main, n1 or n2');
    return v;
  }
  /** stable = stable only; beta = beta and stable (the beta toggle adds beta releases); null = any. */
  const inChannel = (rel, channel) => !channel || channel === 'beta' || rel.channel === channel;
  const newestFirst = (a, b) => (a.versionKey !== b.versionKey ? (a.versionKey < b.versionKey ? 1 : -1)
    : fw.TARGETS.indexOf(a.target) - fw.TARGETS.indexOf(b.target));

  async function releases({ target = null, channel = null, statuses = ['published'] } = {}) {
    const all = await store.listReleases(fw.PRODUCT);
    return all.filter(r => statuses.includes(r.status) && (!target || r.target === target) && inChannel(r, channel)).sort(newestFirst);
  }

  /** A release by ID; drafts only for admins. */
  async function releaseFrom(req) {
    const id = String(req.params.id || '');
    const rel = ID_RE.test(id) ? await store.findRelease(id) : null;
    if (!rel || rel.product !== fw.PRODUCT || (rel.status === 'draft' && !isAdmin(req))) {
      throw new TbError(404, 'not_found', `no firmware release with ID "${id}"`);
    }
    return rel;
  }

  const view = (req, rel) => fw.toApi(rel, { admin: isAdmin(req) });

  // ---------- 7.1 list and query ----------
  router.get('/firmware', wrap(async (req, res) => {
    const target = targetParam(req.query.target, false);
    const channel = channelParam(req.query.channel, null);
    const statuses = ['published'];
    if (boolParam(req.query.include_yanked)) statuses.push('yanked');
    if (boolParam(req.query.include_drafts) && isAdmin(req)) statuses.push('draft');
    res.json((await releases({ target, channel, statuses })).map(r => view(req, r)));
  }));

  router.get('/firmware/latest', wrap(async (req, res) => {
    const target = targetParam(req.query.target, true);
    const channel = channelParam(req.query.channel, 'stable');
    const [rel] = await releases({ target, channel });
    if (!rel) throw new TbError(404, 'not_found', `no ${channel} release for target ${target}`);
    res.json(view(req, rel));
  }));

  async function compatibleSetFor(req) {
    const channel = channelParam(req.query.channel, 'stable');
    const set = fw.compatibleSet(await releases({ channel }));
    if (!set) throw new TbError(404, 'not_found', `no compatible set of main, n1 and n2 ${channel === 'stable' ? 'stable ' : ''}releases (same proto and all requires met)`);
    return set;
  }

  router.get('/firmware/compatible-set', wrap(async (req, res) => {
    const set = await compatibleSetFor(req);
    res.json({ main: view(req, set.main), n1: view(req, set.n1), n2: view(req, set.n2) });
  }));

  // ---------- 7.2 downloads ----------
  async function imageOf(rel) {
    const data = await store.getFirmwareFile(rel.sha256);
    if (!data) throw new TbError(500, 'file_missing', 'the firmware file is missing on the server: tell an admin');
    return data;
  }
  async function packageOf(rel) {
    const data = await imageOf(rel);
    return createZip([
      { name: 'manifest.json', data: fw.manifestBytes(rel) },
      { name: fw.canonicalFile(rel.target, rel.version), data },
    ], rel.publishedAt || rel.uploadedAt);
  }

  async function logDownload(req, rels, kind, sent) {
    // A resumed download (Range starting after byte 0) is the same download: log it once.
    if (!(sent.status === 200 || (sent.status === 206 && sent.start === 0))) return;
    const at = new Date();
    for (const rel of rels) {
      try {
        await store.insertDownload({
          _id: crypto.randomBytes(12).toString('hex'), releaseId: rel._id, target: rel.target, version: rel.version,
          kind, user: who(req), via: req.tb.via, at, ip: req.ip || '',
        });
      } catch (err) { log.error('download log write failed:', err.message); }
    }
    await audit(req, 'download', rels.length === 1 ? rels[0]._id : null,
      { kind, releases: rels.map(r => ({ release_id: r._id, target: r.target, version: r.version })) });
  }

  const statusHeader = rel => ({ 'X-Release-Id': rel._id, 'X-Release-Status': rel.status });

  router.get('/firmware/compatible-set/package', wrap(async (req, res) => {
    const set = await compatibleSetFor(req);
    const list = [set.main, set.n1, set.n2];
    const entries = [];
    for (const rel of list) entries.push({ name: fw.packageName(rel.target, rel.version), data: await packageOf(rel) });
    const zip = createZip(entries, list.map(r => r.publishedAt).sort().pop());
    const name = `tb-set-main-${set.main.version}-n1-${set.n1.version}-n2-${set.n2.version}.zip`;
    const sent = sendBytes(req, res, zip, { contentType: 'application/zip', fileName: name });
    await logDownload(req, list, 'set', sent);
  }));

  router.get('/firmware/:id', wrap(async (req, res) => { res.json(view(req, await releaseFrom(req))); }));

  router.get('/firmware/:id/package', wrap(async (req, res) => {
    const rel = await releaseFrom(req);
    const zip = await packageOf(rel);
    const sent = sendBytes(req, res, zip, { contentType: 'application/zip', fileName: fw.packageName(rel.target, rel.version), extraHeaders: statusHeader(rel) });
    await logDownload(req, [rel], 'package', sent);
  }));

  router.get('/firmware/:id/bin', wrap(async (req, res) => {
    const rel = await releaseFrom(req);
    const data = await imageOf(rel);
    const sent = sendBytes(req, res, data, {
      contentType: 'application/octet-stream', fileName: fw.canonicalFile(rel.target, rel.version), sha256: rel.sha256,
      extraHeaders: { ...statusHeader(rel), 'X-Firmware-MD5': rel.md5 },
    });
    await logDownload(req, [rel], 'bin', sent);
  }));

  router.get('/firmware/:id/manifest', wrap(async (req, res) => {
    const rel = await releaseFrom(req);
    const sent = sendBytes(req, res, fw.manifestBytes(rel), { contentType: 'application/json', fileName: 'manifest.json', extraHeaders: statusHeader(rel) });
    await logDownload(req, [rel], 'manifest', sent);
  }));

  // ---------- 7.3 admin ----------
  /** multipart/form-data: the §3 fields plus "file". */
  function readUpload(req) {
    return new Promise((resolve, reject) => {
      let bb;
      try {
        bb = Busboy({ headers: req.headers, limits: { fileSize: maxUpload + 1, files: 1, fields: 30, fieldSize: 16 * 1024 } });
      } catch {
        return reject(new TbError(400, 'bad_request', 'send multipart/form-data with the release fields and the .bin file'));
      }
      const fields = {};
      let file = null;
      let tooBig = false;
      let tooMany = false;
      bb.on('field', (name, value) => { fields[name] = value; });
      bb.on('file', (name, stream, info) => {
        if (name !== 'file') { stream.resume(); return; }
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('limit', () => { tooBig = true; });
        stream.on('end', () => { file = { name: info.filename || '', data: Buffer.concat(chunks) }; });
      });
      bb.on('filesLimit', () => { tooMany = true; });
      bb.on('error', () => reject(new TbError(400, 'bad_request', 'the upload could not be read')));
      bb.on('close', () => {
        if (tooMany) return reject(new TbError(400, 'bad_request', 'upload one .bin file per release'));
        resolve({ fields, file, tooBig });
      });
      req.pipe(bb);
    });
  }

  router.post('/firmware', adminOnly, wrap(async (req, res) => {
    if (!/^multipart\/form-data/i.test(req.get('content-type') || '')) {
      throw new TbError(415, 'bad_request', 'send multipart/form-data with the release fields and the .bin file in "file"');
    }
    const { fields, file, tooBig } = await readUpload(req);
    const f = fw.validateFields(fields);
    if (!file) throw new TbError(400, 'file_required', 'choose the .ino.bin file to upload (form field "file")');
    if (tooBig) throw new TbError(413, 'too_large', `the image is larger than ${config.maxAppSize[f.target]} bytes, the OTA app slot of ${f.target}`);
    const img = fw.inspectImage({ fileName: file.name, data: file.data, target: f.target, maxSize: config.maxAppSize[f.target] });

    const warnings = [];
    const same = (await store.findReleasesBySha(img.sha256)).filter(r => r.product === fw.PRODUCT);
    if (same.length) {
      warnings.push(`the same file (SHA-256) is already uploaded as ${same.map(r => `${r.target} ${r.version}`).join(', ')}`);
    }
    const now = new Date();
    const doc = {
      _id: fw.newReleaseId(), product: fw.PRODUCT, target: f.target, version: f.version, versionKey: f.versionKey,
      proto: f.proto, requires: f.requires, channel: f.channel, status: 'draft', yankReason: null, yankedAt: null,
      size: img.size, md5: img.md5, sha256: img.sha256, chipId: img.chipId, builtWith: f.builtWith, notes: f.notes,
      originalFileName: fw.cleanName(file.name), uploadedBy: req.tb.name, uploadedByPhone: req.tb.phone,
      uploadedAt: now, publishedAt: null, sameShaAs: same.map(r => ({ release_id: r._id, target: r.target, version: r.version })),
    };
    await store.putFirmwareFile(img.sha256, file.data);
    try {
      await store.insertRelease(doc);
    } catch (err) {
      if (!same.length) await store.deleteFirmwareFile(img.sha256).catch(() => {});
      if (err.code === 'DUPLICATE') throw new TbError(409, 'duplicate_version', `${f.target} ${f.version} already exists: use a new version number`);
      throw err;
    }
    await audit(req, 'upload', doc._id, { target: doc.target, version: doc.version, size: doc.size, sha256: doc.sha256, file: doc.originalFileName });
    log.log(`Firmware ${doc.target} ${doc.version} uploaded as a draft by ${req.tb.name}`);
    res.status(201).json({ ...view(req, doc), warnings });
  }));

  const jsonBody = express.json({ limit: '20kb', type: () => true });
  const bodyOf = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  router.post('/firmware/:id/publish', adminOnly, jsonBody, wrap(async (req, res) => {
    const rel = await releaseFrom(req);
    const confirm = bodyOf(req).confirm_target;
    if (confirm !== undefined && confirm !== rel.target) {
      throw new TbError(400, 'target_not_confirmed', `this release is for target ${rel.target}, not ${confirm}`);
    }
    if (rel.status !== 'draft') throw new TbError(409, 'not_draft', `this release is already ${rel.status}`);
    const done = await store.updateRelease(rel._id, { status: 'draft' }, { status: 'published', publishedAt: new Date() });
    if (!done) throw new TbError(409, 'not_draft', 'this release is no longer a draft');
    await audit(req, 'publish', rel._id, { target: rel.target, version: rel.version, channel: rel.channel });
    log.log(`Firmware ${rel.target} ${rel.version} published by ${req.tb.name}`);
    res.json(view(req, done));
  }));

  router.post('/firmware/:id/yank', adminOnly, jsonBody, wrap(async (req, res) => {
    const rel = await releaseFrom(req);
    const reason = typeof bodyOf(req).reason === 'string' ? bodyOf(req).reason.trim() : '';
    if (!reason) throw new TbError(400, 'reason_required', 'give the reason for yanking: {"reason":"…"}');
    if (reason.length > 500) throw new TbError(400, 'reason_too_long', 'the reason must be at most 500 characters');
    if (rel.status === 'draft') throw new TbError(409, 'not_published', 'a draft cannot be yanked: delete it instead');
    if (rel.status === 'yanked') throw new TbError(409, 'already_yanked', 'this release is already yanked');
    const done = await store.updateRelease(rel._id, { status: 'published' }, { status: 'yanked', yankReason: reason, yankedAt: new Date() });
    if (!done) throw new TbError(409, 'not_published', 'this release is no longer published');
    await audit(req, 'yank', rel._id, { target: rel.target, version: rel.version, reason });
    log.log(`Firmware ${rel.target} ${rel.version} yanked by ${req.tb.name}: ${reason}`);
    res.json(view(req, done));
  }));

  router.patch('/firmware/:id', adminOnly, jsonBody, wrap(async (req, res) => {
    const rel = await releaseFrom(req);
    const body = bodyOf(req);
    const keys = Object.keys(body);
    const bad = keys.filter(k => k !== 'channel' && k !== 'notes');
    if (bad.length) {
      throw new TbError(400, 'immutable_field', `only channel and notes can be changed (not ${bad.join(', ')}); to change anything else, yank this release and upload a new version`);
    }
    if (!keys.length) throw new TbError(400, 'bad_request', 'send {"channel":"stable"} and/or {"notes":"…"}');
    const set = {};
    if ('channel' in body) {
      if (!fw.CHANNELS.includes(body.channel)) throw new TbError(400, 'invalid_channel', 'channel must be stable or beta');
      set.channel = body.channel;
    }
    if ('notes' in body) set.notes = fw.checkNotes(body.notes);
    const done = await store.updateRelease(rel._id, {}, set);
    await audit(req, 'update', rel._id, { target: rel.target, version: rel.version, changed: Object.keys(set), from: { channel: rel.channel } });
    res.json(view(req, done));
  }));

  router.delete('/firmware/:id', adminOnly, wrap(async (req, res) => {
    const rel = await releaseFrom(req);
    if (rel.status !== 'draft') {
      throw new TbError(409, 'not_draft', 'published releases are never deleted: yank it instead');
    }
    if (!(await store.deleteRelease(rel._id, { status: 'draft' }))) throw new TbError(409, 'not_draft', 'this release is no longer a draft');
    if (!(await store.findReleasesBySha(rel.sha256)).length) await store.deleteFirmwareFile(rel.sha256);
    await audit(req, 'delete_draft', rel._id, { target: rel.target, version: rel.version });
    res.json({ deleted: rel._id });
  }));

  // ---------- 7.4 install reports ----------
  router.post('/installs', jsonBody, wrap(async (req, res) => {
    const b = bodyOf(req);
    const bad = (code, message) => { throw new TbError(400, code, message); };
    if (typeof b.bench_mac !== 'string' || !MAC_RE.test(b.bench_mac.trim())) bad('invalid_bench_mac', 'bench_mac must be a MAC address such as 80:B5:4E:C2:A6:1C');
    const benchMac = b.bench_mac.trim().toUpperCase().replace(/-/g, ':');
    if (typeof b.release_id !== 'string' || !ID_RE.test(b.release_id)) bad('invalid_release_id', 'release_id must be the release_id from the manifest');
    if (!fw.TARGETS.includes(b.target)) bad('invalid_target', 'target must be main, n1 or n2');
    if (!RESULTS.includes(b.result)) bad('invalid_result', `result must be one of ${RESULTS.join(', ')}`);
    const versionsAfter = {};
    if (b.versions_after !== undefined) {
      if (!b.versions_after || typeof b.versions_after !== 'object' || Array.isArray(b.versions_after)) bad('invalid_versions_after', 'versions_after must be an object such as {"main":"2.1.0"}');
      for (const [k, v] of Object.entries(b.versions_after)) {
        if (!fw.TARGETS.includes(k)) bad('invalid_versions_after', `versions_after: unknown target "${k}"`);
        const p = fw.parseSemver(String(v));
        if (!p) bad('invalid_versions_after', `versions_after.${k} ${fw.SEMVER_HELP}`);
        versionsAfter[k] = p.version;
      }
    }
    const flashedAt = typeof b.flashed_at === 'string' ? new Date(b.flashed_at) : null;
    if (!flashedAt || Number.isNaN(flashedAt.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(b.flashed_at)) bad('invalid_flashed_at', 'flashed_at must be an ISO 8601 time such as 2026-11-25T08:10:00Z');
    if (flashedAt.getTime() > Date.now() + 24 * 3600e3) bad('invalid_flashed_at', 'flashed_at is in the future');
    const text = (v, n, name) => {
      if (v === undefined || v === null) return '';
      if (typeof v !== 'string' || v.length > n || /[\u0000-\u001f]/.test(v)) bad(`invalid_${name}`, `${name} must be text of at most ${n} characters`);
      return v.trim();
    };
    const engineer = text(b.engineer, 100, 'engineer');
    const dashboardVersion = text(b.dashboard_version, 40, 'dashboard_version');

    const rel = await store.findRelease(b.release_id);
    if (!rel || rel.product !== fw.PRODUCT) throw new TbError(422, 'unknown_release', `no firmware release with ID "${b.release_id}"`);
    if (rel.target !== b.target) throw new TbError(422, 'target_mismatch', `release ${b.release_id} is for ${rel.target}, not ${b.target}`);

    const key = { benchMac, releaseId: rel._id, flashedAt };
    const existing = await store.findInstall(key);
    if (existing) return res.status(200).json({ install_id: existing._id, duplicate: true });
    const doc = {
      _id: crypto.randomBytes(12).toString('hex'), ...key, target: rel.target, version: rel.version, result: b.result,
      versionsAfter, engineer, dashboardVersion, reportedBy: who(req), receivedAt: new Date(),
    };
    try { await store.insertInstall(doc); } catch (err) {
      if (err.code !== 'DUPLICATE') throw err;
      const again = await store.findInstall(key);
      return res.status(200).json({ install_id: again ? again._id : null, duplicate: true });
    }
    await audit(req, 'install_report', rel._id, { bench_mac: benchMac, result: b.result });
    res.status(201).json({ install_id: doc._id, duplicate: false });
  }));

  const installApi = i => ({
    install_id: i._id, bench_mac: i.benchMac, release_id: i.releaseId, target: i.target, version: i.version, result: i.result,
    versions_after: i.versionsAfter || {}, engineer: i.engineer || '', reported_by: i.reportedBy?.name || '',
    flashed_at: fw.isoSeconds(i.flashedAt), dashboard_version: i.dashboardVersion || '', received_at: fw.isoSeconds(i.receivedAt),
  });

  router.get('/installs', wrap(async (req, res) => {
    let benchMac = null;
    if (req.query.bench_mac) {
      if (!MAC_RE.test(String(req.query.bench_mac))) throw new TbError(400, 'invalid_bench_mac', 'bench_mac must be a MAC address');
      benchMac = String(req.query.bench_mac).toUpperCase().replace(/-/g, ':');
    }
    res.json((await store.listInstalls({ benchMac, limit: 500 })).map(installApi));
  }));

  /** What is installed where: per bench, the versions after its newest successful install. */
  router.get('/benches', wrap(async (req, res) => {
    const list = await store.listInstalls({ limit: 5000 });
    const benches = new Map();
    for (const i of list) {     // newest first
      let b = benches.get(i.benchMac);
      if (!b) { b = { bench_mac: i.benchMac, versions: null, last_ok_at: null, last_report: installApi(i), reports: 0 }; benches.set(i.benchMac, b); }
      b.reports += 1;
      if (!b.versions && i.result === 'ok') { b.versions = { ...(i.versionsAfter || {}), [i.target]: i.version }; b.last_ok_at = fw.isoSeconds(i.flashedAt); }
    }
    res.json([...benches.values()]);
  }));

  // ---------- me, tokens, users ----------
  router.get('/me', (req, res) => res.json({ name: req.tb.name, phone: req.tb.phone, role: req.tb.role, auth: req.tb.via }));

  router.get('/limits', wrap(async (req, res) => {
    const out = { max_app_size: { ...config.maxAppSize }, notes_max: fw.NOTES_MAX, targets: fw.TARGETS, target_chip_id: fw.TARGET_CHIP };
    if (isAdmin(req)) out.storage = { ...(await store.firmwareBytes()), free_tier_bytes: FREE_TIER_BYTES };
    res.json(out);
  }));

  const tokenApi = (t, names) => ({
    id: t._id, label: t.label, created_at: fw.isoSeconds(t.createdAt), last_used_at: fw.isoSeconds(t.lastUsedAt),
    revoked_at: fw.isoSeconds(t.revokedAt), ...(names ? { user: { name: names.get(t.phone) || '', phone: t.phone } } : {}),
  });

  router.get('/tokens', sessionOnly, wrap(async (req, res) => {
    if (boolParam(req.query.all)) {
      if (!isAdmin(req)) throw new TbError(403, 'forbidden', 'only an admin can see everyone\'s tokens');
      const names = new Map((await store.listUsers()).map(u => [u.phone, u.name]));
      return res.json((await store.listTokens(null)).map(t => tokenApi(t, names)));
    }
    res.json((await store.listTokens(req.tb.phone)).map(t => tokenApi(t)));
  }));

  router.post('/tokens', sessionOnly, jsonBody, wrap(async (req, res) => {
    const label = typeof bodyOf(req).label === 'string' ? bodyOf(req).label.trim() : '';
    if (label.length < 1 || label.length > 60 || /[\u0000-\u001f]/.test(label)) {
      throw new TbError(400, 'invalid_label', 'give the token a name of 1-60 characters, e.g. "Field laptop 2"');
    }
    const active = (await store.listTokens(req.tb.phone)).filter(t => !t.revokedAt);
    if (active.length >= MAX_TOKENS_PER_USER) throw new TbError(400, 'too_many_tokens', `at most ${MAX_TOKENS_PER_USER} active tokens per user: revoke an old one`);
    const token = `tbt_${crypto.randomBytes(32).toString('base64url')}`;
    const doc = { _id: crypto.randomBytes(8).toString('hex'), tokenHash: hashToken(token), phone: req.tb.phone, label, createdAt: new Date(), lastUsedAt: null, revokedAt: null };
    await store.createToken(doc);
    await audit(req, 'token_create', null, { token_id: doc._id, label });
    res.status(201).json({ ...tokenApi(doc), token });
  }));

  router.delete('/tokens/:tokenId', sessionOnly, wrap(async (req, res) => {
    const t = /^[0-9a-f]{16}$/.test(req.params.tokenId) ? await store.findToken(req.params.tokenId) : null;
    if (!t || (t.phone !== req.tb.phone && !isAdmin(req))) throw new TbError(404, 'not_found', 'no such token');
    if (t.revokedAt) throw new TbError(409, 'already_revoked', 'this token is already revoked');
    await store.revokeToken(t._id, new Date());
    await audit(req, 'token_revoke', null, { token_id: t._id, label: t.label, owner: t.phone });
    res.json({ revoked: t._id });
  }));

  router.get('/users', sessionOnly, adminOnly, wrap(async (req, res) => {
    const users = await store.listUsers();
    const tokens = await store.listTokens(null);
    res.json(users.map(u => ({
      name: u.name, phone: u.phone, email: u.email, role: roleOf(u, config),
      role_fixed: (config.adminPhones || []).includes(u.phone), created_at: fw.isoSeconds(u.createdAt),
      active_tokens: tokens.filter(t => t.phone === u.phone && !t.revokedAt).length,
    })));
  }));

  router.patch('/users/:phone', sessionOnly, adminOnly, jsonBody, wrap(async (req, res) => {
    const role = bodyOf(req).role;
    if (!ROLES.includes(role)) throw new TbError(400, 'invalid_role', 'role must be admin, engineer or none');
    const phone = String(req.params.phone || '');
    const user = /^\d{10}$/.test(phone) ? await store.findUserByPhone(phone) : null;
    if (!user) throw new TbError(404, 'not_found', 'no user with that mobile number');
    if (phone === req.tb.phone) throw new TbError(409, 'own_role', 'you cannot change your own role');
    if ((config.adminPhones || []).includes(phone)) throw new TbError(409, 'role_fixed', 'this user is an admin through ADMIN_PHONES on the server');
    const before = roleOf(user, config);
    await store.setUserRole(phone, role);
    let revoked = 0;
    if (role === 'none') revoked = await store.revokeTokensOf(phone, new Date());
    await audit(req, 'role_change', null, { user: { name: user.name, phone }, from: before, to: role, tokens_revoked: revoked });
    res.json({ phone, role, tokens_revoked: revoked });
  }));

  // ---------- logs (admin) ----------
  const limitParam = v => Math.min(Math.max(parseInt(v, 10) || 200, 1), 1000);
  router.get('/downloads', adminOnly, wrap(async (req, res) => {
    res.json((await store.listDownloads(limitParam(req.query.limit))).map(d => ({
      at: fw.isoSeconds(d.at), user: d.user, via: d.via, release_id: d.releaseId, target: d.target, version: d.version, kind: d.kind, ip: d.ip,
    })));
  }));
  router.get('/audit', adminOnly, wrap(async (req, res) => {
    res.json((await store.listAudit(limitParam(req.query.limit))).map(a => ({
      at: fw.isoSeconds(a.at), action: a.action, user: a.user, via: a.via, release_id: a.releaseId, details: a.details, ip: a.ip,
    })));
  }));

  router.use((req, res) => tbError(res, 404, 'not_found', `no such endpoint: ${req.method} ${req.baseUrl}${req.path}`));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (res.headersSent) { res.end(); return; }
    if (err instanceof TbError || err instanceof fw.FirmwareError) return tbError(res, err.status, err.code, err.message);
    if (err.type === 'entity.too.large') return tbError(res, 413, 'too_large', 'the body is too large');
    if (err.type === 'entity.parse.failed') return tbError(res, 400, 'bad_json', 'the body is not valid JSON');
    log.error('Firmware API request failed:', req.method, req.originalUrl, '-', err.message);
    tbError(res, 503, 'server_error', 'the server could not complete the request; try again');
  });

  return router;
}

module.exports = { createTbRouter, roleOf, hashToken };
