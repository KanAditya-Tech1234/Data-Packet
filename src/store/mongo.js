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
    await Promise.all([
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

  async dropDatabase() {
    await this.client.db(this.dbName).dropDatabase();
  }

  async close() {
    if (this.client) await this.client.close();
    this.client = null;
  }
}

module.exports = { MongoStore, DuplicateError };
