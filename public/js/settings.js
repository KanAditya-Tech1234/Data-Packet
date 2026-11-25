/* Settings page: sensors, and each sensor's own configuration files and versions. */
(function () {
  'use strict';
  const { esc, fmtIST, api, header, showStatus } = window.DT;
  const $ = id => document.getElementById(id);
  const MAX_BYTES = 1024 * 1024;
  const VERSION_RE = /^v?\d{1,6}(\.\d{1,6}){0,3}$/i;
  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

  header('settings');

  let sensors = [];
  let selected = new URLSearchParams(location.search).get('sensor') || '';

  const fmtSize = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const slugify = name => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const nextVersion = v => { const p = v.split('.').map(Number); p[p.length - 1] += 1; return p.join('.'); };
  const sensorPath = id => `/api/sensors/${encodeURIComponent(id)}`;
  const toLogin = () => { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; };

  function setUrl() {
    const u = new URL(location.href);
    if (selected) u.searchParams.set('sensor', selected); else u.searchParams.delete('sensor');
    history.replaceState(null, '', u.pathname + u.search);
  }

  // ---------- sensor list ----------
  function renderList() {
    $('sensor-count').textContent = `${sensors.length} sensor${sensors.length === 1 ? '' : 's'}`;
    $('sensor-list').innerHTML = sensors.length ? sensors.map(s => `
      <button type="button" class="sensor-item${s.id === selected ? ' active' : ''}" data-id="${esc(s.id)}" aria-pressed="${s.id === selected}">
        <span class="sensor-name">${esc(s.name)}</span>
        <span class="sensor-meta"><code>${esc(s.id)}</code>
          ${s.latestVersion ? `<span class="chip tiny">v${esc(s.latestVersion)}</span>` : '<span class="chip tiny alt">no file</span>'}</span>
      </button>`).join('')
      : '<p class="muted" style="margin:0">No sensors yet. Add the first one below, for example “Node sensor”.</p>';
  }

  $('sensor-list').addEventListener('click', e => {
    const btn = e.target.closest('.sensor-item');
    if (!btn) return;
    selected = btn.dataset.id;
    setUrl();
    renderList();
    loadDetail();
  });

  async function loadSensors() {
    const r = await api('/api/sensors');
    if (!r.ok) { $('sensor-list').innerHTML = '<p class="status err">Could not load the sensors. Reload the page to try again.</p>'; return; }
    sensors = r.data.sensors || [];
    if (!sensors.some(s => s.id === selected)) selected = sensors.length ? sensors[0].id : '';
    setUrl();
    renderList();
    await loadDetail();
  }

  // ---------- add sensor ----------
  let idEdited = false;
  $('s-name').addEventListener('input', () => { if (!idEdited) $('s-id').value = slugify($('s-name').value); });
  $('s-id').addEventListener('input', () => { idEdited = $('s-id').value.trim() !== ''; });

  $('sensor-form').addEventListener('submit', async e => {
    e.preventDefault();
    const box = $('sensor-status');
    const name = $('s-name').value.trim();
    const id = ($('s-id').value.trim() || slugify(name)).toLowerCase();
    const description = $('s-desc').value.trim();
    const problems = [];
    if (name.length < 2) problems.push('Enter a sensor name (at least 2 characters).');
    if (!ID_RE.test(id)) problems.push('The sensor ID may only use lower-case letters, digits, - and _ (e.g. node-sensor).');
    if (problems.length) { showStatus(box, 'err', problems[0], problems); return; }
    const btn = $('s-add');
    btn.disabled = true;
    const r = await api('/api/sensors', { method: 'POST', body: JSON.stringify({ name, id, description }) });
    btn.disabled = false;
    if (r.status === 401) return toLogin();
    if (!r.ok) { showStatus(box, 'err', r.data.message || 'Could not add the sensor. Try again.', r.data.errors); return; }
    showStatus(box, 'ok', `Sensor “${r.data.sensor.name}” added. Now upload its configuration file.`);
    e.target.reset();
    idEdited = false;
    selected = r.data.sensor.id;
    loadSensors();
  });

  // ---------- selected sensor ----------
  function renderDetail(sensor, versions) {
    const host = $('detail');
    if (!sensor) {
      host.innerHTML = '<section class="card"><h2 class="section-title">No sensor selected</h2><p class="muted" style="margin:0">Add a sensor on the left, then upload its configuration file here.</p></section>';
      return;
    }
    host.replaceChildren($('detail-tpl').content.cloneNode(true));
    const f = name => host.querySelector(`[data-f="${name}"]`);
    const latest = versions[0] || null;
    const origin = location.origin;
    const base = `${origin}${sensorPath(sensor.id)}`;

    f('name').textContent = sensor.name;
    f('id').textContent = sensor.id;
    f('desc').textContent = sensor.description || `Added ${fmtIST(sensor.createdAt)}${sensor.createdBy ? ' by ' + sensor.createdBy : ''}`;

    // current version
    f('current').innerHTML = latest ? `
      <dl class="facts facts-2">
        <div><dt>Version</dt><dd class="big">${esc(latest.version)}</dd></div>
        <div><dt>File</dt><dd>${esc(latest.fileName)} (${esc(fmtSize(latest.size))})</dd></div>
        <div><dt>Uploaded (IST)</dt><dd>${esc(fmtIST(latest.uploadedAt))}</dd></div>
        <div><dt>By</dt><dd>${esc(latest.uploadedBy || '–')}</dd></div>
        <div class="wide"><dt>Notes</dt><dd>${esc(latest.notes || '–')}</dd></div>
        <div class="wide"><dt>SHA-256</dt><dd class="hash">${esc(latest.sha256)}</dd></div>
      </dl>
      <div class="actions" style="margin-top:14px"><a class="btn btn-accent" href="${esc(latest.downloadUrl)}">Download version ${esc(latest.version)}</a></div>`
      : `<p class="muted" style="margin:0">${esc(sensor.name)} has no configuration file yet. Upload the first one on the right.</p>`;
    if (latest) {
      f('version').placeholder = `e.g. ${nextVersion(latest.version)}`;
      f('version-hint').textContent = `Numbers separated by dots, e.g. 1, 1.2 or 1.2.10. It must be newer than ${latest.version}.`;
    }

    // APIs
    const cur = latest ? latest.version : '1.0';
    f('url-version').textContent = `GET ${base}/config/version?current=${cur}`;
    f('url-download').textContent = `GET ${base}/config/download`;
    const sample = latest
      ? { status: 'ok', updateAvailable: false, version: latest.version, fileName: latest.fileName, contentType: latest.contentType }
      : { status: 'error', message: `sensor "${sensor.id}" has no configuration file yet` };
    f('example').textContent =
      `# 1. Is there a newer configuration for ${sensor.name} than the one on the drone (${cur})?\n` +
      `curl "${base}/config/version?current=${cur}"\n` +
      `# -> ${JSON.stringify(sample)}\n\n` +
      '# 2. If "updateAvailable" is true: download the file\n' +
      `curl -o ${latest ? latest.fileName.replace(/ /g, '_') : 'config.json'} "${base}/config/download"`;

    // versions table
    f('versions').innerHTML = versions.length ? versions.map((v, i) => `
      <tr>
        <td><b>${esc(v.version)}</b>${i === 0 ? ' <span class="chip tiny">current</span>' : ''}</td>
        <td>${esc(v.fileName)}</td><td class="num">${esc(fmtSize(v.size))}</td>
        <td>${esc(fmtIST(v.uploadedAt))}</td><td>${esc(v.uploadedBy || '–')}</td>
        <td class="notes">${v.notes ? esc(v.notes) : '<span class="muted">–</span>'}</td>
        <td><a href="${esc(v.downloadUrl)}">Download</a></td>
      </tr>`).join('')
      : '<tr class="empty"><td colspan="7">No versions yet.</td></tr>';

    // delete
    f('delete').addEventListener('click', async () => {
      const n = versions.length;
      if (!confirm(`Delete sensor “${sensor.name}” (${sensor.id})${n ? ` and its ${n} configuration file${n === 1 ? '' : 's'}` : ''}?\n\nThis cannot be undone, and drones using its API will get 404.`)) return;
      const r = await api(sensorPath(sensor.id), { method: 'DELETE' });
      if (r.status === 401) return toLogin();
      if (!r.ok) { alert(r.data.message || 'Could not delete the sensor.'); return; }
      selected = '';
      loadSensors();
    });

    // upload
    f('upload-form').addEventListener('submit', async e => {
      e.preventDefault();
      const box = f('upload-status');
      const file = f('file').files[0];
      const version = f('version').value.trim();
      const notes = f('notes').value.trim();
      const problems = [];
      if (!file) problems.push('Choose a configuration file.');
      else if (!file.size) problems.push('The file is empty.');
      else if (file.size > MAX_BYTES) problems.push(`The file is ${fmtSize(file.size)}; the limit is 1 MB.`);
      if (!VERSION_RE.test(version)) problems.push('Enter a version number such as 1, 1.2 or 1.2.10.');
      if (problems.length) { showStatus(box, 'err', problems[0], problems); return; }

      const btn = f('upload-btn');
      btn.disabled = true; btn.textContent = 'Uploading…';
      showStatus(box, null);
      const q = new URLSearchParams({ version, fileName: file.name });
      if (notes) q.set('notes', notes);
      let res, data = {};
      try {
        res = await fetch(`${sensorPath(sensor.id)}/config?${q}`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' }, body: file,
        });
        data = await res.json().catch(() => ({}));
      } catch {
        res = { ok: false, status: 0 };
      }
      btn.disabled = false; btn.textContent = 'Upload';
      if (res.status === 401) return toLogin();
      if (!res.ok) { showStatus(box, 'err', data.message || 'The upload failed. Check your connection and try again.', data.errors); return; }
      await loadSensors();
      const again = $('detail').querySelector('[data-f="upload-status"]');
      showStatus(again, 'ok', `Version ${data.version} uploaded for ${sensor.name} (${data.fileName}, ${fmtSize(data.size)}). Drones get it on their next check.`);
    });
  }

  let detailGen = 0;
  async function loadDetail() {
    const gen = ++detailGen;
    const sensor = sensors.find(s => s.id === selected);
    if (!sensor) { renderDetail(null, []); return; }
    const r = await api(`${sensorPath(sensor.id)}/config/versions`);
    if (gen !== detailGen) return;
    if (r.status === 401) return toLogin();
    if (!r.ok) {
      $('detail').innerHTML = `<section class="card"><p class="status err">${esc(r.data.message || 'Could not load this sensor.')}</p></section>`;
      return;
    }
    renderDetail(r.data.sensor || sensor, r.data.versions || []);
  }

  loadSensors();
})();
