// ---------- Supabase client ----------
// Renamed to `sb` to avoid clashing with the global `supabase` object the
// CDN script attaches to `window`.
const sb = window.supabase.createClient(
  window.CTORQ_CONFIG.SUPABASE_URL,
  window.CTORQ_CONFIG.SUPABASE_ANON_KEY
);

let currentUser = null;
let currentProfile = null;

// ---------- IndexedDB: the offline queue ----------
const DB_NAME = 'ctorq-workflow';
const STORE = 'entries';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    req.onerror = () => reject(req.error);
  });
}

async function updateEntry(entry) {
  return addEntry(entry); // put() overwrites by id either way
}

// ---------- UI plumbing ----------
function $(id) { return document.getElementById(id); }

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2500);
}

function setActiveTab(name) {
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('section.panel').forEach(s => s.classList.toggle('active', s.id === name));
  if (name === 'queue') renderQueue();
  if (name === 'admin') renderTeamList();
}

document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});

$('type').addEventListener('change', () => {
  const isTimesheet = $('type').value === 'timesheet';
  $('hoursLabel').style.display = isTimesheet ? 'block' : 'none';
  $('hours').style.display = isTimesheet ? 'block' : 'none';
  $('hours').required = isTimesheet;
});
$('type').dispatchEvent(new Event('change'));

function updateOnlineBadge() {
  const badge = $('statusBadge');
  const online = navigator.onLine;
  badge.textContent = online ? 'Online' : 'Offline — saving locally';
  badge.className = online ? 'online' : 'offline';
}
window.addEventListener('online', () => { updateOnlineBadge(); syncQueue(); });
window.addEventListener('offline', updateOnlineBadge);
updateOnlineBadge();

// =====================================================================
// AUTH
// =====================================================================

function showAuthView(view) {
  ['loginView', 'forgotView', 'setPasswordView'].forEach(id => {
    $(id).style.display = id === view ? 'block' : 'none';
  });
  $('authMsg').textContent = '';
}

$('showForgot').addEventListener('click', (e) => { e.preventDefault(); showAuthView('forgotView'); });
$('backToLogin').addEventListener('click', (e) => { e.preventDefault(); showAuthView('loginView'); });

$('loginBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) return;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) $('authMsg').textContent = error.message;
});

$('sendResetBtn').addEventListener('click', async () => {
  const email = $('forgotEmail').value.trim();
  if (!email) return;
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.CTORQ_CONFIG.APP_URL}/index.html#recovery`
  });
  $('authMsg').textContent = error ? error.message : 'Check your email for a reset link.';
});

$('setPasswordBtn').addEventListener('click', async () => {
  const p1 = $('newPassword').value;
  const p2 = $('confirmPassword').value;
  if (!p1 || p1.length < 8) {
    $('authMsg').textContent = 'Use at least 8 characters.';
    return;
  }
  if (p1 !== p2) {
    $('authMsg').textContent = "Passwords don't match.";
    return;
  }
  const { error } = await sb.auth.updateUser({ password: p1 });
  if (error) { $('authMsg').textContent = error.message; return; }

  // First-time invite acceptance: flip the profile from 'invited' to 'active'.
  if (currentUser) {
    await sb.from('profiles').update({ status: 'active' }).eq('id', currentUser.id);
  }
  showToast('Password set — welcome in.');
  await enterApp();
});

$('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  currentUser = null;
  currentProfile = null;
  $('appShell').style.display = 'none';
  $('authScreen').style.display = 'flex';
  showAuthView('loginView');
});

async function loadProfile(user) {
  const { data } = await sb.from('profiles').select('*').eq('id', user.id).single();
  return data;
}

async function enterApp() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  currentUser = user;
  currentProfile = await loadProfile(user);

  $('authScreen').style.display = 'none';
  $('appShell').style.display = 'block';
  $('accountEmail').textContent = user.email;
  $('adminTabBtn').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';

  renderQueue();
  syncQueue();
}

// Handles both the invite link and the "forgot password" recovery link —
// Supabase fires PASSWORD_RECOVERY for recovery links; for a brand new
// invite, the profile's status is still 'invited', so we route based on that.
sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    currentUser = session.user;
    $('setPasswordIntro').textContent = 'Choose a new password.';
    $('authScreen').style.display = 'flex';
    $('appShell').style.display = 'none';
    showAuthView('setPasswordView');
    return;
  }

  if (event === 'SIGNED_IN' && session) {
    const profile = await loadProfile(session.user);
    currentUser = session.user;
    currentProfile = profile;
    if (profile && profile.status === 'invited') {
      $('setPasswordIntro').textContent = 'Welcome! Set a password to finish joining.';
      $('authScreen').style.display = 'flex';
      $('appShell').style.display = 'none';
      showAuthView('setPasswordView');
    } else {
      await enterApp();
    }
  }

  if (event === 'SIGNED_OUT') {
    $('appShell').style.display = 'none';
    $('authScreen').style.display = 'flex';
    showAuthView('loginView');
  }
});

