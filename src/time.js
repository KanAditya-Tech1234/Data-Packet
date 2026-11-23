'use strict';
// Time helpers. India Standard Time is UTC+05:30 all year (no daylight saving).

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 10 * 60 * 1000;          // device time may be at most 10 minutes ahead
const MAX_BEHIND_MS = 7 * 24 * 60 * 60 * 1000; // ...and at most 7 days behind the arrival time

const pad = n => String(n).padStart(2, '0');

/** Date -> "DD-MM-YYYY HH:MM:SS IST" */
function formatIST(date) {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} IST`;
}

const IST_TEXT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const UNIX_TEXT = /^\d{9,13}(\.\d+)?$/;

function validCalendar(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function fromUnix(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  // Unix seconds; a 13-digit value is taken as milliseconds.
  const ms = n >= 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a device timestamp. Accepts:
 *  - "YYYY-MM-DD HH:MM:SS" (India time, no zone)
 *  - ISO 8601 with a zone ("2025-01-31T10:15:00Z", "...+05:30")
 *  - Unix seconds (number or text)
 * Returns a Date, or null when the value is not a valid time.
 */
function parseDeviceTime(value) {
  if (typeof value === 'number') return fromUnix(value);
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (UNIX_TEXT.test(s)) return fromUnix(Number(s));
  let m = IST_TEXT.exec(s);
  if (m) {
    const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
    if (!validCalendar(y, mo, d, h, mi, sec)) return null;
    const frac = m[7] ? Math.round(Number(m[7]) * 1000) : 0;
    return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, frac) - IST_OFFSET_MS);
  }
  if (ISO_WITH_ZONE.test(s)) {
    m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
    if (!validCalendar(y, mo, d, h, mi, Number(m[6] || 0))) return null;
    const d2 = new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isNaN(d2.getTime()) ? null : d2;
  }
  return null;
}

/** Is a device time believable compared with the arrival time? */
function believable(deviceTime, receivedAt) {
  if (!deviceTime) return false;
  const diff = deviceTime.getTime() - receivedAt.getTime();
  return diff <= MAX_AHEAD_MS && diff >= -MAX_BEHIND_MS;
}

module.exports = { formatIST, parseDeviceTime, believable, IST_OFFSET_MS };
