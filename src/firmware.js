'use strict';
// Thrust-bench firmware releases (SERVER_OTA_HANDOFF.md v1.0):
// semver, image checks (§4), the manifest (§5) and the compatible-set rule (§6, §7.1).

const crypto = require('node:crypto');

const PRODUCT = 'thrust-bench';
const SCHEMA = 1;
const TARGETS = ['main', 'n1', 'n2'];
const CHANNELS = ['stable', 'beta'];
const STATUSES = ['draft', 'published', 'yanked'];
const NOTES_MAX = 4000;

/** Chip IDs from esp_image_header_t.chip_id (offset 12, uint16 little-endian). */
const TARGET_CHIP = { main: 0x0000, n1: 0x0005, n2: 0x0005 };
const CHIP_NAMES = {
  0x0000: 'ESP32', 0x0002: 'ESP32-S2', 0x0005: 'ESP32-C3', 0x0009: 'ESP32-S3',
  0x000c: 'ESP32-C2', 0x000d: 'ESP32-C6', 0x0010: 'ESP32-H2', 0x0012: 'ESP32-P4',
};
const BOARD_NAMES = { main: 'main node (ESP32 DevKit V1)', n1: 'n1 (ESP32-C3, temperature + RPM)', n2: 'n2 (ESP32-C3, voltage + current)' };
const chipName = id => CHIP_NAMES[id] || `unknown chip 0x${id.toString(16).padStart(4, '0')}`;

// ---------- semver ----------
const SEMVER_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const SEMVER_HELP = 'must be a version MAJOR.MINOR.PATCH such as 2.1.0 (no "v", no leading zeros)';

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  const parts = m.slice(1, 4).map(Number);
  return { version: parts.join('.'), key: parts.map(n => String(n).padStart(6, '0')).join('.') };
}
const semverKey = v => parseSemver(v)?.key ?? null;
/** < 0 when a is older than b, 0 when equal, > 0 when newer. */
function compareSemver(a, b) {
  const ka = semverKey(a), kb = semverKey(b);
  if (!ka || !kb) throw new Error('invalid version');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// ---------- requires: { other target: ">=x.y.z" } ----------
/**
 * Accepts { n2: ">=2.0.0" } or { n2: "2.0.0" } (empty values are skipped).
 * Returns { requires } in target order, or { error }.
 */
function parseRequires(target, raw) {
  if (raw === undefined || raw === null || raw === '') return { requires: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'requires must be an object such as {"main":">=2.1.0"}' };
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!TARGETS.includes(key)) return { error: `requires: unknown target "${key}" (use main, n1 or n2)` };
    if (key === target) return { error: `requires: a ${target} release cannot require ${target} itself; give minimum versions of the other targets` };
  }
  for (const key of TARGETS) {
    let v = raw[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
    if (typeof v !== 'string') return { error: `requires.${key} must be a string such as ">=2.1.0"` };
    v = v.trim().replace(/^>=\s*/, '');
    const p = parseSemver(v);
    if (!p) return { error: `requires.${key} ${SEMVER_HELP} (only ">=" constraints are supported)` };
    out[key] = `>=${p.version}`;
  }
  return { requires: out };
}

const minVersion = constraint => (constraint ? constraint.replace(/^>=/, '') : null);
/** Does `version` meet the constraint ">=x.y.z"? (no constraint = yes) */
const satisfies = (version, constraint) => !constraint || compareSemver(version, minVersion(constraint)) >= 0;

/** a and b (different targets) can run together: same proto, and each one's requires is met by the other. */
function compatible(a, b) {
  return a.proto === b.proto && satisfies(b.version, a.requires?.[b.target]) && satisfies(a.version, b.requires?.[a.target]);
}

/**
 * The newest mutually compatible set from releases already filtered (published, channel).
 * Newest main first; for it the newest n1, then the newest n2 that fits both.
 */
