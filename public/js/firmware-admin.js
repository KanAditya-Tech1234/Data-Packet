/* Firmware admin: upload → draft → review → publish; yank; channel and notes; logs (SERVER_OTA_HANDOFF.md §3, §4, §7.3). */
(function () {
  'use strict';
  const { esc, fmtIST, fmtSize, api, header, showStatus, md, dialog } = window.DT;
  const $ = id => document.getElementById(id);
  const API = '/api/tb/v1';
  const TARGETS = ['main', 'n1', 'n2'];
  const BOARDS = { main: 'Main node · ESP32 DevKit V1', n1: 'Node 1 · ESP32-C3 · temperature + RPM', n2: 'Node 2 · ESP32-C3 · voltage + current' };
  const CHIPS = { main: 0, n1: 5, n2: 5 };
  const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
  let limits = null;
  let byId = new Map();

  const reqText = r => {
    const parts = Object.entries(r || {}).map(([t, c]) => `${t} ${c.replace('>=', '≥ ')}`);
    return parts.length ? parts.join(', ') : 'none';
  };
  const toLogin = () => { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; };

  // ---------- upload form ----------
  function renderRequires() {
    const target = $('up-target').value;
    const old = {};
    for (const el of document.querySelectorAll('#up-requires input')) old[el.name] = el.value;
    const others = TARGETS.filter(t => t !== target);
    $('up-requires').innerHTML = target ? others.map(t => `
      <label class="field">${t} ≥
        <input name="requires_${t}" value="${esc(old[`requires_${t}`] || '')}" placeholder="e.g. 2.0.0" maxlength="20" autocomplete="off" spellcheck="false">
      </label>`).join('') : '<p class="hint" style="margin:0">Choose the target first.</p>';
  }
  $('up-target').addEventListener('change', renderRequires);
  renderRequires();
  $('up-notes').addEventListener('input', () => { $('notes-count').textContent = $('up-notes').value.length; });

  /** Read the first 24 bytes in the browser so obvious mistakes show before uploading (the server checks again). */
  async function quickCheck(file, target) {
    const problems = [];
    const name = file.name.toLowerCase();
    if (/\.(merged|bootloader|partitions)\./.test(name)) problems.push(`${file.name} is not an OTA app image: use the file that ends in .ino.bin.`);
    else if (!name.endsWith('.ino.bin')) problems.push('The file name must end in .ino.bin.');
    if (!file.size) problems.push('The file is empty.');
    else if (limits && target && file.size > limits.max_app_size[target]) {
      problems.push(`The file is ${file.size} bytes; the limit for ${target} is ${limits.max_app_size[target]} bytes.`);
    }
    if (file.size >= 24 && target) {
      const head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
      if (head[0] !== 0xE9) problems.push(`Byte 0 is 0x${head[0].toString(16).padStart(2, '0').toUpperCase()}, not 0xE9: this is not an ESP32 app image.`);
      else {
        const chip = head[12] | (head[13] << 8);
        if (chip !== CHIPS[target]) problems.push(`Chip mismatch: the image is for chip ID ${chip} (${chip === 0 ? 'ESP32' : chip === 5 ? 'ESP32-C3' : 'another chip'}), but ${target} needs ${CHIPS[target] === 0 ? 'ESP32 (0)' : 'ESP32-C3 (5)'}.`);
      }
    }
    return problems;
  }

  $('up-form').addEventListener('submit', async e => {
    e.preventDefault();
    const box = $('up-status');
    const file = $('up-file').files[0];
    const target = $('up-target').value;
    const version = $('up-version').value.trim();
    const proto = $('up-proto').value.trim();
    const notes = $('up-notes').value.trim();
    const problems = [];
    if (!file) problems.push('Choose the .ino.bin file.');
    if (!TARGETS.includes(target)) problems.push('Choose the target.');
    if (!SEMVER.test(version)) problems.push('Version must be MAJOR.MINOR.PATCH, e.g. 2.1.0.');
    if (!/^[1-9]\d*$/.test(proto)) problems.push('Proto must be a whole number of at least 1.');
    for (const el of document.querySelectorAll('#up-requires input')) {
      if (el.value.trim() && !SEMVER.test(el.value.trim().replace(/^>=\s*/, ''))) problems.push(`Requires ${el.name.slice(9)}: use a version such as 2.0.0.`);
    }
    if (!notes) problems.push('Write the release notes.');
    if (file) problems.push(...await quickCheck(file, target));
    if (problems.length) { showStatus(box, 'err', problems[0], problems); return; }

    const form = new FormData();
    form.append('target', target);
    form.append('version', version);
    form.append('proto', proto);
    form.append('channel', $('up-channel').value);
    form.append('notes', notes);
    form.append('built_with', $('up-built').value.trim());
    for (const el of document.querySelectorAll('#up-requires input')) if (el.value.trim()) form.append(el.name, el.value.trim());
    form.append('file', file, file.name);
    const btn = $('up-btn');
    btn.disabled = true; btn.textContent = 'Uploading…';
    showStatus(box, null);
    let res, data = {};
    try {
      res = await fetch(`${API}/firmware`, { method: 'POST', credentials: 'same-origin', body: form });
      data = await res.json().catch(() => ({}));
    } catch { res = { ok: false, status: 0 }; }
    btn.disabled = false; btn.textContent = 'Upload as draft';
    if (res.status === 401) return toLogin();
    if (!res.ok) { showStatus(box, 'err', data.message || 'The upload failed. Check your connection and try again.'); return; }
    const warn = (data.warnings || []).length;
    showStatus(box, warn ? 'warn' : 'ok', `Draft ${data.target} ${data.version} created. Review it under "Drafts" and publish it.`, data.warnings);
    e.target.reset();
    renderRequires();
    $('notes-count').textContent = '0';
    await load();
  });

  // ---------- review and publish ----------
  const facts = rel => `
    <dl class="facts facts-2">
      <div><dt>Target</dt><dd><span class="tname">${esc(rel.target)}</span></dd></div>
      <div><dt>Version</dt><dd class="big">${esc(rel.version)}</dd></div>
      <div><dt>Proto</dt><dd>${esc(rel.proto)}</dd></div>
      <div><dt>Channel</dt><dd>${esc(rel.channel)}</dd></div>
      <div><dt>Requires</dt><dd>${esc(reqText(rel.requires))}</dd></div>
      <div><dt>Built with</dt><dd>${esc(rel.built_with || '–')}</dd></div>
      <div><dt>Size (computed)</dt><dd>${esc(rel.size)} bytes (${esc(fmtSize(rel.size))})</dd></div>
      <div><dt>Chip ID (computed)</dt><dd>${esc(rel.chip_id)} (${rel.chip_id === 0 ? 'ESP32' : 'ESP32-C3'})</dd></div>
      <div class="wide"><dt>MD5 (computed)</dt><dd class="hash">${esc(rel.md5)}</dd></div>
      <div class="wide"><dt>SHA-256 (computed)</dt><dd class="hash">${esc(rel.sha256)}</dd></div>
      <div class="wide"><dt>File name when downloaded</dt><dd class="mono">${esc(rel.file)} <span class="muted">(uploaded as ${esc(rel.meta.original_file_name || '–')})</span></dd></div>
      <div><dt>Uploaded (IST)</dt><dd>${esc(fmtIST(rel.meta.uploaded_at))}</dd></div>
      <div><dt>By</dt><dd>${esc(rel.meta.uploaded_by || '–')}</dd></div>
      ${rel.meta.same_sha256_as ? `<div class="wide"><dt>Warning</dt><dd class="status warn">The same file is already uploaded as ${esc(rel.meta.same_sha256_as.map(s => `${s.target} ${s.version}`).join(', '))}.</dd></div>` : ''}
      <div class="wide"><dt>Release notes</dt><dd>${md(rel.notes)}</dd></div>
    </dl>`;

  async function publish(rel) {
    const ok = await dialog({
      title: 'Publish this release?', confirmText: `Publish for ${rel.target.toUpperCase()}`,
      html: `<div class="big-target"><div class="t">${esc(rel.target.toUpperCase())}</div><div class="b">${esc(BOARDS[rel.target])}</div></div>
        <p style="margin:0 0 8px">Version <b>${esc(rel.version)}</b>, proto ${esc(rel.proto)}, channel <b>${esc(rel.channel)}</b>, ${esc(fmtSize(rel.size))}.</p>
        <p class="muted" style="margin:0 0 10px">n1 and n2 are both ESP32-C3, so the server cannot tell them apart: make sure this image really is for
          <b>${esc(rel.target)}</b>. After publishing, the file and manifest can never change.</p>
        <label class="field">Type the target to confirm
          <input name="confirm" autocomplete="off" spellcheck="false" placeholder="${esc(rel.target)}"></label>`,
      validate: v => (v.confirm.trim().toLowerCase() === rel.target ? null : `Type “${rel.target}” to confirm.`),
    });
    if (!ok) return;
    const r = await api(`${API}/firmware/${rel.release_id}/publish`, { method: 'POST', body: JSON.stringify({ confirm_target: rel.target }) });
    if (!r.ok) { alert(r.data.message || 'Could not publish.'); return; }
    await load();
  }

  async function review(rel) {
    const go = await dialog({ title: `Draft: ${rel.target} ${rel.version}`, html: facts(rel), confirmText: 'Continue to publish', wide: true });
    if (go) publish(rel);
  }

  async function removeDraft(rel) {
    const ok = await dialog({ title: `Delete draft ${rel.target} ${rel.version}?`, danger: true, confirmText: 'Delete draft',
      html: '<p style="margin:0">The draft and its file are deleted. You can upload the same version again afterwards.</p>' });
    if (!ok) return;
    const r = await api(`${API}/firmware/${rel.release_id}`, { method: 'DELETE' });
    if (!r.ok) { alert(r.data.message || 'Could not delete.'); return; }
    await load();
  }

  async function yank(rel) {
    const ok = await dialog({
      title: `Yank ${rel.target} ${rel.version}?`, danger: true, confirmText: 'Yank release',
      html: `<p>It disappears from "latest" and from the compatible set. Engineers can still download it by ID, after a warning.</p>
        <label class="field">Reason (shown to engineers)
          <textarea name="reason" maxlength="500" style="min-height:80px" placeholder="e.g. Current sensor reads 2x high"></textarea></label>`,
      validate: v => (v.reason.trim() ? null : 'Give the reason.'),
    });
    if (!ok) return;
    const r = await api(`${API}/firmware/${rel.release_id}/yank`, { method: 'POST', body: JSON.stringify({ reason: ok.reason.trim() }) });
    if (!r.ok) { alert(r.data.message || 'Could not yank.'); return; }
    await load();
  }

  async function setChannel(rel) {
    const to = rel.channel === 'stable' ? 'beta' : 'stable';
    const ok = await dialog({ title: `Move ${rel.target} ${rel.version} to ${to}?`, confirmText: `Make it ${to}`,
      html: `<p style="margin:0">${to === 'stable' ? 'Field engineers see stable releases by default.' : 'It will only be shown when "Show beta releases" is on.'}</p>` });
    if (!ok) return;
    const r = await api(`${API}/firmware/${rel.release_id}`, { method: 'PATCH', body: JSON.stringify({ channel: to }) });
    if (!r.ok) { alert(r.data.message || 'Could not change the channel.'); return; }
    await load();
  }

  async function editNotes(rel) {
    const ok = await dialog({
      title: `Release notes: ${rel.target} ${rel.version}`, confirmText: 'Save notes', wide: true,
      html: `<label class="field">Markdown, up to 4000 characters
        <textarea name="notes" maxlength="4000" style="min-height:200px">${esc(rel.notes)}</textarea></label>`,
      validate: v => (v.notes.trim() ? null : 'Release notes cannot be empty.'),
    });
    if (!ok) return;
    const r = await api(`${API}/firmware/${rel.release_id}`, { method: 'PATCH', body: JSON.stringify({ notes: ok.notes }) });
    if (!r.ok) { alert(r.data.message || 'Could not save the notes.'); return; }
    await load();
  }

  const ACTIONS = { review, publish, delete: removeDraft, yank, channel: setChannel, notes: editNotes };
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const rel = byId.get(btn.dataset.id);
    if (rel) ACTIONS[btn.dataset.act](rel);
  });
  const act = (rel, name, text, cls = 'btn-outline') => `<button type="button" class="btn ${cls} btn-sm" data-act="${name}" data-id="${esc(rel.release_id)}">${text}</button>`;

  // ---------- lists ----------
  function renderDrafts(list) {
    $('drafts').innerHTML = list.length ? `<div class="stack" style="gap:10px">${list.map(r => `
      <div class="set-item">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
          <div><span class="tname">${esc(r.target)}</span> <b>${esc(r.version)}</b> <span class="chip tiny draft">draft</span>
            <div class="small muted">${esc(fmtSize(r.size))} · uploaded ${esc(fmtIST(r.meta.uploaded_at))} by ${esc(r.meta.uploaded_by || '–')}</div></div>
          <div class="actions">${act(r, 'review', 'Review', 'btn-outline')}${act(r, 'publish', 'Publish', 'btn-primary')}${act(r, 'delete', 'Delete', 'btn-danger')}</div>
        </div>
      </div>`).join('')}</div>` : '<p class="muted" style="margin:0">No drafts. Upload a release on the left.</p>';
  }

  function renderReleases(list) {
    $('releases').innerHTML = list.length ? list.map(r => {
      const y = r.meta.status === 'yanked';
      return `<tr class="${y ? 'yanked' : ''}">
        <td><span class="tname">${esc(r.target)}</span></td>
        <td><b>${esc(r.version)}</b></td>
        <td>${y ? `<span class="chip tiny yanked">yanked</span><span class="yank-reason">${esc(r.meta.yank_reason)}</span>` : '<span class="chip tiny">published</span>'}</td>
        <td>${r.channel === 'beta' ? '<span class="chip tiny beta">beta</span>' : '<span class="chip tiny">stable</span>'}</td>
        <td class="num">${esc(r.proto)}</td>
        <td>${esc(fmtIST(r.published_at))}</td>
        <td>${esc(r.meta.uploaded_by || '–')}</td>
        <td class="wrap">${md(r.notes)}</td>
        <td><div class="actions">${act(r, 'channel', r.channel === 'stable' ? 'Make beta' : 'Make stable')}${act(r, 'notes', 'Edit notes')}${y ? '' : act(r, 'yank', 'Yank', 'btn-danger')}</div></td>
      </tr>`;
    }).join('') : '<tr class="empty"><td colspan="9">Nothing published yet.</td></tr>';
  }

  function renderLimits() {
    if (!limits) return;
    const s = limits.storage;
    const pct = s ? Math.min(100, (s.bytes / s.free_tier_bytes) * 100) : 0;
    $('limits').innerHTML = `
      <dl class="facts">
        ${TARGETS.map(t => `<div><dt>Max size ${t}</dt><dd>${esc(fmtSize(limits.max_app_size[t]))}<br><span class="small muted">${esc(limits.max_app_size[t])} bytes</span></dd></div>`).join('')}
      </dl>
      ${s ? `<p style="margin:12px 0 0"><b>Firmware storage:</b> ${esc(fmtSize(s.bytes))} in ${esc(s.files)} file${s.files === 1 ? '' : 's'}, of the 512 MB of the MongoDB Atlas free tier
        (which also holds packets and everything else).</p>
        <div class="meter${pct > 90 ? ' full' : pct > 75 ? ' warn' : ''}"><span style="width:${pct.toFixed(1)}%"></span></div>
        <p class="hint" style="margin:0">${pct.toFixed(1)} % used by firmware. Size limits are set on the server (TB_MAX_APP_SIZE_MAIN, _N1, _N2).</p>` : ''}`;
  }

  async function loadLogs() {
    const [d, a] = await Promise.all([api(`${API}/downloads?limit=200`), api(`${API}/audit?limit=200`)]);
    const dl = d.ok && Array.isArray(d.data) ? d.data : [];
    $('downloads').innerHTML = dl.length ? dl.map(x => `<tr><td>${esc(fmtIST(x.at))}</td><td>${esc(x.user?.name || '')}</td>
      <td><span class="tname">${esc(x.target)}</span> ${esc(x.version)}</td><td>${esc(x.kind)}</td><td>${esc(x.via)}</td><td class="mono">${esc(x.ip)}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="6">No downloads yet.</td></tr>';
    const au = a.ok && Array.isArray(a.data) ? a.data : [];
    const detail = x => {
      const dt = x.details || {};
      if (dt.target && dt.version) return `${dt.target} ${dt.version}${dt.reason ? ` · ${dt.reason}` : ''}${dt.kind ? ` · ${dt.kind}` : ''}`;
      if (dt.releases) return dt.releases.map(r => `${r.target} ${r.version}`).join(', ') + (dt.kind ? ` · ${dt.kind}` : '');
      if (dt.to) return `${dt.user?.name || ''}: ${dt.from} → ${dt.to}`;
      if (dt.label) return `token “${dt.label}”`;
      if (dt.bench_mac) return `${dt.bench_mac} · ${dt.result}`;
      return '';
    };
    $('audit').innerHTML = au.length ? au.map(x => `<tr><td>${esc(fmtIST(x.at))}</td><td><b>${esc(x.action)}</b></td><td>${esc(x.user?.name || '')}</td>
      <td class="wrap">${esc(detail(x))}</td><td class="mono">${esc(x.ip)}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="5">Nothing yet.</td></tr>';
  }

  async function load() {
    const [all, lim] = await Promise.all([api(`${API}/firmware?include_yanked=true&include_drafts=true`), api(`${API}/limits`)]);
    if (all.status === 401) return toLogin();
    if (lim.ok) { limits = lim.data; renderLimits(); }
    const list = all.ok && Array.isArray(all.data) ? all.data : [];
    byId = new Map(list.map(r => [r.release_id, r]));
    renderDrafts(list.filter(r => r.meta.status === 'draft'));
    renderReleases(list.filter(r => r.meta.status !== 'draft'));
    loadLogs();
  }

  header('firmware').then(user => {
    if (!user) return;
    if (user.role !== 'admin') { $('content').classList.add('hidden'); $('no-access').classList.remove('hidden'); return; }
    load();
  });
})();
