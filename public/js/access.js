/* Users (roles) and API tokens for the firmware API (SERVER_OTA_HANDOFF.md §7, §9). */
(function () {
  'use strict';
  const { esc, fmtIST, api, header, showStatus, dialog } = window.DT;
  const $ = id => document.getElementById(id);
  const API = '/api/tb/v1';
  let me = null;

  const status = t => (t.revoked_at ? `<span class="chip tiny yanked">revoked ${esc(fmtIST(t.revoked_at))}</span>` : '<span class="chip tiny">active</span>');
  const revokeBtn = t => (t.revoked_at ? '' : `<button type="button" class="btn btn-danger btn-sm" data-revoke="${esc(t.id)}" data-label="${esc(t.label)}">Revoke</button>`);

  async function loadMine() {
    const r = await api(`${API}/tokens`);
    const list = r.ok && Array.isArray(r.data) ? r.data : [];
    $('my-tokens').innerHTML = list.length ? list.map(t => `<tr>
        <td><b>${esc(t.label)}</b></td><td>${esc(fmtIST(t.created_at))}</td>
        <td>${t.last_used_at ? esc(fmtIST(t.last_used_at)) : '<span class="muted">never</span>'}</td><td>${status(t)}</td><td>${revokeBtn(t)}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="5">No tokens yet.</td></tr>';
  }

  async function loadAdmin() {
    const [u, t] = await Promise.all([api(`${API}/users`), api(`${API}/tokens?all=true`)]);
    const users = u.ok && Array.isArray(u.data) ? u.data : [];
    $('users').innerHTML = users.map(x => {
      const fixed = x.role_fixed || x.phone === me.phone;
      const sel = `<select data-role="${esc(x.phone)}" data-name="${esc(x.name)}" aria-label="Role of ${esc(x.name)}" ${fixed ? 'disabled' : ''} style="min-width:140px">
          ${['admin', 'engineer', 'none'].map(r => `<option value="${r}"${x.role === r ? ' selected' : ''}>${r === 'none' ? 'no access' : r}</option>`).join('')}</select>`;
      const why = x.role_fixed ? '<span class="hint">set by ADMIN_PHONES on the server</span>' : x.phone === me.phone ? '<span class="hint">you</span>' : '';
      return `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.phone)}</td><td>${esc(x.email)}</td><td>${esc(fmtIST(x.created_at))}</td>
        <td class="num">${esc(x.active_tokens)}</td><td>${sel} ${why}</td></tr>`;
    }).join('') || '<tr class="empty"><td colspan="6">No users.</td></tr>';
    const tokens = t.ok && Array.isArray(t.data) ? t.data : [];
    $('all-tokens').innerHTML = tokens.length ? tokens.map(x => `<tr>
        <td>${esc(x.user?.name || '')} <span class="muted small">${esc(x.user?.phone || '')}</span></td><td><b>${esc(x.label)}</b></td>
        <td>${esc(fmtIST(x.created_at))}</td><td>${x.last_used_at ? esc(fmtIST(x.last_used_at)) : '<span class="muted">never</span>'}</td>
        <td>${status(x)}</td><td>${revokeBtn(x)}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="6">No tokens yet.</td></tr>';
  }

  const reload = () => Promise.all([loadMine(), me.role === 'admin' ? loadAdmin() : null]);

  $('tok-form').addEventListener('submit', async e => {
    e.preventDefault();
    const label = $('tok-label').value.trim();
    if (!label) { showStatus($('tok-status'), 'err', 'Give the token a name, e.g. “Field laptop 2”.'); return; }
    $('tok-btn').disabled = true;
    const r = await api(`${API}/tokens`, { method: 'POST', body: JSON.stringify({ label }) });
    $('tok-btn').disabled = false;
    if (!r.ok) { showStatus($('tok-status'), 'err', r.data.message || 'Could not create the token.'); return; }
    showStatus($('tok-status'), null);
    $('tok-label').value = '';
    const box = $('tok-new');
    box.classList.remove('hidden');
    box.innerHTML = `<div class="token-box">
        <b>Token “${esc(r.data.label)}” created. Copy it now: it is not shown again.</b>
        <code id="tok-value">${esc(r.data.token)}</code>
        <div class="actions"><button type="button" class="btn btn-accent btn-sm" id="tok-copy">Copy</button>
          <span class="hint">Use it as <code>Authorization: Bearer ${esc(r.data.token.slice(0, 10))}…</code></span></div>
      </div>`;
    $('tok-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.data.token); $('tok-copy').textContent = 'Copied'; } catch { $('tok-copy').textContent = 'Select and copy it'; }
    });
    reload();
  });

  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-revoke]');
    if (!btn) return;
    const ok = await dialog({ title: `Revoke token “${btn.dataset.label}”?`, danger: true, confirmText: 'Revoke',
      html: '<p style="margin:0">Anything using this token stops working at once. This cannot be undone.</p>' });
    if (!ok) return;
    const r = await api(`${API}/tokens/${btn.dataset.revoke}`, { method: 'DELETE' });
    if (!r.ok) alert(r.data.message || 'Could not revoke the token.');
    reload();
  });

  document.addEventListener('change', async e => {
    const sel = e.target.closest('[data-role]');
    if (!sel) return;
    const role = sel.value;
    const ok = await dialog({
      title: `Make ${sel.dataset.name} ${role === 'none' ? '“no access”' : `an ${role}`}?`, danger: role === 'none', confirmText: 'Change role',
      html: role === 'none' ? '<p style="margin:0">They lose firmware access and all their API tokens are revoked.</p>'
        : role === 'admin' ? '<p style="margin:0">Admins can upload, publish and yank firmware and manage users.</p>'
          : '<p style="margin:0">Engineers can list and download firmware and create API tokens.</p>',
    });
    if (!ok) { reload(); return; }
    const r = await api(`${API}/users/${sel.dataset.role}`, { method: 'PATCH', body: JSON.stringify({ role }) });
    if (!r.ok) alert(r.data.message || 'Could not change the role.');
    reload();
  });

  header('access').then(user => {
    if (!user) return;
    me = user;
    if (user.role === 'none' || !user.role) { $('content').classList.add('hidden'); $('no-access').classList.remove('hidden'); return; }
    if (user.role === 'admin') {
      $('title').textContent = 'Users and API tokens';
      $('users-card').classList.remove('hidden');
      $('all-tokens-card').classList.remove('hidden');
    }
    reload();
  });
})();
