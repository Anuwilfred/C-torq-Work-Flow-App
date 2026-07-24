// ---------- Supabase client ----------
const sb = window.supabase.createClient(
  window.CTORQ_CONFIG.SUPABASE_URL,
  window.CTORQ_CONFIG.SUPABASE_ANON_KEY
);

let currentUser = null;
let currentProfile = null;
let selectedMode = null; // mode-of-work chip currently selected

const LEAVE_MODES = ['sick_leave', 'holiday', 'emergency_leave'];
const MODE_LABEL = {
  office: 'Office', site: 'Site', driver: 'Driver', wfh: 'Work from Home',
  exhibition: 'Exhibition', inspection: 'Inspection', field_work: 'Field Work', other: 'Other',
  sick_leave: 'Sick Leave', holiday: 'Holiday', emergency_leave: 'Emergency Leave'
};

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
  return addEntry(entry);
}

// ---------- UI plumbing ----------
function $(id) { return document.getElementById(id); }

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

function setActiveTab(name) {
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('section.panel').forEach(s => s.classList.toggle('active', s.id === name));
  if (name === 'queue') renderQueue();
  if (name === 'admin') renderTeamList();
  if (name === 'reports') initReportsTab();
  if (name === 'settings') refreshPushStatus();
}
document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});

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
// ENTRY FORM — type switching, mode-of-work, conditional fields
// =====================================================================

function refreshTypeVisibility() {
  const isTimesheet = $('type').value === 'timesheet';
  $('timesheetBlock').style.display = isTimesheet ? 'block' : 'none';
  $('simpleBlock').style.display = isTimesheet ? 'none' : 'block';
  if (isTimesheet) refreshModeVisibility();
}
$('type').addEventListener('change', refreshTypeVisibility);

function refreshModeVisibility() {
  const isLeave = LEAVE_MODES.includes(selectedMode);
  const hasMode = !!selectedMode;
  $('workModeFields').classList.toggle('active', hasMode && !isLeave);
  $('leaveModeFields').classList.toggle('active', hasMode && isLeave);
  $('sickDocField').style.display = selectedMode === 'sick_leave' ? 'block' : 'none';
}

document.querySelectorAll('.mode-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    selectedMode = chip.dataset.mode;
    document.querySelectorAll('.mode-chip').forEach(c => c.classList.toggle('selected', c === chip));
    refreshModeVisibility();
  });
});

// Default date fields to today for convenience (still fully editable/manual).
const today = new Date().toISOString().slice(0, 10);
$('date').value = today;
$('dateSimple').value = today;

refreshTypeVisibility();

// ---------- Geolocation -> reverse geocode (free, no API key: OSM Nominatim) ----------
$('fetchLocationBtn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    showToast('Location not supported on this device — type it manually.');
    return;
  }
  const btn = $('fetchLocationBtn');
  btn.disabled = true;
  btn.textContent = '📍 Locating…';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=16`,
          { headers: { Accept: 'application/json' } }
        );
        const data = await res.json();
        $('location').value = data.display_name || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      } catch {
        $('location').value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      } finally {
        btn.disabled = false;
        btn.textContent = '📍 Use my location';
      }
    },
    () => {
      showToast('Could not get location — type it manually.');
      btn.disabled = false;
      btn.textContent = '📍 Use my location';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ---------- File -> base64 helpers ----------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function filesToAttachments(fileList) {
  const files = Array.from(fileList || []);
  return Promise.all(files.map(async (f) => ({
    name: f.name,
    mime: f.type || 'application/octet-stream',
    base64: await fileToBase64(f)
  })));
}

// =====================================================================
// REVIEW STEP
// =====================================================================

let pendingEntryDraft = null; // built when "Review & Submit" is clicked, actually saved on confirm

function rowHtml(k, v) {
  if (v === undefined || v === null || v === '') return '';
  return `<div class="review-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`;
}

async function buildDraftFromForm() {
  const type = $('type').value;
  const base = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    userLabel: currentProfile?.full_name || currentUser.email,
    createdAt: new Date().toISOString(),
    status: 'pending',
    error: null
  };

  if (type === 'timesheet') {
    if (!selectedMode) { showToast('Pick a mode of work first.'); return null; }
    const isLeave = LEAVE_MODES.includes(selectedMode);

    if (isLeave) {
      if (!$('leaveStart').value || !$('leaveEnd').value) {
        showToast('Fill in the start and end date.');
        return null;
      }
      let effectiveMode = selectedMode;
      let sickDocAttachment = null;
      if (selectedMode === 'sick_leave') {
        const file = $('sickDoc').files[0];
        if (file) {
          sickDocAttachment = { name: file.name, mime: file.type || 'application/octet-stream', base64: await fileToBase64(file) };
        } else {
          effectiveMode = 'leave'; // no proof -> recorded as general leave, not sick leave
        }
      }
      return {
        ...base,
        category: 'leave',
        mode: effectiveMode,
        requestedMode: selectedMode,
        jobId: $('jobId').value.trim() || null,
        leaveStart: $('leaveStart').value,
        leaveEnd: $('leaveEnd').value,
        description: $('leaveReason').value.trim(),
        attachments: sickDocAttachment ? [sickDocAttachment] : []
      };
    }

    if (!$('date').value) { showToast('Pick a date.'); return null; }
    return {
      ...base,
      category: 'timesheet',
      mode: selectedMode,
      jobId: $('jobId').value.trim() || null,
      project: $('project').value.trim(),
      location: $('location').value.trim(),
      date: $('date').value,
      startTime: $('startTime').value,
      endTime: $('endTime').value,
      description: $('workNotes').value.trim(),
      attachments: []
    };
  }

  // progress / data
  if (!$('projectSimple').value.trim() || !$('dateSimple').value || !$('descriptionSimple').value.trim()) {
    showToast('Fill in project, date and description.');
    return null;
  }
  return {
    ...base,
    category: type === 'progress' ? 'daily-progress' : 'project-report',
    project: $('projectSimple').value.trim(),
    date: $('dateSimple').value,
    description: $('descriptionSimple').value.trim(),
    attachments: await filesToAttachments($('filesSimple').files)
  };
}

