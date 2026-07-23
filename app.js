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
  closeAiChat();
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
  $('aiOrb').style.display = 'flex';

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

function openAiChat() {
  aiOpen = true;
  $('aiMesh').classList.add('show');
  $('aiChatPanel').classList.add('show');
  setTimeout(() => $('aiInput').focus(), 200);
}
function closeAiChat() {
  aiOpen = false;
  $('aiMesh').classList.remove('show');
  $('aiChatPanel').classList.remove('show');
}

$('aiOrb').addEventListener('click', () => { aiOpen ? closeAiChat() : openAiChat(); });
$('aiCloseBtn').addEventListener('click', closeAiChat);
$('aiMesh').addEventListener('click', closeAiChat);

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
