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
  async dropDatabase() { this.packets = []; this.users.clear(); this.trackers.clear(); this.configs = []; this.sensors.clear(); this.counter = 0; }
  async close() {}
}

module.exports = { MemoryStore };
