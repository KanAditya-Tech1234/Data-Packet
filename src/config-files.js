'use strict';
// Configuration files for the drones: version numbers, file names and the metadata the APIs return.
//
// A version is 1 to 4 whole numbers separated by dots: "3", "1.2", "1.2.10", "2.0.0.7".
// Versions are compared number by number (1.10 is newer than 1.9), and "1.2" equals "1.2.0".

const crypto = require('node:crypto');

const MAX_CONFIG_BYTES = 1024 * 1024;   // 1 MB per file
const KEEP_VERSIONS = 20;               // older versions are deleted automatically
const VERSION_RE = /^\d{1,6}(\.\d{1,6}){0,3}$/;
const VERSION_HELP = 'version must be numbers separated by dots, e.g. 1, 1.2 or 1.2.10 (at most 4 parts)';

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/^v/i, '');
  if (!VERSION_RE.test(v)) return null;
  const parts = v.split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  return {
    version: v.split('.').map(Number).join('.'),            // "01.2" -> "1.2"
    key: parts.map(n => String(n).padStart(6, '0')).join('.'),   // sortable: "000001.000002.000000.000000"
  };
}

/** < 0 when a is older than b, 0 when equal, > 0 when newer. */
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) throw new Error('invalid version');
  return pa.key < pb.key ? -1 : pa.key > pb.key ? 1 : 0;
}

/** Keep only a plain file name: no folders, no control or odd characters. */
function cleanFileName(value) {
  const base = String(value || '').split(/[\\/]/).pop();
  const clean = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 100);
  return clean || 'config.txt';
}

const CONTENT_TYPES = {
  json: 'application/json', txt: 'text/plain', ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain',
  yaml: 'text/plain', yml: 'text/plain', csv: 'text/csv', xml: 'application/xml',
};
const contentTypeFor = fileName => CONTENT_TYPES[(fileName.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

function makeConfigDoc({ version, fileName, notes, data, uploadedBy }) {
  const v = parseVersion(version);
  const name = cleanFileName(fileName);
  return {
    _id: crypto.randomBytes(12).toString('hex'),
    version: v.version,
    versionKey: v.key,
    fileName: name,
    contentType: contentTypeFor(name),
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    md5: crypto.createHash('md5').update(data).digest('hex'),
    notes: notes || '',
    uploadedBy: uploadedBy || '',
    uploadedAt: new Date(),
    data,
  };
}

/** What the APIs return about a file (never the file itself). */
function toMeta(doc) {
  return {
    version: doc.version,
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    sha256: doc.sha256,
    md5: doc.md5,
    notes: doc.notes,
    uploadedBy: doc.uploadedBy,
    uploadedAt: new Date(doc.uploadedAt).toISOString(),
    downloadUrl: `/api/config/download?version=${encodeURIComponent(doc.version)}`,
  };
}

module.exports = {
  MAX_CONFIG_BYTES, KEEP_VERSIONS, VERSION_HELP,
  parseVersion, compareVersions, cleanFileName, makeConfigDoc, toMeta,
};
