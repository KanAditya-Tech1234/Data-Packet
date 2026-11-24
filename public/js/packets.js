/* Data packets page: initial load + live Server-Sent Events feed. */
(async function () {
  'use strict';
  const { esc, fmtIST, fmtInt, api, header, showStatus } = window.DT;
  const $ = id => document.getElementById(id);
  const MAX_ROWS = 100;   // the dashboard shows only the newest 100 packets
  const EMPTY = 'No data packets yet. They will appear here as soon as a drone sends one.';

  const tbody = $('rows');
  const select = $('tracker');
  const liveChip = $('live');
  const countChip = $('count');
  const pauseBtn = $('pause');
  const waiting = $('waiting');
  const statusBox = $('status');
  const exportLink = $('export');
  const mapLink = $('map-link');

  let trackerId = new URLSearchParams(location.search).get('id') || '';
  let shown = new Set();   // seq numbers in the table
  let lastSeq = 0;         // newest seq known (the stream continues from here)
  let total = 0;           // packets stored for this view
  let source = null;
  let retryTimer = null;
  let paused = false;
  let held = [];           // packets that arrived while paused
  let generation = 0;      // bumps when the drone filter changes
  const known = new Set();

  header('packets');

  // ---------- rendering ----------
  const dash = '<td class="num none">–</td>';
  const numCell = (v, digits) => (typeof v === 'number' && Number.isFinite(v)
    ? `<td class="num">${esc(digits === undefined ? String(v) : v.toFixed(digits))}</td>` : dash);
  const textCell = v => (v === null || v === undefined || v === '' ? '<td class="none">–</td>' : `<td>${esc(v)}</td>`);

  function rowHtml(p) {
    const src = p.timeSource === 'server' ? '<span class="src">(received)</span>' : '';
    return `<td>${esc(fmtIST(p.recordedAt))}${src}</td>${textCell(p.trackerId)}` +
      numCell(p.lat, 6) + numCell(p.lon, 6) + numCell(p.alt) + textCell(p.altRef) +
      numCell(p.dx) + numCell(p.dy) + numCell(p.dz);
  }

  function setEmpty(text) {
    tbody.innerHTML = `<tr class="empty"><td colspan="9">${esc(text)}</td></tr>`;
  }

  function updateCount() {
    const n = shown.size;
    countChip.textContent = total > n
      ? `${fmtInt(total)} packets (latest ${fmtInt(n)} shown)`
      : `${fmtInt(total)} packet${total === 1 ? '' : 's'}`;
  }

  /** Add packets (oldest first) at the top of the table. Rows already shown are never redrawn. */
  function addPackets(list, { flash }) {
    const fresh = list.filter(p => !shown.has(p.seq));
    if (!fresh.length) return;
    const empty = tbody.querySelector('tr.empty');
    if (empty) empty.remove();
    const frag = document.createDocumentFragment();
    for (let i = fresh.length - 1; i >= 0; i--) {   // newest first
      const p = fresh[i];
      const tr = document.createElement('tr');
      tr.dataset.seq = p.seq;
      tr.innerHTML = rowHtml(p);
      if (flash) {
        tr.classList.add('flash');
        tr.addEventListener('animationend', () => tr.classList.remove('flash'), { once: true });
      }
      frag.appendChild(tr);
      shown.add(p.seq);
    }
    tbody.insertBefore(frag, tbody.firstChild);
    while (tbody.rows.length > MAX_ROWS) {
      const last = tbody.rows[tbody.rows.length - 1];
      shown.delete(Number(last.dataset.seq));
      last.remove();
    }
    updateCount();
  }

  function addTrackers(ids) {
    let added = false;
    for (const id of ids) {
      if (!id || known.has(id.toLowerCase())) continue;
      known.add(id.toLowerCase());
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = id;
      select.appendChild(opt);
      added = true;
    }
    if (added) {   // keep the list sorted after "All drones"
      const opts = [...select.options].slice(1).sort((a, b) => a.value.localeCompare(b.value, 'en', { numeric: true }));
      opts.forEach(o => select.appendChild(o));
    }
    select.value = trackerId;
  }

  function setLive(kind) {
    const map = {
      live: ['chip live', 'Live'], connecting: ['chip alt', 'Connecting…'],
      reconnecting: ['chip error', 'Reconnecting…'], paused: ['chip alt', 'Paused'],
    };
    const [cls, text] = map[paused ? 'paused' : kind];
    liveChip.className = cls;
    liveChip.textContent = text;
    liveChip.dataset.state = kind;
  }

  function updateWaiting() {
    const n = held.length;
    waiting.textContent = paused && n ? `${fmtInt(n)} new packet${n === 1 ? '' : 's'} waiting` : '';
  }

  // ---------- live stream ----------
  function onPacket(p) {
    // The stream delivers packets in seq order, so anything at or below lastSeq was already received.
    if (!Number.isFinite(p.seq) || p.seq <= lastSeq) return;
    lastSeq = p.seq;
    total += 1;
    addTrackers([p.trackerId]);
    if (paused) { held.push(p); updateWaiting(); updateCount(); return; }
    addPackets([p], { flash: true });
  }

  function connect(gen) {
    if (gen !== generation) return;
    if (source) source.close();
    clearTimeout(retryTimer);
    const q = new URLSearchParams({ since: String(lastSeq) });
    if (trackerId) q.set('trackerId', trackerId);
    const es = new EventSource(`/api/packet-stream?${q}`);
    source = es;
    setLive(liveChip.dataset.state === 'live' || liveChip.dataset.state === 'reconnecting' ? 'reconnecting' : 'connecting');
    es.onopen = () => { if (gen === generation) setLive('live'); };
    es.addEventListener('packet', e => {
      if (gen !== generation) return;
      try { onPacket(JSON.parse(e.data)); } catch { /* ignore a bad event */ }
    });
    es.onerror = () => {
      if (gen !== generation) return;
      setLive('reconnecting');
      // The browser reconnects by itself (sending Last-Event-ID). If it gave up, start a new stream.
      if (es.readyState === EventSource.CLOSED) retryTimer = setTimeout(() => connect(gen), 3000);
    };
  }

  // ---------- initial load ----------
  async function load() {
    const gen = ++generation;
    if (source) { source.close(); source = null; }
    clearTimeout(retryTimer);
    shown = new Set(); held = []; lastSeq = 0; total = 0;
    updateWaiting();
    setLive('connecting');
    setEmpty('Loading data packets…');
    countChip.textContent = '–';
    showStatus(statusBox, null);
    exportLink.href = trackerId ? `/api/export.csv?id=${encodeURIComponent(trackerId)}` : '/api/export.csv';
    mapLink.href = trackerId ? `/map?id=${encodeURIComponent(trackerId)}` : '/map';

    const url = trackerId ? `/api/packet/${encodeURIComponent(trackerId)}?limit=${MAX_ROWS}` : `/api/packet?limit=${MAX_ROWS}`;
    let r;
    try { r = await api(url); } catch { r = { ok: false, status: 0, data: {} }; }
    if (gen !== generation) return;
    if (r.status === 404 && trackerId) {
      addTrackers(r.data.trackers || []);
      lastSeq = 0;
      setEmpty(`No data packets from drone ${trackerId} yet. They will appear here as soon as it sends one.`);
      total = 0; updateCount();
      connect(gen);
      return;
    }
    if (!r.ok) {
      if (r.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
      showStatus(statusBox, 'err', r.data.message || 'Could not load the data packets. Retrying…');
      setEmpty('Could not load the data packets.');
      setLive('reconnecting');
      retryTimer = setTimeout(() => { if (gen === generation) load(); }, 5000);
      return;
    }
    const d = r.data;
    addTrackers(d.trackers || []);
    lastSeq = d.seq || 0;
    total = d.total ?? d.count ?? 0;
    if (!d.packets.length) { setEmpty(EMPTY); updateCount(); }
    else addPackets(d.packets, { flash: false });
    connect(gen);
  }

  // ---------- controls ----------
  select.addEventListener('change', () => {
    trackerId = select.value;
    const u = new URL(location.href);
    if (trackerId) u.searchParams.set('id', trackerId); else u.searchParams.delete('id');
    history.replaceState(null, '', u.pathname + u.search);
    paused = false;
    pauseBtn.textContent = 'Pause'; pauseBtn.setAttribute('aria-pressed', 'false');
    load();
  });

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-pressed', String(paused));
    if (!paused && held.length) {
      const list = held.sort((a, b) => a.seq - b.seq);
      held = [];
      addPackets(list, { flash: true });
    }
    updateWaiting();
    setLive(source && source.readyState === EventSource.OPEN ? 'live' : (liveChip.dataset.state || 'connecting'));
  });

  addEventListener('popstate', () => { trackerId = new URLSearchParams(location.search).get('id') || ''; load(); });
  addEventListener('pagehide', () => { if (source) source.close(); });

  select.value = trackerId;
  if (trackerId && !known.has(trackerId.toLowerCase())) addTrackers([trackerId]);
  load();
})();
