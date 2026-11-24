/* Drone Tag – Data Packets: shared browser helpers (header, escaping, time format). */
(function () {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
  const pad = n => String(n).padStart(2, '0');

  /** ISO / Date -> "DD-MM-YYYY HH:MM:SS IST" */
  function fmtIST(value) {
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) return '';
    const d = new Date(t + 5.5 * 3600 * 1000);
    return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} IST`;
  }

  const fmtInt = n => Number(n || 0).toLocaleString('en-IN');

  async function api(url, options = {}) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, ...options });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  /** Render the sticky header. active: 'packets' | 'map' | 'help' | 'docs' */
  async function header(active) {
    const host = document.getElementById('app-header');
    if (!host) return null;
    const link = (href, key, text) => `<a href="${href}"${key === active ? ' class="active" aria-current="page"' : ''}>${text}</a>`;
    host.innerHTML = `
      <header class="topbar"><div class="inner">
        <a class="brand" href="/">
          <img src="/images/logo.png" alt="">
          <span><b>DRONE TAG</b><small>Abhyuday Bharat · data packets</small></span>
        </a>
        <nav class="nav" aria-label="Main">
          ${link('/', 'packets', 'Data packets')}
          ${link('/map', 'map', 'Map')}
          ${link('/help', 'help', 'Help')}
          ${link('/docs', 'docs', 'API docs')}
          <div class="user-menu" id="user-menu"></div>
        </nav>
      </div></header>`;

    const r = await api('/api/auth/me');
    const box = document.getElementById('user-menu');
    if (!r.ok) {
      box.innerHTML = '<a href="/login">Log in</a>';
      return null;
    }
    const u = r.data.user;
    const initial = (u.name || '?').trim().charAt(0).toUpperCase() || '?';
    box.innerHTML = `
      <button class="user-btn" type="button" aria-haspopup="true" aria-expanded="false" id="user-btn">
        <span class="avatar" aria-hidden="true">${esc(initial)}</span><span class="uname">${esc(u.name)}</span>
        <span class="sr-only">Account menu</span>
      </button>
      <div class="menu" id="user-dropdown" role="menu">
        <div class="who"><b>${esc(u.name)}</b>${esc(u.phone)}<br>${esc(u.email)}</div>
        <a href="/help" role="menuitem">Help</a>
        <button type="button" role="menuitem" id="logout-btn">Log out</button>
      </div>`;
    const btn = document.getElementById('user-btn');
    const menu = document.getElementById('user-dropdown');
    const setOpen = open => { menu.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', e => { e.stopPropagation(); setOpen(!menu.classList.contains('open')); });
    document.addEventListener('click', e => { if (!box.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      location.href = '/login';
    });
    return u;
  }

  function showStatus(el, kind, message, list) {
    if (!el) return;
    if (!message) { el.className = 'hidden'; el.innerHTML = ''; return; }
    el.className = `status ${kind}`;
    const items = (list || []).filter(x => x && x !== message);
    el.innerHTML = esc(message) + (items.length ? `<ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  }

  window.DT = { esc, fmtIST, fmtInt, api, header, showStatus };
})();
