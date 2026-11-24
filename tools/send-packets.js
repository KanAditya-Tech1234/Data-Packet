#!/usr/bin/env node
'use strict';
// Simulator: sends realistic data packets, like a drone circling over Ahmedabad.
//
//   node tools/send-packets.js --url http://localhost:3000 --id 1005 --interval 1
//
// Options: --url <base>  --id <drone id>  --interval <seconds>  --count <n> (default: forever)
//          --lat <start lat>  --lon <start lon>  --batch <n> (send n packets per request)

function args(argv) {
  const out = { url: 'http://localhost:3000', id: '1005', interval: 1, count: Infinity, lat: 23.078143, lon: 72.531243, batch: 1 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (k === 'help' || k === 'h') { out.help = true; continue; }
    if (!(k in out) || v === undefined) { console.error(`Unknown or incomplete option: ${argv[i]}`); process.exit(2); }
    out[k] = ['url', 'id'].includes(k) ? v : Number(v);
    i++;
  }
  return out;
}

const opt = args(process.argv);
if (opt.help) {
  console.log('Usage: node tools/send-packets.js --url <base> --id <id> --interval <seconds> [--count n] [--batch n]');
  process.exit(0);
}
const base = opt.url.replace(/\/+$/, '');
const pad = n => String(n).padStart(2, '0');
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

let step = 0;
let prev = null;
function nextPacket() {
  // A ~60 m circle with gentle climbs and a little GPS noise.
  const t = step++ * 0.12;
  const r = 0.00055;
  const lat = opt.lat + r * Math.sin(t) + (Math.random() - 0.5) * 0.000004;
  const lon = opt.lon + r * Math.cos(t) * 1.09 + (Math.random() - 0.5) * 0.000004;
  const alt = 15 + 5 * Math.sin(t / 3) + (Math.random() - 0.5) * 0.2;
  const x = (lon - opt.lon) * 102000, y = (lat - opt.lat) * 111000, z = alt;
  if (!prev) prev = { x, y, z };
  const p = {
    id: opt.id,
    lat: Number(lat.toFixed(8)), lon: Number(lon.toFixed(8)),
    Alt: Number(alt.toFixed(2)), Alt_R: 'AGL',
    d_x: Number((x - prev.x).toFixed(2)), d_y: Number((y - prev.y).toFixed(2)), d_z: Number((z - prev.z).toFixed(2)),
    Timestamp: istNow(),
  };
  prev = { x, y, z };
  return p;
}

let sent = 0;
async function tick() {
  const n = Math.max(1, Math.min(100, opt.batch | 0));
  const body = n === 1 ? nextPacket() : Array.from({ length: n }, nextPacket);
  try {
    const res = await fetch(`${base}/api/packet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reply = await res.json().catch(() => ({}));
    sent += n;
    const first = Array.isArray(body) ? body[0] : body;
    console.log(`${new Date().toLocaleTimeString('en-IN')}  ${res.status}  id=${opt.id} lat=${first.lat} lon=${first.lon} alt=${first.Alt}  seq=${reply.seq ?? '-'}` +
      (res.ok ? '' : `  ${reply.message || ''}`));
  } catch (err) {
    console.log(`${new Date().toLocaleTimeString('en-IN')}  failed: ${err.message} (is the server running at ${base}?)`);
  }
  if (sent >= opt.count) return; // nothing left scheduled: the process ends by itself
  setTimeout(tick, Math.max(0.05, opt.interval) * 1000);
}

console.log(`Sending packets for drone ${opt.id} to ${base}/api/packet every ${opt.interval}s (Ctrl+C to stop)`);
tick();
