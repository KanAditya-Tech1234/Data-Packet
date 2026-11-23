'use strict';
// Packet storage logic on top of a store: sequence numbers, pruning, live publishing.

const crypto = require('node:crypto');
const { finalizeTimes } = require('./packets');

class PacketService {
  /**
   * @param {object} store  MongoStore or MemoryStore
   * @param {object} hub    SSE hub with publish(doc)
   * @param {number} maxPackets
   */
  constructor(store, hub, maxPackets) {
    this.store = store;
    this.hub = hub;
    this.maxPackets = maxPackets;
    this.head = 0;               // highest seq whose packet is fully stored (visible to readers)
    this.trackers = new Map();   // lower-case id -> id as first seen
    this.queue = Promise.resolve();
  }

  async init() {
    this.head = await this.store.maxSeq();
    for (const id of await this.store.listTrackers()) this.trackers.set(id.toLowerCase(), id);
  }

  trackerList() {
    return [...this.trackers.values()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  /**
   * Store validated packets. Inserts run one after another so that sequence numbers
   * become visible strictly in order (readers and the live stream never skip one).
   */
  insert(packets) {
    const run = this.queue.then(() => this._insert(packets));
    this.queue = run.catch(() => {});
    return run;
  }

  async _insert(packets) {
    const receivedAt = new Date();
    const first = await this.store.reserveSeq(packets.length);
    const docs = packets.map((p, i) => {
      const doc = finalizeTimes(p, receivedAt);
      return { _id: crypto.randomBytes(12).toString('hex'), seq: first + i, ...doc, trackerIdLower: p.trackerId.toLowerCase() };
    });
    await this.store.insertPackets(docs);
    this.head = docs[docs.length - 1].seq;

    const newTrackers = new Map();
    for (const d of docs) {
      const prev = this.trackers.get(d.trackerIdLower);
      newTrackers.set(d.trackerIdLower, { lower: d.trackerIdLower, trackerId: prev || d.trackerId, lastSeq: d.seq });
      if (!prev) this.trackers.set(d.trackerIdLower, d.trackerId);
    }
    try { await this.store.upsertTrackers([...newTrackers.values()]); } catch { /* list is rebuilt from memory */ }

    // Keep at most maxPackets: delete the oldest (by seq). Gaps in seq only make the count smaller.
    const cut = this.head - this.maxPackets;
    if (cut > 0) { try { await this.store.deleteUpTo(cut); } catch { /* retried on the next insert */ } }

    for (const d of docs) this.hub.publish(d);
    return docs;
  }

  /** Newest `limit` packets with seq > since (and <= head), returned oldest first. */
  async list({ trackerLower = null, since = 0, limit = 200 }) {
    const head = this.head;
    const docs = await this.store.findPackets({ trackerLower, gt: since, lte: head, limit, order: 'desc' });
    return { head, docs: docs.reverse() };
  }

  count(trackerLower = null) { return this.store.countPackets(trackerLower); }
}

module.exports = { PacketService };