function showReview(draft) {
  const rows = [];
  if (draft.type === 'timesheet') {
    rows.push(rowHtml('Mode', MODE_LABEL[draft.requestedMode || draft.mode]));
    if (draft.requestedMode === 'sick_leave' && draft.mode === 'leave') {
      rows.push(rowHtml('Note', 'No document attached — recorded as general Leave'));
    }
    rows.push(rowHtml('Job ID', draft.jobId));
    if (draft.category === 'leave') {
      rows.push(rowHtml('Start date', draft.leaveStart));
      rows.push(rowHtml('End date', draft.leaveEnd));
    } else {
      rows.push(rowHtml('Project', draft.project));
      rows.push(rowHtml('Location', draft.location));
      rows.push(rowHtml('Date', draft.date));
      rows.push(rowHtml('Start time', draft.startTime));
      rows.push(rowHtml('End time', draft.endTime));
    }
    rows.push(rowHtml('Notes', draft.description));
  } else {
    rows.push(rowHtml('Type', draft.type === 'progress' ? 'Daily Progress' : 'Project Report'));
    rows.push(rowHtml('Project', draft.project));
    rows.push(rowHtml('Date', draft.date));
    rows.push(rowHtml('Description', draft.description));
  }
  if (draft.attachments?.length) {
    rows.push(rowHtml('Attachments', draft.attachments.map(a => a.name).join(', ')));
  }
  $('reviewContent').innerHTML = rows.join('');
  $('reviewOverlay').classList.add('show');
}

$('reviewBtn').addEventListener('click', async () => {
  if (!currentUser) { showToast('Please log in first.'); return; }
  const draft = await buildDraftFromForm();
  if (!draft) return;
  pendingEntryDraft = draft;
  showReview(draft);
});

$('reviewBackBtn').addEventListener('click', () => {
  $('reviewOverlay').classList.remove('show');
});

$('reviewConfirmBtn').addEventListener('click', async () => {
  if (!pendingEntryDraft) return;
  await addEntry(pendingEntryDraft);
  $('reviewOverlay').classList.remove('show');
  $('entryForm').reset();
  selectedMode = null;
  document.querySelectorAll('.mode-chip').forEach(c => c.classList.remove('selected'));
  $('date').value = today;
  $('dateSimple').value = today;
  refreshTypeVisibility();
  showToast(navigator.onLine ? 'Saved — submitting…' : 'Saved locally — will submit when online');
  setActiveTab('queue');
  syncQueue();
  pendingEntryDraft = null;
});

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
    redirectTo: `${window.CTORQ_CONFIG.APP_URL}/index.html`
  });
  $('authMsg').textContent = error ? error.message : 'Check your email for a reset link.';
});

$('setPasswordBtn').addEventListener('click', async () => {
  const p1 = $('newPassword').value;
  const p2 = $('confirmPassword').value;
  if (!p1 || p1.length < 8) { $('authMsg').textContent = 'Use at least 8 characters.'; return; }
  if (p1 !== p2) { $('authMsg').textContent = "Passwords don't match."; return; }
  const { error } = await sb.auth.updateUser({ password: p1 });
  if (error) { $('authMsg').textContent = error.message; return; }
  if (currentUser) await sb.from('profiles').update({ status: 'active' }).eq('id', currentUser.id);
  showToast('Password set — welcome in.');
  await enterApp();
});