function compatibleSet(releases) {
  const by = t => releases.filter(r => r.target === t).sort((x, y) => (x.versionKey < y.versionKey ? 1 : -1));
  const mains = by('main'), n1s = by('n1'), n2s = by('n2');
  for (const m of mains) {
    for (const a of n1s) {
      if (!compatible(m, a)) continue;
      for (const b of n2s) {
        if (compatible(m, b) && compatible(a, b)) return { main: m, n1: a, n2: b };
      }
    }
  }
  return null;
}

// ---------- file names ----------
const canonicalFile = (target, version) => `tb-${target}-${version}.ino.bin`;
const packageName = (target, version) => `tb-${target}-${version}.tbfw`;

/** Keep only a plain file name (for display): no folders, no odd characters. */
function cleanName(value) {
  const base = String(value || '').split(/[\\/]/).pop();
  return base.replace(/[^A-Za-z0-9._ +-]/g, '_').slice(0, 150);
}

// ---------- image checks (§4) ----------
class FirmwareError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/**
 * Check an uploaded image. Returns the values the server computes (never taken from the form).
 * Throws FirmwareError with a clear message when a check fails.
 */
function inspectImage({ fileName, data, target, maxSize }) {
  const name = String(fileName || '').toLowerCase();
  for (const bad of ['.merged.', '.bootloader.', '.partitions.']) {
    if (name.includes(bad)) {
      throw new FirmwareError(400, 'not_ota_image',
        `"${cleanName(fileName)}" is a ${bad.slice(1, -1)} file from "Export Compiled Binary", not an OTA app image: upload the file that ends in .ino.bin`);
    }
  }
  if (!name.endsWith('.ino.bin')) {
    throw new FirmwareError(400, 'bad_file_name', `"${cleanName(fileName) || '(no name)'}" is not an app image: the file name must end in .ino.bin`);
  }
  if (!data || !data.length) throw new FirmwareError(400, 'empty_file', 'the file is empty');
  if (data.length > maxSize) {
    throw new FirmwareError(413, 'too_large', `the image is ${data.length} bytes; the limit for ${target} is ${maxSize} bytes (its OTA app slot size)`);
  }
  if (data[0] !== 0xE9) {
    throw new FirmwareError(400, 'bad_magic', `this is not an ESP32 app image: byte 0 is 0x${data[0].toString(16).padStart(2, '0').toUpperCase()}, expected 0xE9`);
  }
  if (data.length < 24) throw new FirmwareError(400, 'bad_header', 'the file is too short to hold an ESP32 image header (24 bytes)');
  const chipId = data.readUInt16LE(12);
  const want = TARGET_CHIP[target];
  if (chipId !== want) {
    throw new FirmwareError(400, 'chip_mismatch',
      `chip mismatch: this image is built for ${chipName(chipId)} (chip ID ${chipId}), but target ${target} is the ${BOARD_NAMES[target]} and needs ${chipName(want)} (chip ID ${want})`);
  }
  return {
    size: data.length,
    md5: crypto.createHash('md5').update(data).digest('hex'),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    chipId,
  };
}

