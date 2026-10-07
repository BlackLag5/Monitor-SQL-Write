const $ = (id) => document.getElementById(id);
const state = { users: [], editing: null, isAdmin: false };

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Authentication required');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function showBanner(el, kind, text) {
  const div = document.createElement('div');
  div.className = 'banner ' + kind;
  div.textContent = text;
  el.appendChild(div);
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/* ---------- User management (admin only) ---------- */

function renderUsers() {
  const body = $('usersBody');
  body.innerHTML = '';
  if (!state.users.length) {
    body.innerHTML = '<tr><td colspan="6" style="color:#64748b">No users yet.</td></tr>';
    return;
  }
  for (const u of state.users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(u.username)}</strong><div class="hint">${esc(u.displayName || '')}</div></td>
      <td><span class="pill ${u.isAdmin ? 'admin' : 'user'}">${u.isAdmin ? 'Admin' : 'User'}</span></td>
      <td><span class="pill ${u.active ? 'active' : 'inactive'}">${u.active ? 'Active' : 'Inactive'}</span></td>
      <td>${esc(fmtDate(u.createdAt))}</td>
      <td>${esc(fmtDate(u.lastLoginAt))}</td>
      <td class="table-actions">
        <button class="secondary" data-edit="${u.id}">Edit</button>
        <button class="danger" data-delete="${u.id}">Delete</button>
      </td>`;
    body.appendChild(tr);
  }
}

function openUserDialog(user = null) {
  state.editing = user;
  $('userDialogTitle').textContent = user ? 'Edit user' : 'Add user';
  $('userUsername').value = user ? user.username : '';
  $('userUsername').disabled = !!user;
  $('userDisplayName').value = user ? (user.displayName || '') : '';
  $('userPassword').value = '';
  $('userPasswordHint').textContent = user ? 'Leave blank to keep the current password.' : 'At least 10 characters.';
  $('userAdmin').checked = user ? !!user.isAdmin : false;
  $('userActive').checked = user ? !!user.active : true;
  $('userDialogError').style.display = 'none';
  $('userDialog').showModal();
}

function closeUserDialog() {
  $('userDialog').close();
}

function showDialogError(msg) {
  const el = $('userDialogError');
  el.textContent = msg;
  el.style.display = 'block';
}

async function saveUser() {
  const username = $('userUsername').value.trim();
  const displayName = $('userDisplayName').value.trim();
  const password = $('userPassword').value;
  const isAdmin = $('userAdmin').checked;
  const active = $('userActive').checked;

  const body = { displayName, isAdmin, active };
  if (!state.editing) {
    if (!username) return showDialogError('Username is required.');
    if (!password) return showDialogError('Password is required.');
    if (password.length < 10) return showDialogError('Password must be at least 10 characters.');
    body.username = username;
    body.password = password;
  } else if (password) {
    if (password.length < 10) return showDialogError('Password must be at least 10 characters.');
    body.password = password;
  }

  try {
    if (state.editing) {
      await api('/api/admin/users/' + state.editing.id, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
    }
    closeUserDialog();
    await loadUsers();
  } catch (err) {
    showDialogError(err.message);
  }
}

async function deleteUser(id) {
  const u = state.users.find((x) => String(x.id) === String(id));
  if (!confirm(`Delete user "${u ? u.username : id}"? This cannot be undone.`)) return;
  try {
    await api('/api/admin/users/' + id, { method: 'DELETE' });
    await loadUsers();
  } catch (err) {
    showBanner($('messages'), 'error', err.message);
  }
}

async function loadUsers() {
  state.users = await api('/api/admin/users');
  renderUsers();
}

/* ---------- Change my password ---------- */

async function changePassword() {
  $('passwordMsg').innerHTML = '';
  const currentPassword = $('currentPassword').value;
  const newPassword = $('newPassword').value;
  const confirmPassword = $('confirmPassword').value;
  if (!currentPassword) return showBanner($('passwordMsg'), 'warn', 'Enter your current password.');
  if (newPassword.length < 10) return showBanner($('passwordMsg'), 'warn', 'New password must be at least 10 characters.');
  if (newPassword !== confirmPassword) return showBanner($('passwordMsg'), 'warn', 'New passwords do not match.');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    $('currentPassword').value = '';
    $('newPassword').value = '';
    $('confirmPassword').value = '';
    showBanner($('passwordMsg'), 'ok', 'Password changed.');
  } catch (err) {
    showBanner($('passwordMsg'), 'error', err.message);
  }
}

/* ---------- Init ---------- */

(async () => {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) return (location.href = '/login.html');
    const u = await r.json();
    $('sidebarUser').textContent = u.displayName || u.username;
    state.isAdmin = !!u.isAdmin;
    if (state.isAdmin) {
      $('usersSection').style.display = 'block';
      await loadUsers();
    }
  } catch {
    location.href = '/login.html';
  }
})();

$('addUserBtn').onclick = () => openUserDialog();
$('userDialogClose').onclick = closeUserDialog;
$('userDialogCancel').onclick = closeUserDialog;
$('userDialogSave').onclick = saveUser;
$('usersBody').addEventListener('click', (e) => {
  if (e.target.dataset.edit) openUserDialog(state.users.find((u) => String(u.id) === e.target.dataset.edit));
  if (e.target.dataset.delete) deleteUser(e.target.dataset.delete);
});
$('changePasswordBtn').onclick = changePassword;
$('logoutBtn').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
};
