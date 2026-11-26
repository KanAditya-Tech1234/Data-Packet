/* Firmware download page for field engineers (SERVER_OTA_HANDOFF.md §6). */
(function () {
  'use strict';
  const { esc, fmtIST, fmtSize, api, header, md, dialog } = window.DT;
  const $ = id => document.getElementById(id);
  const API = '/api/tb/v1';
  const TARGETS = ['main', 'n1', 'n2'];
  const BOARDS = { main: 'Main node: ESP32 DevKit V1 (load cells are wired here)', n1: 'Node 1: ESP32-C3, temperature + RPM', n2: 'Node 2: ESP32-C3, voltage + current' };

  const beta = $('show-beta');
  beta.checked = new URLSearchParams(location.search).get('channel') === 'beta';
  const channel = () => (beta.checked ? 'beta' : 'stable');

  const reqText = r => {
    const parts = Object.entries(r || {}).map(([t, c]) => `${t} ${c.replace('>=', '≥ ')}`);
    return parts.length ? parts.join(', ') : 'none';
  };
  const chChip = ch => (ch === 'beta' ? '<span class="chip tiny beta">beta</span>' : '<span class="chip tiny">stable</span>');

  /** Start a download; yanked releases ask first (§6). */
  async function download(rel, kind) {
    if (rel.meta.status === 'yanked') {
      const ok = await dialog({
        title: `${rel.target} ${rel.version} was yanked`, danger: true, confirmText: 'Download anyway',
        html: `<p>This release was withdrawn and should not normally be installed.</p>
          <p class="status err" style="margin:0">Reason: ${esc(rel.meta.yank_reason || '–')}</p>`,
      });
      if (!ok) return;
    }
    const a = document.createElement('a');
    a.href = rel.meta.urls[kind];
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  }

  const buttons = (rel, big) => `
    <div class="actions"${big ? ' style="margin-top:12px"' : ''}>
      <button type="button" class="btn ${big ? 'btn-accent' : 'btn-outline btn-sm'}" data-dl="package" data-id="${esc(rel.release_id)}">${big ? `Download ${esc(rel.meta.package)}` : '.tbfw'}</button>
      <button type="button" class="btn btn-outline btn-sm" data-dl="bin" data-id="${esc(rel.release_id)}">.bin</button>
      <button type="button" class="btn btn-outline btn-sm" data-dl="manifest" data-id="${esc(rel.release_id)}">manifest.json</button>
    </div>`;

  let byId = new Map();

  function renderLatest(rel, target) {
    if (!rel) return `<p class="muted" style="margin:0">No ${channel() === 'stable' ? 'stable ' : ''}release for ${target} yet.</p>`;
    return `
      <dl class="facts">
        <div><dt>Latest ${rel.channel}</dt><dd class="big" style="font-size:22px;color:var(--forest)">${esc(rel.version)} ${rel.channel === 'beta' ? chChip('beta') : ''}</dd></div>
        <div><dt>Proto</dt><dd>${esc(rel.proto)}</dd></div>
        <div><dt>Requires</dt><dd>${esc(reqText(rel.requires))}</dd></div>
        <div><dt>Published (IST)</dt><dd>${esc(fmtIST(rel.published_at))}</dd></div>
        <div><dt>Size</dt><dd>${esc(fmtSize(rel.size))} (${esc(rel.size)} bytes)</dd></div>
        <div><dt>Built with</dt><dd>${esc(rel.built_with || '–')}</dd></div>
        <div class="wide" style="grid-column:1/-1"><dt>MD5</dt><dd class="mono">${esc(rel.md5)}</dd></div>
        <div class="wide" style="grid-column:1/-1"><dt>Release notes</dt><dd>${md(rel.notes)}</dd></div>
      </dl>
      ${buttons(rel, true)}`;
  }

  function renderHistory(list) {
    if (!list.length) return '<tr class="empty"><td colspan="9">No releases yet.</td></tr>';
    return list.map(r => {
      const y = r.meta.status === 'yanked';
      return `<tr class="${y ? 'yanked' : ''}">
        <td><b>${esc(r.version)}</b>${y ? ' <span class="chip tiny yanked">yanked</span>' : ''}</td>
        <td>${chChip(r.channel)}</td>
        <td class="num">${esc(r.proto)}</td>
        <td>${esc(reqText(r.requires))}</td>
        <td>${esc(fmtIST(r.published_at))}</td>
        <td class="num">${esc(fmtSize(r.size))}</td>
        <td class="mono" title="${esc(r.md5)}">${esc(r.md5.slice(0, 10))}…</td>
        <td class="wrap">${y ? `<span class="yank-reason">Yanked: ${esc(r.meta.yank_reason)}</span>` : ''}${md(r.notes)}</td>
        <td>${buttons(r, false)}</td>
      </tr>`;
    }).join('');
  }

  async function loadSet() {
    const r = await api(`${API}/firmware/compatible-set?channel=${channel()}`);
    const box = $('set');
    if (r.status === 404) { const m = r.data.message || 'no compatible set yet'; box.innerHTML = `<p class="muted" style="margin:0">${esc(m.charAt(0).toUpperCase() + m.slice(1))}.</p>`; return; }
    if (!r.ok) { box.innerHTML = `<p class="status err">${esc(r.data.message || 'Could not load the compatible set.')}</p>`; return; }
    for (const t of TARGETS) byId.set(r.data[t].release_id, r.data[t]);
    box.innerHTML = `<div class="set-row">${TARGETS.map(t => `
        <div class="set-item"><span class="tname">${t}</span> ${r.data[t].channel === 'beta' ? chChip('beta') : ''}
          <div class="v">${esc(r.data[t].version)}</div><div class="small muted">proto ${esc(r.data[t].proto)} · ${esc(fmtSize(r.data[t].size))}</div></div>`).join('')}
      </div>
      <a class="btn btn-accent" href="${API}/firmware/compatible-set/package?channel=${channel()}" download>Download all three (one ZIP of three .tbfw)</a>`;
  }

  async function loadTargets() {
    const host = $('targets');
    const r = await api(`${API}/firmware?include_yanked=true${channel() === 'beta' ? '&channel=beta' : ''}`);
    if (!r.ok) { host.innerHTML = `<section class="card"><p class="status err">${esc(r.data.message || 'Could not load the releases.')}</p></section>`; return; }
    const all = Array.isArray(r.data) ? r.data : [];
    for (const rel of all) byId.set(rel.release_id, rel);
    host.replaceChildren();
    for (const t of TARGETS) {
      const list = all.filter(x => x.target === t);
      const latest = list.find(x => x.meta.status === 'published' && (channel() === 'beta' || x.channel === 'stable')) || null;
      const node = $('target-tpl').content.cloneNode(true);
      const f = n => node.querySelector(`[data-f="${n}"]`);
      f('name').textContent = t;
      f('title').textContent = t === 'main' ? 'Main node' : `Node ${t.slice(1)}`;
      f('board').textContent = BOARDS[t];
      f('latest').innerHTML = renderLatest(latest, t);
      f('history').innerHTML = renderHistory(list);
      host.appendChild(node);
    }
  }

  async function loadBenches() {
    const r = await api(`${API}/benches`);
    const body = $('benches');
    if (!r.ok) { body.innerHTML = `<tr class="empty"><td colspan="7">${esc(r.data.message || 'Could not load.')}</td></tr>`; return; }
    const list = Array.isArray(r.data) ? r.data : [];
    body.innerHTML = list.length ? list.map(b => `<tr>
        <td class="mono">${esc(b.bench_mac)}</td>
        ${TARGETS.map(t => `<td>${b.versions && b.versions[t] ? `<b>${esc(b.versions[t])}</b>` : '<span class="muted">–</span>'}</td>`).join('')}
        <td>${b.last_ok_at ? esc(fmtIST(b.last_ok_at)) : '<span class="muted">none</span>'}</td>
        <td>${esc(b.last_report.target)} ${esc(b.last_report.version)}: <b>${esc(b.last_report.result)}</b></td>
        <td class="num">${esc(b.reports)}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="7">No install reports yet. The dashboard sends them after an OTA, once it is back online.</td></tr>';
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-dl]');
    if (!btn) return;
    const rel = byId.get(btn.dataset.id);
    if (rel) download(rel, btn.dataset.dl);
  });

  function load() {
    byId = new Map();
    const u = new URL(location.href);
    if (beta.checked) u.searchParams.set('channel', 'beta'); else u.searchParams.delete('channel');
    history.replaceState(null, '', u.pathname + u.search);
    return Promise.all([loadSet(), loadTargets(), loadBenches()]);
  }
  beta.addEventListener('change', load);

  header('firmware').then(user => {
    if (!user) return;
    if (user.role === 'none' || !user.role) { $('content').classList.add('hidden'); $('no-access').classList.remove('hidden'); return; }
    if (user.role === 'admin') $('admin-link').classList.remove('hidden');
    load();
  });
})();
