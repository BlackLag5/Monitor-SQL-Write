const $ = (s) => document.querySelector(s);
let setup = false;

async function request(url, options) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function show(message) {
  $('#authError').textContent = message;
  $('#authError').hidden = false;
}

async function init() {
  try {
    const s = await request('/api/auth/status');
    if (s.authenticated) return (location.href = '/price.html');
    setup = s.setupRequired;
    if (setup) {
      $('#modeLabel').textContent = 'FIRST-TIME SETUP';
      $('#title').textContent = 'Create administrator';
      $('#intro').textContent = 'Create the first administrator account to secure this app.';
      $('#displayLabel').hidden = false;
      $('#confirmLabel').hidden = false;
      $('#submitButton').textContent = 'Create administrator';
    }
  } catch (err) {
    show(err.message);
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#authError').hidden = true;
  $('#submitButton').disabled = true;
  try {
    const password = $('#password').value;
    if (setup && password !== $('#confirmPassword').value) throw new Error('Passwords do not match');
    const body = { username: $('#username').value, password, displayName: $('#displayName').value };
    await request(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
    location.href = '/price.html';
  } catch (err) {
    show(err.message);
    $('#submitButton').disabled = false;
  }
});

init();
