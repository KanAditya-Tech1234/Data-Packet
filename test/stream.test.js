'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PACKET, post, openStream } = require('./helpers');

describe('live stream (SSE)', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('headers, retry, and live delivery', async () => {
    const s = openStream(srv.base, '/api/packet-stream');
    const res = await s.ready;
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    await s.waitFor(() => s.events.some(e => e.retry === '3000'));
    await new Promise(r => setTimeout(r, 50));

    const sent = await post(srv.base, { ...PACKET, id: 'live-1' });
    await s.waitFor(() => s.packets().length >= 1);
    const [p] = s.packets();
    assert.equal(p.id, sent.body.seq);
    assert.equal(p.data.trackerId, 'live-1');
    assert.equal(p.data.id, sent.body.packetId);
    assert.equal(s.events.find(e => e.event === 'packet').id, String(sent.body.seq));
    s.close();
  });

  test('Last-Event-ID replays missed packets, without duplicates', async () => {
    const a = await post(srv.base, { ...PACKET, id: 'replay', Alt: 1 });
    await post(srv.base, { ...PACKET, id: 'replay', Alt: 2 });
    await post(srv.base, { ...PACKET, id: 'replay', Alt: 3 });
    const s = openStream(srv.base, '/api/packet-stream?since=0&trackerId=replay', { 'Last-Event-ID': String(a.body.seq) });
    await s.ready;
    await s.waitFor(() => s.packets().length >= 2);
    await post(srv.base, { ...PACKET, id: 'replay', Alt: 4 });
    await s.waitFor(() => s.packets().length >= 3);
    await new Promise(r => setTimeout(r, 100));
    const alts = s.packets().map(p => p.data.alt);
    assert.deepEqual(alts, [2, 3, 4]);
    const seqs = s.packets().map(p => p.id);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    s.close();
  });

  test('since= replays newer packets', async () => {
    const a = await post(srv.base, { ...PACKET, id: 'since-q', Alt: 10 });
    await post(srv.base, { ...PACKET, id: 'since-q', Alt: 11 });
    const s = openStream(srv.base, `/api/packet-stream?trackerId=since-q&since=${a.body.seq - 1}`);
    await s.ready;
    await s.waitFor(() => s.packets().length >= 2);
    assert.deepEqual(s.packets().map(p => p.data.alt), [10, 11]);
    s.close();
  });

  test('trackerId filter (case-insensitive)', async () => {
    const s = openStream(srv.base, '/api/packet-stream?trackerId=FILTER-A');
    await s.ready;
    await s.waitFor(() => s.events.some(e => e.retry));
    await new Promise(r => setTimeout(r, 50));
    await post(srv.base, { ...PACKET, id: 'filter-b' });
    await post(srv.base, { ...PACKET, id: 'filter-a', Alt: 5 });
    await post(srv.base, [{ ...PACKET, id: 'filter-b' }, { ...PACKET, id: 'Filter-A', Alt: 6 }]);
    await s.waitFor(() => s.packets().length >= 2);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(s.packets().map(p => p.data.alt), [5, 6]);
    s.close();
  });

  test('invalid trackerId gives a JSON 400', async () => {
    const res = await fetch(`${srv.base}/api/packet-stream?trackerId=${encodeURIComponent('<x>')}`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).status, 'error');
  });

  test('ping comments are sent', async () => {
    const s = openStream(srv.base, '/api/packet-stream');
    await s.ready;
    await s.waitFor(() => s.events.some(e => e.retry));
    srv.hub.ping();
    await s.waitFor(() => s.events.some(e => e.comment.includes('ping')));
    s.close();
  });
});
