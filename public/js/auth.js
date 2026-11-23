/* Log in and Register forms. */
(function () {
  'use strict';
  const { api, showStatus } = window.DT;
  const form = document.getElementById('auth-form');
  const statusBox = document.getElementById('status');
  const mode = form.dataset.mode;
  const button = form.querySelector('button[type=submit]');
  const next = new URLSearchParams(location.search).get('next') || '/';

  const loginLink = document.querySelector('.switch a');
  if (loginLink && next !== '/') loginLink.href += `?next=${encodeURIComponent(next)}`;

  for (const t of form.querySelectorAll('.pw-toggle')) {
    t.addEventListener('click', () => {
      const input = t.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      t.textContent = show ? 'Hide' : 'Show';
      t.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  }

  function localCheck(v) {
    const phone = v.phone.replace(/[\s()-]/g, '').replace(/^(\+91|91(?=\d{10}$)|0(?=\d{10}$))/, '');
    if (mode === 'register') {
      if (v.name.trim().length < 2) return 'Enter your name.';
      if (!/^[6-9]\d{9}$/.test(phone)) return 'Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email.trim())) return 'Enter a valid email address.';
      if (v.password.length < 8 || !/[a-z]/.test(v.password) || !/[A-Z]/.test(v.password) || !/\d/.test(v.password)) {
        return 'Use a password of at least 8 characters with an upper-case letter, a lower-case letter and a digit.';
      }
    } else {
      if (!/^[6-9]\d{9}$/.test(phone)) return 'Enter your 10-digit mobile number.';
      if (!v.password) return 'Enter your password.';
    }
    return null;
  }

  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    const problem = localCheck(v);
    if (problem) { showStatus(statusBox, 'err', problem); return; }
    button.disabled = true;
    showStatus(statusBox, null);
    try {
      const body = mode === 'login' ? { phone: v.phone, password: v.password, next } : v;
      const r = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(body) });
      if (r.ok) {
        showStatus(statusBox, 'ok', mode === 'login' ? 'Logged in. Opening the dashboard…' : 'Account created. Opening the dashboard…');
        location.href = r.data.next || (mode === 'login' ? '/' : (next.startsWith('/') && !next.startsWith('//') ? next : '/'));
        return;
      }
      const list = (r.data.errors || []).map(x => cap(x.replace(/^\w+: /, '')));
      showStatus(statusBox, r.status === 429 ? 'warn' : 'err', cap(r.data.message) || 'Something went wrong. Try again.', list.length > 1 ? list : []);
    } catch {
      showStatus(statusBox, 'err', 'Could not reach the server. Check your connection and try again.');
    }
    button.disabled = false;
  });
})();