// ---------- form fields (§3) ----------
/** Validate the upload form fields. Returns { release } or throws FirmwareError. */
function validateFields(f) {
  const bad = (code, message) => { throw new FirmwareError(400, code, message); };
  const target = String(f.target ?? '').trim();
  if (!TARGETS.includes(target)) bad('invalid_target', 'target must be main, n1 or n2');
  const v = parseSemver(String(f.version ?? ''));
  if (!v) bad('invalid_version', `version ${SEMVER_HELP}`);
  const protoText = String(f.proto ?? '').trim();
  if (!/^[1-9]\d{0,8}$/.test(protoText)) bad('invalid_proto', 'proto must be a whole number of at least 1');
  let rawReq = f.requires;
  if (typeof rawReq === 'string') {
    if (rawReq.trim() === '') rawReq = {};
    else { try { rawReq = JSON.parse(rawReq); } catch { bad('invalid_requires', 'requires must be JSON such as {"main":">=2.1.0"}'); } }
  }
  rawReq = { ...(rawReq || {}) };
  for (const t of TARGETS) if (f[`requires_${t}`] !== undefined && f[`requires_${t}`] !== '') rawReq[t] = f[`requires_${t}`];
  const r = parseRequires(target, rawReq);
  if (r.error) bad('invalid_requires', r.error);
  const channel = f.channel === undefined || f.channel === '' ? 'beta' : String(f.channel).trim();
  if (!CHANNELS.includes(channel)) bad('invalid_channel', 'channel must be stable or beta');
  const notes = checkNotes(f.notes);
  const builtWith = String(f.built_with ?? f.builtWith ?? '').trim();
  if (builtWith.length > 100 || /[\u0000-\u001f]/.test(builtWith)) bad('invalid_built_with', 'built with must be at most 100 characters on one line');
  return { target, version: v.version, versionKey: v.key, proto: Number(protoText), requires: r.requires, channel, notes, builtWith };
}

function checkNotes(value) {
  const notes = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!notes) throw new FirmwareError(400, 'notes_required', 'release notes are required');
  if (notes.length > NOTES_MAX) throw new FirmwareError(400, 'notes_too_long', `release notes must be at most ${NOTES_MAX} characters (now ${notes.length})`);
  return notes;
}

// ---------- manifest (§5) ----------
const isoSeconds = d => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/** Exactly the manifest fields of schema 1, in the documented order. */
function manifestOf(rel) {
  return {
    schema: SCHEMA,
    product: rel.product,
    target: rel.target,
    version: rel.version,
    proto: rel.proto,
    requires: { ...(rel.requires || {}) },
    channel: rel.channel,
    file: canonicalFile(rel.target, rel.version),
    size: rel.size,
    md5: rel.md5,
    sha256: rel.sha256,
    chip_id: rel.chipId,
    built_with: rel.builtWith || '',
    notes: rel.notes,
    published_at: isoSeconds(rel.publishedAt),
    release_id: rel._id,
  };
}

/** The manifest.json file: pretty JSON with a trailing newline. */
const manifestBytes = rel => Buffer.from(JSON.stringify(manifestOf(rel), null, 2) + '\n', 'utf8');

/** API view: the manifest plus server-side facts under "meta" (never part of manifest.json). */
function toApi(rel, { admin = false } = {}) {
  const meta = {
    status: rel.status,
    yank_reason: rel.yankReason || null,
    yanked_at: isoSeconds(rel.yankedAt),
    uploaded_at: isoSeconds(rel.uploadedAt),
    package: packageName(rel.target, rel.version),
    urls: {
      package: `/api/tb/v1/firmware/${rel._id}/package`,
      bin: `/api/tb/v1/firmware/${rel._id}/bin`,
      manifest: `/api/tb/v1/firmware/${rel._id}/manifest`,
    },
  };
  meta.uploaded_by = rel.uploadedBy || '';
  if (admin) {
    meta.original_file_name = rel.originalFileName || '';
    if (rel.sameShaAs?.length) meta.same_sha256_as = rel.sameShaAs;
  }
  return { ...manifestOf(rel), meta };
}

function newReleaseId() { return crypto.randomBytes(12).toString('hex'); }

module.exports = {
  PRODUCT, SCHEMA, TARGETS, CHANNELS, STATUSES, NOTES_MAX, TARGET_CHIP, BOARD_NAMES, SEMVER_HELP,
  FirmwareError, parseSemver, compareSemver, parseRequires, satisfies, compatible, compatibleSet,
  canonicalFile, packageName, cleanName, chipName, inspectImage, validateFields, checkNotes,
  manifestOf, manifestBytes, toApi, isoSeconds, newReleaseId,
};