$('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  currentUser = null;
  currentProfile = null;
  $('appShell').style.display = 'none';
  $('authScreen').style.display = 'flex';
  $('aiOrb').style.display = 'none';
  $('aiOrbLabel').style.display = 'none';
  $('chatOrb').style.display = 'none';
  $('chatOrbLabel').style.display = 'none';
  closeAiChat();
  closeChatOverlay();
  stopPresence();
  if (messagesChannel) { sb.removeChannel(messagesChannel); messagesChannel = null; }
  clearInterval(chatListTimer);
  clearInterval(openChatTimer);
  activeChatId = null; activeChatMeta = null; teamProfiles = []; chatListCache = [];
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
  $('newGroupBtn').style.display = currentProfile?.role === 'admin' ? 'inline-block' : 'none';
  $('aiOrb').style.display = 'flex';
  $('aiOrbLabel').style.display = 'block';
  $('chatOrb').style.display = 'flex';
  $('chatOrbLabel').style.display = 'block';
  startPresence();

  renderQueue();
  syncQueue();
}

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
  if (error) { list.innerHTML = `<div class="empty">Couldn't load team list.</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="empty">No one invited yet.</div>'; return; }
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
// REPORTS — per-person monthly timesheet report (hours, overtime, leave)
// =====================================================================

let reportMonth = null;          // 'YYYY-MM', defaults to current month
let reportTargetEmail = null;    // null = viewing your own report
let reportPersonPopulated = false;

const GAUGE_MAX = {
  totalHours: 200, overtimeHours: 40, daysWorked: 26,
  sickLeaveDays: 5, holidayDays: 6, emergencyLeaveDays: 3,
};

function monthKey(d) { return d.toISOString().slice(0, 7); }
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return monthKey(d);
}
function last12Months(anchorKey) {
  const out = [];
  for (let i = 0; i < 12; i++) out.push(shiftMonth(anchorKey, -i));
  return out;
}

// ---------- Speedometer-style SVG gauge (no external chart library) ----------
function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return ['M', start.x, start.y, 'A', r, r, 0, largeArcFlag, 0, end.x, end.y].join(' ');
}
function gaugeCard(label, value, max, unit, color) {
  const cx = 65, cy = 62, r = 52;
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const valAngle = -90 + pct * 180;
  const bg = describeArc(cx, cy, r, -90, 90);
  const fg = describeArc(cx, cy, r, -90, valAngle);
  const needle = polarToCartesian(cx, cy, r - 12, valAngle);
  return `
    <div class="gauge-card">
      <svg viewBox="0 0 130 74" class="gauge-svg">
        <path d="${bg}" class="gauge-track" />
        <path d="${fg}" class="gauge-fill" style="stroke:${color}" />
        <line x1="${cx}" y1="${cy}" x2="${needle.x}" y2="${needle.y}" class="gauge-needle" />
        <circle cx="${cx}" cy="${cy}" r="4" class="gauge-pivot" />
      </svg>
      <div class="gauge-value">${value}<span class="gauge-unit">${unit}</span></div>
      <div class="gauge-label">${escapeHtml(label)}</div>
    </div>
  `;
}

async function populateReportPersonPicker() {
  const card = $('reportPersonCard');
  if (currentProfile?.role !== 'admin') { card.style.display = 'none'; return; }
  card.style.display = 'block';
  if (reportPersonPopulated) return;
  reportPersonPopulated = true;

  const { data } = await sb.from('profiles').select('email, full_name').order('full_name', { ascending: true });
  const select = $('reportPerson');
  const people = data || [];
  select.innerHTML = people.map(p =>
    `<option value="${escapeHtml(p.email)}">${escapeHtml(p.full_name || p.email)}${p.email === currentUser.email ? ' (you)' : ''}</option>`
  ).join('');
  select.value = currentUser.email;
  select.addEventListener('change', () => {
    reportTargetEmail = select.value === currentUser.email ? null : select.value;
    fetchAndRenderReport();
  });
}

function renderMonthStrip() {
  const strip = $('monthStrip');
  const months = last12Months(monthKey(new Date()));
  strip.innerHTML = months.map(key => {
    const [y, m] = key.split('-');
    const short = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return `<div class="month-pill ${key === reportMonth ? 'active' : ''}" data-month="${key}">${short}<br>${y}</div>`;
  }).join('');
  strip.querySelectorAll('.month-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      reportMonth = pill.dataset.month;
      renderMonthStrip();
      $('reportMonthLabel').textContent = monthLabel(reportMonth);
      fetchAndRenderReport();
    });
  });
}

function hoursBarChart(dayRows) {
  if (!dayRows.length) return '<div class="empty">No hours to chart yet.</div>';
  const chartH = 110;
  const maxH = Math.max(10, ...dayRows.map(r => r.hours || 0));
  const bars = dayRows.map(r => {
    const day = r.date ? new Date(r.date + 'T00:00:00Z').getUTCDate() : '?';
    const normalH = Math.min(r.hours || 0, 8);
    const otH = r.overtime || 0;
    const normalPx = Math.round((normalH / maxH) * chartH);
    const otPx = Math.round((otH / maxH) * chartH);
    return `
      <div class="hbar-col" title="${escapeHtml(r.date || '')}: ${r.hours}h">
        <div class="hbar-stack" style="height:${chartH}px">
          ${otPx > 0 ? `<div class="hbar-ot" style="height:${otPx}px"></div>` : ''}
          <div class="hbar-normal" style="height:${normalPx}px"></div>
        </div>
        <div class="hbar-day">${day}</div>
      </div>
    `;
  }).join('');
  return `<div class="hbar-chart">${bars}</div>`;
}

function renderReportTable(data) {
  const wrap = $('reportTableWrap');
  if (!data.dayRows.length) {
    wrap.innerHTML = '<div class="empty">No timesheet entries this month.</div>';
    return;
  }
  const rows = data.dayRows.map(r => `
    <tr>
      <td>${escapeHtml(r.date || '—')}</td>
      <td>${escapeHtml(MODE_LABEL[r.mode] || r.mode)}</td>
      <td>${escapeHtml(r.project || '—')}</td>
      <td>${r.hours}h</td>
      <td class="${r.overtime > 0 ? 'ot' : ''}">${r.overtime > 0 ? r.overtime + 'h' : '—'}</td>
    </tr>
  `).join('');
  wrap.innerHTML = `
    <table class="report-table">
      <thead><tr><th>Date</th><th>Mode</th><th>Project</th><th>Hours</th><th>Overtime</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderReport(data) {
  const t = data.totals;
  $('gaugeGrid').innerHTML = [
    gaugeCard('Total Hours', t.totalHours, GAUGE_MAX.totalHours, 'h', 'var(--accent)'),
    gaugeCard('Overtime', t.overtimeHours, GAUGE_MAX.overtimeHours, 'h', 'var(--warn)'),
    gaugeCard('Days Worked', t.daysWorked, GAUGE_MAX.daysWorked, '', 'var(--accent-2)'),
    gaugeCard('Sick Leave', t.sickLeaveDays, GAUGE_MAX.sickLeaveDays, 'd', 'var(--err)'),
    gaugeCard('Holiday', t.holidayDays, GAUGE_MAX.holidayDays, 'd', 'var(--ok)'),
    gaugeCard('Emergency', t.emergencyLeaveDays, GAUGE_MAX.emergencyLeaveDays, 'd', 'var(--warn)'),
  ].join('');
  $('hoursChart').innerHTML = hoursBarChart(data.dayRows);
  renderReportTable(data);
}

async function fetchAndRenderReport() {
  if (!currentUser) return;
  $('gaugeGrid').innerHTML = '<div class="empty">Loading…</div>';
  $('reportTableWrap').innerHTML = '';
  try {
    const { data: { session } } = await sb.auth.getSession();
    const { data, error } = await sb.functions.invoke('get-report', {
      body: { targetEmail: reportTargetEmail, month: reportMonth },
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (error || data?.error) throw new Error(data?.error || error.message);
    renderReport(data);
  } catch (err) {
    $('gaugeGrid').innerHTML = `<div class="empty">Couldn't load report: ${escapeHtml(String(err.message || err))}</div>`;
  }
}

async function initReportsTab() {
  if (!reportMonth) reportMonth = monthKey(new Date());
  $('reportMonthLabel').textContent = monthLabel(reportMonth);
  await populateReportPersonPicker();
  renderMonthStrip();
  fetchAndRenderReport();
}

$('reportPrevMonth').addEventListener('click', () => {
  reportMonth = shiftMonth(reportMonth || monthKey(new Date()), -1);
  $('reportMonthLabel').textContent = monthLabel(reportMonth);
  renderMonthStrip();
  fetchAndRenderReport();
});
$('reportNextMonth').addEventListener('click', () => {
  reportMonth = shiftMonth(reportMonth || monthKey(new Date()), 1);
  $('reportMonthLabel').textContent = monthLabel(reportMonth);
  renderMonthStrip();
  fetchAndRenderReport();
});

// =====================================================================
// CHAT — Slack/WhatsApp-style groups + DMs, live via Supabase Realtime
// =====================================================================

let teamProfiles = [];          // cached team list (excluding self) for DM/group pickers
let chatListCache = [];         // [{ id, type, name, memberNames, lastLine, lastAt }]
let activeChatId = null;
let activeChatMeta = null;
let messagesChannel = null;     // realtime subscription for the open thread
let chatListTimer = null;
let openChatTimer = null;       // backup poll for the open thread, in case realtime drops (flaky mobile networks)
let pendingChatAttachment = null; // { file } selected but not yet sent
let onlineUserIds = new Set();  // who's currently online, via Supabase Realtime Presence
let presenceChannel = null;

// ---------- Chat overlay (floating icon, bottom-left) ----------
function openChatOverlay() {
  $('chatOverlayBackdrop').classList.add('show');
  $('chatOverlay').classList.add('show');
  initChatTab();
}
function closeChatOverlay() {
  $('chatOverlayBackdrop').classList.remove('show');
  $('chatOverlay').classList.remove('show');
}
$('chatOrb').addEventListener('click', openChatOverlay);
$('chatOverlayBackdrop').addEventListener('click', closeChatOverlay);
$('chatCloseBtn').addEventListener('click', closeChatOverlay);
$('chatHomeBtn').addEventListener('click', closeChatOverlay);

// ---------- Online presence — who's currently in the app ----------
function startPresence() {
  if (presenceChannel || !currentUser) return;
  presenceChannel = sb.channel('presence:online', { config: { presence: { key: currentUser.id } } });
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      onlineUserIds = new Set(Object.keys(presenceChannel.presenceState()));
      renderChatList();
      updateThreadPresence();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await presenceChannel.track({ online_at: new Date().toISOString() });
    });
}
function stopPresence() {
  if (presenceChannel) { sb.removeChannel(presenceChannel); presenceChannel = null; }
  onlineUserIds = new Set();
}
function updateThreadPresence() {
  const dot = $('chatThreadPresence');
  const statusText = $('chatThreadStatus');
  if (!dot) return;
  const other = activeChatMeta?.type === 'dm'
    ? (activeChatMeta.memberProfiles || []).find((p) => p.id !== currentUser.id)
    : null;
  const isOnline = !!(other && onlineUserIds.has(other.id));
  dot.style.display = other ? 'inline-block' : 'none';
  dot.classList.toggle('online', isOnline);
  if (statusText) {
    statusText.textContent = other ? (isOnline ? 'Online' : '') : '';
    statusText.classList.toggle('online', isOnline);
  }
}

async function loadTeamProfiles() {
  const { data } = await sb.from('profiles').select('id, email, full_name').neq('id', currentUser.id);
  teamProfiles = data || [];
}

function chatDisplayName(chatRow) {
  if (chatRow.type === 'group') return chatRow.name || 'Group';
  const other = (chatRow.memberProfiles || []).find((p) => p.id !== currentUser.id);
  return other ? (other.full_name || other.email) : 'Direct message';
}

async function fetchChatList() {
  const { data, error } = await sb
    .from('chats')
    .select('id, type, name, created_at, chat_members(user_id, profiles(id, full_name, email))');
  if (error) return [];

  const rows = (data || []).map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    memberProfiles: (c.chat_members || []).map((m) => m.profiles).filter(Boolean),
  }));

  // Grab each chat's most recent message for the preview line, in parallel.
  const withPreview = await Promise.all(rows.map(async (r) => {
    const { data: last } = await sb
      .from('messages')
      .select('content, attachment_name, created_at, sender_id')
      .eq('chat_id', r.id)
      .order('created_at', { ascending: false })
      .limit(1);
    const m = last?.[0];
    return {
      ...r,
      lastLine: m ? (m.content || (m.attachment_name ? `📎 ${m.attachment_name}` : '')) : 'No messages yet',
      lastAt: m?.created_at || null,
    };
  }));

  withPreview.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  return withPreview;
}

