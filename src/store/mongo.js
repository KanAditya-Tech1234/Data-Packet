'use strict';
// MongoDB (Atlas) storage. One client is created at start-up and reused.

const { MongoClient } = require('mongodb');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class DuplicateError extends Error {
  constructor(message) { super(message); this.code = 'DUPLICATE'; }
}

class MongoStore {
  constructor(uri, dbName, { log = console } = {}) {
    this.uri = uri;
    this.dbName = dbName;
    this.log = log;
    this.client = null;
  }

  /** Connect (with retries) and create the indexes. */
  async init({ attempts = 6 } = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        this.client = new MongoClient(this.uri, {
          appName: 'drone-tag-data-packets',
          serverSelectionTimeoutMS: 10000,
          maxPoolSize: 10,
        });
        await this.client.connect();
        await this.client.db(this.dbName).command({ ping: 1 });
        break;
      } catch (err) {
        lastErr = err;
        try { await this.client?.close(); } catch { /* ignore */ }
        this.client = null;
        if (i === attempts) throw new Error(`could not connect to MongoDB after ${attempts} attempts: ${err.message}`);
        const wait = Math.min(2000 * 2 ** (i - 1), 30000);
        this.log.warn(`MongoDB connection attempt ${i} failed (${err.message}); retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
    if (!this.client) throw lastErr;
    const db = this.client.db(this.dbName);
    this.packets = db.collection('packets');
    this.counters = db.collection('counters');
    this.trackers = db.collection('trackers');
    this.users = db.collection('users');
    this.configs = db.collection('configs');
    this.sensors = db.collection('sensors');
    // Before sensors existed a version was unique on its own; now it is unique per sensor.
    try { await this.configs.dropIndex('versionKey_1'); } catch { /* not there */ }
    await Promise.all([
      this.configs.createIndex({ sensorId: 1, versionKey: 1 }, { unique: true }),
      this.packets.createIndex({ seq: 1 }, { unique: true }),
      this.packets.createIndex({ trackerIdLower: 1, seq: 1 }),
      this.users.createIndex({ phone: 1 }, { unique: true }),
    ]);
  }

  async ping() {
    if (!this.client) return false;
    try { await this.client.db(this.dbName).command({ ping: 1 }); return true; } catch { return false; }
  }

  /** Reserve n consecutive sequence numbers in one $inc; returns the first. */
  async reserveSeq(n) {
    const doc = await this.counters.findOneAndUpdate(
      { _id: 'packets' }, { $inc: { seq: n } }, { upsert: true, returnDocument: 'after' });
    return doc.seq - n + 1;
  }

  async insertPackets(docs) {
    await this.packets.insertMany(docs, { ordered: true });
  }

  async findPackets({ trackerLower = null, gt = 0, lte = null, limit = 200, order = 'desc' }) {
    const seq = { $gt: gt };
    if (lte !== null) seq.$lte = lte;
    const q = { seq };
    if (trackerLower) q.trackerIdLower = trackerLower;
    return this.packets.find(q, { projection: { trackerIdLower: 0 } })
      .sort({ seq: order === 'asc' ? 1 : -1 }).limit(limit).toArray();
  }

  async countPackets(trackerLower = null) {
    if (!trackerLower) return this.packets.estimatedDocumentCount();
    return this.packets.countDocuments({ trackerIdLower: trackerLower });
  }

  async maxSeq() {
    const [last] = await this.packets.find({}, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
    return last ? last.seq : 0;
  }

  async deleteUpTo(seq) {
    const r = await this.packets.deleteMany({ seq: { $lte: seq } });
    return r.deletedCount;
  }

  async upsertTrackers(list) {
    if (!list.length) return;
    await this.trackers.bulkWrite(list.map(t => ({
      updateOne: { filter: { _id: t.lower }, update: { $set: { trackerId: t.trackerId, lastSeq: t.lastSeq } }, upsert: true },
    })), { ordered: false });
  }

  async listTrackers() {
    const docs = await this.trackers.find({}, { projection: { trackerId: 1 } }).toArray();
    return docs.map(d => d.trackerId);
  }

  async createUser(user) {
    try {
      await this.users.insertOne(user);
    } catch (err) {
      if (err && err.code === 11000) throw new DuplicateError('phone already registered');
      throw err;
    }
  }

  async findUserByPhone(phone) {
    return this.users.findOne({ phone });
  }

  // ---------- sensors ----------
  async createSensor(sensor) {
    try {
      await this.sensors.insertOne(sensor);
    } catch (err) {
      if (err && err.code === 11000) throw new DuplicateError('sensor already exists');
      throw err;
    }
  }

  async findSensor(id) { return this.sensors.findOne({ _id: id }); }

  async listSensors() { return this.sensors.find({}).sort({ createdAt: 1 }).toArray(); }

  async countSensors() { return this.sensors.countDocuments(); }

  /** Delete a sensor and all of its configuration files. */
  async deleteSensor(id) {
    await this.configs.deleteMany({ sensorId: id });
    const r = await this.sensors.deleteOne({ _id: id });
    return r.deletedCount > 0;
  }

  // ---------- configuration files (each belongs to one sensor) ----------
  static fromConfigDoc(doc) {
    if (!doc) return null;
    if (doc.data && !Buffer.isBuffer(doc.data)) doc.data = Buffer.from(doc.data.buffer ?? doc.data);
    return doc;
  }

  async insertConfig(doc) {
    try {
      await this.configs.insertOne(doc);
    } catch (err) {
      if (err && err.code === 11000) throw new DuplicateError('version already exists');
      throw err;
    }
  }

  /** The sensor's newest version (highest versionKey), or the given one. withData adds the file bytes. */
  async findConfig({ sensorId, versionKey = null, withData = false }) {
    const projection = withData ? {} : { data: 0 };
    const q = versionKey ? { sensorId, versionKey } : { sensorId };
    const [doc] = await this.configs.find(q, { projection }).sort({ versionKey: -1 }).limit(1).toArray();
    return MongoStore.fromConfigDoc(doc || null);
  }

  async listConfigs(sensorId, limit = 50) {
    return this.configs.find({ sensorId }, { projection: { data: 0 } }).sort({ versionKey: -1 }).limit(limit).toArray();
  }

  /** Keep the sensor's newest `keep` versions, delete the rest. */
  async pruneConfigs(sensorId, keep) {
    const [cut] = await this.configs.find({ sensorId }, { projection: { versionKey: 1 } })
      .sort({ versionKey: -1 }).skip(keep).limit(1).toArray();
    if (!cut) return 0;
    const r = await this.configs.deleteMany({ sensorId, versionKey: { $lte: cut.versionKey } });
    return r.deletedCount;
  }

  /**
   * Files uploaded before sensors existed have no sensorId: move them to the given sensor
   * (created if needed). Returns how many were moved.
   */
  async adoptLegacyConfigs(sensor) {
    const n = await this.configs.countDocuments({ sensorId: { $exists: false } });
    if (!n) return 0;
    try { await this.createSensor(sensor); } catch (err) { if (err.code !== 'DUPLICATE') throw err; }
    const r = await this.configs.updateMany({ sensorId: { $exists: false } }, { $set: { sensorId: sensor._id } });
    return r.modifiedCount;
  }

  async dropDatabase() {
    await this.client.db(this.dbName).dropDatabase();
  }

  async close() {
    if (this.client) await this.client.close();
    this.client = null;
  }
}

module.exports = { MongoStore, DuplicateError };
