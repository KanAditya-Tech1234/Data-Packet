'use strict';
// Server-Sent Events hub: one per process (Render runs a single instance).

const { toApi } = require('./packets');

const PING_MS = 25000;
const REPLAY_LIMIT = 5000;

class SseHub {
  constructor() {
    this.clients = new Set();
    this.timer = setInterval(() => this.ping(), PING_MS);
    this.timer.unref();
  }

  get size() { return this.clients.size; }

  ping() {
    for (const c of this.clients) c.res.write(': ping\n\n');
  }

  static frame(doc) {
    return `id: ${doc.seq}\nevent: packet\ndata: ${JSON.stringify(toApi(doc))}\n\n`;
  }

  send(client, doc) {
    if (doc.seq <= client.lastSeq) return;
    if (client.trackerLower && doc.trackerIdLower !== client.trackerLower &&
        (doc.trackerId || '').toLowerCase() !== client.trackerLower) return;
    client.lastSeq = doc.seq;
    client.res.write(SseHub.frame(doc));
  }

  publish(doc) {
    for (const c of this.clients) {
      if (!c.ready) c.pending.push(doc);
      else this.send(c, doc);
    }
  }

  /**
   * Open a stream. Missed packets (seq > since) are replayed first; packets published
   * meanwhile are held back and sent afterwards, so nothing is lost or duplicated.
   */
  async open(req, res, { service, trackerLower, since }) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    if (req.socket) req.socket.setNoDelay(true);

    const client = { res, trackerLower, lastSeq: 0, ready: false, pending: [] };
    this.clients.add(client);
    const cleanup = () => this.clients.delete(client);
    req.on('close', cleanup);
    res.on('error', cleanup);

    try {
      if (since !== null) {
        client.lastSeq = since;
        const { docs } = await service.list({ trackerLower, since, limit: REPLAY_LIMIT });
        for (const d of docs) this.send(client, { ...d, trackerIdLower: d.trackerId.toLowerCase() });
      } else {
        client.lastSeq = service.head;
      }
    } catch {
      res.write(': replay failed, live packets follow\n\n');
    }
    for (const d of client.pending) this.send(client, d);
    client.pending = [];
    client.ready = true;
  }

  closeAll() {
    clearInterval(this.timer);
    for (const c of this.clients) { try { c.res.end(); } catch { /* ignore */ } }
    this.clients.clear();
  }
}

module.exports = { SseHub };
