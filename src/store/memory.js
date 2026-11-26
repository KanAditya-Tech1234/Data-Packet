'use strict';
// In-memory store with the same interface as MongoStore.
// Used ONLY by the automated tests when TEST_MONGODB_URI is not set; the server itself always uses MongoDB.

const { DuplicateError } = require('./mongo');

const clone = o => structuredClone(o);

class MemoryStore {
  constructor() {
    this.packets = [];
    this.counter = 0;
    this.trackers = new Map();
    this.users = new Map();
    this.configs = [];
    this.sensors = new Map();
    this.tokens = [];
    this.releases = [];
    this.fwFiles = new Map();
    this.downloads = [];
    this.audit = [];
    this.installs = [];
    this.up = true;
  }
  async init() {}
  async ping() { return this.up; }
  async reserveSeq(n) { this.counter += n; return this.counter - n + 1; }
  async insertPackets(docs) {
    for (const d of docs) if (this.packets.some(p => p.seq === d.seq)) throw new Error('duplicate seq');
    this.packets.push(...docs.map(clone));
    this.packets.sort((a, b) => a.seq - b.seq);
  }
  async findPackets({ trackerLower = null, gt = 0, lte = null, limit = 200, order = 'desc' }) {
    let list = this.packets.filter(p => p.seq > gt && (lte === null || p.seq <= lte) &&
      (!trackerLower || p.trackerIdLower === trackerLower));
    if (order !== 'asc') list = list.reverse();
    return list.slice(0, limit).map(p => { const { trackerIdLower, ...rest } = clone(p); return rest; });
  }
  async countPackets(trackerLower = null) {
    return trackerLower ? this.packets.filter(p => p.trackerIdLower === trackerLower).length : this.packets.length;
  }
  async maxSeq() { return this.packets.length ? this.packets[this.packets.length - 1].seq : 0; }
  async deleteUpTo(seq) {
    const before = this.packets.length;
    this.packets = this.packets.filter(p => p.seq > seq);
    return before - this.packets.length;
  }
  async upsertTrackers(list) { for (const t of list) this.trackers.set(t.lower, t.trackerId); }
  async listTrackers() { return [...this.trackers.values()]; }
  async createUser(user) {
    if (this.users.has(user.phone)) throw new DuplicateError('phone already registered');
    this.users.set(user.phone, clone(user));
  }
  async findUserByPhone(phone) { const u = this.users.get(phone); return u ? clone(u) : null; }
  async createSensor(sensor) {
    if (this.sensors.has(sensor._id)) throw new DuplicateError('sensor already exists');
    this.sensors.set(sensor._id, clone(sensor));
  }
  async findSensor(id) { const x = this.sensors.get(id); return x ? clone(x) : null; }
  async listSensors() { return [...this.sensors.values()].map(clone).sort((p, q) => p.createdAt - q.createdAt); }
  async countSensors() { return this.sensors.size; }
  async deleteSensor(id) {
    this.configs = this.configs.filter(c => c.sensorId !== id);
    return this.sensors.delete(id);
  }
  async insertConfig(doc) {
    if (this.configs.some(c => c.sensorId === doc.sensorId && c.versionKey === doc.versionKey)) throw new DuplicateError('version already exists');
    this.configs.push({ ...doc, data: Buffer.from(doc.data) });
    this.configs.sort((p, q) => (p.versionKey < q.versionKey ? 1 : -1));   // newest first
  }
  async findConfig({ sensorId, versionKey = null, withData = false }) {
    const doc = this.configs.find(c => c.sensorId === sensorId && (!versionKey || c.versionKey === versionKey));
    if (!doc) return null;
    const { data, ...meta } = doc;
    return withData ? { ...meta, data: Buffer.from(data) } : { ...meta };
  }
  async listConfigs(sensorId, limit = 50) {
    return this.configs.filter(c => c.sensorId === sensorId).slice(0, limit).map(({ data, ...meta }) => ({ ...meta }));
  }
  async pruneConfigs(sensorId, keep) {
    const mine = this.configs.filter(c => c.sensorId === sensorId);
    const drop = new Set(mine.slice(keep));
    this.configs = this.configs.filter(c => !drop.has(c));
    return drop.size;
  }
  async adoptLegacyConfigs(sensor) {
    const legacy = this.configs.filter(c => !c.sensorId);
    if (!legacy.length) return 0;
    if (!this.sensors.has(sensor._id)) this.sensors.set(sensor._id, clone(sensor));
    for (const c of legacy) c.sensorId = sensor._id;
    return legacy.length;
  }
  async listUsers() {
    return [...this.users.values()].map(u => { const { passwordHash, ...rest } = clone(u); return rest; })
      .sort((p, q) => p.createdAt - q.createdAt);
  }
  async setUserRole(phone, role) {
    const u = this.users.get(phone);
    if (!u) return false;
    u.role = role;
    return true;
  }
  async createToken(doc) { this.tokens.push(clone(doc)); }
  async findTokenByHash(tokenHash) { const t = this.tokens.find(x => x.tokenHash === tokenHash && !x.revokedAt); return t ? clone(t) : null; }
  async listTokens(phone = null) {
    return this.tokens.filter(t => !phone || t.phone === phone).map(t => { const { tokenHash, ...rest } = clone(t); return rest; })
      .sort((p, q) => q.createdAt - p.createdAt);
  }
  async findToken(id) { const t = this.tokens.find(x => x._id === id); if (!t) return null; const { tokenHash, ...rest } = clone(t); return rest; }
  async revokeToken(id, at) {
    const t = this.tokens.find(x => x._id === id && !x.revokedAt);
    if (!t) return false;
    t.revokedAt = at;
    return true;
  }
  async revokeTokensOf(phone, at) {
    let n = 0;
    for (const t of this.tokens) if (t.phone === phone && !t.revokedAt) { t.revokedAt = at; n++; }
    return n;
  }
  async touchToken(id, at) { const t = this.tokens.find(x => x._id === id); if (t) t.lastUsedAt = at; }

