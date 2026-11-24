/* Map page: the path of one drone from its data packets, updated live (Server-Sent Events). */
(async function () {
  'use strict';
  const { esc, fmtIST, fmtInt, api, header, showStatus } = window.DT;
  const $ = id => document.getElementById(id);
  const MAX_POINTS = 500;   // the database keeps the latest 500 packets, so a drone never has more

  const select = $('tracker');
  const liveChip = $('live');
  const countChip = $('count');
  const followBox = $('follow');
  const statusBox = $('status');
  const emptyBox = $('map-empty');
  const latestBox = $('latest');
  const tableLink = $('table-link');

  let trackerId = new URLSearchParams(location.search).get('id') || '';
  let points = [];          // packets of this drone, oldest first
  let dots = [];            // one circle per point (same order as points)
  let lastSeq = 0;
  let source = null;
  let retryTimer = null;
  let generation = 0;       // bumps when the drone changes
  let popupOpen = false;
  const known = new Set();

  header('map');

  // ---------- map ----------
  const map = L.map('map', { preferCanvas: true }).setView([22.6, 78.9], 5);
  // OpenStreetMap refuses tiles (403 "Access blocked") without a Referer. The site's own policy sends none
  // to other sites, so the tiles send just the site's origin (e.g. https://….onrender.com), as OSM asks.
  const TILE_REFERRER = 'strict-origin-when-cross-origin';
  const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors', referrerPolicy: TILE_REFERRER,
  });
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Imagery &copy; Esri', referrerPolicy: TILE_REFERRER,
  });
  street.addTo(map);
  L.control.layers({ 'Street map': street, Satellite: satellite }, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  // Green pin = first point of the path, arrow = current position (pointing where the drone is heading).
  const pinSvg = (color, size = 30) => `
    <svg width="${size}" height="${Math.round(size * 4 / 3)}" viewBox="0 0 30 40" aria-hidden="true">
      <path d="M15 38.5S27.5 23.6 27.5 14a12.5 12.5 0 0 0-25 0c0 9.6 12.5 24.5 12.5 24.5z" fill="${color}" stroke="#fff" stroke-width="2.5"/>
      <circle cx="15" cy="14" r="5" fill="#fff"/>
    </svg>`;
  const arrowSvg = (size = 34) => `
    <svg width="${size}" height="${size}" viewBox="0 0 34 34" aria-hidden="true">
      <path d="M17 2.5 30 31 17 24.2 4 31z" fill="#0b3d2e" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
    </svg>`;
  const PATH_COLOR = '#b45309';
  const startIcon = L.divIcon({ className: 'map-pin', html: pinSvg('#16a34a'), iconSize: [30, 40], iconAnchor: [15, 39], popupAnchor: [0, -36] });
  const arrowIcon = L.divIcon({
    className: 'map-arrow',
    html: '<div class="arrow-halo"></div><div class="arrow-body">' + arrowSvg() + '</div>',
    iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16],
  });

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const box = L.DomUtil.create('div', 'map-legend');
    box.innerHTML = '<b>Legend</b>' +
      `<div class="legend-row"><span class="legend-icon">${pinSvg('#16a34a', 15)}</span>Start of the path</div>` +
      `<div class="legend-row"><span class="legend-icon">${arrowSvg(17)}</span>Current drone position</div>` +
      `<div class="legend-row"><span class="legend-icon"><svg width="18" height="6" aria-hidden="true"><rect y="1" width="18" height="4" rx="2" fill="${PATH_COLOR}"/></svg></span>Path flown</div>`;
    L.DomEvent.disableClickPropagation(box);
    return box;
  };
  legend.addTo(map);

  const pathLine = L.polyline([], { color: PATH_COLOR, weight: 4, opacity: 0.9, interactive: false }).addTo(map);
  const dotLayer = L.layerGroup().addTo(map);
  const startMark = L.marker([0, 0], { icon: startIcon });
  const arrowMark = L.marker([0, 0], { icon: arrowIcon, zIndexOffset: 1000 });

  map.on('popupopen', () => { popupOpen = true; });
  map.on('popupclose', () => { popupOpen = false; });
  // Dragging the map means the user wants to look around: stop following.
  map.on('dragstart', () => { followBox.checked = false; });

  // ---------- helpers ----------
  const num = (v, digits) => (typeof v === 'number' && Number.isFinite(v) ? (digits === undefined ? String(v) : v.toFixed(digits)) : '–');
  const ll = p => [p.lat, p.lon];
  // Latitude / longitude exactly as sent, up to 8 decimals (no padding zeros): 23.07814312, 72.5312
  const coordText = v => v.toFixed(8).replace(/\.?0+$/, '');
  const coord = v => (typeof v === 'number' && Number.isFinite(v) ? coordText(v) : '–');
  const timeText = p => fmtIST(p.recordedAt) + (p.timeSource === 'server' ? ' (received)' : '');

  function popupHtml(p, title) {
    const alt = typeof p.alt === 'number' ? `${num(p.alt)} m${p.altRef ? ' ' + esc(p.altRef) : ''}` : '–';
    return `<div class="map-pop">${title ? `<div class="pop-title">${esc(title)}</div>` : ''}` +
      `<b>Drone:</b> ${esc(p.trackerId)}<br><span class="when"><b>Time:</b> ${esc(timeText(p))}</span><br>` +
      `<b>Lat, Lon:</b> ${coord(p.lat)}, ${coord(p.lon)}<br><b>Altitude:</b> ${alt}</div>`;
  }

  // Compass bearing from a to b in degrees (0 = north, clockwise).
  function bearing(a, b) {
    const r = Math.PI / 180;
    const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  function heading() {
    const last = points[points.length - 1];
    for (let i = points.length - 2; i >= 0; i--) {
      const p = points[i];
      if (p.lat !== last.lat || p.lon !== last.lon) return bearing(p, last);
    }
    return 0;
  }

  function makeDot(p) {
    return L.circleMarker(ll(p), { radius: 4, color: PATH_COLOR, weight: 1.5, fillColor: '#fff', fillOpacity: 1 })
      .bindPopup(() => popupHtml(p)).addTo(dotLayer);
  }

  // Update an open popup in place instead of closing it.
  const setPopup = (m, html) => (m.getPopup() ? m.setPopupContent(html) : m.bindPopup(html));

  function updateMarkers() {
    if (!points.length) { startMark.remove(); arrowMark.remove(); return; }
    const first = points[0];
    const last = points[points.length - 1];
    setPopup(startMark.setLatLng(ll(first)), popupHtml(first, 'Start of the path')).addTo(map);
    setPopup(arrowMark.setLatLng(ll(last)), popupHtml(last, 'Current position')).addTo(map);
    const body = arrowMark.getElement() && arrowMark.getElement().querySelector('.arrow-body');
    if (body) body.style.transform = `rotate(${Math.round(points.length > 1 ? heading() : 0)}deg)`;
  }

  function updateInfo() {
    countChip.textContent = points.length ? `${fmtInt(points.length)} point${points.length === 1 ? '' : 's'}` : 'No points';
    const p = points[points.length - 1];
    if (!p) {
      latestBox.innerHTML = `<div><dt>Drone</dt><dd>${esc(trackerId || '–')}</dd></div><div><dt>Time</dt><dd>No packets yet</dd></div>`;
      return;
    }
    const alt = typeof p.alt === 'number' ? `${num(p.alt)} m${p.altRef ? ' ' + esc(p.altRef) : ''}` : '–';
    latestBox.innerHTML =
      `<div><dt>Drone</dt><dd>${esc(p.trackerId)}</dd></div>` +
      `<div><dt>Time (IST)</dt><dd>${esc(timeText(p))}</dd></div>` +
      `<div><dt>Latitude</dt><dd>${coord(p.lat)}</dd></div>` +
      `<div><dt>Longitude</dt><dd>${coord(p.lon)}</dd></div>` +
      `<div><dt>Altitude</dt><dd>${alt}</dd></div>`;
  }

  function setEmpty(text) {
    emptyBox.textContent = text || '';
    emptyBox.classList.toggle('hidden', !text);
  }

  function fitPath() {
    if (!points.length) return;
    if (points.length === 1) map.setView(ll(points[0]), 17);
    else map.fitBounds(L.latLngBounds(points.map(ll)), { padding: [50, 50], maxZoom: 18 });
  }

  /** Redraw everything for the current points (used after loading). */
  function drawAll() {
    dotLayer.clearLayers();
    dots = points.map(makeDot);
    pathLine.setLatLngs(points.map(ll));
    updateMarkers();
    updateInfo();
    setEmpty(points.length ? '' : `No data packets from drone ${trackerId} yet. Its path will appear here as soon as it sends one.`);
  }

  /** Add one new packet at the end of the path. */
  function addPoint(p) {
    points.push(p);
    dots.push(makeDot(p));
    pathLine.addLatLng(ll(p));
    if (points.length > MAX_POINTS) {   // drop the oldest, like the database does
      points.shift();
      dotLayer.removeLayer(dots.shift());
      pathLine.setLatLngs(points.map(ll));
    }
    updateMarkers();
    updateInfo();
    setEmpty('');
    if (points.length === 1) { fitPath(); return; }
    if (followBox.checked && !popupOpen && !map.getBounds().pad(-0.15).contains(ll(p))) map.panTo(ll(p));
  }

  // ---------- drone list ----------
  function setTrackers(ids) {
    for (const id of ids) known.add(id);
    const list = [...known].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    select.innerHTML = list.length
      ? list.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('')
      : '<option value="">No drones yet</option>';
    const match = list.find(id => id.toLowerCase() === trackerId.toLowerCase());
    if (match) select.value = match;
  }

  function setLive(kind) {
    const states = { live: ['chip live', 'Live'], connecting: ['chip alt', 'Connecting…'], reconnecting: ['chip error', 'Reconnecting…'] };
    const [cls, text] = states[kind];
    liveChip.className = cls;
    liveChip.textContent = text;
    liveChip.dataset.state = kind;
  }

  // ---------- live stream ----------
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
      let p;
      try { p = JSON.parse(e.data); } catch { return; }
      if (!Number.isFinite(p.seq) || p.seq <= lastSeq) return;   // already shown
      lastSeq = p.seq;
      if (!trackerId) {          // no drone had sent anything yet: show the first one that does
        trackerId = p.trackerId;
        setTrackers([p.trackerId]);
        setUrl();
        load();
        return;
      }
      addPoint(p);
    });
    es.onerror = () => {
      if (gen !== generation) return;
      setLive('reconnecting');
      if (es.readyState === EventSource.CLOSED) retryTimer = setTimeout(() => connect(gen), 3000);
    };
  }

  // ---------- loading ----------
  function setUrl() {
    const u = new URL(location.href);
    if (trackerId) u.searchParams.set('id', trackerId); else u.searchParams.delete('id');
    history.replaceState(null, '', u.pathname + u.search);
    tableLink.href = trackerId ? `/?id=${encodeURIComponent(trackerId)}` : '/';
  }

  function failed(gen, r) {
    if (r.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
    showStatus(statusBox, 'err', (r.data && r.data.message) || 'Could not load the data packets. Retrying…');
    setLive('reconnecting');
    retryTimer = setTimeout(() => { if (gen === generation) load(); }, 5000);
  }

  async function load() {
    const gen = ++generation;
    if (source) { source.close(); source = null; }
    clearTimeout(retryTimer);
    points = []; lastSeq = 0;
    map.closePopup();
    showStatus(statusBox, null);
    setLive('connecting');
    countChip.textContent = '–';

    if (!trackerId) {
      // No drone chosen: pick the one that sent the newest packet.
      let r;
      try { r = await api('/api/packet?limit=1'); } catch { r = { ok: false, status: 0, data: {} }; }
      if (gen !== generation) return;
      if (!r.ok) { failed(gen, r); return; }
      setTrackers(r.data.trackers || []);
      const newest = (r.data.packets || [])[0];
      if (!newest) {
        drawAll();
        setEmpty('No drone has sent a data packet yet. The map will show the first drone that does.');
        countChip.textContent = 'No points';
        lastSeq = r.data.seq || 0;
        connect(gen);
        return;
      }
      trackerId = newest.trackerId;
      setUrl();
    }

    setEmpty('Loading the path…');
    let r;
    try { r = await api(`/api/packet/${encodeURIComponent(trackerId)}?limit=${MAX_POINTS}`); } catch { r = { ok: false, status: 0, data: {} }; }
    if (gen !== generation) return;
    if (r.status === 404) {
      setTrackers([trackerId, ...(r.data.trackers || [])]);
      drawAll();
      connect(gen);
      return;
    }
    if (!r.ok) { failed(gen, r); return; }
    setTrackers(r.data.trackers || []);
    points = (r.data.packets || []).slice(-MAX_POINTS);
    lastSeq = r.data.seq || 0;
    drawAll();
    fitPath();
    connect(gen);
  }

  // ---------- controls ----------
  select.addEventListener('change', () => {
    if (!select.value) return;
    trackerId = select.value;
    followBox.checked = true;
    setUrl();
    load();
  });
  $('fit').addEventListener('click', () => { followBox.checked = false; fitPath(); });
  followBox.addEventListener('change', () => {
    if (followBox.checked && points.length) map.panTo(ll(points[points.length - 1]));
  });
  addEventListener('popstate', () => { trackerId = new URLSearchParams(location.search).get('id') || ''; load(); });
  addEventListener('pagehide', () => { if (source) source.close(); });

  setUrl();
  load();
})();