function renderChatList() {
  const list = $('chatList');
  if (!chatListCache.length) { list.innerHTML = '<div class="empty">No chats yet — start one above.</div>'; return; }
  list.innerHTML = chatListCache.map((c) => {
    const name = chatDisplayName(c);
    const icon = c.type === 'group' ? '👥' : '🙂';
    let dot = '';
    if (c.type === 'dm') {
      const other = (c.memberProfiles || []).find((p) => p.id !== currentUser.id);
      const isOnline = other && onlineUserIds.has(other.id);
      dot = `<span class="presence-dot ${isOnline ? 'online' : ''}"></span>`;
    }
    return `
      <div class="chat-list-item ${c.id === activeChatId ? 'active' : ''}" data-chat-id="${c.id}">
        <span class="chat-list-avatar">${icon}${dot}</span>
        <div class="chat-list-body">
          <div class="chat-list-name">${escapeHtml(name)}</div>
          <div class="chat-list-preview">${escapeHtml(c.lastLine)}</div>
        </div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.chat-list-item').forEach((el) => {
    el.addEventListener('click', () => openChat(el.dataset.chatId));
  });
}

async function refreshChatList() {
  chatListCache = await fetchChatList();
  renderChatList();
}

async function initChatTab() {
  if (!teamProfiles.length) await loadTeamProfiles();
  await refreshChatList();
  clearInterval(chatListTimer);
  chatListTimer = setInterval(refreshChatList, 20000); // near-real-time list refresh
}

function attachmentMimeIsImage(mime) { return (mime || '').startsWith('image/'); }

async function attachmentUrl(path) {
  const { data } = await sb.storage.from('chat-attachments').createSignedUrl(path, 3600);
  return data?.signedUrl || null;
}

async function renderMessages(rows) {
  const wrap = $('chatMessages');
  const isGroup = activeChatMeta?.type === 'group';
  const parts = await Promise.all(rows.map(async (m) => {
    const mine = m.sender_id === currentUser.id;
    let mediaHtml = '';
    if (m.attachment_path) {
      const url = await attachmentUrl(m.attachment_path);
      if (url && attachmentMimeIsImage(m.attachment_mime)) {
        mediaHtml = `<a href="${url}" target="_blank" rel="noopener"><img class="chat-img" src="${url}" alt="${escapeHtml(m.attachment_name || '')}" /></a>`;
      } else if (url) {
        mediaHtml = `<a class="chat-file-chip" href="${url}" target="_blank" rel="noopener">📄 ${escapeHtml(m.attachment_name || 'file')}</a>`;
      }
    }
    const senderName = isGroup && !mine ? `<div class="chat-bubble-sender">${escapeHtml(m.senderLabel || '')}</div>` : '';
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="chat-bubble-row ${mine ? 'mine' : ''}">
        <div class="chat-bubble">
          ${senderName}
          ${m.content ? escapeHtml(m.content) : ''}
          ${mediaHtml}
          <div class="chat-bubble-time">${time}</div>
        </div>
      </div>
    `;
  }));
  wrap.innerHTML = parts.join('');
  wrap.scrollTop = wrap.scrollHeight;
}

