'use strict';
// Validation and normalisation of incoming data packets.

const { parseDeviceTime, believable } = require('./time');

const MAX_BATCH = 100;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NUMBER_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Field names are compared ignoring case, spaces, "_" and "-". */
const normKey = k => String(k).toLowerCase().replace(/[\s_-]+/g, '');

// normalised alias -> canonical field
const ALIASES = {
  id: 'id', trackerid: 'id',
  lat: 'lat', latitude: 'lat',
  lon: 'lon', long: 'lon', longitude: 'lon', lng: 'lon',
  alt: 'alt', altitude: 'alt',
  altr: 'altR', altitudereference: 'altR', altref: 'altR',
  dx: 'dx', deltax: 'dx',
  dy: 'dy', deltay: 'dy',
  dz: 'dz', deltaz: 'dz',
  timestamp: 'timestamp',
};

// Display names used in error messages (as the drones send them).
const LABEL = { id: 'id', lat: 'lat', lon: 'lon', alt: 'Alt', altR: 'Alt_R', dx: 'd_x', dy: 'd_y', dz: 'd_z', timestamp: 'Timestamp' };

const RANGES = {
  lat: [-90, 90], lon: [-180, 180], alt: [-1000, 100000],
  dx: [-1e6, 1e6], dy: [-1e6, 1e6], dz: [-1e6, 1e6],
};

const isBlank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Returns { value } (number or null when blank) or { error }. */
function toNumber(raw, field, required) {
  const label = LABEL[field];
  if (isBlank(raw)) return required ? { error: `${label} is required` } : { value: null };
  let n;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && NUMBER_TEXT.test(raw.trim())) n = Number(raw.trim());
  else return { error: `${label} must be a number` };
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  const [min, max] = RANGES[field];
  if (n < min || n > max) return { error: `${label} must be between ${min} and ${max}` };
  return { value: n };
}

/**
 * Validate one packet object.
 * Returns { packet, ignoredFields, errors } where packet is the normalised content
 * (without server fields) when errors is empty.
 */
function validatePacket(body) {
  const errors = [];
  const ignoredFields = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { packet: null, ignoredFields, errors: ['must be a JSON object'] };
  }
  const raw = {};
  for (const [key, value] of Object.entries(body)) {
    const field = ALIASES[normKey(key)];
    if (!field || field in raw) { ignoredFields.push(key); continue; }
    raw[field] = value;
  }

  // id
  let trackerId = null;
  const id = raw.id;
  if (isBlank(id)) errors.push('id is required');
  else if (typeof id === 'number') {
    if (Number.isSafeInteger(id)) trackerId = String(id);
    else errors.push('id must be text or a whole number');
  } else if (typeof id === 'string') {
    if (ID_RE.test(id.trim())) trackerId = id.trim();
    else errors.push('id must be 1-64 characters: letters, digits, ".", "_" or "-"');
  } else errors.push('id must be text or a whole number');

  const out = {};
  for (const f of ['lat', 'lon', 'alt', 'dx', 'dy', 'dz']) {
    const r = toNumber(raw[f], f, f === 'lat' || f === 'lon');
    if (r.error) errors.push(r.error); else out[f] = r.value;
  }
  if (out.lat === 0 && out.lon === 0) errors.push('lat and lon are both 0 (no GPS fix)');

  // Alt_R
  let altRef = null;
  const ar = raw.altR;
  if (!isBlank(ar)) {
    if (typeof ar === 'number' && Number.isFinite(ar)) altRef = String(ar);
    else if (typeof ar === 'string') {
      const t = ar.trim();
      if (t.length > 40) errors.push('Alt_R must be at most 40 characters');
      else if (/[\u0000-\u001f\u007f]/.test(t)) errors.push('Alt_R contains control characters');
      else altRef = t;
    } else errors.push('Alt_R must be text or a number');
  }

  // Timestamp
  let timestamp = null;
  let deviceTime = null;
  const ts = raw.timestamp;
  if (!isBlank(ts)) {
    if (typeof ts === 'string' && ts.length > 40) errors.push('Timestamp is too long');
    else {
      deviceTime = parseDeviceTime(ts);
      if (!deviceTime) errors.push('Timestamp must be "YYYY-MM-DD HH:MM:SS" (IST), ISO 8601 with a time zone, or Unix seconds');
      else timestamp = typeof ts === 'string' ? ts.trim() : ts;
    }
  }

  if (errors.length) return { packet: null, ignoredFields, errors };
  return {
    packet: { trackerId, lat: out.lat, lon: out.lon, alt: out.alt, altRef, dx: out.dx, dy: out.dy, dz: out.dz, timestamp, deviceTime },
    ignoredFields,
    errors,
  };
}

/**
 * Validate a request body: one packet (object) or up to 100 (array).
 * All-or-nothing: returns { ok:false, errors } if any packet is invalid.
 */
function validateBody(body) {
  const isBatch = Array.isArray(body);
  if (isBatch) {
    if (body.length === 0) return { ok: false, isBatch, errors: ['the array is empty: send at least one packet'] };
    if (body.length > MAX_BATCH) return { ok: false, isBatch, errors: [`at most ${MAX_BATCH} packets per request (got ${body.length})`] };
  } else if (body === null || typeof body !== 'object') {
    return { ok: false, isBatch, errors: ['the body must be a JSON object (one packet) or an array of packets'] };
  }
  const list = isBatch ? body : [body];
  const errors = [];
  const packets = [];
  const ignored = new Set();
  list.forEach((item, i) => {
    const r = validatePacket(item);
    r.ignoredFields.forEach(f => ignored.add(f));
    if (r.errors.length) r.errors.forEach(e => errors.push(isBatch ? `packet ${i + 1}: ${e}` : e));
    else packets.push(r.packet);
  });
  if (errors.length) return { ok: false, isBatch, errors };
  return { ok: true, isBatch, packets, ignoredFields: [...ignored] };
}

/** Add the server-side times. */
function finalizeTimes(packet, receivedAt) {
  const useDevice = believable(packet.deviceTime, receivedAt);
  const { deviceTime, ...rest } = packet;
  return { ...rest, receivedAt, recordedAt: useDevice ? deviceTime : receivedAt, timeSource: useDevice ? 'device' : 'server' };
}

/** Stored document -> API JSON. */
function toApi(doc) {
  return {
    id: doc._id,
    seq: doc.seq,
    trackerId: doc.trackerId,
    lat: doc.lat, lon: doc.lon, alt: doc.alt, altRef: doc.altRef,
    dx: doc.dx, dy: doc.dy, dz: doc.dz,
    timestamp: doc.timestamp ?? null,
    receivedAt: new Date(doc.receivedAt).toISOString(),
    recordedAt: new Date(doc.recordedAt).toISOString(),
    timeSource: doc.timeSource,
  };
}

module.exports = { validateBody, validatePacket, finalizeTimes, toApi, normKey, MAX_BATCH, ID_RE };
