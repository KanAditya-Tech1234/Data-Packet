'use strict';
// Test helpers: start the app on a random port with a real MongoDB (TEST_MONGODB_URI)
// or, when that is not set, with the in-memory store.

const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { MemoryStore } = require('../src/store/memory');
const { MongoStore } = require('../src/store/mongo');

const quiet = { log() {}, warn() {}, error() {} };

async function startServer({ maxPackets = 100000, adminPhones = [], maxAppSize = { main: 0x1E0000, n1: 0x140000, n2: 0x140000 } } = {}) {
  let store;
  if (process.env.TEST_MONGODB_URI) {
    const db = `drone_packets_test_${crypto.randomBytes(4).toString('hex')}`;
    store = new MongoStore(process.env.TEST_MONGODB_URI, db, { log: quiet });
    await store.init({ attempts: 2 });
  } else {
    store = new MemoryStore();
  }
  const config = { sessionSecret: 'test-secret', maxPackets, adminPhones, maxAppSize };
  const { app, hub } = await createApp({ store, config, log: quiet });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, store, hub,
    async close() {
      hub.closeAll();
      server.closeAllConnections?.();
      await new Promise(r => server.close(r));
      try { await store.dropDatabase(); } catch { /* ignore */ }
      await store.close();
    },
  };
}

const PACKET = { id: '1005', lat: 23.078143, lon: 72.531243, Alt: 16.5, Alt_R: 'AGL', d_x: 0.32, d_y: -0.18, d_z: 0.19 };

async function post(base, body, headers = {}) {
  const res = await fetch(`${base}/api/packet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function getJson(base, path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
  let body = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) body = await res.json(); else body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

/** Open an SSE stream and collect events. */
function openStream(base, path, headers = {}) {
  const controller = new AbortController();
  const events = [];
  let raw = '';
  let waiters = [];
  const check = () => { waiters = waiters.filter(w => (w.test() ? (w.resolve(), false) : true)); };
  const ready = fetch(`${base}${path}`, { headers, signal: controller.signal }).then(async res => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          raw += dec.decode(value, { stream: true });
          let i;
          while ((i = raw.indexOf('\n\n')) >= 0) {
            const block = raw.slice(0, i); raw = raw.slice(i + 2);
            const ev = { comment: [] };
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) ev.comment.push(line.slice(1).trim());
              else { const j = line.indexOf(':'); const k = line.slice(0, j); const v = line.slice(j + 1).replace(/^ /, ''); ev[k] = v; }
            }
            events.push(ev);
            check();
          }
        }
      } catch { /* aborted */ }
    })();
    return res;
  });
  return {
    ready,
    events,
    packets: () => events.filter(e => e.event === 'packet').map(e => ({ id: Number(e.id), data: JSON.parse(e.data) })),
    waitFor(test, ms = 3000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for stream events (have ${events.length})`)), ms);
        waiters.push({ test, resolve: () => { clearTimeout(t); resolve(); } });
        check();
      });
    },
    close() { controller.abort(); },
  };
}

module.exports = { startServer, PACKET, post, getJson, openStream };