  async insertRelease(doc) {
    if (this.releases.some(r => r.product === doc.product && r.target === doc.target && r.version === doc.version)) {
      throw new DuplicateError('release already exists');
    }
    this.releases.push(clone(doc));
  }
  async findRelease(id) { const r = this.releases.find(x => x._id === id); return r ? clone(r) : null; }
  async listReleases(product) { return this.releases.filter(r => r.product === product).map(clone); }
  async findReleasesBySha(sha256) { return this.releases.filter(r => r.sha256 === sha256).map(clone); }
  async updateRelease(id, where, set) {
    const r = this.releases.find(x => x._id === id && Object.entries(where).every(([k, v]) => x[k] === v));
    if (!r) return null;
    Object.assign(r, clone(set));
    return clone(r);
  }
  async deleteRelease(id, where = {}) {
    const i = this.releases.findIndex(x => x._id === id && Object.entries(where).every(([k, v]) => x[k] === v));
    if (i < 0) return false;
    this.releases.splice(i, 1);
    return true;
  }
  async putFirmwareFile(sha256, data) { if (!this.fwFiles.has(sha256)) this.fwFiles.set(sha256, Buffer.from(data)); }
  async getFirmwareFile(sha256) { const d = this.fwFiles.get(sha256); return d ? Buffer.from(d) : null; }
  async deleteFirmwareFile(sha256) { this.fwFiles.delete(sha256); }
  async firmwareBytes() {
    let bytes = 0;
    for (const d of this.fwFiles.values()) bytes += d.length;
    return { bytes, files: this.fwFiles.size };
  }
  async insertDownload(doc) { this.downloads.push(clone(doc)); }
  async listDownloads(limit = 200) { return [...this.downloads].sort((p, q) => q.at - p.at).slice(0, limit).map(clone); }
  async insertAudit(doc) { this.audit.push(clone(doc)); }
  async listAudit(limit = 200) { return [...this.audit].sort((p, q) => q.at - p.at).slice(0, limit).map(clone); }
  async insertInstall(doc) {
    if (this.installs.some(i => i.benchMac === doc.benchMac && i.releaseId === doc.releaseId && +i.flashedAt === +doc.flashedAt)) {
      throw new DuplicateError('install already reported');
    }
    this.installs.push(clone(doc));
  }
  async findInstall({ benchMac, releaseId, flashedAt }) {
    const i = this.installs.find(x => x.benchMac === benchMac && x.releaseId === releaseId && +x.flashedAt === +flashedAt);
    return i ? clone(i) : null;
  }
  async listInstalls({ benchMac = null, limit = 500 } = {}) {
    return this.installs.filter(i => !benchMac || i.benchMac === benchMac).sort((p, q) => q.flashedAt - p.flashedAt).slice(0, limit).map(clone);
  }
  async dropDatabase() {
    this.packets = []; this.users.clear(); this.trackers.clear(); this.configs = []; this.sensors.clear(); this.counter = 0;
    this.tokens = []; this.releases = []; this.fwFiles.clear(); this.downloads = []; this.audit = []; this.installs = [];
  }
  async close() {}
}

module.exports = { MemoryStore };
