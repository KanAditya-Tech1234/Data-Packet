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

  const ROLE_NAMES = { admin: 'admin', engineer: 'engineer', none: 'no access' };

  /** Render the sticky header. active: 'packets' | 'map' | 'firmware' | 'settings' | 'help' | 'docs' */
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
          ${link('/firmware', 'firmware', 'Firmware')}
          ${link('/settings', 'settings', 'Settings')}
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
        <div class="who role">Firmware role: <b>${esc(ROLE_NAMES[u.role] || 'no access')}</b></div>
        <a href="/access" role="menuitem">${u.role === 'admin' ? 'Users and API tokens' : 'My API tokens'}</a>
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

  const fmtSize = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

  /**
   * Safe Markdown for release notes: everything is escaped first, then headings, lists, code,
   * **bold**, *italic* and [links](https://…) are added. No raw HTML ever gets through.
   */
  function md(text) {
    const inline = s => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const out = [];
    let list = null, code = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const line of String(text || '').split('\n')) {
      if (code) {
        if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else code.push(line);
        continue;
      }
      if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[2])}</h4>`); }
      else if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
    }
    if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    flushPara(); flushList();
    return `<div class="md">${out.join('')}</div>`;
  }

  /**
   * A modal dialog. Resolves with the form values (object) when confirmed, or null when cancelled.
   * opts: { title, html, confirmText, danger, validate(values) -> error text or null, wide }
   */
  function dialog({ title, html, confirmText = 'OK', danger = false, validate = null, wide = false }) {
    return new Promise(resolve => {
      const d = document.createElement('dialog');
      d.className = wide ? 'dlg wide' : 'dlg';
      d.innerHTML = `<form method="dialog" class="form-stack">
          <h2 class="section-title" style="margin:0">${esc(title)}</h2>
          <div class="dlg-body">${html || ''}</div>
          <div class="dlg-error status err hidden" role="alert"></div>
          <div class="actions dlg-actions">
            <button type="button" class="btn btn-outline" value="cancel" data-cancel>Cancel</button>
            <button type="submit" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" value="ok">${esc(confirmText)}</button>
          </div>
        </form>`;
      document.body.appendChild(d);
      const form = d.querySelector('form');
      let result = null;
      d.querySelector('[data-cancel]').addEventListener('click', () => d.close());
      form.addEventListener('submit', e => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(form).entries());
        const check = validate ? validate(values) : null;
        if (check) { const box = d.querySelector('.dlg-error'); box.textContent = check; box.classList.remove('hidden'); return; }
        result = values;
        d.close();
      });
      d.addEventListener('close', () => { d.remove(); resolve(result); });
      d.showModal();
      const first = d.querySelector('input, textarea, select');
      if (first) first.focus(); else d.querySelector('[type=submit]').focus();
    });
  }

  window.DT = { esc, fmtIST, fmtInt, fmtSize, api, header, showStatus, md, dialog };
})();
