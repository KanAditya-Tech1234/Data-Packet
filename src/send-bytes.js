'use strict';
// Send a download with Content-Length, ETag "<sha256>", Content-Disposition and Range support
// (single byte ranges, If-Range, If-None-Match), so a broken field download can resume.

const crypto = require('node:crypto');

/**
 * @returns {{status:number, start:number, end:number}} what was sent (for the download log)
 */
function sendBytes(req, res, data, { contentType, fileName, sha256, extraHeaders = {} }) {
  const hash = sha256 || crypto.createHash('sha256').update(data).digest('hex');
  const etag = `"${hash}"`;
  const total = data.length;
  res.set({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    ...extraHeaders,
  });

  const inm = req.get('If-None-Match');
  if (inm && inm.split(',').map(s => s.trim()).some(t => t === etag || t === `W/${etag}` || t === '*')) {
    res.status(304).end();
    return { status: 304, start: 0, end: -1 };
  }

  let range = req.get('Range');
  const ifRange = req.get('If-Range');
  if (range && ifRange && ifRange.trim() !== etag) range = undefined;   // file changed: send it whole

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start, end;
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, total - n); end = total - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
    }
    if (m && start !== undefined && start <= end && start < total) {
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) });
      res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
      return { status: 206, start, end };
    }
    if (m) {
      res.status(416).set({ 'Content-Range': `bytes */${total}`, 'Content-Type': 'application/json' });
      res.removeHeader('Content-Disposition');
      res.end(JSON.stringify({ error: 'range_not_satisfiable', message: `the file has ${total} bytes` }));
      return { status: 416, start: 0, end: -1 };
    }
    // A malformed Range header is ignored (RFC 9110): send the whole file.
  }
  res.status(200).set('Content-Length', String(total));
  res.end(req.method === 'HEAD' ? undefined : data);
  return { status: 200, start: 0, end: total - 1 };
}

module.exports = { sendBytes };
