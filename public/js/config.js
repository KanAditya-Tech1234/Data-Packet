/* Configuration file page: current version, upload a new one, the drone APIs, all versions. */
(function () {
  'use strict';
  const { esc, fmtIST, api, header, showStatus } = window.DT;
  const $ = id => document.getElementById(id);
  const MAX_BYTES = 1024 * 1024;
  const VERSION_RE = /^v?\d{1,6}(\.\d{1,6}){0,3}$/i;

  header('config');

  const fmtSize = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const dl = v => `/api/config/download?version=${encodeURIComponent(v.version)}`;

  /** "1.2.9" -> "1.2.10" (a suggestion for the next version) */
  const nextVersion = v => { const p = v.split('.').map(Number); p[p.length - 1] += 1; return p.join('.'); };

  function renderApis(latest) {
    const origin = location.origin;
    const cur = latest ? latest.version : '1.0';
    $('url-version').textContent = `GET ${origin}/api/config/version?current=${cur}`;
    $('url-download').textContent = `GET ${origin}/api/config/download`;
    const sample = latest
      ? { status: 'ok', version: latest.version, fileName: latest.fileName, size: latest.size, sha256: latest.sha256, updateAvailable: false }
      : { status: 'error', message: 'no configuration file has been uploaded yet' };
    $('example').textContent =
      `# 1. Check: is there a newer configuration than the one on the drone (${cur})?\n` +
      `curl "${origin}/api/config/version?current=${cur}"\n` +
      `# -> ${JSON.stringify(sample)}\n\n` +
      '# 2. If "updateAvailable" is true: download the file\n' +
      `curl -o ${latest ? latest.fileName.replace(/ /g, '_') : 'config.json'} "${origin}/api/config/download"`;
  }

  function renderCurrent(latest) {
    $('current-chip').textContent = latest ? `Current version ${latest.version}` : 'No file yet';
    $('current-chip').className = latest ? 'chip' : 'chip alt';
    if (!latest) {
      $('current').innerHTML = '<p class="muted">No configuration file has been uploaded yet. Upload the first one on the right.</p>';
      $('cfg-version').placeholder = 'e.g. 1.0';
      return;
    }
    $('current').innerHTML = `
      <dl class="facts facts-2">
        <div><dt>Version</dt><dd class="big">${esc(latest.version)}</dd></div>
        <div><dt>File</dt><dd>${esc(latest.fileName)} (${esc(fmtSize(latest.size))})</dd></div>
        <div><dt>Uploaded (IST)</dt><dd>${esc(fmtIST(latest.uploadedAt))}</dd></div>
        <div><dt>By</dt><dd>${esc(latest.uploadedBy || '–')}</dd></div>
        <div class="wide"><dt>Notes</dt><dd>${esc(latest.notes || '–')}</dd></div>
        <div class="wide"><dt>SHA-256</dt><dd class="hash">${esc(latest.sha256)}</dd></div>
      </dl>
      <div class="actions" style="margin-top:14px"><a class="btn btn-accent" href="${esc(dl(latest))}">Download version ${esc(latest.version)}</a></div>`;
    $('cfg-version').placeholder = `e.g. ${nextVersion(latest.version)}`;
    $('version-hint').textContent = `Numbers separated by dots, e.g. 1, 1.2 or 1.2.10. It must be newer than ${latest.version}.`;
  }

  function renderVersions(list) {
    $('versions').innerHTML = list.length ? list.map((v, i) => `
      <tr>
        <td><b>${esc(v.version)}</b>${i === 0 ? ' <span class="chip tiny">current</span>' : ''}</td>
        <td>${esc(v.fileName)}</td><td class="num">${esc(fmtSize(v.size))}</td>
        <td>${esc(fmtIST(v.uploadedAt))}</td><td>${esc(v.uploadedBy || '–')}</td>
        <td class="notes">${v.notes ? esc(v.notes) : '<span class="muted">–</span>'}</td>
        <td><a href="${esc(dl(v))}">Download</a></td>
      </tr>`).join('')
      : '<tr class="empty"><td colspan="7">No versions yet.</td></tr>';
  }

  async function load() {
    const r = await api('/api/config/versions');
    if (r.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return; }
    if (!r.ok) {
      $('current').innerHTML = '<p class="status err">Could not load the configuration versions. Reload the page to try again.</p>';
      return;
    }
    const list = r.data.versions || [];
    renderCurrent(list[0] || null);
    renderVersions(list);
    renderApis(list[0] || null);
  }

  $('upload-form').addEventListener('submit', async e => {
    e.preventDefault();
    const box = $('upload-status');
    const file = $('cfg-file').files[0];
    const version = $('cfg-version').value.trim();
    const notes = $('cfg-notes').value.trim();
    const problems = [];
    if (!file) problems.push('Choose a configuration file.');
    else if (!file.size) problems.push('The file is empty.');
    else if (file.size > MAX_BYTES) problems.push(`The file is ${fmtSize(file.size)}; the limit is 1 MB.`);
    if (!VERSION_RE.test(version)) problems.push('Enter a version number such as 1, 1.2 or 1.2.10.');
    if (problems.length) { showStatus(box, 'err', problems[0], problems); return; }

    const btn = $('upload-btn');
    btn.disabled = true; btn.textContent = 'Uploading…';
    showStatus(box, null);
    const q = new URLSearchParams({ version, fileName: file.name });
    if (notes) q.set('notes', notes);
    let res, data = {};
    try {
      res = await fetch(`/api/config?${q}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' }, body: file,
      });
      data = await res.json().catch(() => ({}));
    } catch {
      res = { ok: false, status: 0 };
    }
    btn.disabled = false; btn.textContent = 'Upload';
    if (res.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return; }
    if (!res.ok) {
      showStatus(box, 'err', data.message || 'The upload failed. Check your connection and try again.', data.errors);
      return;
    }
    showStatus(box, 'ok', `Version ${data.version} uploaded (${data.fileName}, ${fmtSize(data.size)}). The drones will get it on their next check.`);
    e.target.reset();
    load();
  });

  load();
})();