async function loadMessages(chatId) {
  const { data } = await sb
    .from('messages')
    .select('id, chat_id, sender_id, content, attachment_path, attachment_name, attachment_mime, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });

  const rows = data || [];
  if (activeChatMeta?.type === 'group') {
    const senders = {};
    (activeChatMeta.memberProfiles || []).forEach((p) => { senders[p.id] = p.full_name || p.email; });
    rows.forEach((r) => { r.senderLabel = senders[r.sender_id] || 'Someone'; });
  }
  await renderMessages(rows);
}

async function openChat(chatId) {
  activeChatId = chatId;
  activeChatMeta = chatListCache.find((c) => c.id === chatId) || null;

  $('chatEmpty').style.display = 'none';
  $('chatThreadWrap').style.display = 'flex';
  $('chatShell').classList.add('show-thread');
  $('chatThreadTitle').textContent = activeChatMeta ? chatDisplayName(activeChatMeta) : 'Chat';
  updateThreadPresence();
  renderChatList();

  await loadMessages(chatId);

  if (messagesChannel) sb.removeChannel(messagesChannel);
  messagesChannel = sb
    .channel(`messages-${chatId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` }, () => {
      loadMessages(chatId);
      refreshChatList();
    })
    .subscribe();

  // Realtime can silently drop on flaky mobile connections — this backup
  // poll guarantees messages still show up within a few seconds either way.
  clearInterval(openChatTimer);
  openChatTimer = setInterval(() => { if (activeChatId === chatId) loadMessages(chatId); }, 5000);
}

