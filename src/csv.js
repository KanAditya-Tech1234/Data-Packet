'use strict';
// CSV export helpers.

const { formatIST } = require('./time');

/** A text cell: always quoted; a leading = + - @ tab or CR is neutralised (spreadsheet formula injection). */
function textCell(v) {
  if (v === null || v === undefined || v === '') return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** A number cell: never quoted; empty when missing. */
function numCell(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

const HEADER = ['Time (IST)', 'ID', 'Latitude', 'Longitude', 'Altitude (m)', 'Altitude ref.', 'dx', 'dy', 'dz',
  'Time source', 'Device timestamp', 'Received (IST)', 'Seq', 'Packet ID'];

function row(doc) {
  return [
    textCell(formatIST(doc.recordedAt)), textCell(doc.trackerId),
    numCell(doc.lat), numCell(doc.lon), numCell(doc.alt), textCell(doc.altRef),
    numCell(doc.dx), numCell(doc.dy), numCell(doc.dz),
    textCell(doc.timeSource), textCell(doc.timestamp), textCell(formatIST(doc.receivedAt)),
    numCell(doc.seq), textCell(doc._id),
  ].join(',');
}

module.exports = { HEADER, row, textCell, numCell };