// On first load, check whether a session already exists (e.g. returning user).
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    const profile = await loadProfile(session.user);
    currentUser = session.user;
    currentProfile = profile;
    if (profile && profile.status === 'invited') {
      $('setPasswordIntro').textContent = 'Welcome! Set a password to finish joining.';
      showAuthView('setPasswordView');
      $('authScreen').style.display = 'flex';
    } else {
      await enterApp();
    }
  } else {
    $('authScreen').style.display = 'flex';
  }
})();

// =====================================================================
// ADMIN — invite teammates by email
// =====================================================================

$('sendInviteBtn').addEventListener('click', async () => {
  const email = $('inviteEmail').value.trim();
  const fullName = $('inviteName').value.trim();
  if (!email) return;

  const { data: { session } } = await sb.auth.getSession();
  const { data, error } = await sb.functions.invoke('invite-user', {
    body: { email, fullName },
    headers: { Authorization: `Bearer ${session.access_token}` }
  });

  if (error || data?.error) {
    showToast(`Invite failed: ${data?.error || error.message}`);
    return;
  }
  showToast(`Invite sent to ${email}.`);
  $('inviteEmail').value = '';
  $('inviteName').value = '';
  renderTeamList();
});

async function renderTeamList() {
  const list = $('teamList');
  const { data, error } = await sb
    .from('profiles')
    .select('email, full_name, role, status, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    list.innerHTML = `<div class="empty">Couldn't load team list.</div>`;
    return;
  }
  if (!data.length) {
    list.innerHTML = '<div class="empty">No one invited yet.</div>';
    return;
  }
  list.innerHTML = data.map(p => `
    <div class="entry">
      <span class="type-icon">${p.role === 'admin' ? '👑' : '🙂'}</span>
      <div class="entry-body">
        <div class="entry-meta">${escapeHtml(p.full_name || p.email)}</div>
        <div class="entry-desc">${escapeHtml(p.email)}</div>
      </div>
      <span class="chip ${p.status === 'active' ? 'synced' : 'pending'}">${p.status}</span>
    </div>
  `).join('');
}

// =====================================================================
// ENTRIES — offline-first save, server-side sync
// =====================================================================

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip data: prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$('entryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const photoFile = $('photo').files[0];
  const photoBase64 = await fileToBase64(photoFile);

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: $('type').value,
    userLabel: currentProfile?.full_name || currentUser.email,
    project: $('project').value.trim(),
    date: $('date').value,
    hours: $('type').value === 'timesheet' ? parseFloat($('hours').value || '0') : null,
    description: $('description').value.trim(),
    photo: photoBase64,
    photoName: photoFile ? photoFile.name : null,
    createdAt: new Date().toISOString(),
    status: 'pending', // pending | synced | error
    error: null
  };

  await addEntry(entry);
  $('entryForm').reset();
  $('type').dispatchEvent(new Event('change'));
  showToast(navigator.onLine ? 'Saved — submitting…' : 'Saved locally — will submit when online');
  setActiveTab('queue');
  syncQueue();
});

async function renderQueue() {
  const list = $('entryList');
  const entries = await getAllEntries();
  if (!entries.length) {
    list.innerHTML = '<div class="empty">No entries yet.</div>';
    return;
  }
  const TYPE_ICON = { timesheet: '🕒', progress: '📈', data: '📋' };
  list.innerHTML = entries.map(en => `
    <div class="entry">
      <span class="type-icon">${TYPE_ICON[en.type] || '📄'}</span>
      <div class="entry-body">
        <div class="entry-meta">${en.type} · ${en.project || '—'} · ${en.date}${en.hours ? ' · ' + en.hours + 'h' : ''}</div>
        <div class="entry-desc">${escapeHtml(en.description || '')}</div>
      </div>
      <span class="chip ${en.status}">${en.status}</span>
    </div>
  `).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
$('syncNowBtn').addEventListener('click', () => syncQueue());

// Every entry becomes its own file (unique name) written by the
// submit-entry Edge Function, so there's nothing to merge and no risk of
// two devices overwriting the same file. The GitHub token never touches
// this code — only the Edge Function holds it.
let syncing = false;

async function syncQueue() {
  if (syncing || !navigator.onLine || !currentUser) return;
  syncing = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;

    const entries = await getAllEntries();
    const pending = entries.filter(e => e.status !== 'synced');
    for (const entry of pending) {
      try {
        const { data, error } = await sb.functions.invoke('submit-entry', {
          body: entry,
          headers: { Authorization: `Bearer ${session.access_token}` }
        });
        if (error || data?.error) throw new Error(data?.error || error.message);
        entry.status = 'synced';
        entry.error = null;
      } catch (err) {
        entry.status = 'error';
        entry.error = String(err.message || err);
      }
      await updateEntry(entry);
    }
    if (pending.length) {
      showToast(`Synced ${pending.filter(e => e.status === 'synced').length}/${pending.length} entries.`);
      renderQueue();
    }
  } finally {
    syncing = false;
  }
}

// Try a sync shortly after load and every few minutes while the tab is open.
window.addEventListener('load', () => setTimeout(syncQueue, 1500));
setInterval(syncQueue, 5 * 60 * 1000);

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(console.error);
  });
}