$('chatBackBtn').addEventListener('click', () => {
  $('chatShell').classList.remove('show-thread');
});

// If the app was backgrounded (phone locked, switched tabs/apps) and comes
// back, refresh right away instead of waiting for the next poll tick — this
// is when a dropped realtime connection is most likely.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentUser) return;
  if (activeChatId) loadMessages(activeChatId);
  if ($('chatOverlay').classList.contains('show')) refreshChatList();
});

// ---------- Sending messages ----------
$('chatAttachBtn').addEventListener('click', () => $('chatFileInput').click());
$('chatFileInput').addEventListener('change', () => {
  const file = $('chatFileInput').files[0];
  if (!file) return;
  pendingChatAttachment = file;
  const preview = $('chatAttachPreview');
  preview.style.display = 'flex';
  preview.innerHTML = `📎 ${escapeHtml(file.name)} <button type="button" id="chatAttachRemoveBtn">✕</button>`;
  $('chatAttachRemoveBtn').addEventListener('click', () => {
    pendingChatAttachment = null;
    $('chatFileInput').value = '';
    preview.style.display = 'none';
  });
});

// Guards against a stalled mobile-network request leaving the send button
// stuck disabled forever with no error shown.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out — check your connection and try again`)), ms)),
  ]);
}

// Photos straight from a phone camera can be several MB, which stalls on
// weak mobile data. Downscale/recompress before upload so sends are fast
// and reliable; skipped for already-small images.
async function compressImageIfNeeded(file) {
  if (!file.type || !file.type.startsWith('image/') || file.size <= 800 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 1600;
    let { width, height } = bitmap;
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
    if (!blob) return file;
    const newName = file.name.replace(/\.\w+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg' });
  } catch {
    return file; // if compression fails for any reason, just send the original
  }
}

async function sendChatMessage() {
  const text = $('chatTextInput').value.trim();
  if (!activeChatId || (!text && !pendingChatAttachment)) return;
  const sendBtn = $('chatSendBtn');
  const originalLabel = sendBtn.textContent;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  let attachment_path = null, attachment_name = null, attachment_mime = null;
  try {
    if (pendingChatAttachment) {
      const file = await compressImageIfNeeded(pendingChatAttachment);
      const safeName = file.name.replace(/[^a-z0-9_.-]/gi, '_');
      const path = `${activeChatId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}_${safeName}`;
      const { error: upErr } = await withTimeout(
        sb.storage.from('chat-attachments').upload(path, file),
        25000,
        'Upload'
      );
      if (upErr) throw upErr;
      attachment_path = path;
      attachment_name = file.name;
      attachment_mime = file.type || 'application/octet-stream';
    }

    const { data: newMsg, error } = await withTimeout(
      sb.from('messages').insert({
        chat_id: activeChatId,
        sender_id: currentUser.id,
        content: text || null,
        attachment_path, attachment_name, attachment_mime,
      }).select().single(),
      15000,
      'Send'
    );
    if (error) throw error;

    $('chatTextInput').value = '';
    pendingChatAttachment = null;
    $('chatFileInput').value = '';
    $('chatAttachPreview').style.display = 'none';
    await loadMessages(activeChatId);
    refreshChatList();

    // Best-effort: trigger a real system notification for the other person(s).
    // Never let a push failure interrupt the chat itself.
    if (newMsg) {
      const { data: { session } } = await sb.auth.getSession();
      sb.functions.invoke('send-push', {
        body: { chatId: activeChatId, messageId: newMsg.id },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      }).catch(() => {});
    }
  } catch (err) {
    showToast(`Couldn't send: ${err.message || err}`);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = originalLabel;
  }
}
$('chatSendBtn').addEventListener('click', sendChatMessage);
$('chatTextInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });

// ---------- New DM ----------
function personPickRow(p, checkbox) {
  return `
    <label class="person-pick-row">
      ${checkbox ? `<input type="checkbox" value="${p.id}" />` : ''}
      <span>${escapeHtml(p.full_name || p.email)}</span>
    </label>
  `;
}

$('newDmBtn').addEventListener('click', async () => {
  if (!teamProfiles.length) await loadTeamProfiles();
  $('dmPersonList').innerHTML = teamProfiles.length
    ? teamProfiles.map((p) => personPickRow(p, false)).join('')
    : '<div class="empty">No teammates yet.</div>';
  $('dmPersonList').querySelectorAll('.person-pick-row').forEach((row, i) => {
    row.addEventListener('click', () => startDm(teamProfiles[i]));
  });
  $('newDmOverlay').classList.add('show');
});
$('newDmCancelBtn').addEventListener('click', () => $('newDmOverlay').classList.remove('show'));

async function startDm(person) {
  $('newDmOverlay').classList.remove('show');
  // Reuse an existing DM with this person if one already exists.
  const existing = chatListCache.find((c) => c.type === 'dm' && (c.memberProfiles || []).some((p) => p.id === person.id));
  if (existing) { await openChat(existing.id); return; }

  const { data: chatRow, error } = await sb.from('chats').insert({ type: 'dm', created_by: currentUser.id }).select().single();
  if (error) { showToast(`Couldn't start chat: ${error.message}`); return; }
  await sb.from('chat_members').insert([
    { chat_id: chatRow.id, user_id: currentUser.id },
    { chat_id: chatRow.id, user_id: person.id },
  ]);
  await refreshChatList();
  await openChat(chatRow.id);
}

// ---------- New Group ----------
$('newGroupBtn').addEventListener('click', async () => {
  if (!teamProfiles.length) await loadTeamProfiles();
  $('groupNameInput').value = '';
  $('groupMemberList').innerHTML = teamProfiles.length
    ? teamProfiles.map((p) => personPickRow(p, true)).join('')
    : '<div class="empty">No teammates yet.</div>';
  $('newGroupOverlay').classList.add('show');
});
$('newGroupCancelBtn').addEventListener('click', () => $('newGroupOverlay').classList.remove('show'));

$('newGroupCreateBtn').addEventListener('click', async () => {
  const name = $('groupNameInput').value.trim();
  const selectedIds = Array.from($('groupMemberList').querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
  if (!name) { showToast('Give the group a name.'); return; }
  if (!selectedIds.length) { showToast('Pick at least one teammate.'); return; }

  const { data: chatRow, error } = await sb.from('chats').insert({ type: 'group', name, created_by: currentUser.id }).select().single();
  if (error) { showToast(`Couldn't create group: ${error.message}`); return; }
  await sb.from('chat_members').insert([
    { chat_id: chatRow.id, user_id: currentUser.id },
    ...selectedIds.map((id) => ({ chat_id: chatRow.id, user_id: id })),
  ]);
  $('newGroupOverlay').classList.remove('show');
  await refreshChatList();
  await openChat(chatRow.id);
});

// =====================================================================
// QUEUE rendering
// =====================================================================

const TYPE_ICON = { timesheet: '🕒', progress: '📈', data: '📋' };
const MODE_ICON = {
  office: '🏢', site: '🏗️', driver: '🚗', wfh: '🏠', exhibition: '🎪',
  inspection: '🔍', field_work: '🌾', other: '✨', sick_leave: '🤒',
  holiday: '🏖️', emergency_leave: '🚨', leave: '📄'
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderQueue() {
  const list = $('entryList');
  const entries = await getAllEntries();
  if (!entries.length) { list.innerHTML = '<div class="empty">No entries yet.</div>'; return; }

  list.innerHTML = entries.map(en => {
    const icon = en.type === 'timesheet' ? (MODE_ICON[en.mode] || TYPE_ICON.timesheet) : TYPE_ICON[en.type];
    let meta;
    if (en.type === 'timesheet' && en.category === 'leave') {
      meta = `${MODE_LABEL[en.mode] || en.mode} · ${en.leaveStart} → ${en.leaveEnd}`;
    } else if (en.type === 'timesheet') {
      meta = `${MODE_LABEL[en.mode] || en.mode} · ${en.project || '—'} · ${en.date}`;
    } else {
      meta = `${en.type} · ${en.project || '—'} · ${en.date}`;
    }
    return `
      <div class="entry">
        <span class="type-icon">${icon}</span>
        <div class="entry-body">
          <div class="entry-meta">${escapeHtml(meta)}</div>
          <div class="entry-desc">${escapeHtml(en.description || '')}</div>
        </div>
        <span class="chip ${en.status}">${en.status}</span>
      </div>
    `;
  }).join('');
}
$('syncNowBtn').addEventListener('click', () => syncQueue());

// =====================================================================
// SYNC — server-side via submit-entry Edge Function
// =====================================================================

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

window.addEventListener('load', () => setTimeout(syncQueue, 1500));
setInterval(syncQueue, 5 * 60 * 1000);

// =====================================================================
// AI CHAT — glowing orb, mesh reveal, Gemini-backed Q&A over GitHub data
// =====================================================================

let aiHistory = [];   // [{ role: 'user'|'assistant', text }]
let aiOpen = false;
let aiBusy = false;

// Soft launch chime for opening AEON Ai (real audio clip, not synthesized).
const launchAudio = new Audio('./notify.mp3');
launchAudio.volume = 0.55;
function playLaunchSound() {
  try {
    launchAudio.currentTime = 0;
    launchAudio.play().catch(() => {}); // ignore if autoplay is blocked
  } catch { /* audio not available — silently skip the sound */ }
}

function openAiChat() {
  aiOpen = true;
  playLaunchSound();
  $('aiMesh').classList.add('show');
  $('aiChatPanel').classList.add('show');
  $('aiOrbLabel').style.display = 'none';
  setTimeout(() => $('aiInput').focus(), 200);
}
function closeAiChat() {
  aiOpen = false;
  $('aiMesh').classList.remove('show');
  $('aiChatPanel').classList.remove('show');
  if (currentUser) $('aiOrbLabel').style.display = 'block';
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  $('aiOrb').classList.remove('speaking');
}

$('aiOrb').addEventListener('click', () => { aiOpen ? closeAiChat() : openAiChat(); });
$('aiCloseBtn').addEventListener('click', closeAiChat);
$('aiMesh').addEventListener('click', closeAiChat);

// ---------- Voice assist: AEON Ai speaks its replies, and can listen too ----------
// Both use browser-native APIs (Web Speech) — no API key, no extra cost.
let voiceOutputEnabled = true; // toggled by the speaker button in the chat header

function speakText(text) {
  if (!voiceOutputEnabled || !('speechSynthesis' in window) || !text) return;
  try {
    window.speechSynthesis.cancel(); // don't stack up overlapping replies
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1;
    utter.pitch = 1;
    // Glow the orb brighter/faster while AEON Ai is actually talking.
    utter.onstart = () => $('aiOrb').classList.add('speaking');
    utter.onend = () => $('aiOrb').classList.remove('speaking');
    utter.onerror = () => $('aiOrb').classList.remove('speaking');
    window.speechSynthesis.speak(utter);
  } catch { /* speech synthesis not available — silently skip */ }
}

function updateVoiceToggleUi() {
  const btn = $('aiVoiceToggle');
  if (!btn) return;
  btn.textContent = voiceOutputEnabled ? '🔊' : '🔇';
  btn.title = voiceOutputEnabled ? 'Voice replies on — tap to mute' : 'Voice replies off — tap to unmute';
}
if ($('aiVoiceToggle')) {
  $('aiVoiceToggle').addEventListener('click', () => {
    voiceOutputEnabled = !voiceOutputEnabled;
    if (!voiceOutputEnabled) { window.speechSynthesis.cancel(); $('aiOrb').classList.remove('speaking'); }
    updateVoiceToggleUi();
  });
  updateVoiceToggleUi();
}

// Mic button: tap, speak your question, it fills the input and sends
// automatically once you stop talking — the same loop as Siri/Google Assistant.
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
if ($('aiMicBtn') && SpeechRecognitionApi) {
  const recognizer = new SpeechRecognitionApi();
  recognizer.lang = 'en-US';
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  let listening = false;

  recognizer.addEventListener('result', (event) => {
    const transcript = event.results[0]?.[0]?.transcript?.trim();
    if (transcript) {
      $('aiInput').value = transcript;
      sendAiMessage();
    }
  });
  recognizer.addEventListener('end', () => {
    listening = false;
    $('aiMicBtn').classList.remove('listening');
  });
  recognizer.addEventListener('error', () => {
    listening = false;
    $('aiMicBtn').classList.remove('listening');
  });

  $('aiMicBtn').addEventListener('click', () => {
    if (listening) { recognizer.stop(); return; }
    try {
      recognizer.start();
      listening = true;
      $('aiMicBtn').classList.add('listening');
    } catch { /* already started, or mic permission denied */ }
  });
} else if ($('aiMicBtn')) {
  $('aiMicBtn').style.display = 'none'; // not supported on this browser
}

function addAiMessage(role, text) {
  const wrap = $('aiMessages');
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  div.textContent = text;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

async function sendAiMessage() {
  const input = $('aiInput');
  const text = input.value.trim();
  if (!text || aiBusy || !currentUser) return;
  aiBusy = true;
  $('aiSendBtn').disabled = true;
  input.value = '';

  addAiMessage('user', text);
  const loadingEl = addAiMessage('assistant loading', 'Thinking…');

  try {
    const { data: { session } } = await sb.auth.getSession();
    const { data, error } = await sb.functions.invoke('ai-chat', {
      body: { message: text, history: aiHistory },
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (error || data?.error) throw new Error(data?.error || error.message);
    loadingEl.textContent = data.reply;
    loadingEl.className = 'ai-msg assistant';
    aiHistory.push({ role: 'user', text }, { role: 'assistant', text: data.reply });
    aiHistory = aiHistory.slice(-16);
    speakText(data.reply);
  } catch (err) {
    loadingEl.textContent = `Couldn't get an answer: ${err.message || err}`;
    loadingEl.className = 'ai-msg assistant';
  } finally {
    aiBusy = false;
    $('aiSendBtn').disabled = false;
  }
}

$('aiSendBtn').addEventListener('click', sendAiMessage);
$('aiInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendAiMessage();
});

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(console.error);
  });
}

// ---------- Push notifications (WhatsApp-style system alerts) ----------
// iOS Safari requires: the app installed to the Home Screen (iOS 16.4+), and
// this must run from a real button tap — it silently fails from page-load code.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function getPushStatusLabel() {
  if (!pushSupported()) return 'Not supported on this browser/device';
  if (Notification.permission === 'denied') return 'Blocked — enable notifications for this site in your browser settings';
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  return existing ? 'Enabled on this device' : 'Not enabled yet';
}

async function refreshPushStatus() {
  const el = $('pushStatus');
  if (!el) return;
  el.textContent = await getPushStatusLabel();
}

async function enablePushNotifications() {
  if (!pushSupported()) { showToast("This browser/device doesn't support notifications."); return; }
  const btn = $('enablePushBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Enabling…'; }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { showToast('Notifications permission was not granted.'); return; }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(window.CTORQ_CONFIG.VAPID_PUBLIC_KEY),
      });
    }
    const json = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({
      user_id: currentUser.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    showToast('Notifications enabled on this device.');
  } catch (err) {
    showToast(`Couldn't enable notifications: ${err.message || err}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enable notifications'; }
    refreshPushStatus();
  }
}
if ($('enablePushBtn')) $('enablePushBtn').addEventListener('click', enablePushNotifications);
