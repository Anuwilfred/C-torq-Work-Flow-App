// Bump this alongside CACHE_NAME in service-worker.js on every deploy — shown
// in Settings so it's possible to check, at a glance, exactly which build is
// actually live on a given device (screenshot it instead of guessing).
const APP_VERSION = 'v3.86';
// One short line describing what changed this round — read by OTHER, older
// tabs (via a plain-text fetch of this exact file) so the update icon's
// toast can say what's new before anyone taps to refresh.
const APP_UPDATE_NOTES = 'Project Detail, the Project Tank gauge, and AEON Ai now open project hours instantly instead of re-scanning every timesheet — run the one-time backfill in Admin → Team once you deploy this.';
if (document.getElementById('appVersionLabel')) document.getElementById('appVersionLabel').textContent = `App version ${APP_VERSION}`;

// ---------- Supabase client ----------
const sb = window.supabase.createClient(
  window.CTORQ_CONFIG.SUPABASE_URL,
  window.CTORQ_CONFIG.SUPABASE_ANON_KEY
);

// ---------- Auth-check timeout guard ----------
// Root cause of the "totally blank page, forever, zero console errors" bug:
// Supabase's client stores your session in localStorage, and if that stored
// entry is stale or corrupted (leftover from an old sign-in, a key rotation,
// a half-finished token refresh, etc.), calls like sb.auth.getSession() or
// sb.auth.getUser() can hang forever instead of resolving OR throwing. No
// error ever fires, so nothing ever shows — not the login screen, not the
// app. That matches exactly what a refresh (which re-reads the stored
// session) does versus a fresh magic-link click (which always writes a
// brand-new, healthy session and never hits this path).
// withTimeout forces every one of those calls to give up after a few
// seconds so the app always ends up showing something instead of hanging.
// NOTE: named raceTimeout (not withTimeout) on purpose — this file already
// had a differently-behaved withTimeout() further down (used by chat
// send/upload) that REJECTS with a labeled Error on timeout. Two same-named
// function declarations in one file silently collide (the later one wins
// everywhere), which — before this rename — meant every call below was
// unknowingly using that other, reject-based version instead of this one,
// so the __timedOut checks never worked. Keeping these as two clearly
// distinct helpers avoids that trap for good.
function raceTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ __timedOut: true }), ms)),
  ]);
}

// supabase-js's sb.functions.invoke() sets error.message to a fixed, useless
// string — "Edge Function returned a non-2xx status code" — no matter what
// our own function actually sent back. The real reason (e.g. "AI service
// timed out", "Admin only", the actual Anthropic error) is only reachable by
// reading the raw response body off error.context. This digs that out so
// error messages shown to the user are actually the real ones.
async function readFunctionsError(error) {
  if (!error) return 'Unknown error';
  try {
    if (error.context && typeof error.context.json === 'function') {
      const body = await error.context.clone().json();
      if (body?.error) return body.error;
    }
  } catch (e) { /* body wasn't JSON — fall through */ }
  try {
    if (error.context && typeof error.context.text === 'function') {
      const text = await error.context.clone().text();
      if (text) return text.slice(0, 300);
    }
  } catch (e) { /* ignore */ }
  return error.message || String(error);
}

// RELIABILITY: a dozen different panels (Projects, Reports, Chat, BOQ,
// quotations, AI chat, push notifications...) each call sb.auth.getSession()
// as their very first step before loading any real data. That call can hang
// (same internal Supabase auth-lock contention documented above for
// login/startup) — and since none of these callers had a timeout, a single
// hang left that one panel stuck on "Loading…" forever, with nothing to do
// but refresh the whole app. This wraps every one of those calls with the
// same timeout guard already used at startup, so a hang always resolves
// (falling back to "no session" for that one attempt) instead of freezing
// that panel indefinitely.
async function getSessionSafe(ms = 6000) {
  const result = await raceTimeout(sb.auth.getSession(), ms);
  if (result.__timedOut) {
    console.warn('[Auth] getSession() timed out — treating as no session for this one call.');
    return { data: { session: null } };
  }
  return result;
}

// If a stored session ever causes a hang like that, wipe it so the *next*
// load isn't stuck the same way — the person just logs in again normally.
function clearStoredSession() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('sb-') && k.includes('-auth-token'))
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* ignore */ }
}

let currentUser = null;
let currentProfile = null;
let selectedMode = null; // mode-of-work chip currently selected

const LEAVE_MODES = ['sick_leave', 'holiday', 'emergency_leave'];
const MODE_LABEL = {
  office: 'Office', site: 'Site', workshop: 'Workshop', driver: 'Driver', wfh: 'Work from Home',
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
  if (name === 'admin') { renderTeamList(); renderLocationList(); renderRecalledEntriesList(); }
  if (name === 'reports') initReportsTab();
  if (name === 'settings') refreshPushStatus();
  if (name === 'home') renderJobBoard();
}
document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});

// Home hub tiles (macOS-style icon grid) — same navigation as the pill
// tabs above, just a second, more visual way to get to each section.
document.querySelectorAll('.home-tile[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});
// Chat has no tab/section of its own — it's the existing floating overlay —
// so its home tile opens that overlay directly instead of switching tabs.
$('homeChatTile')?.addEventListener('click', () => openChatOverlay());
// Admin shortcut pinned to the top-right of the header, mirroring the Admin
// pill tab — same destination, just reachable without opening the tab bar.
$('adminHomeBtn')?.addEventListener('click', () => setActiveTab('admin'));

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
  // Belt-and-braces: even if selectedMode was never restored (e.g. an
  // already-in-progress clock-in saved by an older app version, before this
  // was tracked), the Clocked In card must still show whenever the clock
  // state itself says you're actually working/on a break/clocked out
  // pending submit — never gated behind picking a mode chip by hand.
  const clk = getClockState();
  const clockInProgress = clk.status === 'working' || clk.status === 'onbreak' || !!clk.clockOutAt;
  $('workModeFields').classList.toggle('active', (hasMode && !isLeave) || clockInProgress);
  $('leaveModeFields').classList.toggle('active', hasMode && isLeave);
  $('sickDocField').style.display = selectedMode === 'sick_leave' ? 'block' : 'none';
}

// =====================================================================
// CLOCK — tap Clock In / Start Break / Stop Break / Clock Out and the
// device's own clock fills in Date, Start Time, End Time, and Break
// minutes automatically — no typing times by hand. State is saved to
// localStorage so it survives closing and reopening the app mid-shift
// (clock in at 8am, close the app, reopen at lunch — it still remembers).
// The underlying fields stay visible and editable too, in case someone
// needs to correct a time or fill one in by hand after the fact.
// =====================================================================

const CLOCK_KEY = 'ctorq-clock-state';

function getClockState() {
  try {
    const raw = localStorage.getItem(CLOCK_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { status: 'idle', clockInAt: null, clockOutAt: null, breaks: [], totalBreakMinutes: 0, interruptionMinutes: 0 };
}
function saveClockState(state) {
  try { localStorage.setItem(CLOCK_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}
function resetClockState() {
  saveClockState({ status: 'idle', clockInAt: null, clockOutAt: null, breaks: [], totalBreakMinutes: 0, segmentStart: null, interruptionMinutes: 0, qsrSegmentStart: null, qsrSegmentPausedAt: null, qsrJobId: null, qsrJobName: null });
  renderClockUI();
  renderQuickSwitchRing();
}
function fmtClockTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function toTimeInputValue(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderClockUI() {
  const line = $('clockStatusLine');
  if (!line) return; // clock card not on this page/build
  const state = getClockState();
  const inBtn = $('clockInBtn'), startBreakBtn = $('startBreakBtn'), stopBreakBtn = $('stopBreakBtn'), outBtn = $('clockOutBtn');

  inBtn.style.display = state.status === 'idle' ? 'inline-block' : 'none';
  startBreakBtn.style.display = state.status === 'working' ? 'inline-block' : 'none';
  stopBreakBtn.style.display = state.status === 'onbreak' ? 'inline-block' : 'none';
  outBtn.style.display = (state.status === 'working' || state.status === 'onbreak') ? 'inline-block' : 'none';
  outBtn.disabled = state.status === 'onbreak'; // must stop the break first

  if (state.status === 'working') {
    line.textContent = `Clocked in at ${fmtClockTime(state.clockInAt)}.` + (state.totalBreakMinutes ? ` Breaks so far: ${state.totalBreakMinutes} min.` : '');
  } else if (state.status === 'onbreak') {
    const lastBreak = state.breaks[state.breaks.length - 1];
    line.textContent = `On break since ${fmtClockTime(lastBreak?.start)} — tap Stop Break when you're back.`;
  } else if (state.clockOutAt) {
    line.textContent = `Clocked out at ${fmtClockTime(state.clockOutAt)} (in: ${fmtClockTime(state.clockInAt)}, break: ${state.totalBreakMinutes || 0} min). Fill in the rest below and submit.`;
  } else {
    line.textContent = 'Not clocked in yet — tap Clock In to start your day.';
  }
  renderClockLocationArea();
}

// Attendance-proof strip: shows where someone clocked in (and, once they
// have, where they clocked out) — each with its own little map thumbnail —
// so the two can be checked against each other (e.g. clocked in at the
// office but clocked out somewhere else).
function renderClockLocationArea() {
  const area = $('clockLocationArea');
  if (!area) return;
  const state = getClockState();
  const blocks = [];
  if (state.clockInLocation) {
    blocks.push(`
      <div class="clock-loc-block">
        <div class="clock-loc-label">🟢 Clocked in near</div>
        <div class="clock-loc-addr">${escapeHtml(state.clockInLocation)}</div>
        ${state.clockInLat ? `<img class="clock-loc-map" src="${staticMapUrl(state.clockInLat, state.clockInLng, '300x140')}" onerror="this.style.display='none'" alt="Clock-in location map" />` : ''}
      </div>
    `);
  }
  if (state.clockOutLocation) {
    blocks.push(`
      <div class="clock-loc-block">
        <div class="clock-loc-label">🔴 Clocked out near</div>
        <div class="clock-loc-addr">${escapeHtml(state.clockOutLocation)}</div>
        ${state.clockOutLat ? `<img class="clock-loc-map" src="${staticMapUrl(state.clockOutLat, state.clockOutLng, '300x140')}" onerror="this.style.display='none'" alt="Clock-out location map" />` : ''}
      </div>
    `);
  }
  area.innerHTML = blocks.join('');
}

// Clock state itself already survives closing/reopening the app just fine
// (it's saved to localStorage on every change) — but the New Entry FORM
// FIELDS (Job ID, Project, Location, Date, Start time) are plain inputs
// that reset to blank on every fresh page load, since nothing was wiring
// them back up from that saved state. This restores exactly what was there
// before the app was closed, so an in-progress clock-in looks the same
// whether you kept the app open the whole time or closed and reopened it.
// Safe to call multiple times — it never overwrites a field someone's
// already actively filled in during this session.
function rehydrateEntryFormFromClockState() {
  const state = getClockState();
  const stillOpen = state.status === 'working' || state.status === 'onbreak';
  if (!stillOpen && !state.clockOutAt) return; // nothing in progress to restore

  // Re-select whichever mode chip (Office/Site/Driver/etc.) was active when
  // they clocked in, so the Clocked In card — status line, Clock Out button,
  // location — is visible again immediately on open, instead of staying
  // hidden behind "pick a mode of work first" until they tap a chip by hand.
  if (state.mode && !selectedMode) {
    selectedMode = state.mode;
    document.querySelectorAll('.mode-chip').forEach((c) => c.classList.toggle('selected', c.dataset.mode === state.mode));
    refreshModeVisibility();
  }

  if (state.currentJobId && $('jobId') && !$('jobId').value.trim()) {
    $('jobId').value = state.currentJobId;
    autoFillProjectFromJobId(state.currentJobId);
  }
  if (state.clockInAt && $('date') && !$('date').value) $('date').value = state.clockInAt.slice(0, 10);
  if (state.segmentStart && $('startTime')) $('startTime').value = toTimeInputValue(state.segmentStart);
  if (state.clockOutAt && $('endTime')) $('endTime').value = toTimeInputValue(state.clockOutAt);
  if (state.totalBreakMinutes && $('lunchMinutes')) $('lunchMinutes').value = state.totalBreakMinutes;
  if (state.clockInLocation && $('location') && !$('location').value.trim()) {
    $('location').value = state.clockInLocation;
    const mapImg = $('locationMapImg');
    if (mapImg && state.clockInLat) {
      mapImg.onerror = () => { mapImg.style.display = 'none'; };
      mapImg.onload = () => { mapImg.style.display = 'block'; };
      mapImg.src = staticMapUrl(state.clockInLat, state.clockInLng);
    }
  }
}

function setClockLocationStatus(text) {
  const el = $('clockLocationStatus');
  if (!el) return;
  if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = text;
  el.style.display = 'block';
}

$('clockInBtn')?.addEventListener('click', () => {
  const now = new Date();
  const iso = now.toISOString();
  const jobId = $('jobId') ? $('jobId').value.trim() : '';
  saveClockState({
    status: 'working', clockInAt: iso, clockOutAt: null, breaks: [], totalBreakMinutes: 0, segmentStart: iso,
    clockInLocation: null, clockInLat: null, clockInLng: null,
    clockOutLocation: null, clockOutLat: null, clockOutLng: null,
    // Remembered so that if the app is closed/crashes and reopened,
    // rehydrateEntryFormFromClockState() can re-select this same mode chip
    // automatically — otherwise the whole Clocked In card (with Clock Out)
    // stays hidden behind "pick a mode of work first" even though the clock
    // itself is still running.
    mode: selectedMode,
    currentJobId: jobId || null,
    currentJobName: jobId ? (jobSearchOptions.find((r) => r.job_id === jobId)?.name || '') : '',
    // Fresh day, fresh Quick Job Switch bookkeeping — QJS runs entirely on
    // its own timer/location fields (qsr*) from here, completely separate
    // from this normal job's segmentStart above, so switching to a quick
    // job never touches or pauses this one.
    interruptionMinutes: 0,
    qsrSegmentStart: null,
    qsrSegmentPausedAt: null,
  });
  $('date').value = iso.slice(0, 10);
  $('startTime').value = toTimeInputValue(iso);
  renderClockUI();
  renderQuickSwitchRing();
  showToast('Clocked in — have a good shift.');
  // Auto-fill the location (and its map preview) right away — no need to
  // tap "Use my location" separately. This is also stamped as attendance
  // proof (separate from the job's own Location field) so both clock-in
  // and clock-out locations can be checked against each other later.
  // Visible status here (not just a toast) so a denied/slow GPS is never
  // silently invisible — you can always see what happened.
  setClockLocationStatus('📍 Getting your location…');
  fetchAndFillLocation({ silent: true }).then((r) => {
    if (!r.ok) {
      setClockLocationStatus("⚠️ Couldn't get your location — check that this site has location permission, then tap \"Refresh my location\" below.");
      return;
    }
    setClockLocationStatus('');
    const s = getClockState();
    s.clockInLocation = r.address; s.clockInLat = r.lat; s.clockInLng = r.lng;
    saveClockState(s);
    renderClockUI();
  });
});

$('startBreakBtn')?.addEventListener('click', () => {
  const state = getClockState();
  if (state.status !== 'working') return;
  state.breaks.push({ start: new Date().toISOString(), end: null });
  state.status = 'onbreak';
  saveClockState(state);
  renderClockUI();
  showToast('Break started.');
});

$('stopBreakBtn')?.addEventListener('click', () => {
  const state = getClockState();
  if (state.status !== 'onbreak' || !state.breaks.length) return;
  const last = state.breaks[state.breaks.length - 1];
  last.end = new Date().toISOString();
  const mins = Math.max(0, Math.round((new Date(last.end) - new Date(last.start)) / 60000));
  state.totalBreakMinutes = (state.totalBreakMinutes || 0) + mins;
  state.status = 'working';
  saveClockState(state);
  if ($('lunchMinutes')) $('lunchMinutes').value = state.totalBreakMinutes;
  renderClockUI();
  renderQuickSwitchRing();
  showToast(`Break ended — ${mins} min added (total ${state.totalBreakMinutes} min).`);
});

$('clockOutBtn')?.addEventListener('click', () => {
  const state = getClockState();
  if (state.status !== 'working') return;
  const iso = new Date().toISOString();
  state.clockOutAt = iso;
  state.status = 'idle';
  saveClockState(state);
  $('endTime').value = toTimeInputValue(iso);
  if ($('lunchMinutes')) $('lunchMinutes').value = state.totalBreakMinutes || 0;
  renderClockUI();
  renderQuickSwitchRing();
  showToast('Clocked out — review the rest of the entry and submit when ready.');
  // Stamp where they clocked out from, same as the clock-in stamp — so if
  // someone clocked in at the office but clocked out somewhere else, that's
  // visible. This is attendance proof only: it does NOT touch the job's own
  // Location field above (fillField: false), since that describes where
  // the work itself happened, which may be a different place entirely.
  setClockLocationStatus('📍 Getting your clock-out location…');
  fetchAndFillLocation({ silent: true, fillField: false }).then((r) => {
    if (!r.ok) {
      setClockLocationStatus("⚠️ Couldn't get your clock-out location — check location permission for this site.");
      return;
    }
    setClockLocationStatus('');
    const s = getClockState();
    s.clockOutLocation = r.address; s.clockOutLat = r.lat; s.clockOutLng = r.lng;
    saveClockState(s);
    renderClockUI();
  });
});

// =====================================================================
// QUICK JOB SWITCH RING — only shown while clocked in ("working" or
// "onbreak"). Runs on its OWN independent timer/location fields (the
// qsr-prefixed ones in clock state) — it never reads or writes the normal
// job's segmentStart, Job ID, Project, Location, Date, or Start time. This
// is deliberate: the normal job keeps counting exactly as if Quick Job
// Switch didn't exist, for as long as it's clocked in.
//   - Start: begins timing the loaded Job ID on its own clock, capturing a
//     fresh GPS location for "where this quick job started" — completely
//     independent of, and simultaneous with, the normal job's own clock.
//   - Stop: closes out the quick job's own segment without starting
//     another, capturing a fresh GPS location for "where it ended".
// When a quick job is Submitted, its duration is saved as its own separate
// timesheet entry AND added to a running "interruption minutes" total for
// the day. That total gets subtracted from the normal job's hours (folded
// into its lunch/break minutes) the next time the normal entry is actually
// submitted — so the normal job's clock-in/out times never change, but its
// counted hours correctly exclude whatever time went to quick jobs.
// =====================================================================

// Quick Job Switch — right-side drawer with a game-console D-pad:
//   Job ID (top)  — tap to open the scrollable job picker, just changes
//                    which job is "loaded"; never touches the timer, and
//                    never touches the New Entry form's own Job ID field.
//   Start (left)  — begins timing the currently-loaded Job ID on QJS's own
//                    clock. If another quick job was already running (or
//                    stopped-but-not-yet-submitted), it's auto-submitted
//                    first as a safety net so no time is ever silently lost.
//   Stop (right)  — pauses QJS's own timer (freezes the elapsed reading)
//                    without saving yet, in case the person wants to double
//                    check before it's written to their timesheet.
//   Submit (down) — saves the (paused or still-running) stretch as its own
//                    timesheet entry. After this, pick the next Job ID and
//                    tap Start again.
let qsrLoadedJobId = '';
let qsrLoadedJobName = '';
let qsrMode = 'site'; // mode-of-work chip for quick jobs — defaults to Site, kept independent of the main New Entry mode chips

function renderQuickSwitchRing() {
  const handle = $('qsrHandle');
  if (!handle) return;
  const state = getClockState();
  const clockedIn = state.status === 'working' || state.status === 'onbreak';
  handle.style.display = clockedIn ? 'flex' : 'none';
  if (!clockedIn) { $('qsrDrawer')?.classList.remove('show'); $('qsrDrawerBackdrop')?.classList.remove('show'); return; }

  if (!qsrLoadedJobId) qsrLoadedJobId = $('jobId').value.trim();
  const paused = !!state.qsrSegmentPausedAt;
  const running = !!state.qsrSegmentStart && !paused;

  const badge = $('qsrSelectedBadge');
  if (badge) badge.textContent = qsrLoadedJobId ? `${qsrLoadedJobId}${qsrLoadedJobName ? ' — ' + qsrLoadedJobName : ''}` : 'No job selected yet';

  $('qsrStartBtn').disabled = state.status === 'onbreak' || !qsrLoadedJobId;
  $('qsrStopBtn').disabled = state.status === 'onbreak' || !state.qsrSegmentStart || paused;
  $('qsrSubmitBtn').disabled = !state.qsrSegmentStart;

  const center = $('qsrElapsed');
  center.classList.toggle('running', running);
  if (state.qsrSegmentStart) {
    const endPoint = paused ? new Date(state.qsrSegmentPausedAt) : new Date();
    const mins = Math.max(0, Math.round((endPoint - new Date(state.qsrSegmentStart)) / 60000));
    const label = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    center.textContent = paused ? `⏸ ${label}` : label;
  } else {
    center.textContent = '—';
  }
}
setInterval(renderQuickSwitchRing, 30000);

// Job ID (top button): opens the drawer's job picker. Selecting a job just
// loads it into QJS's own local variables — it never touches the timer,
// and never touches the New Entry form's Job ID/Project fields.
function openQsrJobPicker() {
  $('qsrJobSearch').value = '';
  $('qsrJobResults').style.display = 'none';
  showQsrJobMatches('');
  $('qsrJobSearch').focus();
}

function showQsrJobMatches(q) {
  const box = $('qsrJobResults');
  const query = (q || '').trim().toLowerCase();
  const matches = (query
    ? jobSearchOptions.filter((r) => String(r.job_id).toLowerCase().includes(query) || String(r.name || '').toLowerCase().includes(query))
    : jobSearchOptions
  ).slice(0, 30);
  box.innerHTML = matches.length
    ? matches.map((r) => `
        <div class="job-search-item" data-job-id="${escapeHtml(r.job_id)}" data-job-name="${escapeHtml(r.name || '')}">
          <div class="jid">${escapeHtml(r.job_id)}</div>
          <div class="jdesc">${escapeHtml(r.name || '')}${r.client ? ' · ' + escapeHtml(r.client) : ''}</div>
        </div>
      `).join('')
    : '<div class="job-search-empty">No matching job found.</div>';
  box.style.display = 'block';
  box.querySelectorAll('.job-search-item[data-job-id]').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      qsrLoadedJobId = item.dataset.jobId;
      qsrLoadedJobName = item.dataset.jobName || '';
      box.style.display = 'none';
      $('qsrJobSearch').value = '';
      showToast(`Loaded job: ${qsrLoadedJobId}`);
      renderQuickSwitchRing();
    });
  });
}

// Start (left): begins timing the loaded Job ID on QJS's own clock —
// completely separate from whatever's running in the normal New Entry
// form/segmentStart, which is left running untouched. Captures a fresh GPS
// location for "where this quick job started". Safety net — if a PRIOR
// quick job was already running or stopped-but-not-yet-submitted, it's
// auto-submitted first so nothing is ever silently lost.
async function qsrStart() {
  if (!qsrLoadedJobId) { showToast('Pick a Job ID first.'); return; }
  const now = new Date();
  let state = getClockState();
  if (state.qsrSegmentStart) {
    // qsrSubmit() clears qsrLoadedJobId/Name once it's done (ready for a
    // fresh pick) — but here that variable is actually the NEXT job we're
    // about to start, so stash and restore it around the safety-net submit.
    const nextJobId = qsrLoadedJobId, nextJobName = qsrLoadedJobName;
    await qsrSubmit();
    qsrLoadedJobId = nextJobId; qsrLoadedJobName = nextJobName;
    state = getClockState();
  }
  state.qsrSegmentStart = now.toISOString();
  state.qsrSegmentPausedAt = null;
  // Stamped into STATE (not just the module-level "currently loaded in the
  // picker" variable) so that if someone picks a different job in the
  // picker before Stop/Submit, the safety-net auto-submit above still
  // correctly labels the segment that was actually running, not whatever's
  // now loaded.
  state.qsrJobId = qsrLoadedJobId;
  state.qsrJobName = qsrLoadedJobName;
  state.qsrStartLocation = null; state.qsrStartLat = null; state.qsrStartLng = null;
  state.qsrStopLocation = null; state.qsrStopLat = null; state.qsrStopLng = null;
  saveClockState(state);
  showToast(`Started: ${qsrLoadedJobId}${qsrLoadedJobName ? ' — ' + qsrLoadedJobName : ''}`);
  renderQuickSwitchRing();
  fetchAndFillLocation({ silent: true, fillField: false }).then((r) => {
    if (!r.ok) return;
    const s = getClockState();
    if (!s.qsrSegmentStart) return; // already submitted/cancelled by the time this resolved
    s.qsrStartLocation = r.address; s.qsrStartLat = r.lat; s.qsrStartLng = r.lng;
    saveClockState(s);
  });
}

// Stop (right): pauses QJS's own timer — freezes the elapsed reading —
// without saving yet, capturing a fresh GPS location for "where it ended".
// Submit is the step that actually commits it.
async function qsrPause() {
  const state = getClockState();
  if (!state.qsrSegmentStart) { showToast('No quick job currently running.'); return; }
  state.qsrSegmentPausedAt = new Date().toISOString();
  saveClockState(state);
  renderQuickSwitchRing();
  const r = await fetchAndFillLocation({ silent: true, fillField: false });
  if (!r.ok) return;
  const s = getClockState();
  if (!s.qsrSegmentPausedAt) return; // already submitted by the time this resolved
  s.qsrStopLocation = r.address; s.qsrStopLat = r.lat; s.qsrStopLng = r.lng;
  saveClockState(s);
}

// Submit (down): saves the running-or-paused quick-job stretch as its own
// timesheet entry — using QJS's OWN loaded job/location, never the New
// Entry form's fields — and adds its duration to today's running
// "interruption minutes" total, which gets deducted from the normal job's
// hours the next time that entry is actually submitted.
async function qsrSubmit() {
  const state = getClockState();
  if (!state.qsrSegmentStart) { showToast('Nothing to submit yet.'); return; }
  const now = new Date();
  const wasPaused = !!state.qsrSegmentPausedAt;
  const endPoint = wasPaused ? new Date(state.qsrSegmentPausedAt) : now;

  // If it was never explicitly Stopped, capture the "ended here" location
  // right now, at Submit — same idea as Stop, just deferred.
  let stopLocation = state.qsrStopLocation, stopLat = state.qsrStopLat, stopLng = state.qsrStopLng;
  if (!wasPaused) {
    const r = await fetchAndFillLocation({ silent: true, fillField: false });
    if (r.ok) { stopLocation = r.address; stopLat = r.lat; stopLng = r.lng; }
  }

  // Use the job stamped into state at Start time — NOT the module-level
  // "currently loaded in the picker" variable, which may have already
  // changed if this is running as the safety net inside qsrStart() picking
  // up a different job.
  const jobId = state.qsrJobId || qsrLoadedJobId;
  const jobInfo = jobSearchOptions.find((r) => r.job_id === jobId);
  const minutes = Math.max(0, Math.round((endPoint - new Date(state.qsrSegmentStart)) / 60000));

  const draft = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'timesheet',
    userLabel: currentProfile?.full_name || currentUser.email,
    createdAt: new Date().toISOString(),
    status: 'pending',
    error: null,
    category: 'timesheet',
    mode: qsrMode,
    jobId: jobId || null,
    project: jobInfo?.name || jobId || null,
    location: state.qsrStartLocation || null,
    allowanceLocation: null,
    date: new Date(state.qsrSegmentStart).toISOString().slice(0, 10),
    startTime: toTimeInputValue(state.qsrSegmentStart),
    endTime: toTimeInputValue(endPoint),
    lunchMinutes: 0,
    description: ($('qsrNotes')?.value.trim() || ''),
    clockInLocation: state.qsrStartLocation || null,
    clockInLat: state.qsrStartLat ?? null,
    clockInLng: state.qsrStartLng ?? null,
    clockOutLocation: stopLocation || null,
    clockOutLat: stopLat ?? null,
    clockOutLng: stopLng ?? null,
    attachments: [],
  };
  await addEntry(draft);
  syncQueue();

  const fresh = getClockState();
  fresh.qsrSegmentStart = null;
  fresh.qsrSegmentPausedAt = null;
  fresh.qsrJobId = null; fresh.qsrJobName = null;
  fresh.qsrStartLocation = null; fresh.qsrStartLat = null; fresh.qsrStartLng = null;
  fresh.qsrStopLocation = null; fresh.qsrStopLat = null; fresh.qsrStopLng = null;
  // The normal job's clock keeps running untouched throughout all of this —
  // this is the ONLY effect a quick job has on it: minutes banked here to
  // be subtracted from its hours once IT is actually submitted.
  fresh.interruptionMinutes = (fresh.interruptionMinutes || 0) + minutes;
  saveClockState(fresh);

  qsrLoadedJobId = ''; qsrLoadedJobName = '';
  if ($('qsrNotes')) $('qsrNotes').value = '';
  showToast(`${draft.jobId || 'That job'} logged (${minutes}m) — deducted from today's normal job hours.`);
  renderQuickSwitchRing();
}

$('qsrHandle')?.addEventListener('click', () => {
  $('qsrDrawerBackdrop').classList.add('show');
  $('qsrDrawer').classList.add('show');
  renderQuickSwitchRing();
});
function closeQsrDrawer() {
  $('qsrDrawerBackdrop').classList.remove('show');
  $('qsrDrawer').classList.remove('show');
  $('qsrJobResults').style.display = 'none';
}
$('qsrDrawerCloseBtn')?.addEventListener('click', closeQsrDrawer);
$('qsrDrawerBackdrop')?.addEventListener('click', closeQsrDrawer);

$('qsrJobIdBtn')?.addEventListener('click', openQsrJobPicker);
$('qsrJobSearch')?.addEventListener('focus', () => showQsrJobMatches($('qsrJobSearch').value));
$('qsrJobSearch')?.addEventListener('input', () => showQsrJobMatches($('qsrJobSearch').value));

$('qsrStartBtn')?.addEventListener('click', () => { if (!$('qsrStartBtn').disabled) qsrStart(); });
$('qsrStopBtn')?.addEventListener('click', () => { if (!$('qsrStopBtn').disabled) qsrPause(); });
$('qsrSubmitBtn')?.addEventListener('click', () => { if (!$('qsrSubmitBtn').disabled) qsrSubmit(); });

// Quick Job Switch's own Mode of work chips — separate element/class from
// the main New Entry mode-chip grid on purpose, so tapping one never
// affects the other. Whatever's picked here stays selected across quick
// jobs (most people repeat the same mode), it isn't reset on Submit.
document.querySelectorAll('.qsr-mode-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    qsrMode = chip.dataset.qsrMode;
    document.querySelectorAll('.qsr-mode-chip').forEach((c) => c.classList.toggle('selected', c === chip));
  });
});

renderClockUI();
renderQuickSwitchRing();

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
// Shared by the manual "Use my location" button, the automatic Clock In
// fetch, and the automatic Clock Out fetch, so the location + map preview
// are usually already filled in before anyone's typed anything.
//   opts.silent    — suppress the "couldn't get location" toast (used for
//                    the automatic calls — a denied/slow GPS shouldn't
//                    interrupt clocking in/out; the button is still there
//                    to retry or type it in manually).
//   opts.fillField — false for the Clock Out reading, which is only an
//                    attendance-proof stamp, not the job's own Location
//                    field (which may already describe a site visited
//                    earlier in the day and shouldn't be overwritten by
//                    "wherever I'm standing when I tap Clock Out").
// Resolves with { ok, lat, lng, address } either way.
function staticMapUrl(lat, lng, size = '340x180') {
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=16&size=${size}&maptype=mapnik&markers=${lat},${lng},red-dot`;
}
function fetchAndFillLocation(opts = {}) {
  const fillField = opts.fillField !== false;
  if (!navigator.geolocation) {
    if (!opts.silent) showToast('Location not supported on this device — type it manually.');
    return Promise.resolve({ ok: false });
  }
  const btn = fillField ? $('fetchLocationBtn') : null;
  if (btn) { btn.disabled = true; btn.textContent = '📍 Locating…'; }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        let address = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=16`,
            { headers: { Accept: 'application/json' } }
          );
          const data = await res.json();
          if (data.display_name) address = data.display_name;
        } catch { /* keep the lat/lng fallback address */ }

        if (fillField) {
          $('location').value = address;
          // Map preview is purely decorative — never let it block or delay
          // the location text. If there's no network, the <img> just fails
          // to load and we hide it.
          const mapImg = $('locationMapImg');
          if (mapImg) {
            mapImg.onerror = () => { mapImg.style.display = 'none'; };
            mapImg.onload = () => { mapImg.style.display = 'block'; };
            mapImg.src = staticMapUrl(latitude, longitude);
          }
          if (btn) { btn.disabled = false; btn.textContent = '📍 Use my location'; }
        }
        resolve({ ok: true, lat: latitude, lng: longitude, address });
      },
      () => {
        if (!opts.silent) showToast('Could not get location — type it manually.');
        if (btn) { btn.disabled = false; btn.textContent = '📍 Use my location'; }
        resolve({ ok: false });
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}
$('fetchLocationBtn').addEventListener('click', () => fetchAndFillLocation());

// =====================================================================
// LIVE DRIVERS — anyone with a Role named "Driver" has their location
// captured every couple of minutes WHILE THEIR APP IS OPEN, so the rest of
// the team can see roughly where each driver currently is. IMPORTANT
// HONESTY NOTE: this is not true background tracking — a browser/PWA
// cannot capture location while fully closed (this is an OS-level
// restriction on both iOS and Android, not something this app can work
// around). A driver's dot only updates while they actually have the app
// open in the foreground; if they close it, their last-known location just
// sits there until they reopen it.
// =====================================================================

let driverLocationIntervalId = null;
const DRIVER_LOCATION_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes while open

async function isCurrentUserDriverRole() {
  if (!currentProfile?.role_id) return false;
  try {
    const roles = await fetchRoles();
    const match = roles.find((r) => r.id === currentProfile.role_id);
    return !!match && String(match.name || '').trim().toLowerCase() === 'driver';
  } catch {
    return false;
  }
}

async function updateMyDriverLocation() {
  const r = await fetchAndFillLocation({ silent: true, fillField: false });
  if (!r.ok) return;
  await sb.from('driver_locations').upsert({
    person_id: currentUser.id,
    lat: r.lat,
    lng: r.lng,
    address: r.address,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'person_id' });
}

async function startDriverLocationLoopIfNeeded() {
  if (driverLocationIntervalId) return; // already running
  const isDriver = await isCurrentUserDriverRole();
  if (!isDriver || !navigator.geolocation) return;
  updateMyDriverLocation();
  driverLocationIntervalId = setInterval(updateMyDriverLocation, DRIVER_LOCATION_INTERVAL_MS);
}

function minutesAgoLabel(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
}

// One combined map with every driver pinned on it at once — refreshed each
// time this panel opens or Refresh is tapped. Not a moving live feed (it's
// a static image), but it shows everyone's last-known spot together on one
// map instead of only separate per-driver thumbnails.
function combinedDriverMapUrl(points, size = '640x280') {
  if (!points.length) return '';
  // Center on the average position so every pin fits reasonably on screen.
  const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const avgLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const markers = points.map((p) => `${p.lat},${p.lng},red-dot`).join('|');
  const zoom = points.length > 1 ? 11 : 15;
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${avgLat},${avgLng}&zoom=${zoom}&size=${size}&maptype=mapnik&markers=${markers}`;
}

async function renderLiveDrivers() {
  const wrap = $('liveDriversList');
  const mapWrap = $('liveDriversMapArea');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty">Loading…</div>';
  if (mapWrap) mapWrap.innerHTML = '';
  const { data, error } = await sb
    .from('driver_locations')
    .select('person_id, lat, lng, address, updated_at, profiles(full_name, email)')
    .order('updated_at', { ascending: false });
  if (error) {
    wrap.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data || !data.length) {
    wrap.innerHTML = '<div class="empty">No driver locations yet — a driver needs to open the app at least once with location access allowed. (Make sure at least one person has the "Driver" role set in Admin → Team.)</div>';
    return;
  }
  if (mapWrap) {
    mapWrap.innerHTML = `<img src="${combinedDriverMapUrl(data)}" onerror="this.style.display='none'" alt="All drivers map" style="width:100%; border-radius:14px; display:block;" />`;
  }
  wrap.innerHTML = data.map((d) => `
    <div class="entry">
      <span class="type-icon">🚗</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(d.profiles?.full_name || d.profiles?.email || 'Driver')}</div>
        <div class="entry-meta">${escapeHtml(d.address || `${d.lat}, ${d.lng}`)} · ${minutesAgoLabel(d.updated_at)}</div>
      </div>
    </div>
  `).join('');
}

if ($('refreshLiveDriversBtn')) $('refreshLiveDriversBtn').addEventListener('click', renderLiveDrivers);

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

// Pairs a clock-in or clock-out moment together — date, time, AND where it
// happened (address + map) — as one clearly-labeled block, instead of
// scattered separate rows. This is what actually answers "where and when
// did they clock in vs out", which separate Date/Start time/Clocked-in-near
// rows never made obvious at a glance.
function clockEventBlockHtml(label, emoji, dateVal, timeVal, address, lat, lng) {
  if (!timeVal && !address) return '';
  const whenBits = [dateVal, timeVal ? timeLabel12h(timeVal) : ''].filter(Boolean);
  const when = whenBits.length ? ` — ${whenBits.join(' at ')}` : '';
  return `
    <div class="review-row-block clock-loc-block">
      <div class="clock-loc-label">${emoji} ${escapeHtml(label)}${escapeHtml(when)}</div>
      ${address ? `<div class="clock-loc-addr">${escapeHtml(address)}</div>` : ''}
      ${lat ? `<img class="clock-loc-map" src="${staticMapUrl(lat, lng, '300x140')}" onerror="this.style.display='none'" alt="${escapeHtml(label)} map" />` : ''}
    </div>`;
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
    const lunchMinutesRaw = parseInt($('lunchMinutes').value, 10) || 0;
    const allowanceLocation = $('allowanceLocation') && $('allowanceLocation').value ? $('allowanceLocation').value : null;
    // Attendance proof — where they actually clocked in and (once they have)
    // clocked out, captured automatically by GPS, never typed by hand.
    const clk = getClockState();
    // Any time spent on Quick Job Switch interruptions today gets deducted
    // from THIS job's hours here — folded straight into lunchMinutes, since
    // that's the one field every hour calculation (Reports, edge functions)
    // already subtracts. lunchMinutesRaw/qsrDeductedMinutes are kept
    // separately too, purely so the entry detail view can show the two
    // apart instead of one confusing combined number.
    const qsrDeductedMinutes = clk.interruptionMinutes || 0;

    // If they never explicitly tapped "Clock Out" (still shows as
    // working/on a break) and are submitting anyway, submitting IS the
    // clock-out — capture the same date/time/location a manual Clock Out
    // tap would, right now, so every entry always has both ends of the day
    // instead of only "Clocked in" with nothing for "Clocked out". This
    // does not touch the persisted clock state itself — that's only ever
    // reset on final confirm (resetClockState), so going Back from Review
    // doesn't wrongly stop an actually-still-running clock.
    let endTimeVal = $('endTime').value;
    let clockOutLocation = clk.clockOutLocation || null;
    let clockOutLat = clk.clockOutLat ?? null;
    let clockOutLng = clk.clockOutLng ?? null;
    if (clk.status === 'working' || clk.status === 'onbreak') {
      if (!endTimeVal) {
        endTimeVal = toTimeInputValue(new Date());
        $('endTime').value = endTimeVal;
      }
      if (!clockOutLocation) {
        setClockLocationStatus('📍 Getting your clock-out location…');
        const r = await fetchAndFillLocation({ silent: true, fillField: false });
        setClockLocationStatus('');
        if (r.ok) { clockOutLocation = r.address; clockOutLat = r.lat; clockOutLng = r.lng; }
      }
    }

    // Break In / Break Out — the actual clock times (local "HH:MM", same
    // format as Start/End Time) of the first break started and the last
    // break ended today, not just a duration — for the Time Entry sheet's
    // own Break In / Break Out columns. A person who never took a break
    // simply has both blank.
    const firstBreak = Array.isArray(clk.breaks) && clk.breaks.length ? clk.breaks[0] : null;
    const lastBreak = Array.isArray(clk.breaks) && clk.breaks.length ? clk.breaks[clk.breaks.length - 1] : null;
    const breakStart = firstBreak?.start ? toTimeInputValue(firstBreak.start) : null;
    const breakEnd = lastBreak?.end ? toTimeInputValue(lastBreak.end) : null;

    return {
      ...base,
      category: 'timesheet',
      mode: selectedMode,
      jobId: $('jobId').value.trim() || null,
      project: $('project').value.trim(),
      location: $('location').value.trim(),
      allowanceLocation,
      date: $('date').value,
      startTime: $('startTime').value,
      endTime: endTimeVal,
      lunchMinutes: lunchMinutesRaw + qsrDeductedMinutes,
      lunchMinutesRaw,
      qsrDeductedMinutes,
      breakStart,
      breakEnd,
      description: $('workNotes').value.trim(),
      clockInLocation: clk.clockInLocation || null,
      clockInLat: clk.clockInLat ?? null,
      clockInLng: clk.clockInLng ?? null,
      clockOutLocation,
      clockOutLat,
      clockOutLng,
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
    jobId: $('jobIdSimple') && $('jobIdSimple').value.trim() ? $('jobIdSimple').value.trim() : null,
    project: $('projectSimple').value.trim(),
    date: $('dateSimple').value,
    time: $('timeSimple') && $('timeSimple').value ? $('timeSimple').value : null,
    description: $('descriptionSimple').value.trim(),
    attachments: await filesToAttachments($('filesSimple').files)
  };
}

// Shared row-builder — used both for the pre-submit Review step and for
// "view details" on an already-queued entry. opts.full adds the
// bookkeeping fields (who, when, sync status) that only make sense once an
// entry actually exists in the queue.
function entryDetailRows(draft, opts = {}) {
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
      // Clock-in and clock-out each get their date + time + where-it-happened
      // shown together as one block — this is what actually lets someone
      // check "clocked in at the office at 8am, clocked out somewhere else
      // at 5pm" at a glance, instead of hunting across separate rows.
      rows.push(clockEventBlockHtml('Clocked in', '🟢', draft.date, draft.startTime, draft.clockInLocation, draft.clockInLat, draft.clockInLng));
      rows.push(clockEventBlockHtml('Clocked out', '🔴', draft.date, draft.endTime, draft.clockOutLocation, draft.clockOutLat, draft.clockOutLng));
      // draft.lunchMinutes (used for every actual hour calculation) is the
      // raw lunch value PLUS any Quick Job Switch time deducted — shown
      // here broken back apart so it's clear where the deduction came from,
      // rather than one confusing combined number. Older entries saved
      // before this existed won't have these two sub-fields, so fall back
      // to showing the plain combined value exactly as before.
      if (draft.lunchMinutesRaw !== undefined || draft.qsrDeductedMinutes !== undefined) {
        rows.push(rowHtml('Lunch/break (min)', draft.lunchMinutesRaw || 0));
        if (draft.qsrDeductedMinutes) rows.push(rowHtml('Quick job time deducted (min)', draft.qsrDeductedMinutes));
      } else {
        rows.push(rowHtml('Lunch/break (min)', draft.lunchMinutes));
      }
      rows.push(rowHtml('Allowance area', draft.allowanceLocation));
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
  if (opts.full) {
    rows.push(rowHtml('Submitted by', draft.userLabel));
    rows.push(rowHtml('Created', draft.createdAt ? new Date(draft.createdAt).toLocaleString() : ''));
    rows.push(rowHtml('Status', draft.status));
    if (draft.status === 'error' && draft.error) rows.push(rowHtml('Sync error', draft.error));
  }
  return rows;
}

function showReview(draft) {
  $('reviewContent').innerHTML = entryDetailRows(draft).join('');
  $('reviewOverlay').classList.add('show');
}

// Queue → tap any entry to review its full details again before/after sync.
async function openEntryDetail(id) {
  const entries = await getAllEntries();
  const en = entries.find((e) => e.id === id);
  if (!en) return;
  if ($('entryDetailTitle')) $('entryDetailTitle').textContent = 'Entry details';
  $('entryDetailBody').innerHTML = entryDetailRows(en, { full: true }).join('');

  // Recall — only makes sense once it's actually synced (live on
  // Reports/dashboards) and only for timesheet/leave entries (that's what
  // recall-entry supports right now). Already-recalled entries just show a
  // status line instead of the button again.
  const actions = $('entryDetailActions');
  if (actions) {
    const canRecall = en.status === 'synced' && (en.category === 'timesheet' || en.category === 'leave');
    if (canRecall) {
      actions.innerHTML = `<button type="button" class="secondary" id="recallEntryBtn" style="width:100%;">↩️ Recall this entry</button>`;
      $('recallEntryBtn').addEventListener('click', () => recallEntry(en));
    } else if (en.status === 'recalled') {
      actions.innerHTML = `<p class="hint" style="margin-top:0;">↩️ Recalled — this is no longer on any dashboard or report. An admin can restore, correct, or delete it from Admin → Recalled Entries.</p>`;
    } else {
      actions.innerHTML = '';
    }
  }
  openPanel('entryDetail');
}

// Pulls a live (already-synced) timesheet/leave entry back out of GitHub —
// moves it into a "_recalled" holding area (see recall-entry Edge Function)
// so it disappears from every dashboard/report immediately, while an admin
// can still find and fix or delete it from Admin → Recalled Entries.
async function recallEntry(en) {
  if (!confirm('Recall this entry? It will be removed from Reports and every dashboard right away. An admin will need to review it before it counts again.')) return;
  const { data: { session } } = await getSessionSafe();
  if (!session) { showToast('Please log in first.'); return; }
  const btn = $('recallEntryBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Recalling…'; }
  try {
    const { data, error } = await sb.functions.invoke('recall-entry', {
      body: {
        category: en.category,
        id: en.id,
        date: en.date || en.leaveStart,
        userLabel: en.userLabel,
      },
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (error || data?.error) throw new Error(data?.error || await readFunctionsError(error));
    en.status = 'recalled';
    await updateEntry(en);
    showToast('Recalled — removed from dashboards. An admin can now review it.');
    renderQueue();
    closePanel('entryDetail');
  } catch (err) {
    showToast(`Couldn't recall: ${err.message || err}`);
    if (btn) { btn.disabled = false; btn.textContent = '↩️ Recall this entry'; }
  }
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
  // A submitted work-day entry means today's clock cycle is done — reset it
  // so tomorrow's Clock In starts fresh instead of showing yesterday's times.
  if (pendingEntryDraft.category === 'timesheet') resetClockState();
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
  const btn = $('loginBtn');
  if (btn.disabled) return; // already trying — a repeat tap on a slow mobile
                            // connection used to fire a second sign-in on
                            // top of the first, with nothing shown either way.
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  $('authMsg').textContent = '';
  try {
    // Same reasoning as everywhere else this pass: no ceiling here meant a
    // slow/flaky mobile connection just sat there with the button doing
    // nothing and no message at all — which is exactly what "tried logging
    // in several times and it just won't go in" looks like from the outside.
    const { data, error } = await withTimeout(sb.auth.signInWithPassword({ email, password }), 20000, 'Sign in');
    if (error) {
      $('authMsg').textContent = error.message;
    } else {
      // Normally sb.auth.onAuthStateChange's 'SIGNED_IN' event fires right
      // after this and calls enterApp() on its own. But on some mobile
      // browsers that event can be delayed or dropped entirely (backgrounding,
      // power-saving throttling, etc.) — which looks exactly like "login
      // screen just sits there and never moves forward" even though signing
      // in actually worked. Calling enterApp() directly here as well costs
      // nothing extra (it's a safe no-op if onAuthStateChange already did
      // it) and closes that gap for good. Passing data.user directly (this
      // sign-in response already confirmed exactly who it is) skips the
      // redundant getUser() re-check that was itself timing out right after
      // a fresh, already-successful login.
      await enterApp(data.user);
    }
  } catch (err) {
    $('authMsg').textContent = err.message || 'Something went wrong — please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
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
  await enterApp(currentUser || undefined);
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
  if ($('adminMoreRow')) $('adminMoreRow').style.display = 'none';
  closeAiChat();
  closeChatOverlay();
  closePanel('projects');
  closePanel('projectDetail');
  closePanel('learning');
  closePanel('health');
  stopPresence();
  if (messagesChannel) { sb.removeChannel(messagesChannel); messagesChannel = null; }
  clearInterval(chatListTimer);
  clearInterval(openChatTimer);
  activeChatId = null; activeChatMeta = null; teamProfiles = []; chatListCache = [];
  showAuthView('loginView');
});

// RELIABILITY: this used to always require a live network round-trip, which
// meant opening the app with no signal at all (or a very weak one) could
// fail before the app shell ever showed — even though the person already
// had a perfectly valid saved session. Now every successful load is cached
// to localStorage, and if the network call fails (offline, timeout, DNS
// hiccup, anything), we fall back to that last-known-good copy instead of
// blocking the whole app. This is exactly what lets someone open the app
// with zero connectivity, log a timesheet entry, and have it wait in the
// local queue until they're back online — the app shell itself has to be
// able to open offline first for that to even be possible.
function cacheProfile(userId, profile) {
  try { localStorage.setItem(`ctorq-profile-${userId}`, JSON.stringify(profile)); } catch (e) { /* ignore */ }
}
function getCachedProfile(userId) {
  try {
    const raw = localStorage.getItem(`ctorq-profile-${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
async function loadProfile(user) {
  try {
    const result = await raceTimeout(
      sb.from('profiles').select('*').eq('id', user.id).single(),
      6000
    );
    if (result.__timedOut) throw new Error('profile lookup timed out');
    const { data, error } = result;
    if (error) throw error;
    if (!data) throw new Error('no profile row');
    cacheProfile(user.id, data);
    return data;
  } catch (err) {
    const cached = getCachedProfile(user.id);
    if (cached) {
      console.warn('[Profile] using cached profile (network unavailable):', err);
      return cached;
    }
    throw err; // no cache to fall back to — caller decides what to do
  }
}

async function enterApp(knownUser) {
 try {
  // If the caller already has a just-verified user (e.g. straight off a
  // successful sign-in response), use it directly instead of asking the
  // server "who is this?" all over again right afterward. That redundant
  // re-check is exactly what was causing "login succeeds instantly, then
  // the button sits on Signing in… forever" — the fresh sign-in and the
  // immediate follow-up getUser() call can contend over the same internal
  // auth lock, so the re-check waits out the same multi-second timeout/retry
  // this function uses for a plain page refresh, even though there was
  // nothing left to verify.
  let user = knownUser || null;
  if (!user) {
  let result = await raceTimeout(sb.auth.getUser(), 7000);
  user = result.__timedOut ? null : result.data.user;
  if (!user) {
    // Either the check timed out (likely a slow-to-release internal lock
    // on a fast refresh, not an actual problem), or the stored session
    // looked valid locally but the server couldn't confirm it (expired
    // token, brief network hiccup, etc.). Try once more after a short
    // pause — most of these are transient — before giving up. This used
    // to just silently return here, which left BOTH screens hidden with
    // nothing shown at all: a genuinely blank page with no error, since
    // nothing actually crashed.
    await new Promise((r) => setTimeout(r, 1500));
    result = await raceTimeout(sb.auth.getUser(), 7000);
    user = result.__timedOut ? null : result.data.user;
  }
  if (!user) {
    currentUser = null;
    currentProfile = null;
    // Only wipe the stored session if the server actually, confirmedly
    // said there's no valid user (result.error / null user came back
    // cleanly) — not if we merely timed out both times. A timeout just
    // means the check was slow, not that the session is bad; clearing it
    // in that case would force a real re-login even though the person was
    // probably fine and the next attempt would have worked.
    if (!result.__timedOut) clearStoredSession();
    $('appShell').style.display = 'none';
    $('authScreen').style.display = 'flex';
    showAuthView('loginView');
    $('authMsg').textContent = 'Your session expired — please log in again.';
    return;
  }
  }
  currentUser = user;
  currentProfile = await loadProfile(user);

  // Belt-and-braces: an admin deactivating someone bans their account at
  // the Auth level (blocks future sign-ins), but a device that was already
  // signed in might still be holding a short-lived access token. If that
  // happens, boot them out here too rather than letting the app shell show.
  if (currentProfile?.status === 'deactivated') {
    await sb.auth.signOut().catch(() => {});
    currentUser = null;
    currentProfile = null;
    $('appShell').style.display = 'none';
    $('authScreen').style.display = 'flex';
    showAuthView('loginView');
    $('authMsg').textContent = 'Your account has been deactivated. Contact your admin.';
    return;
  }

  $('authScreen').style.display = 'none';
  $('appShell').style.display = 'block';
  $('accountEmail').textContent = user.email;
  $('adminTabBtn').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
  $('adminHomeBtn').style.display = currentProfile?.role === 'admin' ? 'flex' : 'none';
  $('newGroupBtn').style.display = currentProfile?.role === 'admin' ? 'inline-block' : 'none';
  if ($('newsComposeCard')) $('newsComposeCard').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
  checkForUnreadNews();
  applyFeatureAccess();
  startPresence();
  populateAllowanceDropdown();
  // Rehydrate BEFORE checking today's allocation, so an already-in-progress
  // clock-in (possibly on a different job than today's fresh allocation)
  // wins — renderMyTodayAssignment only fills Job ID if it's still empty.
  populateJobIdDropdown()
    .then(() => { rehydrateEntryFormFromClockState(); return renderMyTodayAssignment(); })
    .then(renderJobBoard)
    .then(renderAdminScheduleBoard);
  renderMyTripsToday();
  // Projects / Departments / Learning / Health / Clients / Quotations /
  // Project Tank / Job Allocation tiles are all just part of the single
  // Home grid now (see index.html) — visible to everyone, gated per-tile
  // by data-feature/applyFeatureAccess() same as every other tile, so
  // there's nothing extra to show/hide here anymore.
  if ($('adminMoreRow')) $('adminMoreRow').style.display = 'flex';

  renderQueue();
  syncQueue();
  startDriverLocationLoopIfNeeded();
 } catch (err) {
  // Anything unexpected here (a Supabase error, a network hiccup loading
  // the profile, anything at all) used to leave the page permanently
  // blank, since nothing ever caught it. Now it always falls back to a
  // normal, usable login screen instead. We deliberately do NOT clear the
  // stored session here — this only runs when loadProfile() had no cached
  // fallback to use either (e.g. the very first time this device has ever
  // loaded a profile), which is a real edge case, but it still isn't proof
  // the session itself is bad, so we don't force a real re-login over it.
  console.warn('[Auth] enterApp failed, falling back to login:', err);
  currentUser = null;
  currentProfile = null;
  $('appShell').style.display = 'none';
  $('authScreen').style.display = 'flex';
  showAuthView('loginView');
  $('authMsg').textContent = 'Something went wrong loading your session — please log in again.';
 }
}

// Shows the signed-in person's own Job Allocation for today, right on the
// New Entry tab — previously this only ever reached them via the 6:55am
// push/email reminder, with no way to check it again later in the day.
async function renderMyTodayAssignment() {
  const card = $('myAssignmentCard');
  const area = $('myAssignmentArea');
  if (!card || !area || !currentUser) return;
  const todayKey = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('daily_assignments')
    .select('project, location, notes, assignment_type')
    .eq('person_id', currentUser.id)
    .eq('work_date', todayKey)
    .maybeSingle();
  if (error || !data) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  // Job ID is the one thing someone actually picks in New Entry — if
  // there's already a real job published for them today and they haven't
  // picked something else, load it in automatically so Clock In is the
  // very next tap.
  if (data.project && $('jobId') && !$('jobId').value.trim()) {
    $('jobId').value = data.project;
    autoFillProjectFromJobId(data.project);
  }
  const isTransport = data.assignment_type === 'transportation';
  // The job may have been allocated via Job Allocation (data.project holds a
  // real Job ID) — look up its description if we already have it cached, so
  // this reads as "TVD/26/00229 — Site inspection" instead of just a code.
  const jobMatch = jobSearchOptions.find((r) => r.job_id === data.project);
  const jobLine = jobMatch ? `${data.project} — ${jobMatch.name || ''}` : (data.project || 'No details given');
  area.innerHTML = isTransport ? `
    <div class="entry" style="border-color: rgba(224,190,90,0.45);">
      <span class="type-icon" style="font-size:20px;">🚗</span>
      <div class="entry-body">
        <div class="entry-meta" style="color: var(--warn); font-weight:700; text-transform:uppercase; font-size:11px; letter-spacing:0.3px;">You're driving today</div>
        <div class="entry-desc" style="font-size:14.5px; font-weight:650; margin-top:2px;">${escapeHtml(jobLine)}</div>
        ${data.location ? `<div class="entry-meta" style="margin-top:2px;">📍 Pickup: ${escapeHtml(data.location)}</div>` : ''}
        ${data.notes ? `<div class="entry-meta" style="margin-top:2px;">${escapeHtml(data.notes)}</div>` : ''}
      </div>
    </div>
  ` : `
    <div class="entry">
      <span class="type-icon">🗓️</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(jobLine)}</div>
        <div class="entry-meta">${data.location ? escapeHtml(data.location) : ''}${data.notes ? (data.location ? ' · ' : '') + escapeHtml(data.notes) : ''}</div>
      </div>
    </div>
  `;
}

// Looks up a job's description from the cached project list, same helper
// logic used by renderMyTodayAssignment above, shared by the job board and
// My Jobs panel below so every "job id — description" line reads the same.
function jobLineFor(jobId) {
  const jobMatch = jobSearchOptions.find((r) => r.job_id === jobId);
  return jobMatch ? `${jobId}${jobMatch.name ? ' — ' + jobMatch.name : ''}` : (jobId || 'No job set');
}

// The New Entry "Project" field is read-only — it's always derived from
// whichever Job ID was picked, never typed by hand. Called every time a Job
// ID gets set, from wherever that happens (search pick, Quick Job Switch,
// or auto-preloading today's allocation).
function autoFillProjectFromJobId(jobId) {
  if (!$('project')) return;
  const jobMatch = jobSearchOptions.find((r) => r.job_id === jobId);
  $('project').value = jobMatch?.name || jobId || '';
}
function timeLabel12h(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, '0')} ${period}`;
}

// TODAY'S JOB BOARD — a message-board style broadcast on Home, visible to
// EVERYONE (not just people assigned), so the whole team can see what's
// been published for today at a glance: job id, location, arrival time,
// driver, and who's working it. Re-rendered on login and every time
// someone returns to Home.
async function renderJobBoard() {
  const card = $('jobBoardCard');
  const area = $('jobBoardArea');
  if (!card || !area || !currentUser) return;
  const todayKey = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('daily_assignments')
    .select('project, location, attendance_time, assignment_type, is_driver, person_id, profiles!daily_assignments_person_id_fkey(full_name, email)')
    .eq('work_date', todayKey);
  if (error || !data || !data.length) { card.style.display = 'none'; return; }

  // Group every row by job id — each published job becomes one message box,
  // listing its driver(s) and everyone else ticked onto it. A worker can
  // also be the driver (is_driver=true on their 'job' row), so we collect
  // driver names separately from the plain-worker list rather than treating
  // the two as mutually exclusive.
  const byJob = new Map();
  data.forEach((r) => {
    if (!byJob.has(r.project)) byJob.set(r.project, { location: '', attendanceTime: '', drivers: [], workers: [] });
    const g = byJob.get(r.project);
    if (r.location && !g.location) g.location = r.location;
    if (r.attendance_time && !g.attendanceTime) g.attendanceTime = r.attendance_time;
    const name = r.profiles?.full_name || r.profiles?.email || 'Someone';
    if (r.assignment_type === 'transportation') g.drivers.push(name);
    else { g.workers.push(name); if (r.is_driver) g.drivers.push(name); }
  });

  card.style.display = 'block';
  area.innerHTML = Array.from(byJob.entries()).map(([jobId, g]) => `
    <div class="job-board-item">
      <div class="job-board-head">
        <strong>${escapeHtml(jobLineFor(jobId))}</strong>
        ${g.attendanceTime ? `<span class="job-board-time">⏰ ${escapeHtml(timeLabel12h(g.attendanceTime))}</span>` : ''}
      </div>
      ${g.location ? `<div class="job-board-line">📍 ${escapeHtml(g.location)}</div>` : ''}
      ${g.drivers.length ? `<div class="job-board-line">🚗 Driver: ${escapeHtml(g.drivers.join(', '))}</div>` : ''}
      ${g.workers.length ? `<div class="job-board-line">🧑‍🤝‍🧑 ${escapeHtml(g.workers.join(', '))}</div>` : ''}
    </div>
  `).join('');
}

// ADMIN — ALL SCHEDULES: every published job allocation from today onward,
// across every person, grouped by date then by job — so an admin sees the
// whole upcoming roster right on the dashboard, not just today's board.
async function renderAdminScheduleBoard() {
  const card = $('adminScheduleCard');
  const area = $('adminScheduleArea');
  if (!card || !area || !currentUser) return;
  if (currentProfile?.role !== 'admin') { card.style.display = 'none'; return; }
  const todayKey = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('daily_assignments')
    .select('work_date, project, location, attendance_time, assignment_type, is_driver, person_id, profiles!daily_assignments_person_id_fkey(full_name, email)')
    .gte('work_date', todayKey)
    .order('work_date', { ascending: true })
    .limit(500);
  if (error || !data || !data.length) { card.style.display = 'none'; return; }

  // Group by date, then by job id within each date — same shape as the
  // Today's Job Board, just spanning every upcoming date instead of one.
  // A worker can also be the driver (is_driver=true on their 'job' row), so
  // drivers are collected separately rather than treated as exclusive.
  const byDate = new Map();
  data.forEach((r) => {
    if (!byDate.has(r.work_date)) byDate.set(r.work_date, new Map());
    const byJob = byDate.get(r.work_date);
    if (!byJob.has(r.project)) byJob.set(r.project, { location: '', attendanceTime: '', drivers: [], workers: [] });
    const g = byJob.get(r.project);
    if (r.location && !g.location) g.location = r.location;
    if (r.attendance_time && !g.attendanceTime) g.attendanceTime = r.attendance_time;
    const name = r.profiles?.full_name || r.profiles?.email || 'Someone';
    if (r.assignment_type === 'transportation') g.drivers.push(name);
    else { g.workers.push(name); if (r.is_driver) g.drivers.push(name); }
  });

  const tomorrowKey = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const dateLabel = (d) => (d === todayKey ? 'Today' : d === tomorrowKey ? 'Tomorrow' : d);

  card.style.display = 'block';
  area.innerHTML = Array.from(byDate.entries()).map(([date, byJob]) => `
    <div class="admin-schedule-date-group">
      <div class="admin-schedule-date-head">${escapeHtml(dateLabel(date))}</div>
      ${Array.from(byJob.entries()).map(([jobId, g]) => `
        <div class="job-board-item">
          <div class="job-board-head">
            <strong>${escapeHtml(jobLineFor(jobId))}</strong>
            ${g.attendanceTime ? `<span class="job-board-time">⏰ ${escapeHtml(timeLabel12h(g.attendanceTime))}</span>` : ''}
          </div>
          ${g.location ? `<div class="job-board-line">📍 ${escapeHtml(g.location)}</div>` : ''}
          ${g.drivers.length ? `<div class="job-board-line">🚗 Driver: ${escapeHtml(g.drivers.join(', '))}</div>` : ''}
          ${g.workers.length ? `<div class="job-board-line">🧑‍🤝‍🧑 ${escapeHtml(g.workers.join(', '))}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');
}

// MY JOBS — each person's own view of everything they've been allocated,
// today plus every other day (recent history and anything upcoming), not
// gated by allowed_features since it's just their own information.
let myJobsCache = []; // last-loaded rows, so tapping one can show full details without re-querying

async function renderMyJobsPanel() {
  const list = $('myJobsList');
  if (!list || !currentUser) return;
  list.innerHTML = '<div class="empty">Loading…</div>';
  const todayKey = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('daily_assignments')
    .select('id, work_date, project, location, notes, attendance_time, assignment_type, is_driver')
    .eq('person_id', currentUser.id)
    .order('work_date', { ascending: false })
    .limit(120);
  if (error) { list.innerHTML = `<div class="empty">Couldn't load your jobs: ${escapeHtml(error.message)}</div>`; return; }
  if (!data || !data.length) { list.innerHTML = '<div class="empty">No jobs allocated to you yet.</div>'; return; }
  myJobsCache = data;

  list.innerHTML = data.map((r) => {
    const isToday = r.work_date === todayKey;
    const isDriver = r.assignment_type === 'transportation' || !!r.is_driver;
    return `
      <div class="entry entry-clickable" data-myjob-id="${escapeHtml(r.id)}" title="Tap for full details" style="${isToday ? 'border-color: var(--accent);' : ''}">
        <span class="type-icon">${isDriver ? '🚗' : '🗓️'}</span>
        <div class="entry-body">
          <div class="entry-desc">${escapeHtml(jobLineFor(r.project))}</div>
          <div class="entry-meta">
            ${isToday ? '<strong style="color:var(--accent);">TODAY</strong> · ' : ''}${escapeHtml(r.work_date)}
            ${r.attendance_time ? ' · ⏰ ' + escapeHtml(timeLabel12h(r.attendance_time)) : ''}
            ${r.location ? ' · 📍 ' + escapeHtml(r.location) : ''}
            ${isDriver ? ' · 🚗 Driver' : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('[data-myjob-id]').forEach((row) => {
    row.addEventListener('click', () => openMyJobDetail(row.dataset.myjobId));
  });
}

// Tapping a row in My Jobs — shows everything about that day's allocation:
// job + description, date, location, arrival time, your role, and any note
// the admin left when publishing it.
function openMyJobDetail(id) {
  const r = myJobsCache.find((x) => x.id === id);
  if (!r) return;
  const isTransportOnly = r.assignment_type === 'transportation';
  const roleLabel = isTransportOnly ? 'Driver' : (r.is_driver ? 'Worker + Driver' : 'Worker');
  const rows = [
    rowHtml('Job', jobLineFor(r.project)),
    rowHtml('Date', r.work_date),
    rowHtml('Your role', roleLabel),
    rowHtml('Location', r.location),
    rowHtml('Arrival time', r.attendance_time ? timeLabel12h(r.attendance_time) : ''),
    rowHtml('Notes', r.notes),
  ];
  if ($('entryDetailTitle')) $('entryDetailTitle').textContent = 'Job details';
  $('entryDetailBody').innerHTML = rows.join('');
  if ($('entryDetailActions')) $('entryDetailActions').innerHTML = ''; // this view has no Recall action — Queue's openEntryDetail is the only one that populates it
  openPanel('entryDetail');
}

// Loads every active project into memory once, so the New Entry "Project /
// Job ID" field can search by job number OR description as the person
// types — with 50+ jobs a plain dropdown is painful to scroll through, this
// is common for everyone (not just admins).
let jobSearchOptions = [];
async function populateJobIdDropdown() {
  const { data, error } = await sb.from('projects').select('job_id, name, client').eq('status', 'active').order('job_id');
  jobSearchOptions = error ? [] : (data || []);
}

function renderJobSearchResults(matches) {
  const box = $('jobIdResults');
  if (!box) return;
  if (!matches.length) {
    box.innerHTML = '<div class="job-search-empty">No matching job found — you can still type a Job ID manually.</div>';
  } else {
    box.innerHTML = matches.slice(0, 8).map((r) => `
      <div class="job-search-item" data-job-id="${escapeHtml(r.job_id)}">
        <div class="jid">${escapeHtml(r.job_id)}</div>
        <div class="jdesc">${escapeHtml(r.name || '')}${r.client ? ' · ' + escapeHtml(r.client) : ''}</div>
      </div>
    `).join('');
  }
  box.style.display = 'block';
  box.querySelectorAll('.job-search-item[data-job-id]').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      // mousedown (not click) so this fires before the input's blur hides the box
      e.preventDefault();
      $('jobId').value = item.dataset.jobId;
      autoFillProjectFromJobId(item.dataset.jobId);
      box.style.display = 'none';
    });
  });
}

if ($('jobId')) {
  $('jobId').addEventListener('input', () => {
    const q = $('jobId').value.trim().toLowerCase();
    if (!q) { $('jobIdResults').style.display = 'none'; return; }
    const matches = jobSearchOptions.filter((r) =>
      String(r.job_id).toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q)
    );
    renderJobSearchResults(matches);
  });
  $('jobId').addEventListener('focus', () => {
    if ($('jobId').value.trim()) $('jobId').dispatchEvent(new Event('input'));
  });
  $('jobId').addEventListener('blur', () => {
    // Small delay so a click/mousedown on a result registers first.
    setTimeout(() => { if ($('jobIdResults')) $('jobIdResults').style.display = 'none'; }, 150);
    // Covers a Job ID typed out fully by hand (no result tapped) — still
    // auto-fills Project if it's a real, known job.
    autoFillProjectFromJobId($('jobId').value.trim());
  });
}

// Same searchable Job ID box, reused on the Daily Progress / Project Report
// form (jobIdSimple) — kept separate from jobId above since the two forms
// aren't visible at the same time but share the same jobSearchOptions cache.
function renderJobSearchResultsSimple(matches) {
  const box = $('jobIdSimpleResults');
  if (!box) return;
  if (!matches.length) {
    box.innerHTML = '<div class="job-search-empty">No matching job found — you can still type a Job ID manually.</div>';
  } else {
    box.innerHTML = matches.slice(0, 8).map((r) => `
      <div class="job-search-item" data-job-id="${escapeHtml(r.job_id)}">
        <div class="jid">${escapeHtml(r.job_id)}</div>
        <div class="jdesc">${escapeHtml(r.name || '')}${r.client ? ' · ' + escapeHtml(r.client) : ''}</div>
      </div>
    `).join('');
  }
  box.style.display = 'block';
  box.querySelectorAll('.job-search-item[data-job-id]').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('jobIdSimple').value = item.dataset.jobId;
      const jobMatch = jobSearchOptions.find((r) => r.job_id === item.dataset.jobId);
      if ($('projectSimple') && !$('projectSimple').value.trim()) $('projectSimple').value = jobMatch?.name || item.dataset.jobId;
      box.style.display = 'none';
    });
  });
}
if ($('jobIdSimple')) {
  $('jobIdSimple').addEventListener('input', () => {
    const q = $('jobIdSimple').value.trim().toLowerCase();
    if (!q) { $('jobIdSimpleResults').style.display = 'none'; return; }
    const matches = jobSearchOptions.filter((r) =>
      String(r.job_id).toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q)
    );
    renderJobSearchResultsSimple(matches);
  });
  $('jobIdSimple').addEventListener('focus', () => {
    if ($('jobIdSimple').value.trim()) $('jobIdSimple').dispatchEvent(new Event('input'));
  });
  $('jobIdSimple').addEventListener('blur', () => {
    setTimeout(() => { if ($('jobIdSimpleResults')) $('jobIdSimpleResults').style.display = 'none'; }, 150);
  });
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
      await enterApp(session.user);
    }
  }
  if (event === 'SIGNED_OUT') {
    $('appShell').style.display = 'none';
    $('authScreen').style.display = 'flex';
    showAuthView('loginView');
  }
});

// Show the login screen immediately, synchronously, before any async auth
// check even begins. This guarantees the page can never sit fully blank —
// worst case, someone briefly sees the login form for a split second before
// being signed straight in, instead of any future hiccup in the checks
// below leaving absolutely nothing on screen.
$('authScreen').style.display = 'flex';

(async () => {
 try {
  let result = await raceTimeout(sb.auth.getSession(), 7000);
  if (result.__timedOut) {
    // This is the "sometimes goes straight in, sometimes doesn't, but a
    // brand-new tab always works" case: Supabase's client uses an internal
    // lock to stop two tabs/reloads refreshing the same token at once, and
    // a fast refresh (as opposed to opening a fresh tab) can briefly land
    // on that lock while the previous page's copy is still releasing it.
    // That's slow, not broken — so retry once after a short pause instead
    // of immediately giving up and wiping out an otherwise perfectly good
    // session.
    await new Promise((r) => setTimeout(r, 1500));
    result = await raceTimeout(sb.auth.getSession(), 7000);
  }
  if (result.__timedOut) {
    // Still nothing after the retry. Show the login screen, but do NOT
    // clear the stored session here — we don't actually know it's invalid,
    // just that checking it is taking unusually long. Wiping it now would
    // force a real login even though the session might be perfectly fine a
    // few seconds later.
    $('authScreen').style.display = 'flex';
    return;
  }
  const { data: { session } } = result;
  if (session) {
    const profile = await loadProfile(session.user);
    currentUser = session.user;
    currentProfile = profile;
    if (profile && profile.status === 'invited') {
      $('setPasswordIntro').textContent = 'Welcome! Set a password to finish joining.';
      showAuthView('setPasswordView');
      $('authScreen').style.display = 'flex';
    } else {
      // Pass the already-known session user straight through — this is the
      // difference between the app requiring a live network round-trip just
      // to open, and it working offline: getSession() above reads purely
      // from local storage, so if we hand that user directly to enterApp()
      // it never needs to ask the server "who is this?" all over again
      // before showing the app shell.
      await enterApp(session.user);
    }
  } else {
    $('authScreen').style.display = 'flex';
  }
 } catch (err) {
  // Whatever went wrong (network hiccup, a Supabase error, a corrupted
  // stored session, anything) — never let it leave the screen blank.
  // Fall back to a normal, usable login screen every time. Note: we do NOT
  // clear the stored session here — a network hiccup or being offline isn't
  // proof the session is actually bad, and wiping it would force a real
  // re-login the next time they open the app even if they were fine, just
  // briefly offline.
  console.warn('[Auth] startup check failed, falling back to login:', err);
  currentUser = null;
  currentProfile = null;
  $('appShell').style.display = 'none';
  $('authScreen').style.display = 'flex';
  showAuthView('loginView');
 }
})();

// =====================================================================
// NEWS ROOM — left-edge drawer. Everyone can read; only admins can post.
// =====================================================================

async function fetchNews() {
  const { data, error } = await sb.from('news').select('id, title, body, created_at, attachment_path, attachment_name, attachment_mime').order('created_at', { ascending: false }).limit(50);
  return error ? [] : (data || []);
}

// In-memory model for likes/comments, keyed by news id, so liking or
// commenting can patch just that one post's DOM instead of re-rendering
// (and losing) every expanded comment thread on the page.
let newsState = new Map(); // id -> { likes: Set<personId>, comments: [{id, person_id, body, created_at}] }
let newsPeopleCache = new Map(); // person_id -> {full_name, email}

async function loadNewsPeopleCache() {
  if (newsPeopleCache.size) return;
  const { data } = await sb.from('profiles').select('id, full_name, email');
  (data || []).forEach((p) => newsPeopleCache.set(p.id, p));
}
function newsPersonName(id) {
  const p = newsPeopleCache.get(id);
  if (!p) return id === currentUser?.id ? 'You' : 'Someone';
  return p.full_name || p.email;
}

function newsCommentRowHtml(c) {
  const mine = c.person_id === currentUser?.id;
  const isAdmin = currentProfile?.role === 'admin';
  return `
    <div class="news-comment-row" data-comment-id="${c.id}">
      <div class="news-comment-body-wrap">
        <div class="news-comment-name">${escapeHtml(newsPersonName(c.person_id))}</div>
        <div class="news-comment-text">${escapeHtml(c.body)}</div>
        <div class="news-comment-time">${new Date(c.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div>
      </div>
      ${(mine || isAdmin) ? `<button type="button" class="news-comment-del" data-delete-comment="${c.id}" title="Delete comment">✕</button>` : ''}
    </div>
  `;
}

function wireNewsCommentDelete(scopeEl) {
  scopeEl.querySelectorAll('[data-delete-comment]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this comment?')) return;
      const commentId = btn.dataset.deleteComment;
      const { error } = await sb.from('news_comments').delete().eq('id', commentId);
      if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
      const row = scopeEl.querySelector(`[data-comment-id="${commentId}"]`);
      const newsId = row?.closest('[data-news-id]')?.dataset.newsId;
      row?.remove();
      if (newsId && newsState.has(newsId)) {
        const state = newsState.get(newsId);
        state.comments = state.comments.filter((c) => c.id !== commentId);
        const countEl = document.querySelector(`[data-comment-count="${newsId}"]`);
        if (countEl) countEl.textContent = state.comments.length ? String(state.comments.length) : '';
      }
    });
  });
}

async function renderNewsList() {
  const list = $('newsList');
  if (!list) return;
  const rows = await fetchNews();
  if (!rows.length) { list.innerHTML = '<div class="empty">No news yet.</div>'; return; }
  const isAdmin = currentProfile?.role === 'admin';
  const ids = rows.map((n) => n.id);
  await loadNewsPeopleCache();
  const [{ data: likeRows }, { data: commentRows }] = await Promise.all([
    sb.from('news_likes').select('news_id, person_id').in('news_id', ids),
    sb.from('news_comments').select('id, news_id, person_id, body, created_at').in('news_id', ids).order('created_at', { ascending: true }),
  ]);
  newsState = new Map(rows.map((n) => [n.id, { likes: new Set(), comments: [] }]));
  (likeRows || []).forEach((r) => newsState.get(r.news_id)?.likes.add(r.person_id));
  (commentRows || []).forEach((c) => newsState.get(c.news_id)?.comments.push(c));

  list.innerHTML = rows.map((n) => {
    let attachmentHtml = '';
    if (n.attachment_path) {
      const { data: pub } = sb.storage.from('news-attachments').getPublicUrl(n.attachment_path);
      const url = pub?.publicUrl;
      attachmentHtml = (n.attachment_mime || '').startsWith('image/')
        ? `<div class="news-item-media"><img src="${url}" alt="${escapeHtml(n.attachment_name || 'Attachment')}" onclick="window.open(this.src, '_blank')" /></div>`
        : `<a class="chat-file-chip" href="${url}" target="_blank" rel="noopener" style="margin-top:8px;">📎 ${escapeHtml(n.attachment_name || 'Attachment')}</a>`;
    }
    const state = newsState.get(n.id);
    const likeCount = state.likes.size;
    const iLiked = currentUser && state.likes.has(currentUser.id);
    const commentCount = state.comments.length;
    return `
    <div class="news-item" data-news-id="${n.id}">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
        <div class="news-item-title">${escapeHtml(n.title)}</div>
        ${isAdmin ? `<button type="button" class="ghost" data-delete-news="${n.id}" data-attachment="${escapeHtml(n.attachment_path || '')}" title="Delete" style="flex:none; padding:2px 8px;">✕</button>` : ''}
      </div>
      <div class="news-item-body">${escapeHtml(n.body)}</div>
      ${attachmentHtml}
      <div class="news-item-date">${new Date(n.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div>
      <div class="news-item-actions">
        <button type="button" class="news-action-btn${iLiked ? ' liked' : ''}" data-like-btn="${n.id}">
          <span data-like-icon="${n.id}">${iLiked ? '👍' : '👍🏻'}</span> Like <span data-like-count="${n.id}">${likeCount || ''}</span>
        </button>
        <button type="button" class="news-action-btn" data-toggle-comments="${n.id}">
          💬 Comment <span data-comment-count="${n.id}">${commentCount || ''}</span>
        </button>
      </div>
      <div class="news-comments" data-comments-for="${n.id}">
        <div class="news-comment-list" data-comment-list="${n.id}">${state.comments.map(newsCommentRowHtml).join('')}</div>
        <div class="news-comment-input-row">
          <input type="text" placeholder="Write a comment…" data-comment-input="${n.id}" />
          <button type="button" class="secondary" data-comment-send="${n.id}">Send</button>
        </div>
      </div>
    </div>
  `;
  }).join('');

  list.querySelectorAll('[data-delete-news]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this news post?')) return;
      const { error } = await sb.from('news').delete().eq('id', btn.dataset.deleteNews);
      if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
      if (btn.dataset.attachment) {
        sb.storage.from('news-attachments').remove([btn.dataset.attachment]).catch(() => {});
      }
      showToast('Deleted.');
      renderNewsList();
    });
  });

  list.querySelectorAll('[data-like-btn]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newsId = btn.dataset.likeBtn;
      const state = newsState.get(newsId);
      if (!state || !currentUser) return;
      const alreadyLiked = state.likes.has(currentUser.id);
      btn.disabled = true;
      if (alreadyLiked) {
        const { error } = await sb.from('news_likes').delete().eq('news_id', newsId).eq('person_id', currentUser.id);
        if (!error) state.likes.delete(currentUser.id);
      } else {
        const { error } = await sb.from('news_likes').insert({ news_id: newsId, person_id: currentUser.id });
        if (!error) state.likes.add(currentUser.id);
      }
      btn.disabled = false;
      const nowLiked = state.likes.has(currentUser.id);
      btn.classList.toggle('liked', nowLiked);
      document.querySelector(`[data-like-icon="${newsId}"]`).textContent = nowLiked ? '👍' : '👍🏻';
      document.querySelector(`[data-like-count="${newsId}"]`).textContent = state.likes.size || '';
    });
  });

  list.querySelectorAll('[data-toggle-comments]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = document.querySelector(`[data-comments-for="${btn.dataset.toggleComments}"]`);
      el?.classList.toggle('show');
    });
  });

  list.querySelectorAll('[data-comment-send]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newsId = btn.dataset.commentSend;
      const input = list.querySelector(`[data-comment-input="${newsId}"]`);
      const body = input.value.trim();
      if (!body || !currentUser) return;
      btn.disabled = true;
      const { data, error } = await sb.from('news_comments').insert({ news_id: newsId, person_id: currentUser.id, body }).select().single();
      btn.disabled = false;
      if (error) { showToast(`Couldn't post comment: ${error.message}`); return; }
      input.value = '';
      newsState.get(newsId)?.comments.push(data);
      const listEl = list.querySelector(`[data-comment-list="${newsId}"]`);
      listEl.insertAdjacentHTML('beforeend', newsCommentRowHtml(data));
      wireNewsCommentDelete(listEl.lastElementChild);
      const countEl = list.querySelector(`[data-comment-count="${newsId}"]`);
      countEl.textContent = String(newsState.get(newsId).comments.length);
    });
  });
  list.querySelectorAll('[data-comment-input]').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') list.querySelector(`[data-comment-send="${input.dataset.commentInput}"]`)?.click();
    });
  });
  wireNewsCommentDelete(list);

  if (rows[0]) {
    try { localStorage.setItem('ctorq-news-last-seen', rows[0].created_at); } catch (e) { /* ignore */ }
  }
  if ($('newsHandleDot')) $('newsHandleDot').style.display = 'none';
}

async function checkForUnreadNews() {
  const rows = await fetchNews();
  if (!rows.length || !$('newsHandleDot')) return;
  let lastSeen = null;
  try { lastSeen = localStorage.getItem('ctorq-news-last-seen'); } catch (e) { /* ignore */ }
  if (!lastSeen || new Date(rows[0].created_at) > new Date(lastSeen)) {
    $('newsHandleDot').style.display = 'block';
  }
}

function openNewsDrawer() {
  $('newsDrawerBackdrop').classList.add('show');
  $('newsDrawer').classList.add('show');
  renderNewsList();
}
function closeNewsDrawer() {
  $('newsDrawerBackdrop').classList.remove('show');
  $('newsDrawer').classList.remove('show');
}
$('newsHandle')?.addEventListener('click', openNewsDrawer);
$('newsCloseBtn')?.addEventListener('click', closeNewsDrawer);
$('newsDrawerBackdrop')?.addEventListener('click', closeNewsDrawer);

$('postNewsBtn')?.addEventListener('click', async () => {
  const title = $('newsTitle').value.trim();
  const body = $('newsBody').value.trim();
  if (!title || !body) { showToast('Add a title and a message.'); return; }
  const btn = $('postNewsBtn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Posting…';
  try {
    let attachment_path = null, attachment_name = null, attachment_mime = null;
    const file = $('newsFile')?.files?.[0];
    if (file) {
      const safeName = file.name.replace(/[^a-z0-9_.-]/gi, '_');
      const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}_${safeName}`;
      const { error: upErr } = await sb.storage.from('news-attachments').upload(path, file);
      if (upErr) { showToast(`Couldn't upload attachment: ${upErr.message}`); return; }
      attachment_path = path;
      attachment_name = file.name;
      attachment_mime = file.type || 'application/octet-stream';
    }
    const { data: newRow, error } = await sb.from('news').insert({ title, body, attachment_path, attachment_name, attachment_mime, created_by: currentUser.id }).select().single();
    if (error) { showToast(`Couldn't post: ${error.message}`); return; }
    $('newsTitle').value = '';
    $('newsBody').value = '';
    if ($('newsFile')) $('newsFile').value = '';
    showToast('Posted.');
    renderNewsList();
    if (newRow) {
      const { data: { session } } = await getSessionSafe();
      sb.functions.invoke('send-push', {
        body: { kind: 'news', newsId: newRow.id },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      }).catch(() => {});
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// Swipe-to-open: a touch starting within 24px of the left edge that moves
// right by 40px or more opens the drawer, same destination as tapping the
// handle — the "drag the shutter open" gesture the handle alone doesn't
// cover on touch devices.
let newsDragStartX = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (t && t.clientX < 24) newsDragStartX = t.clientX;
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (newsDragStartX === null) return;
  const t = e.touches[0];
  if (t && t.clientX - newsDragStartX > 40) {
    openNewsDrawer();
    newsDragStartX = null;
  }
}, { passive: true });
document.addEventListener('touchend', () => { newsDragStartX = null; });

// =====================================================================
// ADMIN — invite teammates by email
// =====================================================================

$('sendInviteBtn').addEventListener('click', async () => {
  const email = $('inviteEmail').value.trim();
  const fullName = $('inviteName').value.trim();
  const roleId = $('inviteRole').value || null;
  if (!email) return;
  const { data: { session } } = await getSessionSafe();
  const { data, error } = await sb.functions.invoke('invite-user', {
    body: { email, fullName, roleId },
    headers: { Authorization: `Bearer ${session.access_token}` }
  });
  if (error || data?.error) {
    showToast(`Invite failed: ${data?.error || await readFunctionsError(error)}`);
    return;
  }
  showToast(`Invite sent to ${email}.`);
  $('inviteEmail').value = '';
  $('inviteName').value = '';
  renderTeamList();
});

const POSITION_LABEL = { engineer: 'Engineer', technician: 'Technician', other: 'Other' };

// The account owner's Admin status can never be removed by anyone —
// including other admins — not just "can't remove your own". Without this,
// any second admin could open Team, tap Remove Admin on the owner's row,
// and lock them out of their own system.
const PROTECTED_OWNER_EMAIL = 'anu@tv-me.com';

// Dashboard feature keys — must match the data-feature attributes on the
// home tiles / nav tabs in index.html, plus the two floating orbs (chat, ai)
// which are gated by id directly in applyFeatureAccess() below.
const FEATURE_LIST = [
  { key: 'entry', label: 'New Entry (timesheet & leave submission)' },
  { key: 'queue', label: 'Queue (their own submitted entries)' },
  { key: 'reports', label: 'Reports' },
  { key: 'projects', label: 'Projects' },
  { key: 'chat', label: 'Team Chat' },
  { key: 'ai', label: 'AEON Ai Assistant' },
  { key: 'settings', label: 'Settings' },
  { key: 'departments', label: 'Departments' },
  { key: 'learning', label: 'Learning' },
  { key: 'health', label: 'Health Challenges' },
  { key: 'clients', label: 'Clients' },
  { key: 'quotations', label: 'Quotations' },
  { key: 'tank', label: 'Project Tank' },
  { key: 'allocation', label: 'Job Allocation (allocate people & drivers to jobs)' },
  { key: 'datafeed', label: 'Data Feed (add jobs from pasted WhatsApp messages)' },
  { key: 'liveDrivers', label: 'Live Drivers (see driver locations)' },
];

// Hides every dashboard element tagged data-feature="X" (nav tabs, home
// tiles) plus the two floating orbs (chat, ai) unless X is in this person's
// allowed_features — a system admin (profiles.role === 'admin') always sees
// everything, regardless of what's ticked in Map Access.
function applyFeatureAccess() {
  const isAdmin = currentProfile?.role === 'admin';
  const allowed = Array.isArray(currentProfile?.allowed_features) ? currentProfile.allowed_features : [];
  const has = (key) => isAdmin || allowed.includes(key);

  document.querySelectorAll('[data-feature]').forEach((el) => {
    el.style.display = has(el.dataset.feature) ? '' : 'none';
  });

  const chatOn = has('chat');
  $('chatOrb').style.display = chatOn ? 'flex' : 'none';
  $('chatOrbLabel').style.display = chatOn ? 'block' : 'none';

  const aiOn = has('ai');
  $('aiOrb').style.display = aiOn ? 'flex' : 'none';
  $('aiOrbLabel').style.display = aiOn ? 'block' : 'none';

  // If the person's current tab just got hidden out from under them (e.g.
  // an admin revoked Reports while they were on it), send them back Home
  // rather than leaving a blank/inaccessible panel showing.
  const activeTabBtn = document.querySelector('nav.tabs button.active');
  const activeTab = activeTabBtn?.dataset.tab;
  if (activeTab && activeTab !== 'home' && activeTab !== 'admin' && !has(activeTab)) {
    document.querySelector('nav.tabs [data-tab="home"]')?.click();
  }
}

// This person's job-title role decides which internal budget bucket
// ('engineer' | 'technician' | 'other') their hours count toward in Reports
// — same two buckets that already existed, just now driven by the richer
// role list instead of a hardcoded dropdown.
function positionForRoleName(name) {
  const n = (name || '').toLowerCase();
  if (n === 'engineer') return 'engineer';
  if (n === 'technician') return 'technician';
  return 'other';
}

async function fetchRoles() {
  const { data, error } = await sb.from('roles').select('id, name').order('name');
  return error ? [] : (data || []);
}

async function populateInviteRoleDropdown() {
  const sel = $('inviteRole');
  if (!sel) return;
  const roles = await fetchRoles();
  sel.innerHTML = '<option value="">No role yet</option>' +
    roles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
}
populateInviteRoleDropdown();

$('addRoleBtn')?.addEventListener('click', async () => {
  const name = $('newRoleName').value.trim();
  if (!name) return;
  const { error } = await sb.from('roles').insert({ name });
  if (error) { showToast(`Couldn't add role: ${error.message}`); return; }
  $('newRoleName').value = '';
  showToast('Role added.');
  populateInviteRoleDropdown();
  renderTeamList();
});

async function renderTeamList() {
  const list = $('teamList');
  const [{ data, error }, { rows: depts }, roles] = await Promise.all([
    sb.from('profiles').select('id, email, full_name, role, status, position, role_id, allowed_features, department_id, created_at').order('created_at', { ascending: false }),
    fetchDepartments(),
    fetchRoles(),
  ]);
  if (error) { list.innerHTML = `<div class="empty">Couldn't load team list.</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="empty">No one invited yet.</div>'; return; }
  const deptOptions = '<option value="">No department</option>' + (depts || []).map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  const roleOptions = '<option value="">No role</option>' + roles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  list.innerHTML = data.map(p => `
    <div class="entry team-entry">
      <span class="type-icon">${p.role === 'admin' ? '👑' : '🙂'}</span>
      <div class="entry-body">
        <div class="entry-meta">${escapeHtml(p.full_name || p.email)}</div>
        <div class="entry-desc">${escapeHtml(p.email)}</div>
      </div>
      <select class="position-select" data-role-user="${p.id}">
        ${roleOptions.replace(`value="${p.role_id || ''}"`, `value="${p.role_id || ''}" selected`)}
      </select>
      <select class="position-select" data-department-user="${p.id}">
        ${deptOptions.replace(`value="${p.department_id || ''}"`, `value="${p.department_id || ''}" selected`)}
      </select>
      <button type="button" class="secondary" data-map-access="${p.id}" data-map-access-name="${escapeHtml(p.full_name || p.email)}" ${p.role === 'admin' ? 'disabled title="Admins already see everything"' : ''}>🔐 Map Access</button>
      ${p.role === 'admin'
        ? (() => {
            const isOwner = p.email === PROTECTED_OWNER_EMAIL;
            const isSelf = p.id === currentUser?.id;
            const guard = isOwner ? 'disabled title="Account owner — admin access is protected and can\'t be removed"'
              : isSelf ? 'disabled title="Can\'t remove your own admin"' : '';
            return `<button type="button" class="secondary" data-remove-admin="${p.id}" ${guard}>👑 Remove Admin</button>`;
          })()
        : `<button type="button" class="secondary" data-make-admin="${p.id}">👑 Make Admin</button>`}
      ${p.role === 'admin'
        ? ''
        : (p.status === 'deactivated'
            ? `<button type="button" class="secondary" data-reactivate="${p.id}">✅ Reactivate</button>`
            : `<button type="button" class="secondary" data-deactivate="${p.id}" ${p.id === currentUser?.id ? 'disabled' : ''}>⛔ Deactivate</button>`)}
      <span class="chip ${p.status === 'active' ? 'synced' : 'pending'}">${p.status}</span>
    </div>
  `).join('');
  list.querySelectorAll('[data-role-user]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const roleName = sel.options[sel.selectedIndex]?.textContent || '';
      const position = positionForRoleName(roleName);
      const { error: updErr } = await sb.from('profiles').update({ role_id: sel.value || null, position }).eq('id', sel.dataset.roleUser);
      if (updErr) { showToast(`Couldn't update role: ${updErr.message}`); return; }
      showToast('Role updated.');
    });
  });
  list.querySelectorAll('[data-department-user]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const { error: updErr } = await sb.from('profiles').update({ department_id: sel.value || null }).eq('id', sel.dataset.departmentUser);
      if (updErr) { showToast(`Couldn't update department: ${updErr.message}`); return; }
      showToast('Department updated.');
    });
  });
  initAllGlassSelects(list);
  list.querySelectorAll('[data-map-access]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const person = data.find((p) => p.id === btn.dataset.mapAccess);
      openMapAccessModal(person);
    });
  });
  list.querySelectorAll('[data-make-admin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Make this person a full system Admin? They will be able to see and manage everything, bypassing Map Access.')) return;
      const { error: updErr } = await sb.from('profiles').update({ role: 'admin' }).eq('id', btn.dataset.makeAdmin);
      if (updErr) { showToast(`Couldn't update: ${updErr.message}`); return; }
      showToast('They are now an Admin.');
      renderTeamList();
    });
  });
  list.querySelectorAll('[data-remove-admin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      // Re-checked here (not just via the disabled attribute) so this can
      // never fire on the protected owner account even if the button's
      // disabled state were somehow bypassed.
      const target = data.find((p) => p.id === btn.dataset.removeAdmin);
      if (target?.email === PROTECTED_OWNER_EMAIL) { showToast("The account owner's admin access is protected and can't be removed."); return; }
      if (!confirm('Remove Admin from this person? They will go back to whatever Map Access has ticked for them.')) return;
      const { error: updErr } = await sb.from('profiles').update({ role: 'member' }).eq('id', btn.dataset.removeAdmin);
      if (updErr) { showToast(`Couldn't update: ${updErr.message}`); return; }
      showToast('Admin removed.');
      renderTeamList();
    });
  });
  list.querySelectorAll('[data-deactivate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (!confirm("Deactivate this person? They won't be able to sign in anymore. Their past entries are kept, and you can reactivate them anytime.")) return;
      const { data: { session } } = await getSessionSafe();
      const { data: resData, error: fnErr } = await sb.functions.invoke('manage-team-member', {
        body: { userId: btn.dataset.deactivate, action: 'deactivate' },
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (fnErr || resData?.error) { showToast(`Couldn't deactivate: ${resData?.error || await readFunctionsError(fnErr)}`); return; }
      showToast('Deactivated.');
      renderTeamList();
    });
  });
  list.querySelectorAll('[data-reactivate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { data: { session } } = await getSessionSafe();
      const { data: resData, error: fnErr } = await sb.functions.invoke('manage-team-member', {
        body: { userId: btn.dataset.reactivate, action: 'reactivate' },
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (fnErr || resData?.error) { showToast(`Couldn't reactivate: ${resData?.error || await readFunctionsError(fnErr)}`); return; }
      showToast('Reactivated — they can sign in again.');
      renderTeamList();
    });
  });
}

// =====================================================================
// RECALLED ENTRIES — timesheet/leave entries people pulled back before an
// admin reviewed them. Lives entirely server-side (admin-recalled-entries
// Edge Function scans everyone's "_recalled" GitHub subfolders) — nothing
// here is stored locally, so this always reflects the true current state.
// =====================================================================

let recalledEntriesCache = [];

function recalledEntrySummary(item) {
  const e = item.entry || {};
  if (item.category === 'leave') {
    return `${MODE_LABEL[e.mode] || e.mode || 'Leave'} · ${escapeHtml(e.leaveStart || '')} → ${escapeHtml(e.leaveEnd || '')}`;
  }
  return `${escapeHtml(MODE_LABEL[e.mode] || e.mode || 'Timesheet')} · ${escapeHtml(e.date || '')}${e.jobId ? ' · ' + escapeHtml(e.jobId) : ''}`;
}

async function renderRecalledEntriesList() {
  const list = $('recalledEntriesList');
  if (!list) return;
  list.innerHTML = '<div class="empty">Loading…</div>';
  const { data: { session } } = await getSessionSafe();
  if (!session) { list.innerHTML = '<div class="empty">Please log in first.</div>'; return; }
  const { data, error } = await sb.functions.invoke('admin-recalled-entries', {
    body: { action: 'list' },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error || data?.error) {
    list.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(data?.error || await readFunctionsError(error))}</div>`;
    return;
  }
  recalledEntriesCache = data.results || [];
  if (!recalledEntriesCache.length) { list.innerHTML = '<div class="empty">Nothing recalled right now.</div>'; return; }
  list.innerHTML = recalledEntriesCache.map((item, idx) => `
    <div class="entry entry-clickable" data-recalled-idx="${idx}" title="Tap to review">
      <span class="type-icon">${item.category === 'leave' ? '🌴' : '🗓️'}</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(item.personName)}</div>
        <div class="entry-meta">${recalledEntrySummary(item)}</div>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('[data-recalled-idx]').forEach((row) => {
    row.addEventListener('click', () => openRecalledEditPanel(recalledEntriesCache[Number(row.dataset.recalledIdx)]));
  });
}

let currentRecalledItem = null;

function openRecalledEditPanel(item) {
  currentRecalledItem = item;
  const e = item.entry || {};
  $('recalledEditPersonName').textContent = item.personName;
  const isLeave = item.category === 'leave';
  $('recalledEditTimesheetFields').style.display = isLeave ? 'none' : 'block';
  $('recalledEditLeaveFields').style.display = isLeave ? 'block' : 'none';
  if (isLeave) {
    $('recEditLeaveStart').value = e.leaveStart || '';
    $('recEditLeaveEnd').value = e.leaveEnd || '';
  } else {
    $('recEditDate').value = e.date || '';
    $('recEditStart').value = e.startTime || '';
    $('recEditEnd').value = e.endTime || '';
    $('recEditLunch').value = e.lunchMinutesRaw ?? e.lunchMinutes ?? 0;
    $('recEditJobId').value = e.jobId || '';
    $('recEditProject').value = e.project || '';
    $('recEditLocation').value = e.location || '';
  }
  $('recEditNotes').value = e.description || '';
  openPanel('recalledEdit');
}

async function callAdminRecalled(action, extra) {
  const { data: { session } } = await getSessionSafe();
  if (!session) { showToast('Please log in first.'); return { ok: false }; }
  const { data, error } = await sb.functions.invoke('admin-recalled-entries', {
    body: { action, path: currentRecalledItem.path, ...extra },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error || data?.error) {
    showToast(`Couldn't ${action}: ${data?.error || await readFunctionsError(error)}`);
    return { ok: false };
  }
  return { ok: true };
}

$('recalledSaveRestoreBtn')?.addEventListener('click', async () => {
  if (!currentRecalledItem) return;
  const isLeave = currentRecalledItem.category === 'leave';
  const updates = isLeave
    ? { leaveStart: $('recEditLeaveStart').value, leaveEnd: $('recEditLeaveEnd').value, description: $('recEditNotes').value.trim() }
    : {
        date: $('recEditDate').value, startTime: $('recEditStart').value, endTime: $('recEditEnd').value,
        lunchMinutes: parseInt($('recEditLunch').value, 10) || 0, lunchMinutesRaw: parseInt($('recEditLunch').value, 10) || 0,
        jobId: $('recEditJobId').value.trim() || null, project: $('recEditProject').value.trim(),
        location: $('recEditLocation').value.trim(), description: $('recEditNotes').value.trim(),
      };
  const btn = $('recalledSaveRestoreBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const { ok } = await callAdminRecalled('update', { updates });
  btn.disabled = false; btn.textContent = '💾 Save corrections & restore';
  if (!ok) return;
  showToast('Corrected and restored — back on their dashboard and Reports.');
  closePanel('recalledEdit');
  renderRecalledEntriesList();
});

$('recalledRestoreAsIsBtn')?.addEventListener('click', async () => {
  if (!currentRecalledItem) return;
  if (!confirm('Restore this entry exactly as it was, with no changes?')) return;
  const { ok } = await callAdminRecalled('restore', {});
  if (!ok) return;
  showToast('Restored — back on their dashboard and Reports.');
  closePanel('recalledEdit');
  renderRecalledEntriesList();
});

$('recalledDeleteBtn')?.addEventListener('click', async () => {
  if (!currentRecalledItem) return;
  if (!confirm("Permanently delete this entry? This can't be undone.")) return;
  const { ok } = await callAdminRecalled('delete', {});
  if (!ok) return;
  showToast('Deleted permanently.');
  closePanel('recalledEdit');
  renderRecalledEntriesList();
});

$('refreshRecalledBtn')?.addEventListener('click', renderRecalledEntriesList);

// One-time backfill for the fast job_hours_ledger table — see
// job_hours_ledger_schema.sql / backfill-job-hours Edge Function. Safe to
// tap more than once (every write is an upsert keyed by entry id).
$('backfillJobHoursBtn')?.addEventListener('click', async () => {
  const btn = $('backfillJobHoursBtn');
  const status = $('backfillJobHoursStatus');
  btn.disabled = true;
  status.textContent = 'Scanning every timesheet in GitHub — this can take a little while on a team with a lot of history…';
  try {
    const { data: { session } } = await getSessionSafe();
    const { data, error } = await withTimeout(
      sb.functions.invoke('backfill-job-hours', { headers: { Authorization: `Bearer ${session.access_token}` } }),
      120000,
      'Job hours backfill'
    );
    if (error || data?.error) throw new Error(data?.error || await readFunctionsError(error));
    status.textContent = `Done — scanned ${data.entriesScanned} timesheet entries, updated ${data.rowsWritten} project-hour records.`;
    showToast('Job hours backfill complete.');
  } catch (err) {
    status.textContent = `Backfill failed: ${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
});

// =====================================================================
// MAP ACCESS — admin ticks which dashboard features one person can see.
// =====================================================================

let mapAccessUserId = null;

function openMapAccessModal(person) {
  mapAccessUserId = person.id;
  $('mapAccessPersonName').textContent = person.full_name || person.email;
  const current = Array.isArray(person.allowed_features) ? person.allowed_features : [];
  $('mapAccessList').innerHTML = FEATURE_LIST.map((f) => `
    <label class="map-access-row">
      <input type="checkbox" value="${f.key}" ${current.includes(f.key) ? 'checked' : ''} />
      <span>${escapeHtml(f.label)}</span>
    </label>
  `).join('');

  const featureCbs = () => [...$('mapAccessList').querySelectorAll('input[type="checkbox"]')];
  const allCb = $('mapAccessAllCb');
  // Reflects the individual list: on if every single feature is already
  // ticked, off otherwise — this is a convenience "grant everything" toggle,
  // not a separate permission of its own, so it always mirrors reality.
  allCb.checked = featureCbs().every((cb) => cb.checked);
  allCb.onchange = () => { featureCbs().forEach((cb) => { cb.checked = allCb.checked; }); };
  featureCbs().forEach((cb) => {
    cb.addEventListener('change', () => { allCb.checked = featureCbs().every((c) => c.checked); });
  });

  openPanel('mapAccess');
}

$('mapAccessSaveBtn').addEventListener('click', async () => {
  if (!mapAccessUserId) return;
  const checked = [...$('mapAccessList').querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
  const { error } = await sb.from('profiles').update({ allowed_features: checked }).eq('id', mapAccessUserId);
  if (error) { showToast(`Couldn't save access: ${error.message}`); return; }
  showToast('Access updated.');
  closePanel('mapAccess');
  renderTeamList();
});

// =====================================================================
// LOCATIONS & ALLOWANCES — admin-managed list; used to auto-add extra hours
// when someone works from a listed place (e.g. Abu Dhabi = +2 hours).
// =====================================================================

async function fetchLocationAllowances() {
  const { data, error } = await sb.from('location_allowances').select('id, name, extra_hours').order('name');
  return error ? [] : (data || []);
}

// Populates the New Entry "Allowance area" dropdown for everyone.
async function populateAllowanceDropdown() {
  const select = $('allowanceLocation');
  if (!select) return;
  const rows = await fetchLocationAllowances();
  const current = select.value;
  select.innerHTML = '<option value="">No allowance area</option>' +
    rows.map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)} (+${r.extra_hours}h)</option>`).join('');
  if (current) select.value = current;
}

// Admin-only: list + add + delete locations.
async function renderLocationList() {
  const list = $('locationList');
  if (!list) return;
  const rows = await fetchLocationAllowances();
  if (!rows.length) { list.innerHTML = '<div class="empty">No locations added yet.</div>'; return; }
  list.innerHTML = rows.map((r) => `
    <div class="entry">
      <span class="type-icon">📍</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(r.name)}</div>
        <div class="entry-meta">+${r.extra_hours} hour${Number(r.extra_hours) === 1 ? '' : 's'} allowance</div>
      </div>
      <button type="button" class="ghost" data-location-id="${r.id}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-location-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await sb.from('location_allowances').delete().eq('id', btn.dataset.locationId);
      renderLocationList();
      populateAllowanceDropdown();
    });
  });
}

if ($('addLocationBtn')) {
  $('addLocationBtn').addEventListener('click', async () => {
    const name = $('newLocationName').value.trim();
    const hours = parseFloat($('newLocationHours').value);
    if (!name) { showToast('Enter a location name.'); return; }
    if (isNaN(hours) || hours < 0) { showToast('Enter a valid number of extra hours.'); return; }
    const { error } = await sb.from('location_allowances').insert({ name, extra_hours: hours, created_by: currentUser.id });
    if (error) { showToast(`Couldn't add location: ${error.message}`); return; }
    $('newLocationName').value = '';
    $('newLocationHours').value = '';
    renderLocationList();
    populateAllowanceDropdown();
  });
}

// =====================================================================
// (Removed: the old single-person "Job Allocation" card that lived
// directly in the Admin tab — superseded by the full Job Allocation panel
// under Home, which handles multi-job/multi-person draft-then-publish plus
// Morning/Evening slots. This legacy form wrote to daily_assignments with
// onConflict: 'person_id,work_date', which no longer matches that table's
// current unique constraint (person_id, work_date, slot) added for Evening
// Allocation — so it was also quietly out of date, not just redundant.)
// =====================================================================
// JOB ALLOCATION PANEL — draft-then-publish multi-job planner.
//
// PLAN: search jobs, add any number of them to an in-memory draft; each
// draft job gets its own location, its own worker tick-list (no limit)
// and its own single driver select. Nothing touches the database until
// "Publish" is tapped, which writes every row in one go, then clears the
// draft. A person can't be double-booked: the underlying daily_assignments
// table only allows one row per person per work_date, so the UI disables
// a person (with a note) wherever they're already used — either in
// another job within this same draft, or in an already-published
// assignment for that date.
//
// MANAGE: a separate tab listing everything already published for a
// chosen date, grouped by job, with direct remove-person / clear-driver /
// delete-whole-job controls — no soft-delete, no undo history.
// =====================================================================

let allocationWired = false;
let allocationPeopleCache = [];           // active profiles: [{id, full_name, email}]
let allocationDraftJobs = [];              // [{jobId, jobName, location, driverId, workers: Set<personId>}]
let allocationPublishedMap = new Map();    // person_id -> { project, assignment_type } already saved for the picked date
let allocDraftIdxCounter = 0;

function allocPersonLabel(id) {
  const p = allocationPeopleCache.find((x) => x.id === id);
  return p ? allocPersonDisplay(p) : id;
}

function wireAllocationJobSearch() {
  if (allocationWired) return;
  allocationWired = true;
  const input = $('allocationJobSearch');
  const box = $('allocationJobResults');
  if (!input || !box) return;

  // Tapping the field opens the FULL job list right away (no typing
  // required) — typing then narrows it down. This is a "tap to browse,
  // type to filter" field rather than a search-only one.
  function showAllocJobMatches() {
    const q = input.value.trim().toLowerCase();
    // Every active job is always listed here, even ones already in the
    // draft — picking one again just shows a reminder toast instead of
    // vanishing from the list, so nothing ever looks "lost".
    const matches = q
      ? jobSearchOptions.filter((r) => String(r.job_id).toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q))
      : jobSearchOptions;
    if (!matches.length) {
      box.innerHTML = `<div class="job-search-empty">${q ? 'No matching job found.' : 'No active jobs yet — add one under Admin → Projects.'}</div>`;
    } else {
      box.innerHTML = matches.map((r) => `
        <div class="job-search-item" data-job-id="${escapeHtml(r.job_id)}" data-job-name="${escapeHtml(r.name || '')}" data-job-client="${escapeHtml(r.client || '')}">
          <div class="jid">${escapeHtml(r.job_id)}</div>
          <div class="jdesc">${escapeHtml(r.name || '')}${r.client ? ' · ' + escapeHtml(r.client) : ''}</div>
        </div>
      `).join('');
    }
    box.style.display = 'block';
    box.querySelectorAll('.job-search-item[data-job-id]').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        addJobToDraft(item.dataset.jobId, item.dataset.jobName);
        box.style.display = 'none';
        input.value = '';
      });
    });
  }
  input.addEventListener('focus', showAllocJobMatches);
  input.addEventListener('click', showAllocJobMatches);
  input.addEventListener('input', showAllocJobMatches);
  input.addEventListener('blur', () => { setTimeout(() => { box.style.display = 'none'; }, 150); });

  $('allocationDate').addEventListener('change', async () => {
    await loadAllocationPublishedForDate();
    renderAllocationDraft();
  });

  $('allocPlanTabBtn')?.addEventListener('click', () => showAllocTab('plan'));
  $('allocManageTabBtn')?.addEventListener('click', () => showAllocTab('manage'));
  $('allocationPublishBtn')?.addEventListener('click', publishAllocationDraft);
  $('allocManageDate')?.addEventListener('change', loadManageAllocations);
}

function showAllocTab(which) {
  const isPlan = which === 'plan';
  $('allocPlanView').style.display = isPlan ? 'block' : 'none';
  $('allocManageView').style.display = isPlan ? 'none' : 'block';
  $('allocPlanTabBtn').classList.toggle('active', isPlan);
  $('allocManageTabBtn').classList.toggle('active', !isPlan);
  if (!isPlan) loadManageAllocations();
}

// Jobs a person is already used in WITHIN this draft (worker or driver),
// keyed by person id -> job label they're used in (excluding the given job index).
function draftUsageFor(personId, excludeIdx) {
  for (let i = 0; i < allocationDraftJobs.length; i++) {
    if (i === excludeIdx) continue;
    const j = allocationDraftJobs[i];
    if (j.driverId === personId || j.workers.has(personId)) return j.jobId;
  }
  return null;
}

function addJobToDraft(jobId, jobName) {
  if (allocationDraftJobs.some((j) => j.jobId === jobId)) { showToast('That job is already in your draft — scroll down to it below.'); return; }
  allocationDraftJobs.push({ idx: allocDraftIdxCounter++, jobId, jobName: jobName || '', location: '', attendanceTime: '', driverId: '', workers: new Set() });
  renderAllocationDraft();
}

// "Wilfred — anu@tv-me.com" when a name is set, or just the email if not.
function allocPersonDisplay(p) {
  return p.full_name ? `${p.full_name} — ${p.email}` : p.email;
}

function removeJobFromDraft(idx) {
  const job = allocationDraftJobs.find((j) => j.idx === idx);
  if (!job) return;
  const peopleCount = job.workers.size + (job.driverId && !job.workers.has(job.driverId) ? 1 : 0);
  if (peopleCount > 0 && !confirm(`Remove job ${job.jobId}? This clears the ${peopleCount} ${peopleCount === 1 ? 'person' : 'people'} ticked for it — nothing has been published yet, so this can't be undone.`)) return;
  allocationDraftJobs = allocationDraftJobs.filter((j) => j.idx !== idx);
  renderAllocationDraft();
}

async function loadAllocationPublishedForDate() {
  const date = $('allocationDate').value;
  allocationPublishedMap = new Map();
  if (!date) return;
  // Only the morning/job slot counts as a conflict here — an evening
  // transport allocation for the same date/person is a separate row and
  // shouldn't block ticking them onto a job.
  const { data, error } = await sb.from('daily_assignments').select('person_id, project, assignment_type').eq('work_date', date).eq('slot', 'day');
  if (!error && data) data.forEach((r) => allocationPublishedMap.set(r.person_id, { project: r.project, assignment_type: r.assignment_type }));
}

function renderAllocationDraft() {
  const box = $('allocationDraftList');
  if (!box) return;
  if (!allocationDraftJobs.length) {
    box.innerHTML = '<div class="empty">No jobs added yet — search above to add one.</div>';
  } else {
    box.innerHTML = allocationDraftJobs.map((job) => {
      const locInputId = `allocDraftLoc_${job.idx}`;
      const locResultsId = `allocDraftLocResults_${job.idx}`;
      const peopleRows = allocationPeopleCache.map((p) => {
        const inThisJobAsWorker = job.workers.has(p.id);
        const isThisJobsDriver = job.driverId === p.id;
        const usedElsewhereInDraft = draftUsageFor(p.id, allocationDraftJobs.indexOf(job));
        const published = allocationPublishedMap.get(p.id);
        const publishedElsewhere = published && published.project !== job.jobId;
        const disabled = (!!usedElsewhereInDraft || !!publishedElsewhere) && !inThisJobAsWorker;
        let note = '';
        let freeUpBtn = '';
        if (usedElsewhereInDraft) {
          note = `already on job ${usedElsewhereInDraft} (this draft)`;
          freeUpBtn = `<button type="button" class="alloc-free-up" data-free-draft="${p.id}" title="Untick them from ${escapeHtml(usedElsewhereInDraft)} so they can be ticked here instead">Free up</button>`;
        } else if (publishedElsewhere) {
          note = `already assigned to job ${published.project}`;
          freeUpBtn = `<button type="button" class="alloc-free-up" data-free-published="${p.id}" data-free-job="${escapeHtml(published.project)}" title="Delete their already-published entry on ${escapeHtml(published.project)} for this date, so they can be ticked here instead">Free up</button>`;
        } else if (isThisJobsDriver) {
          note = '🚗 driver for this job';
        }
        return `
          <label class="alloc-person-row${disabled ? ' conflict' : ''}">
            <span class="alloc-person-name">
              <span class="apn-main">${escapeHtml(p.full_name || p.email)}</span>
              ${p.full_name ? `<span class="apn-sub">${escapeHtml(p.email)}</span>` : ''}
            </span>
            ${note ? `<span class="alloc-conflict-note">${escapeHtml(note)}</span>${freeUpBtn}` : ''}
            <input type="checkbox" class="alloc-worker-cb" data-job-idx="${job.idx}" data-person="${p.id}" ${inThisJobAsWorker ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
          </label>
        `;
      }).join('');
      // Anyone already ticked as a Worker on THIS job can still be picked as
      // its driver too (dual role — e.g. they drive themselves to site and
      // also do the work). Only people used on a DIFFERENT job/date are
      // excluded here.
      // Always list every person as a possible driver — a report/attendance
      // TIME, not just the date, is what actually decides whether someone
      // can drive two jobs the same day (e.g. drop one job at 9am, drive
      // another at 2pm — same day is fine, same time isn't). This app only
      // has a single point-in-time per job, not a start/end range, so it
      // can't safely auto-block on time — instead every option stays
      // pickable, annotated with where else they're used (job + time) so
      // the admin can judge for themselves whether it actually overlaps.
      const driverOptions = allocationPeopleCache.map((p) => {
        const usedElsewhereInDraft = draftUsageFor(p.id, allocationDraftJobs.indexOf(job));
        const published = allocationPublishedMap.get(p.id);
        const publishedElsewhere = published && published.project !== job.jobId ? published : null;
        const alsoWorking = job.workers.has(p.id) ? ' (also ticked as a worker here)' : '';
        let conflictNote = '';
        if (usedElsewhereInDraft) {
          const otherJob = allocationDraftJobs.find((j) => j.driverId === p.id || j.workers.has(p.id));
          const otherTime = otherJob?.attendanceTime ? ` at ${timeLabel12h(otherJob.attendanceTime)}` : '';
          conflictNote = ` — also on ${usedElsewhereInDraft}${otherTime} (this draft)`;
        } else if (publishedElsewhere) {
          conflictNote = ` — already assigned to ${publishedElsewhere.project}`;
        }
        return `<option value="${p.id}" ${job.driverId === p.id ? 'selected' : ''}>${escapeHtml(allocPersonDisplay(p))}${alsoWorking}${escapeHtml(conflictNote)}</option>`;
      }).join('');
      return `
        <div class="alloc-job-card">
          <div class="alloc-job-card-head">
            <div>
              <strong style="font-size:14px;">${escapeHtml(job.jobId)}</strong>
              <p class="hint" style="margin:2px 0 0;">${escapeHtml(job.jobName)}</p>
            </div>
            <button type="button" class="alloc-remove-job" data-remove-job="${job.idx}">✕ Remove job</button>
          </div>

          <label for="${locInputId}" style="margin-top:10px;">Location / pickup (optional)</label>
          <div class="job-search-wrap" style="position:relative;">
            <input id="${locInputId}" type="text" placeholder="Type an address, or search..." autocomplete="off" value="${escapeHtml(job.location)}" />
            <div id="${locResultsId}" class="job-search-results" style="display:none;"></div>
          </div>

          <label for="allocDraftTime_${job.idx}" style="margin-top:10px;">Attendance / report time (optional)</label>
          <input id="allocDraftTime_${job.idx}" type="time" data-attendance-time="${job.idx}" value="${escapeHtml(job.attendanceTime || '')}" />

          <div style="margin-top:14px;">
            <strong style="font-size:13px;">Workers on this job</strong>
            <p class="hint" style="margin-top:2px;">Tick anyone working this job, from the list below — no limit. Greyed-out people are already used elsewhere for this date.</p>
            <div style="margin-top:6px; max-height:320px; overflow-y:auto;">${peopleRows}</div>
          </div>

          <label style="margin-top:14px;">🚗 Assign a driver for this job (pick-up/drop-off)</label>
          <select data-driver-select="${job.idx}"><option value="">No driver for this job</option>${driverOptions}</select>
        </div>
      `;
    }).join('');

    // Wire per-card controls (re-wired on every render since the cards are rebuilt).
    allocationDraftJobs.forEach((job) => {
      const locInput = $(`allocDraftLoc_${job.idx}`);
      if (locInput) {
        locInput.addEventListener('input', () => { job.location = locInput.value; });
        wireAddressSearch(`allocDraftLoc_${job.idx}`, `allocDraftLocResults_${job.idx}`);
      }
      const timeInput = $(`allocDraftTime_${job.idx}`);
      if (timeInput) timeInput.addEventListener('input', () => { job.attendanceTime = timeInput.value; });
    });
    box.querySelectorAll('[data-driver-select]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const job = allocationDraftJobs.find((j) => j.idx === Number(sel.dataset.driverSelect));
        if (job) { job.driverId = sel.value; renderAllocationDraft(); }
      });
    });
    initAllGlassSelects(box);
    box.querySelectorAll('.alloc-worker-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const job = allocationDraftJobs.find((j) => j.idx === Number(cb.dataset.jobIdx));
        if (!job) return;
        if (cb.checked) job.workers.add(cb.dataset.person);
        else job.workers.delete(cb.dataset.person);
        renderAllocationDraft();
      });
    });
    box.querySelectorAll('[data-remove-job]').forEach((btn) => {
      btn.addEventListener('click', () => removeJobFromDraft(Number(btn.dataset.removeJob)));
    });
    // "Free up" — clears whatever is blocking this person so they can be
    // ticked on the job you're actually looking at right now.
    box.querySelectorAll('[data-free-draft]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const personId = btn.dataset.freeDraft;
        allocationDraftJobs.forEach((j) => {
          j.workers.delete(personId);
          if (j.driverId === personId) j.driverId = '';
        });
        renderAllocationDraft();
      });
    });
    box.querySelectorAll('[data-free-published]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const personId = btn.dataset.freePublished;
        const jobId = btn.dataset.freeJob;
        const date = $('allocationDate').value;
        if (!confirm(`Delete their already-published entry on job ${jobId} for this date? This can't be undone.`)) return;
        const { error } = await sb.from('daily_assignments').delete()
          .eq('person_id', personId).eq('work_date', date).eq('project', jobId);
        if (error) { showToast(`Couldn't free them up: ${error.message}`); return; }
        allocationPublishedMap.delete(personId);
        showToast('Freed up — you can tick them here now.');
        renderAllocationDraft();
      });
    });
  }

  const totalPeople = allocationDraftJobs.reduce((sum, j) => sum + j.workers.size + (j.driverId && !j.workers.has(j.driverId) ? 1 : 0), 0);
  $('allocationPublishCount').textContent = allocationDraftJobs.length ? `(${totalPeople} ${totalPeople === 1 ? 'person' : 'people'} across ${allocationDraftJobs.length} ${allocationDraftJobs.length === 1 ? 'job' : 'jobs'})` : '';
}

async function publishAllocationDraft() {
  const date = $('allocationDate').value;
  if (!date) { showToast('Pick a date first.'); return; }
  if (!allocationDraftJobs.length) { showToast('Add at least one job first.'); return; }
  const rows = [];
  allocationDraftJobs.forEach((job) => {
    job.workers.forEach((personId) => {
      // If this same person is also the job's driver, fold that into their
      // one 'job' row via is_driver — a second row for the same person on
      // the same date/slot would violate the unique constraint.
      const alsoDriver = !!job.driverId && job.driverId === personId;
      rows.push({ person_id: personId, work_date: date, slot: 'day', project: job.jobId, location: job.location.trim() || null, attendance_time: job.attendanceTime || null, assignment_type: 'job', is_driver: alsoDriver, created_by: currentUser.id });
    });
    if (job.driverId && !job.workers.has(job.driverId)) {
      rows.push({ person_id: job.driverId, work_date: date, slot: 'day', project: job.jobId, location: job.location.trim() || null, attendance_time: job.attendanceTime || null, assignment_type: 'transportation', is_driver: true, created_by: currentUser.id });
    }
  });
  if (!rows.length) { showToast('Tick at least one worker or assign a driver first.'); return; }
  const btn = $('allocationPublishBtn');
  btn.disabled = true; btn.textContent = 'Publishing…';
  // Clear out whatever was previously published for exactly these job(s) on
  // this date first, then insert the fresh set. Plain upsert alone only
  // touches rows for people still present in the draft — if editing an
  // already-published job removed someone (untick a worker, clear the
  // driver), their old row would otherwise be left stranded and still show
  // up everywhere. Delete-then-insert makes this a true full replace.
  const jobIds = [...new Set(allocationDraftJobs.map((j) => j.jobId))];
  const { error: clearErr } = await sb.from('daily_assignments').delete().eq('work_date', date).eq('slot', 'day').in('project', jobIds);
  if (clearErr) {
    showToast(`Couldn't publish: ${clearErr.message}`);
    btn.disabled = false; btn.textContent = '🚀 Publish '; btn.appendChild($('allocationPublishCount'));
    return;
  }
  const { error } = await sb.from('daily_assignments').insert(rows);
  btn.disabled = false; btn.textContent = '🚀 Publish ';
  btn.appendChild($('allocationPublishCount'));
  if (error) { showToast(`Couldn't publish: ${error.message}`); return; }
  showToast(`Published ${rows.length} ${rows.length === 1 ? 'allocation' : 'allocations'}.`);
  allocationDraftJobs = [];
  await loadAllocationPublishedForDate();
  renderAllocationDraft();
  // If today is the date just published, refresh the Home job board too,
  // so the publisher (and anyone else with Home open) sees it immediately
  // without waiting for their next login.
  if (date === new Date().toISOString().slice(0, 10)) renderJobBoard();

  // Notify each assigned person with their own job — never lets a push
  // failure interrupt the publish itself, since the data is already saved.
  getSessionSafe().then(({ data: { session } }) => {
    sb.functions.invoke('send-push', {
      body: { kind: 'allocation', workDate: date, assignments: rows.map((r) => ({ personId: r.person_id, project: r.project })) },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    }).catch(() => {});
  });
}

// ---- EVENING (transport pickup/drop) — separate from the job-based plan
// above. No job id, just who's being picked up/dropped, when, by which
// driver. Publishes its own rows (slot='evening') so it never collides with
// anyone's morning job allocation for the same date. ----

let allocSlot = 'day';               // which Plan sub-view is showing: 'day' (morning/job) or 'evening' (transport)
let eveningDraftPeople = new Map();  // person_id -> drop-off location text
let eveningWired = false;

function showAllocSlot(which) {
  allocSlot = which;
  const isDay = which === 'day';
  if ($('allocPlanMorning')) $('allocPlanMorning').style.display = isDay ? 'block' : 'none';
  if ($('allocPlanEvening')) $('allocPlanEvening').style.display = isDay ? 'none' : 'block';
  $('allocSlotDayBtn')?.classList.toggle('active', isDay);
  $('allocSlotEveningBtn')?.classList.toggle('active', !isDay);
}

function wireEveningAllocation() {
  if (eveningWired) return;
  eveningWired = true;
  $('allocSlotDayBtn')?.addEventListener('click', () => showAllocSlot('day'));
  $('allocSlotEveningBtn')?.addEventListener('click', () => showAllocSlot('evening'));

  const input = $('eveningPersonSearch');
  const box = $('eveningPersonResults');
  if (input && box) {
    function showEveningPersonMatches() {
      const q = input.value.trim().toLowerCase();
      const matches = (q
        ? allocationPeopleCache.filter((p) => (p.full_name || '').toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
        : allocationPeopleCache
      ).filter((p) => !eveningDraftPeople.has(p.id));
      box.innerHTML = matches.length
        ? matches.map((p) => `
            <div class="job-search-item" data-person-id="${p.id}">
              <div class="jid">${escapeHtml(p.full_name || p.email)}</div>
              ${p.full_name ? `<div class="jdesc">${escapeHtml(p.email)}</div>` : ''}
            </div>
          `).join('')
        : '<div class="job-search-empty">No matching person found.</div>';
      box.style.display = 'block';
      box.querySelectorAll('.job-search-item[data-person-id]').forEach((item) => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          eveningDraftPeople.set(item.dataset.personId, '');
          box.style.display = 'none';
          input.value = '';
          renderEveningDraft();
        });
      });
    }
    input.addEventListener('focus', showEveningPersonMatches);
    input.addEventListener('click', showEveningPersonMatches);
    input.addEventListener('input', showEveningPersonMatches);
    input.addEventListener('blur', () => { setTimeout(() => { box.style.display = 'none'; }, 150); });
  }

  $('eveningPublishBtn')?.addEventListener('click', publishEveningAllocation);
}

function renderEveningDraft() {
  const box = $('eveningDraftList');
  if (!box) return;
  if (!eveningDraftPeople.size) {
    box.innerHTML = '<div class="empty">No one added yet — search above to add someone.</div>';
  } else {
    box.innerHTML = Array.from(eveningDraftPeople.entries()).map(([personId, dropLoc]) => {
      const p = allocationPeopleCache.find((x) => x.id === personId);
      const inputId = `eveningDrop_${personId}`;
      return `
        <div class="alloc-job-card" style="padding:10px 13px;">
          <div class="alloc-job-card-head">
            <strong style="font-size:13.5px;">${escapeHtml(p ? allocPersonDisplay(p) : personId)}</strong>
            <button type="button" class="alloc-remove-job" data-evening-remove="${personId}">✕</button>
          </div>
          <label for="${inputId}" style="margin-top:8px;">Drop-off location (e.g. office, site, home)</label>
          <input id="${inputId}" type="text" data-evening-drop="${personId}" value="${escapeHtml(dropLoc)}" placeholder="Where are they being dropped?" />
        </div>
      `;
    }).join('');
    box.querySelectorAll('[data-evening-drop]').forEach((inp) => {
      inp.addEventListener('input', () => { eveningDraftPeople.set(inp.dataset.eveningDrop, inp.value); });
    });
    box.querySelectorAll('[data-evening-remove]').forEach((btn) => {
      btn.addEventListener('click', () => { eveningDraftPeople.delete(btn.dataset.eveningRemove); renderEveningDraft(); });
    });
  }
  const count = eveningDraftPeople.size;
  if ($('eveningPublishCount')) $('eveningPublishCount').textContent = count ? ` (${count} ${count === 1 ? 'person' : 'people'})` : '';
}

// Reuses the same "Evening Transport" label as the project value on every
// row — since it isn't a real Job ID, jobLineFor() just shows it verbatim
// wherever it's displayed (Today's Job Board, My Jobs, Admin schedule,
// Manage tab), no special-casing needed there.
async function publishEveningAllocation() {
  const date = $('eveningDate').value;
  const time = $('eveningTime').value;
  const driverId = $('eveningDriverSelect').value;
  if (!date) { showToast('Pick a date first.'); return; }
  if (!eveningDraftPeople.size && !driverId) { showToast('Add at least one person or a driver first.'); return; }
  const rows = [];
  eveningDraftPeople.forEach((dropLoc, personId) => {
    rows.push({ person_id: personId, work_date: date, slot: 'evening', project: 'Evening Transport', location: (dropLoc || '').trim() || null, attendance_time: time || null, assignment_type: 'transport_passenger', created_by: currentUser.id });
  });
  if (driverId) {
    rows.push({ person_id: driverId, work_date: date, slot: 'evening', project: 'Evening Transport', location: null, attendance_time: time || null, assignment_type: 'transportation', created_by: currentUser.id });
  }
  if (!rows.length) { showToast('Add at least one person or a driver first.'); return; }
  const btn = $('eveningPublishBtn');
  btn.disabled = true; btn.textContent = 'Publishing…';
  const { error } = await sb.from('daily_assignments').upsert(rows, { onConflict: 'person_id,work_date,slot' });
  btn.disabled = false; btn.textContent = '🚀 Publish evening transport';
  if ($('eveningPublishCount')) btn.appendChild($('eveningPublishCount'));
  if (error) { showToast(`Couldn't publish: ${error.message}`); return; }
  showToast(`Published evening transport for ${rows.length} ${rows.length === 1 ? 'person' : 'people'}.`);
  eveningDraftPeople = new Map();
  $('eveningTime').value = '';
  $('eveningDriverSelect').value = '';
  renderEveningDraft();
  // Same "show it on the dashboard right now, not just next login" refresh
  // as the morning publish does.
  if (date === new Date().toISOString().slice(0, 10)) { renderJobBoard(); renderAdminScheduleBoard(); }

  getSessionSafe().then(({ data: { session } }) => {
    sb.functions.invoke('send-push', {
      body: { kind: 'allocation', workDate: date, assignments: rows.map((r) => ({ personId: r.person_id, project: r.project })) },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    }).catch(() => {});
  });
}

// ---- MANAGE tab: view/edit/delete already-published allocations ----

// Cache of the currently-shown Manage tab's rows, keyed by job id — kept so
// tapping Edit can pull the exact same rows back into a Plan-tab draft
// without a second round-trip.
let manageJobsCache = new Map();

async function loadManageAllocations() {
  const list = $('allocManageList');
  const date = $('allocManageDate').value;
  if (!list || !date) return;
  list.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await sb.from('daily_assignments').select('person_id, project, assignment_type, location, attendance_time, is_driver').eq('work_date', date).eq('slot', 'day');
  if (error) { list.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  const rows = data || [];
  if (!rows.length) { list.innerHTML = '<div class="empty">Nothing published for this date yet.</div>'; return; }
  const byJob = new Map();
  rows.forEach((r) => {
    const key = r.project || '(no job)';
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key).push(r);
  });
  manageJobsCache = byJob;
  list.innerHTML = Array.from(byJob.entries()).map(([jobId, people]) => {
    const jobInfo = jobSearchOptions.find((j) => String(j.job_id) === String(jobId));
    const workers = people.filter((r) => r.assignment_type !== 'transportation');
    const dedicatedDriver = people.find((r) => r.assignment_type === 'transportation');
    return `
      <div class="alloc-manage-card">
        <div class="alloc-job-card-head">
          <div>
            <strong style="font-size:14px;">${escapeHtml(jobId)}</strong>
            <p class="hint" style="margin:2px 0 0;">${escapeHtml(jobInfo?.name || '')}</p>
          </div>
          <div style="display:flex; gap:8px;">
            <button type="button" class="secondary" data-edit-job="${escapeHtml(jobId)}">✏️ Edit</button>
            <button type="button" class="alloc-remove-job" data-delete-job="${escapeHtml(jobId)}">🗑 Delete this job's allocations</button>
          </div>
        </div>
        ${workers.map((r) => `
          <div class="entry">
            <span class="type-icon">${r.is_driver ? '🚗' : '🙂'}</span>
            <div class="entry-body">
              <div class="entry-desc">${escapeHtml(allocPersonLabel(r.person_id))}${r.is_driver ? ' — also driving' : ''}</div>
              ${r.location ? `<div class="entry-meta">${escapeHtml(r.location)}</div>` : ''}
            </div>
            <input type="time" class="alloc-manage-time" data-time-person="${r.person_id}" data-time-job="${escapeHtml(jobId)}" value="${escapeHtml(r.attendance_time || '')}" title="Attendance / report time" />
            <button type="button" class="alloc-manage-remove" data-remove-person="${r.person_id}" data-remove-job="${escapeHtml(jobId)}">✕</button>
          </div>
        `).join('')}
        ${dedicatedDriver ? `
          <div class="entry">
            <span class="type-icon">🚗</span>
            <div class="entry-body">
              <div class="entry-desc">${escapeHtml(allocPersonLabel(dedicatedDriver.person_id))} — driver</div>
              ${dedicatedDriver.location ? `<div class="entry-meta">${escapeHtml(dedicatedDriver.location)}</div>` : ''}
            </div>
            <input type="time" class="alloc-manage-time" data-time-person="${dedicatedDriver.person_id}" data-time-job="${escapeHtml(jobId)}" value="${escapeHtml(dedicatedDriver.attendance_time || '')}" title="Attendance / report time" />
            <button type="button" class="alloc-manage-remove" data-remove-person="${dedicatedDriver.person_id}" data-remove-job="${escapeHtml(jobId)}">✕</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-edit-job]').forEach((btn) => {
    btn.addEventListener('click', () => editPublishedJob(btn.dataset.editJob, date));
  });
  list.querySelectorAll('[data-remove-person]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { error: delErr } = await sb.from('daily_assignments').delete()
        .eq('person_id', btn.dataset.removePerson).eq('work_date', date).eq('project', btn.dataset.removeJob === '(no job)' ? null : btn.dataset.removeJob);
      if (delErr) { showToast(`Couldn't remove: ${delErr.message}`); return; }
      loadManageAllocations();
    });
  });
  list.querySelectorAll('.alloc-manage-time').forEach((input) => {
    input.addEventListener('change', async () => {
      const { error: updErr } = await sb.from('daily_assignments').update({ attendance_time: input.value || null })
        .eq('person_id', input.dataset.timePerson).eq('work_date', date).eq('project', input.dataset.timeJob === '(no job)' ? null : input.dataset.timeJob);
      if (updErr) { showToast(`Couldn't update time: ${updErr.message}`); return; }
      showToast('Time updated.');
    });
  });
  list.querySelectorAll('[data-delete-job]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const jobId = btn.dataset.deleteJob;
      const { error: delErr } = await sb.from('daily_assignments').delete()
        .eq('work_date', date).eq('project', jobId === '(no job)' ? null : jobId);
      if (delErr) { showToast(`Couldn't delete: ${delErr.message}`); return; }
      showToast('Deleted.');
      loadManageAllocations();
    });
  });
}

// Pulls an already-published job's people (workers + driver) back into a
// fresh Plan-tab draft card, so the admin/allocator can change anything —
// add/remove workers, swap the driver, change location/time — and hit
// Publish to save the corrected version. Nothing is touched here until
// Publish is actually tapped; publishAllocationDraft() then clears out the
// old rows for this exact job/date and writes the new set, so someone
// removed from the job really disappears instead of being left stranded.
function editPublishedJob(jobId, date) {
  const people = manageJobsCache.get(jobId);
  if (!people || !people.length) { showToast("Couldn't find that job's details — try refreshing."); return; }
  if (allocationDraftJobs.some((j) => j.jobId === jobId)) {
    showToast(`${jobId} is already open below — scroll down to it.`);
    showAllocTab('plan');
    return;
  }
  const dedicatedDriver = people.find((r) => r.assignment_type === 'transportation');
  const dualRoleDriver = people.find((r) => r.assignment_type !== 'transportation' && r.is_driver);
  const driverId = dedicatedDriver?.person_id || dualRoleDriver?.person_id || '';
  const workers = new Set(people.filter((r) => r.assignment_type !== 'transportation').map((r) => r.person_id));
  // The draft model has one shared location/time per job, but this table
  // stores them per person (Manage tab lets each person have their own) —
  // picking the first non-empty value as the starting point is the closest
  // fit; re-check it once it's loaded into the draft below.
  const location = people.find((r) => r.location)?.location || '';
  const attendanceTime = people.find((r) => r.attendance_time)?.attendance_time || '';
  const jobInfo = jobSearchOptions.find((j) => String(j.job_id) === String(jobId));

  allocationDraftJobs.push({
    idx: allocDraftIdxCounter++, jobId, jobName: jobInfo?.name || '',
    location, attendanceTime, driverId, workers,
  });
  $('allocationDate').value = date;
  loadAllocationPublishedForDate().then(() => {
    renderAllocationDraft();
    showAllocTab('plan');
    showToast(`Loaded ${jobId} for editing — make your changes below and tap Publish.`);
  });
}

async function openAllocationPanel() {
  if (!$('allocationDate').value) $('allocationDate').value = new Date().toISOString().slice(0, 10);
  if (!$('allocManageDate').value) $('allocManageDate').value = new Date().toISOString().slice(0, 10);
  if (!$('tripDate').value) $('tripDate').value = new Date().toISOString().slice(0, 10);
  if (!$('activityDate').value) $('activityDate').value = new Date().toISOString().slice(0, 10);
  if ($('eveningDate') && !$('eveningDate').value) $('eveningDate').value = new Date().toISOString().slice(0, 10);
  allocationDraftJobs = [];
  eveningDraftPeople = new Map();
  $('allocationJobSearch').value = '';
  const { data: people, error: peopleErr } = await sb.from('profiles').select('id, full_name, email').eq('status', 'active').order('full_name', { ascending: true });
  allocationPeopleCache = peopleErr ? [] : (people || []);
  await Promise.all([populateJobIdDropdown(), populateDriverSelects(), loadAllocationPublishedForDate()]);
  wireAllocationJobSearch();
  wireEveningAllocation();
  showAllocTab('plan');
  showAllocSlot('day');
  renderAllocationDraft();
  renderEveningDraft();
  wireAddressSearch('tripFrom', 'tripFromResults');
  wireAddressSearch('tripTo', 'tripToResults');
}

async function populateDriverSelects() {
  const { data, error } = await sb.from('profiles').select('id, email, full_name').eq('status', 'active').order('full_name', { ascending: true });
  const people = error ? [] : (data || []);
  const options = people.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name || p.email)}</option>`).join('');
  if ($('tripDriverSelect')) $('tripDriverSelect').innerHTML = '<option value="">Choose a driver</option>' + options;
  if ($('activityDriverSelect')) $('activityDriverSelect').innerHTML = '<option value="">Choose a driver</option>' + options;
  if ($('eveningDriverSelect')) $('eveningDriverSelect').innerHTML = '<option value="">Choose a driver</option>' + options;
}

// Free, no-API-key forward address search (Nominatim) — debounced so typing
// doesn't hammer the public API. Picking a result fills the field with the
// full address and stashes lat/lon on the input for saving; typing without
// picking a result still works, it's just plain text with no coordinates.
let addressSearchTimer = null;
function wireAddressSearch(inputId, resultsId) {
  const input = $(inputId);
  const box = $(resultsId);
  if (!input || !box || input.dataset.wired) return;
  input.dataset.wired = 'true';
  input.addEventListener('input', () => {
    input.dataset.lat = '';
    input.dataset.lon = '';
    clearTimeout(addressSearchTimer);
    const q = input.value.trim();
    if (q.length < 3) { box.style.display = 'none'; return; }
    addressSearchTimer = setTimeout(async () => {
      let results = [];
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`, { headers: { Accept: 'application/json' } });
        results = await res.json();
      } catch { /* offline/unreachable — plain typed text still works */ }
      box.innerHTML = results.length
        ? results.map((r, i) => `
            <div class="job-search-item" data-idx="${i}">
              <div class="jid">${escapeHtml(String(r.display_name).split(',')[0])}</div>
              <div class="jdesc">${escapeHtml(r.display_name)}</div>
            </div>
          `).join('')
        : '<div class="job-search-empty">No matching address — your typed text will still be saved.</div>';
      box.style.display = 'block';
      box.querySelectorAll('.job-search-item[data-idx]').forEach((item) => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const r = results[Number(item.dataset.idx)];
          input.value = r.display_name;
          input.dataset.lat = r.lat;
          input.dataset.lon = r.lon;
          box.style.display = 'none';
        });
      });
    }, 400);
  });
  input.addEventListener('blur', () => { setTimeout(() => { box.style.display = 'none'; }, 150); });
}

$('addTripBtn')?.addEventListener('click', async () => {
  const driverId = $('tripDriverSelect').value;
  const workDate = $('tripDate').value;
  const fromLabel = $('tripFrom').value.trim();
  const toLabel = $('tripTo').value.trim();
  if (!driverId || !workDate || !fromLabel || !toLabel) { showToast('Pick a driver, date, from and to.'); return; }
  const { error } = await sb.from('driver_trips').insert({
    driver_id: driverId,
    work_date: workDate,
    trip_time: $('tripTime').value || null,
    job_id: $('tripJobId').value.trim() || null,
    from_label: fromLabel,
    from_lat: $('tripFrom').dataset.lat ? parseFloat($('tripFrom').dataset.lat) : null,
    from_lon: $('tripFrom').dataset.lon ? parseFloat($('tripFrom').dataset.lon) : null,
    to_label: toLabel,
    to_lat: $('tripTo').dataset.lat ? parseFloat($('tripTo').dataset.lat) : null,
    to_lon: $('tripTo').dataset.lon ? parseFloat($('tripTo').dataset.lon) : null,
    km: $('tripKm').value ? parseFloat($('tripKm').value) : null,
    created_by: currentUser.id,
  });
  if (error) { showToast(`Couldn't add trip: ${error.message}`); return; }
  $('tripFrom').value = '';
  $('tripTo').value = '';
  $('tripTime').value = '';
  $('tripKm').value = '';
  $('tripJobId').value = '';
  showToast('Trip added.');
});

$('viewActivityBtn')?.addEventListener('click', async () => {
  const driverId = $('activityDriverSelect').value;
  const date = $('activityDate').value;
  if (!driverId || !date) { showToast('Pick a driver and a date.'); return; }
  const { data, error } = await sb
    .from('driver_trips')
    .select('id, trip_time, job_id, from_label, to_label, km')
    .eq('driver_id', driverId)
    .eq('work_date', date)
    .order('trip_time', { ascending: true });
  if (error) { showToast(`Couldn't load activity: ${error.message}`); return; }
  const rows = data || [];
  const totalKm = rows.reduce((sum, r) => sum + (parseFloat(r.km) || 0), 0);
  $('activitySummary').style.display = 'block';
  $('activityTotalKm').textContent = `${totalKm.toFixed(1)} km`;
  $('activityTripCount').textContent = String(rows.length);
  const list = $('activityTripList');
  if (!rows.length) { list.innerHTML = '<div class="empty">No trips logged for this date.</div>'; return; }
  list.innerHTML = rows.map((r) => `
    <div class="entry">
      <span class="type-icon">🚗</span>
      <div class="entry-body">
        <div class="entry-desc">${r.trip_time ? escapeHtml(String(r.trip_time).slice(0, 5)) + ' — ' : ''}${escapeHtml(r.from_label || '?')} → ${escapeHtml(r.to_label || '?')}</div>
        <div class="entry-meta">${r.job_id ? 'Job ' + escapeHtml(r.job_id) : 'No job linked'}${r.km ? ' · ' + r.km + ' km' : ''}</div>
      </div>
    </div>
  `).join('');
});

// Shows the signed-in driver's own trips for today — separate from the
// single "today's job" card, since a driver can have several trips in one
// day, each with its own from/to and time.
async function renderMyTripsToday() {
  const card = $('myTripsCard');
  const area = $('myTripsArea');
  if (!card || !area || !currentUser) return;
  const todayKey = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('driver_trips')
    .select('trip_time, job_id, from_label, to_label')
    .eq('driver_id', currentUser.id)
    .eq('work_date', todayKey)
    .order('trip_time', { ascending: true });
  if (error || !data || !data.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  area.innerHTML = data.map((r) => `
    <div class="entry">
      <span class="type-icon">🚗</span>
      <div class="entry-body">
        <div class="entry-desc">${r.trip_time ? escapeHtml(String(r.trip_time).slice(0, 5)) + ' — ' : ''}${escapeHtml(r.from_label || '?')} → ${escapeHtml(r.to_label || '?')}</div>
        <div class="entry-meta">${r.job_id ? 'Job ' + escapeHtml(r.job_id) : ''}</div>
      </div>
    </div>
  `).join('');
}

// =====================================================================
// GENERIC FULL-SCREEN PANEL OVERLAYS — Projects / Project detail / Learning
// / Health Challenges all share the same open/close plumbing.
// =====================================================================

const PANEL_IDS = {
  projects: ['projectsOverlay', 'projectsOverlayBackdrop'],
  projectDetail: ['projectDetailOverlay', 'projectDetailOverlayBackdrop'],
  departments: ['departmentsOverlay', 'departmentsOverlayBackdrop'],
  departmentDetail: ['departmentDetailOverlay', 'departmentDetailOverlayBackdrop'],
  learning: ['learningOverlay', 'learningOverlayBackdrop'],
  health: ['healthOverlay', 'healthOverlayBackdrop'],
  clients: ['clientsOverlay', 'clientsOverlayBackdrop'],
  quotations: ['quotationsOverlay', 'quotationsOverlayBackdrop'],
  quotationDetail: ['quotationDetailOverlay', 'quotationDetailOverlayBackdrop'],
  tank: ['tankOverlay', 'tankOverlayBackdrop'],
  mapAccess: ['mapAccessOverlay', 'mapAccessOverlayBackdrop'],
  allocation: ['allocationOverlay', 'allocationOverlayBackdrop'],
  myjobs: ['myJobsOverlay', 'myJobsOverlayBackdrop'],
  entryDetail: ['entryDetailOverlay', 'entryDetailOverlayBackdrop'],
  datafeed: ['dataFeedOverlay', 'dataFeedOverlayBackdrop'],
  recalledEdit: ['recalledEditOverlay', 'recalledEditOverlayBackdrop'],
  liveDrivers: ['liveDriversOverlay', 'liveDriversOverlayBackdrop'],
};
function openPanel(name, opts = {}) {
  const ids = PANEL_IDS[name];
  if (!ids) return;
  if (name === 'liveDrivers') renderLiveDrivers();
  $(ids[0]).classList.add('show');
  $(ids[1]).classList.add('show');
  if (name === 'projects') {
    // The Home screen's "Active Projects" tile is a pure browse/view entry
    // point — no "New project" form there, even for admins. Creating
    // projects still lives in Admin → Projects, which opens this same
    // panel without the hideCreate flag.
    $('newProjectCard').style.display = (currentProfile?.role === 'admin' && !opts.hideCreate) ? 'block' : 'none';
    renderProjectsList();
  }
  if (name === 'departments') {
    $('newDepartmentCard').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
    renderDepartmentsList();
  }
  if (name === 'clients') {
    $('newClientCard').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
    renderClientsList();
  }
  if (name === 'quotations') {
    $('newQuotationCard').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
    populateQuoteClientDropdown();
    populateQuoteJobDropdown();
    renderQuotationsList();
  }
  if (name === 'tank') {
    renderTank();
  }
  if (name === 'allocation') {
    openAllocationPanel();
  }
  if (name === 'myjobs') {
    renderMyJobsPanel();
  }
}
function closePanel(name) {
  const ids = PANEL_IDS[name];
  if (!ids) return;
  $(ids[0]).classList.remove('show');
  $(ids[1]).classList.remove('show');
}
document.querySelectorAll('[data-open]').forEach((btn) => {
  btn.addEventListener('click', () => openPanel(btn.dataset.open, { hideCreate: btn.dataset.hideCreate === 'true' }));
});
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closePanel(btn.dataset.close));
});
Object.entries(PANEL_IDS).forEach(([name, ids]) => {
  const backdrop = $(ids[1]);
  if (backdrop) backdrop.addEventListener('click', () => closePanel(name));
});
if ($('projectDetailBackBtn')) {
  $('projectDetailBackBtn').addEventListener('click', () => { closePanel('projectDetail'); openPanel('projects'); });
}
if ($('departmentDetailBackBtn')) {
  $('departmentDetailBackBtn').addEventListener('click', () => { closePanel('departmentDetail'); openPanel('departments'); });
}
if ($('quotationDetailBackBtn')) {
  $('quotationDetailBackBtn').addEventListener('click', () => { closePanel('quotationDetail'); openPanel('quotations'); });
}

// =====================================================================
// DEPARTMENTS — admin creates/manages a list of departments; every person
// is assigned to one (Admin → Team). Anyone can browse the list and open a
// department to see who's in it and what each person's Job Allocation says
// they're doing today.
// =====================================================================

let departmentsCache = null; // [{id, name}], refetched each time the picker is (re)opened

async function fetchDepartments() {
  try {
    const { data, error } = await sb.from('departments').select('id, name').order('name', { ascending: true });
    if (error) { console.error('fetchDepartments failed:', error); return { rows: [], error }; }
    return { rows: data || [], error: null };
  } catch (err) {
    console.error('fetchDepartments threw:', err);
    return { rows: [], error: err };
  }
}

async function renderDepartmentsList(isRetry = false) {
  const wrap = $('departmentsListArea');
  if (!wrap) return;
  if (!isRetry) wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { rows, error } = await fetchDepartments();
  departmentsCache = rows;
  if (error) {
    if (!isRetry) { await new Promise((r) => setTimeout(r, 400)); return renderDepartmentsList(true); }
    wrap.innerHTML = `<div class="empty">Couldn't load departments: ${escapeHtml(error.message || String(error))}</div>`;
    return;
  }
  if (!rows.length) { wrap.innerHTML = '<div class="empty">No departments yet.</div>'; return; }
  const isAdmin = currentProfile?.role === 'admin';
  wrap.innerHTML = rows.map((d) => `
    <div class="entry" data-department-row="${escapeHtml(d.id)}" data-department-name="${escapeHtml(d.name)}" style="cursor:pointer;">
      <span class="type-icon">🏢</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(d.name)}</div>
      </div>
      ${isAdmin ? `<button type="button" class="ghost" data-delete-department="${escapeHtml(d.id)}">✕</button>` : ''}
    </div>
  `).join('');
  wrap.querySelectorAll('[data-department-row]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-department]')) return;
      openDepartmentDetail(row.dataset.departmentRow, row.dataset.departmentName);
    });
  });
  wrap.querySelectorAll('[data-delete-department]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await sb.from('departments').delete().eq('id', btn.dataset.deleteDepartment);
      renderDepartmentsList();
    });
  });
}

if ($('createDepartmentBtn')) {
  $('createDepartmentBtn').addEventListener('click', async () => {
    const name = $('newDepartmentName').value.trim();
    if (!name) { showToast('Enter a department name.'); return; }
    const { error } = await sb.from('departments').insert({ name, created_by: currentUser.id });
    if (error) { showToast(`Couldn't create department: ${error.message}`); return; }
    $('newDepartmentName').value = '';
    renderDepartmentsList();
    showToast('Department created.');
  });
}

async function openDepartmentDetail(deptId, deptName) {
  $('departmentDetailTitle').textContent = deptName;
  $('departmentDetailCount').textContent = '';
  $('departmentMembersArea').innerHTML = '<div class="empty">Loading…</div>';
  openPanel('departmentDetail');

  const { data: people, error: peopleErr } = await sb
    .from('profiles')
    .select('id, email, full_name, position')
    .eq('department_id', deptId)
    .eq('status', 'active')
    .order('full_name', { ascending: true });

  if (peopleErr) {
    $('departmentMembersArea').innerHTML = `<div class="empty">Couldn't load this department: ${escapeHtml(peopleErr.message)}</div>`;
    return;
  }
  if (!people || !people.length) {
    $('departmentDetailCount').textContent = '0 people';
    $('departmentMembersArea').innerHTML = '<div class="empty">No one is assigned to this department yet — set it from Admin → Team.</div>';
    return;
  }

  $('departmentDetailCount').textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;

  const todayKey = new Date().toISOString().slice(0, 10);
  const personIds = people.map((p) => p.id);
  const { data: assignments } = await sb
    .from('daily_assignments')
    .select('person_id, project, location, assignment_type')
    .eq('work_date', todayKey)
    .in('person_id', personIds);
  const byPerson = {};
  (assignments || []).forEach((a) => { byPerson[a.person_id] = a; });

  $('departmentMembersArea').innerHTML = people.map((p) => {
    const a = byPerson[p.id];
    const posLabel = POSITION_LABEL[p.position] || p.position;
    const jobText = a
      ? `${a.assignment_type === 'transportation' ? '🚕 ' : ''}${escapeHtml(a.project || 'Assigned, no details')}${a.location ? ' · ' + escapeHtml(a.location) : ''}`
      : 'No job allocated today';
    return `
      <div class="entry">
        <span class="type-icon">🙂</span>
        <div class="entry-body">
          <div class="entry-desc">${escapeHtml(p.full_name || p.email)} <span class="chip synced" style="margin-left:6px;">${escapeHtml(posLabel)}</span></div>
          <div class="entry-meta">${jobText}</div>
        </div>
      </div>
    `;
  }).join('');
}

// =====================================================================
// CLIENTS — a simple directory. Anyone signed in can browse it; only
// admins can add/remove entries. Same pattern as Departments above.
// =====================================================================

let clientsCache = []; // [{id, name}] — reused by the quotation client picker

async function fetchClients() {
  try {
    const { data, error } = await sb.from('clients').select('*').order('name', { ascending: true });
    if (error) { console.error('fetchClients failed:', error); return { rows: [], error }; }
    return { rows: data || [], error: null };
  } catch (err) {
    console.error('fetchClients threw:', err);
    return { rows: [], error: err };
  }
}

async function renderClientsList(isRetry = false) {
  const wrap = $('clientsListArea');
  if (!wrap) return;
  if (!isRetry) wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { rows, error } = await fetchClients();
  clientsCache = rows;
  if (error) {
    if (!isRetry) { await new Promise((r) => setTimeout(r, 400)); return renderClientsList(true); }
    wrap.innerHTML = `<div class="empty">Couldn't load clients: ${escapeHtml(error.message || String(error))}</div>`;
    return;
  }
  if (!rows.length) { wrap.innerHTML = '<div class="empty">No clients yet.</div>'; return; }
  const isAdmin = currentProfile?.role === 'admin';
  wrap.innerHTML = rows.map((c) => `
    <div class="entry">
      <span class="type-icon">🤝</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(c.name)}</div>
        <div class="entry-meta">${[c.contact_name, c.email, c.phone].filter(Boolean).map(escapeHtml).join(' · ') || 'No contact details yet'}</div>
      </div>
      ${isAdmin ? `<button type="button" class="ghost" data-delete-client="${escapeHtml(c.id)}">✕</button>` : ''}
    </div>
  `).join('');
  wrap.querySelectorAll('[data-delete-client]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await sb.from('clients').delete().eq('id', btn.dataset.deleteClient);
      renderClientsList();
    });
  });
}

if ($('createClientBtn')) {
  $('createClientBtn').addEventListener('click', async () => {
    const name = $('newClientName').value.trim();
    if (!name) { showToast('Enter a client name.'); return; }
    const { error } = await sb.from('clients').insert({
      name,
      contact_name: $('newClientContact').value.trim() || null,
      email: $('newClientEmail').value.trim() || null,
      phone: $('newClientPhone').value.trim() || null,
      notes: $('newClientNotes').value.trim() || null,
      created_by: currentUser.id,
    });
    if (error) { showToast(`Couldn't add client: ${error.message}`); return; }
    ['newClientName', 'newClientContact', 'newClientEmail', 'newClientPhone', 'newClientNotes'].forEach((id) => { $(id).value = ''; });
    renderClientsList();
    showToast('Client added.');
  });
}

// =====================================================================
// QUOTATIONS — draft/sent/accepted/rejected, each with its own line items.
// Anyone signed in can browse; only admins can create, add items, or move
// the status forward.
// =====================================================================

async function populateQuoteClientDropdown() {
  const select = $('newQuoteClient');
  if (!select) return;
  const { rows } = await fetchClients();
  clientsCache = rows;
  select.innerHTML = '<option value="">Select a client</option>' +
    rows.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
}

async function populateQuoteJobDropdown() {
  const select = $('newQuoteJobId');
  if (!select) return;
  const { data, error } = await sb.from('projects').select('job_id, name').eq('status', 'active').order('job_id');
  const rows = error ? [] : (data || []);
  select.innerHTML = '<option value="">No project linked</option>' +
    rows.map((r) => `<option value="${escapeHtml(r.job_id)}">${escapeHtml(r.job_id)}${r.name ? ' — ' + escapeHtml(r.name) : ''}</option>`).join('');
}

const QUOTE_STATUS_LABEL = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected' };
const QUOTE_STATUS_CLASS = { draft: 'pending', sent: 'pending', accepted: 'synced', rejected: 'error' };

async function fetchQuotations() {
  try {
    const { data, error } = await sb
      .from('quotations')
      .select('id, quote_number, title, status, job_id, issue_date, client_id, clients(name)')
      .order('created_at', { ascending: false });
    if (error) { console.error('fetchQuotations failed:', error); return { rows: [], error }; }
    return { rows: data || [], error: null };
  } catch (err) {
    console.error('fetchQuotations threw:', err);
    return { rows: [], error: err };
  }
}

async function renderQuotationsList(isRetry = false) {
  const wrap = $('quotationsListArea');
  if (!wrap) return;
  if (!isRetry) wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { rows, error } = await fetchQuotations();
  if (error) {
    if (!isRetry) { await new Promise((r) => setTimeout(r, 400)); return renderQuotationsList(true); }
    wrap.innerHTML = `<div class="empty">Couldn't load quotations: ${escapeHtml(error.message || String(error))}</div>`;
    return;
  }
  if (!rows.length) { wrap.innerHTML = '<div class="empty">No quotations yet.</div>'; return; }
  wrap.innerHTML = rows.map((q) => `
    <div class="entry" data-quote-row="${escapeHtml(q.id)}" data-quote-title="${escapeHtml(q.title || q.quote_number)}" style="cursor:pointer;">
      <span class="type-icon">🧾</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(q.quote_number)}${q.title ? ' — ' + escapeHtml(q.title) : ''}</div>
        <div class="entry-meta">${escapeHtml(q.clients?.name || 'No client set')}${q.job_id ? ' · ' + escapeHtml(q.job_id) : ''}</div>
      </div>
      <span class="chip ${QUOTE_STATUS_CLASS[q.status] || ''}">${QUOTE_STATUS_LABEL[q.status] || q.status}</span>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-quote-row]').forEach((row) => {
    row.addEventListener('click', () => openQuotationDetail(row.dataset.quoteRow));
  });
}

if ($('createQuotationBtn')) {
  $('createQuotationBtn').addEventListener('click', async () => {
    const quoteNumber = $('newQuoteNumber').value.trim();
    const clientId = $('newQuoteClient').value;
    if (!quoteNumber) { showToast('Enter a quote number.'); return; }
    if (!clientId) { showToast('Select a client.'); return; }
    const { error } = await sb.from('quotations').insert({
      quote_number: quoteNumber,
      client_id: clientId,
      job_id: $('newQuoteJobId').value || null,
      title: $('newQuoteTitle').value.trim() || null,
      created_by: currentUser.id,
    });
    if (error) { showToast(`Couldn't create quotation: ${error.message}`); return; }
    ['newQuoteNumber', 'newQuoteTitle'].forEach((id) => { $(id).value = ''; });
    renderQuotationsList();
    showToast('Quotation created.');
  });
}

let currentQuotationId = null;

async function openQuotationDetail(quotationId) {
  currentQuotationId = quotationId;
  $('quotationDetailTitle').textContent = 'Quotation';
  $('quotationDetailClient').textContent = '—';
  $('quotationDetailMeta').textContent = '—';
  $('quotationStatusBadge').innerHTML = '';
  $('quotationItemsArea').innerHTML = '<div class="empty">Loading…</div>';
  $('quotationTotalRow').innerHTML = '';
  openPanel('quotationDetail');

  const { data: q, error } = await sb
    .from('quotations')
    .select('id, quote_number, title, status, job_id, issue_date, clients(name)')
    .eq('id', quotationId)
    .single();
  if (error || !q) {
    $('quotationItemsArea').innerHTML = `<div class="empty">Couldn't load this quotation: ${escapeHtml(error?.message || 'not found')}</div>`;
    return;
  }
  $('quotationDetailTitle').textContent = q.quote_number;
  $('quotationDetailClient').textContent = q.title ? `${q.title}` : q.quote_number;
  $('quotationDetailMeta').textContent = `${q.clients?.name || 'No client set'}${q.job_id ? ' · ' + q.job_id : ''} · ${q.issue_date || ''}`;
  $('quotationStatusBadge').innerHTML = `<span class="chip ${QUOTE_STATUS_CLASS[q.status] || ''}">${QUOTE_STATUS_LABEL[q.status] || q.status}</span>`;

  const isAdmin = currentProfile?.role === 'admin';
  $('newQuoteItemCard').style.display = isAdmin ? 'block' : 'none';
  $('quotationStatusButtons').style.display = (isAdmin && q.status !== 'accepted' && q.status !== 'rejected') ? 'grid' : 'none';
  $('quotationRejectBtn').style.display = (isAdmin && q.status !== 'accepted' && q.status !== 'rejected') ? 'block' : 'none';

  renderQuotationItems(quotationId);
}

async function renderQuotationItems(quotationId) {
  const wrap = $('quotationItemsArea');
  const { data: items, error } = await sb
    .from('quotation_items')
    .select('*')
    .eq('quotation_id', quotationId)
    .order('sort_order', { ascending: true });
  if (error) {
    wrap.innerHTML = `<div class="empty">Couldn't load line items: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = items || [];
  const isAdmin = currentProfile?.role === 'admin';
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">No line items yet.</div>';
  } else {
    let total = 0;
    wrap.innerHTML = rows.map((it) => {
      const amount = Number(it.quantity) * Number(it.unit_price);
      total += amount;
      return `
        <div class="entry" data-quote-item="${escapeHtml(it.id)}">
          <div class="entry-body">
            <div class="entry-desc">${escapeHtml(it.description)}</div>
            <div class="entry-meta">${it.quantity} × ${it.unit_price} = ${amount.toFixed(2)}</div>
          </div>
          ${isAdmin ? `<button type="button" class="ghost" data-delete-quote-item="${escapeHtml(it.id)}">✕</button>` : ''}
        </div>
      `;
    }).join('');
    $('quotationTotalRow').innerHTML = `<strong style="font-size:14px;">Total: ${total.toFixed(2)}</strong>`;
    wrap.querySelectorAll('[data-delete-quote-item]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await sb.from('quotation_items').delete().eq('id', btn.dataset.deleteQuoteItem);
        renderQuotationItems(quotationId);
      });
    });
  }
  if (!rows.length) $('quotationTotalRow').innerHTML = '';
}

if ($('addQuoteItemBtn')) {
  $('addQuoteItemBtn').addEventListener('click', async () => {
    if (!currentQuotationId) return;
    const description = $('quoteItemDescription').value.trim();
    if (!description) { showToast('Enter a description.'); return; }
    const quantity = parseFloat($('quoteItemQuantity').value) || 1;
    const unitPrice = parseFloat($('quoteItemUnitPrice').value) || 0;
    const { error } = await sb.from('quotation_items').insert({
      quotation_id: currentQuotationId,
      description,
      quantity,
      unit_price: unitPrice,
    });
    if (error) { showToast(`Couldn't add item: ${error.message}`); return; }
    ['quoteItemDescription', 'quoteItemQuantity', 'quoteItemUnitPrice'].forEach((id) => { $(id).value = ''; });
    renderQuotationItems(currentQuotationId);
  });
}

document.querySelectorAll('[data-quote-status]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!currentQuotationId) return;
    await sb.from('quotations').update({ status: btn.dataset.quoteStatus }).eq('id', currentQuotationId);
    openQuotationDetail(currentQuotationId);
    renderQuotationsList();
  });
});
if ($('quotationRejectBtn')) {
  $('quotationRejectBtn').addEventListener('click', async () => {
    if (!currentQuotationId) return;
    await sb.from('quotations').update({ status: 'rejected' }).eq('id', currentQuotationId);
    openQuotationDetail(currentQuotationId);
    renderQuotationsList();
  });
}

// =====================================================================
// PROJECT TANK — an animated "how much of the next 12 months is already
// covered by lined-up work" gauge. See supabase/functions/get-tank-level
// for the actual calculation (remaining backlog across active projects ÷
// the team's average monthly pace this calendar year, expressed as a
// fraction of 12 months). Below 20% shows a low-pipeline warning.
// =====================================================================

function drawTank(pct) {
  const area = $('tankSvgArea');
  if (!area) return;
  const clamped = Math.max(0, Math.min(100, pct));
  const tankTop = 20, tankBottom = 240, tankHeight = tankBottom - tankTop;
  // Keep the wave visibly inside the tank body even at the extremes.
  const waterY = tankTop + tankHeight * (1 - clamped / 100);
  const waveY1 = Math.max(tankTop + 6, Math.min(tankBottom - 6, waterY));

  let topColor = '#63d197', bottomColor = '#2f8f63'; // healthy (--ok)
  if (clamped < 20) { topColor = '#f27d70'; bottomColor = '#b8443a'; } // critical (--err)
  else if (clamped < 50) { topColor = '#f2b755'; bottomColor = '#b9822c'; } // caution (--warn)

  area.innerHTML = `
    <svg viewBox="0 0 240 280" width="220" height="256" style="display:block; margin:0 auto;">
      <defs>
        <clipPath id="tankClip"><rect x="20" y="${tankTop}" width="200" height="${tankHeight}" rx="26" ry="26" /></clipPath>
        <linearGradient id="tankWaterGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${topColor}" />
          <stop offset="100%" stop-color="${bottomColor}" />
        </linearGradient>
      </defs>
      <rect x="20" y="${tankTop}" width="200" height="${tankHeight}" rx="26" ry="26" fill="rgba(255,255,255,0.04)" />
      <g clip-path="url(#tankClip)">
        <path fill="url(#tankWaterGrad)" opacity="0.92"
          d="M -20 ${waveY1 + 6} Q 10 ${waveY1 - 6} 60 ${waveY1} T 160 ${waveY1} T 260 ${waveY1} V 260 H -20 Z">
          <animate attributeName="d" dur="3.4s" repeatCount="indefinite"
            values="M -20 ${waveY1 + 6} Q 10 ${waveY1 - 6} 60 ${waveY1} T 160 ${waveY1} T 260 ${waveY1} V 260 H -20 Z;
                    M -20 ${waveY1 - 6} Q 10 ${waveY1 + 6} 60 ${waveY1} T 160 ${waveY1} T 260 ${waveY1} V 260 H -20 Z;
                    M -20 ${waveY1 + 6} Q 10 ${waveY1 - 6} 60 ${waveY1} T 160 ${waveY1} T 260 ${waveY1} V 260 H -20 Z" />
        </path>
      </g>
      <rect x="20" y="${tankTop}" width="200" height="${tankHeight}" rx="26" ry="26" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="3" />
      <rect x="94" y="${tankTop - 14}" width="52" height="16" rx="6" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.3)" stroke-width="2" />
      <text x="120" y="140" text-anchor="middle" font-size="36" font-weight="700" fill="#ffffff" stroke="rgba(0,0,0,0.6)" stroke-width="3" paint-order="stroke fill" style="font-family:inherit;">${clamped}%</text>
    </svg>
  `;
}

async function renderTank() {
  $('tankSvgArea').innerHTML = '<div class="empty">Loading…</div>';
  $('tankStatsArea').innerHTML = '';
  $('tankAlertBanner').style.display = 'none';
  try {
    const { data: { session } } = await getSessionSafe();
    const { data, error } = await sb.functions.invoke('get-tank-level', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (error || data?.error) {
      $('tankSvgArea').innerHTML = `<div class="empty">Couldn't load the tank: ${escapeHtml(data?.error || await readFunctionsError(error))}</div>`;
      return;
    }
    drawTank(data.tankLevelPct);
    $('tankStatsArea').innerHTML = `
      <div class="tank-stat-row"><span class="tank-stat-label">Months of runway</span><span class="tank-stat-value">${data.monthsOfRunway} / 12</span></div>
      <div class="tank-stat-row"><span class="tank-stat-label">Remaining backlog hours</span><span class="tank-stat-value">${data.remainingBacklogHours}</span></div>
      <div class="tank-stat-row"><span class="tank-stat-label">Average monthly pace (${data.year} so far)</span><span class="tank-stat-value">${data.avgMonthlyHours} hrs/mo</span></div>
    `;
    if (data.lowAlert) {
      $('tankAlertBanner').className = 'tank-alert-banner';
      $('tankAlertBanner').style.display = 'block';
      $('tankAlertBanner').textContent = `Pipeline is running low — only ${data.monthsOfRunway} months of lined-up work left. Time to bring in new jobs to cover the rest of the year.`;
    }
  } catch (err) {
    $('tankSvgArea').innerHTML = `<div class="empty">Couldn't load the tank: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

// =====================================================================
// PROJECTS DASHBOARD — admin creates a project with an hour budget per
// role; timesheet entries that pick that Job ID count against it. Two
// rings per project (Engineer / Technician) show used-vs-allocated hours,
// switching to an orange overage ring once someone goes past the budget.
// =====================================================================

async function fetchProjects() {
  try {
    const { data, error } = await sb
      .from('projects')
      .select('job_id, name, status, received_date')
      .order('created_at', { ascending: false });
    if (error) { console.error('fetchProjects failed:', error); return { rows: [], error }; }
    return { rows: data || [], error: null };
  } catch (err) {
    // A thrown error (vs. a returned {error}) previously blew past the
    // render logic entirely, leaving the panel blank with nothing shown —
    // this is what caused "no projects until I create one": the very first
    // fetch right after opening the panel could throw (cold client/session),
    // and nothing ever told the user or retried.
    console.error('fetchProjects threw:', err);
    return { rows: [], error: err };
  }
}

async function renderProjectsList(isRetry = false) {
  const wrap = $('projectsListArea');
  if (!wrap) return;
  if (!isRetry) wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { rows, error } = await fetchProjects();
  if (error) {
    if (!isRetry) { await new Promise((r) => setTimeout(r, 400)); return renderProjectsList(true); }
    wrap.innerHTML = `<div class="empty">Couldn't load projects: ${escapeHtml(error.message || String(error))}</div>`;
    return;
  }
  if (!rows.length) { wrap.innerHTML = '<div class="empty">No projects yet' + (currentProfile?.role === 'admin' ? ' — add one above.' : ' yet.') + '</div>'; return; }
  const isAdmin = currentProfile?.role === 'admin';
  wrap.innerHTML = rows.map((r) => `
    <div class="entry" data-project-row="${escapeHtml(r.job_id)}" data-project-name="${escapeHtml(r.name || '')}" style="cursor:pointer;">
      <span class="type-icon">📁</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(r.job_id)}${r.name ? ' — ' + escapeHtml(r.name) : ''}</div>
        ${r.received_date ? `<div class="entry-meta">${escapeHtml(r.received_date)}</div>` : ''}
      </div>
      ${isAdmin ? `<button type="button" class="ghost" data-delete-project="${escapeHtml(r.job_id)}">✕</button>` : ''}
    </div>
  `).join('');
  wrap.querySelectorAll('[data-project-row]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-project]')) return;
      openProjectDetail(row.dataset.projectRow, row.dataset.projectName);
    });
  });
  wrap.querySelectorAll('[data-delete-project]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await sb.from('projects').delete().eq('job_id', btn.dataset.deleteProject);
      renderProjectsList();
      populateJobIdDropdown();
    });
  });
}

if ($('createProjectBtn')) {
  $('createProjectBtn').addEventListener('click', async () => {
    const jobId = $('newProjectJobId').value.trim();
    const name = $('newProjectName').value.trim();
    if (!jobId) { showToast('Enter a Job ID.'); return; }
    const { error } = await sb.from('projects').insert({
      job_id: jobId, name: name || null,
      created_by: currentUser.id,
    });
    if (error) { showToast(`Couldn't create project: ${error.message}`); return; }
    $('newProjectJobId').value = '';
    $('newProjectName').value = '';
    renderProjectsList();
    populateJobIdDropdown();
    showToast('Project created.');
  });
}

// =====================================================================
// IMPORT JOBS FROM WHATSAPP — admin pastes the raw job-announcement
// messages, AEON Ai (via the import-jobs Edge Function) extracts every job
// number/description/client, checks them against Projects already saved,
// and shows only the genuinely new ones for a one-click confirm — nothing
// is written to the database until the admin reviews and hits "Add".
// =====================================================================

let lastScannedJobs = []; // the newJobs array from the last scan, kept so "Add selected" can read it back

function renderImportJobsResults(newJobs, alreadyExists) {
  const wrap = $('importJobsResultsArea');
  if (!wrap) return;
  lastScannedJobs = newJobs;
  if (!newJobs.length && !alreadyExists.length) {
    wrap.innerHTML = '<div class="empty">No job numbers found in that text.</div>';
    return;
  }
  const rows = newJobs.map((j, i) => `
    <label class="entry" style="cursor:pointer;">
      <input type="checkbox" class="import-job-check" data-idx="${i}" checked style="margin-right:10px;" />
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(j.job_id)}${j.date ? ` <span style="color:var(--text-dim); font-weight:400; font-size:11.5px;">— ${escapeHtml(j.date)}</span>` : ''}</div>
        <div class="entry-meta">${escapeHtml(j.description || '—')}${j.client ? ' · ' + escapeHtml(j.client) : ''}</div>
      </div>
    </label>
  `).join('');
  const existingNote = alreadyExists.length
    ? `<p class="hint" style="margin-top:10px;">${alreadyExists.length} job(s) already in your Projects list were skipped: ${alreadyExists.map((j) => escapeHtml(j.job_id)).join(', ')}.</p>`
    : '';
  wrap.innerHTML = newJobs.length
    ? `<p class="hint">${newJobs.length} new job(s) found — uncheck any you don't want to add:</p>${rows}
       <button id="addSelectedJobsBtn" class="primary" style="margin-top:10px;">Add selected jobs</button>${existingNote}`
    : `<div class="empty">No new jobs — every job number in that text is already saved.</div>${existingNote}`;

  const addBtn = $('addSelectedJobsBtn');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      const checked = Array.from(wrap.querySelectorAll('.import-job-check:checked')).map((el) => lastScannedJobs[Number(el.dataset.idx)]);
      if (!checked.length) { showToast('Nothing selected.'); addBtn.disabled = false; addBtn.textContent = 'Add selected jobs'; return; }
      const rowsToInsert = checked.map((j) => ({
        job_id: j.job_id,
        name: j.description || null,
        client: j.client || null,
        received_date: j.date || null,
        created_by: currentUser.id,
      }));
      const { error } = await sb.from('projects').insert(rowsToInsert);
      if (error) { showToast(`Couldn't add jobs: ${error.message}`); addBtn.disabled = false; addBtn.textContent = 'Add selected jobs'; return; }
      showToast(`Added ${rowsToInsert.length} job(s).`);
      $('importJobsText').value = '';
      wrap.innerHTML = '';
      renderProjectsList();
      populateJobIdDropdown();
    });
  }
}

// Data Feed quick actions — "Add or Remove Job" reuses the existing Projects
// panel via the generic data-open wiring further down. These two need their
// own handlers: People management lives inline in the Admin tab (not its own
// overlay), and Rules doesn't exist yet — this is a placeholder until it's
// specified.
if ($('dfGoToTeamBtn')) {
  $('dfGoToTeamBtn').addEventListener('click', () => {
    closePanel('datafeed');
    document.querySelector('nav.tabs [data-tab="admin"]')?.click();
    setTimeout(() => $('teamList')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  });
}
if ($('dfRulesBtn')) {
  $('dfRulesBtn').addEventListener('click', () => {
    showToast('Rules — coming soon. Tell me what rules you want and I\'ll build it.');
  });
}

if ($('scanImportJobsBtn')) {
  $('scanImportJobsBtn').addEventListener('click', async () => {
    const text = $('importJobsText').value.trim();
    if (!text) { showToast('Paste the WhatsApp messages first.'); return; }
    const btn = $('scanImportJobsBtn');
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    $('importJobsResultsArea').innerHTML = '<div class="empty">Reading through the messages…</div>';
    try {
      const { data, error } = await withTimeout(
        sb.functions.invoke('import-jobs', { body: { text } }),
        35000,
        'Scan'
      );
      if (error || data?.error) {
        const message = data?.error || await readFunctionsError(error);
        $('importJobsResultsArea').innerHTML = `<div class="empty">Couldn't scan: ${escapeHtml(message)}</div>`;
        return;
      }
      renderImportJobsResults(data.newJobs || [], data.alreadyExists || []);
    } catch (err) {
      $('importJobsResultsArea').innerHTML = `<div class="empty">Couldn't scan: ${escapeHtml(String(err?.message || err))}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Scan for new jobs';
    }
  });
}

// Apple-Watch-style dual ring: green fills 0→100% of allocated hours used;
// once used exceeds allocated, the green ring stays full and a second,
// smaller orange ring fills to show the overage.
function ringSvg(used, allocated) {
  const size = 140, stroke = 14;
  const rOuter = (size - stroke) / 2;
  const rInner = rOuter - stroke - 6;
  const cOuter = 2 * Math.PI * rOuter;
  const cInner = 2 * Math.PI * rInner;
  const usedPct = allocated > 0 ? Math.min(used / allocated, 1) : (used > 0 ? 1 : 0);
  const overHours = Math.max(0, used - allocated);
  const overPct = allocated > 0 && overHours > 0 ? Math.min(overHours / allocated, 1) : 0;
  const outerOffset = cOuter * (1 - usedPct);
  const innerOffset = cInner * (1 - overPct);
  const cx = size / 2, cy = size / 2;
  return `
    <svg viewBox="0 0 ${size} ${size}" class="ring-svg">
      <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--glass-border)" stroke-width="${stroke}" />
      <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--ok)" stroke-width="${stroke}"
        stroke-dasharray="${cOuter}" stroke-dashoffset="${outerOffset}" stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy})" />
      ${overHours > 0 ? `
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="var(--glass-border)" stroke-width="${stroke - 4}" />
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="var(--warn)" stroke-width="${stroke - 4}"
        stroke-dasharray="${cInner}" stroke-dashoffset="${innerOffset}" stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy})" />` : ''}
    </svg>
  `;
}

function ringCard(roleLabel, used, allocated) {
  const over = Math.max(0, Math.round((used - allocated) * 100) / 100);
  const remaining = Math.max(0, Math.round((allocated - used) * 100) / 100);
  const centerText = over > 0 ? `−${over}h` : `${remaining}h left`;
  const centerClass = over > 0 ? 'over' : 'under';
  return `
    <div class="ring-card">
      <div class="ring-role">${escapeHtml(roleLabel)}</div>
      ${ringSvg(used, allocated)}
      <div class="ring-center-value ${centerClass}">${centerText}</div>
      <div class="ring-sub">${used}h used of ${allocated}h</div>
    </div>
  `;
}

function renderProjectContributors(data) {
  const wrap = $('projectContributors');
  const contributors = data.contributors || [];
  if (!contributors.length) { wrap.innerHTML = '<div class="empty">No one has logged hours on this project yet.</div>'; return; }
  // Bar width = this person's hours as a % of THEIR ROLE's allocated budget
  // for this project (capped at 100%) -- not relative to other contributors.
  // Relative-to-max was wrong: with a single contributor it always came out
  // to 100%, making the bar look "full" even at 1 of 40 hours.
  const allocatedByDept = {};
  (data.project?.departments || []).forEach((d) => { allocatedByDept[d.id] = Number(d.allocatedHours) || 0; });
  const maxHours = Math.max(...contributors.map((c) => c.hours), 1);
  wrap.innerHTML = contributors.map((c) => {
    const allocated = allocatedByDept[c.departmentId] || 0;
    const pct = allocated > 0
      ? Math.min(Math.round((c.hours / allocated) * 100), 100)
      : Math.round((c.hours / maxHours) * 100);
    return `
    <div class="contrib-row">
      <div class="contrib-top">
        <span class="contrib-name">${escapeHtml(c.name)} <span class="chip synced" style="margin-left:6px;">${escapeHtml(c.departmentName)}</span></span>
        <span class="contrib-hours">${c.hours}h</span>
      </div>
      <div class="contrib-bar-track"><div class="contrib-bar-fill" style="width:${pct}%"></div></div>
    </div>
  `;
  }).join('');
}

// =====================================================================
// PROJECT STAGE TIMELINE — the twin-wire glass ladder shown right under
// the allocated/used hours rings on the Project Detail screen. Progress
// is stored per (job_id, stage_key) in the project_stages table; only
// admins can tap a circle to mark it done/undone, everyone else just
// views it. Requires the project_stages table + RLS policies (see the SQL
// migration) to already be set up in Supabase.
// =====================================================================

const STAGE_NODES = {
  boq: { x: 150, y: 36, label: 'BOQ and IO confirmation', side: 'r' },
  arch: { x: 150, y: 120, label: 'Architecture and description', side: 'r' },
  drawing: { x: 150, y: 204, label: 'Drawing', side: 'r' },
  programming: { x: 90, y: 300, label: 'Programming', side: 'b' },
  electrical: { x: 210, y: 300, label: 'Electrical panel build', side: 'b' },
  fat: { x: 150, y: 396, label: 'FAT with client', side: 'r' },
  delivery: { x: 150, y: 480, label: 'Delivery and payment confirmation', side: 'r' },
  commissioning: { x: 150, y: 564, label: 'Commissioning and SAT with client', side: 'r' },
  closed: { x: 150, y: 648, label: 'Project closed', side: 'r' },
};
const STAGE_CONNS = [
  ['boq', 'arch'], ['arch', 'drawing'], ['drawing', 'programming'], ['drawing', 'electrical'],
  ['programming', 'fat'], ['electrical', 'fat'], ['fat', 'delivery'], ['delivery', 'commissioning'], ['commissioning', 'closed'],
];
const STAGE_KEYS = Object.keys(STAGE_NODES);

async function fetchStageState(jobId) {
  const state = {};
  STAGE_KEYS.forEach((k) => { state[k] = false; });
  const { data, error } = await sb.from('project_stages').select('stage_key, completed').eq('job_id', jobId);
  if (!error) (data || []).forEach((r) => { state[r.stage_key] = !!r.completed; });
  return state;
}

async function toggleStage(jobId, stageKey, wasDone) {
  await sb.from('project_stages').upsert({
    job_id: jobId,
    stage_key: stageKey,
    completed: !wasDone,
    completed_at: !wasDone ? new Date().toISOString() : null,
    completed_by: currentUser?.id || null,
  }, { onConflict: 'job_id,stage_key' });
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function drawStageLadder(container, state, jobId, isAdmin) {
  const R = 15, STUB = 13, GAP = 5, WIRE_OFFSET = 2.5;
  container.innerHTML = '';
  const svg = svgEl('svg', { width: 300, height: 680, viewBox: '0 0 300 680', style: 'overflow:visible' });
  const defs = svgEl('defs', {});
  const gGray = svgEl('radialGradient', { id: 'stageGGray', cx: '35%', cy: '30%', r: '75%' });
  gGray.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#8a8985', 'stop-opacity': 0.55 }));
  gGray.appendChild(svgEl('stop', { offset: '60%', 'stop-color': '#5f5e5a', 'stop-opacity': 0.4 }));
  gGray.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#5f5e5a', 'stop-opacity': 0.25 }));
  const gOrange = svgEl('radialGradient', { id: 'stageGOrange', cx: '35%', cy: '30%', r: '75%' });
  gOrange.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#e08a5f', 'stop-opacity': 0.9 }));
  gOrange.appendChild(svgEl('stop', { offset: '60%', 'stop-color': '#cc785c', 'stop-opacity': 0.6 }));
  gOrange.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#cc785c', 'stop-opacity': 0.35 }));
  defs.appendChild(gGray); defs.appendChild(gOrange);
  svg.appendChild(defs);

  STAGE_CONNS.forEach(([a, b], i) => {
    const A = STAGE_NODES[a], B = STAGE_NODES[b];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.sqrt(dx * dx + dy * dy), ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const pA = { x: A.x + ux * R, y: A.y + uy * R };
    const stubAend = { x: A.x + ux * (R + STUB), y: A.y + uy * (R + STUB) };
    const gapAend = { x: A.x + ux * (R + STUB + GAP), y: A.y + uy * (R + STUB + GAP) };
    const pB = { x: B.x - ux * R, y: B.y - uy * R };
    const stubBstart = { x: B.x - ux * (R + STUB), y: B.y - uy * (R + STUB) };
    const gapBstart = { x: B.x - ux * (R + STUB + GAP), y: B.y - uy * (R + STUB + GAP) };
    const done = state[a] && state[b];
    const g = svgEl('g', { class: `stage-conn${done ? ' done' : ''}`, id: `stageConn${i}` });
    const pts = [[pA, stubAend], [gapAend, gapBstart], [stubBstart, pB]];
    [-1, 1].forEach((side) => {
      const ox = nx * WIRE_OFFSET * side, oy = ny * WIRE_OFFSET * side;
      pts.forEach(([p1, p2]) => {
        g.appendChild(svgEl('line', { x1: p1.x + ox, y1: p1.y + oy, x2: p2.x + ox, y2: p2.y + oy }));
      });
    });
    svg.appendChild(g);
  });

  STAGE_KEYS.forEach((id) => {
    const n = STAGE_NODES[id];
    const done = !!state[id];
    const g = svgEl('g', { class: `stage-node${done ? ' done' : ''}` });
    const c = svgEl('circle', { class: 'stage-body', cx: n.x, cy: n.y, r: R });
    g.appendChild(c);
    const sh = svgEl('ellipse', { class: 'stage-shine', cx: n.x - 5, cy: n.y - 6, rx: 5, ry: 3 });
    g.appendChild(sh);
    const t = svgEl('text', {
      class: 'stage-lbl',
      x: n.side === 'r' ? n.x + 22 : n.x,
      y: n.side === 'r' ? n.y + 4 : n.y + 30,
      'text-anchor': n.side === 'r' ? 'start' : 'middle',
    });
    t.textContent = n.label;
    g.appendChild(t);
    if (isAdmin) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', async () => {
        await toggleStage(jobId, id, done);
        const fresh = await fetchStageState(jobId);
        drawStageLadder(container, fresh, jobId, isAdmin);
      });
    }
    svg.appendChild(g);
  });

  container.appendChild(svg);
}

async function renderProjectStages(jobId) {
  const area = $('projectStageArea');
  if (!area) return;
  const isAdmin = currentProfile?.role === 'admin';
  area.innerHTML = `
    <div class="card glass">
      <strong style="font-size:14px;">Project timeline</strong>
      ${isAdmin ? '<p class="hint" style="margin-top:4px;">Tap a circle to mark that stage done.</p>' : ''}
      <div id="stageSvgWrap" style="display:flex; justify-content:center; margin-top:12px;"></div>
    </div>
  `;
  const state = await fetchStageState(jobId);
  drawStageLadder($('stageSvgWrap'), state, jobId, isAdmin);
}

let currentProjectReport = null;
let currentProjectJobId = null;

async function openProjectDetail(jobId, name) {
  currentProjectReport = null;
  currentProjectJobId = jobId;
  $('projectDetailTitle').textContent = name ? `${jobId} — ${name}` : jobId;
  $('projectRingsArea').innerHTML = '<div class="empty">Loading…</div>';
  $('projectContributors').innerHTML = '';
  $('projectStageArea').innerHTML = '';
  $('boqListArea').innerHTML = '';
  $('boqTotalRow').innerHTML = '';
  $('deptHoursListArea').innerHTML = '';
  openPanel('projectDetail');
  populateShareGroupPicker();
  renderProjectStages(jobId);
  renderBoq(jobId);
  const { data: { session } } = await getSessionSafe();
  const { data, error } = await sb.functions.invoke('get-project-report', {
    body: { jobId },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error || data?.error) {
    $('projectRingsArea').innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(data?.error || await readFunctionsError(error))}</div>`;
    return;
  }
  currentProjectReport = data;
  const departments = data.project.departments || [];
  $('projectRingsArea').innerHTML = departments.length
    ? `<div class="project-rings">${departments.map((d) => ringCard(d.name, d.usedHours, d.allocatedHours)).join('')}</div>`
    : '<div class="empty">No department hours logged or allocated yet.</div>';
  renderProjectContributors(data);
  renderDeptHoursManager(jobId, departments);
}

// ---------- Department hours — admin sets an hour budget PER DEPARTMENT for
// this project (replaces the old fixed Engineer/Technician split). Same
// add/list/delete pattern as BOQ items below. ----------
async function renderDeptHoursManager(jobId, departments) {
  const isAdmin = currentProfile?.role === 'admin';
  $('newDeptHoursCard').style.display = isAdmin ? 'block' : 'none';

  const { rows: allDepartments } = await fetchDepartments();
  const select = $('deptHoursSelect');
  if (select) {
    select.innerHTML = allDepartments.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')
      || '<option value="">No departments yet — add one from Admin → Team → Departments</option>';
  }

  const list = $('deptHoursListArea');
  const withAllocation = departments.filter((d) => d.allocatedHours > 0);
  if (!withAllocation.length) {
    list.innerHTML = '<div class="empty">No department hours set yet.</div>';
  } else {
    list.innerHTML = withAllocation.map((d) => `
      <div class="entry" data-dept-hours-row="${escapeHtml(d.id)}">
        <div class="entry-body">
          <div class="entry-desc">${escapeHtml(d.name)}</div>
          <div class="entry-meta">${d.allocatedHours}h allocated · ${d.usedHours}h used</div>
        </div>
        ${isAdmin ? `<button type="button" class="ghost" data-delete-dept-hours="${escapeHtml(d.id)}">✕</button>` : ''}
      </div>
    `).join('');
    list.querySelectorAll('[data-delete-dept-hours]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await sb.from('project_department_hours').delete().eq('job_id', jobId).eq('department_id', btn.dataset.deleteDeptHours);
        openProjectDetail(jobId, currentProjectReport?.project?.name || null);
      });
    });
  }
}

if ($('addDeptHoursBtn')) {
  $('addDeptHoursBtn').addEventListener('click', async () => {
    const jobId = currentProjectJobId;
    if (!jobId) return;
    const departmentId = $('deptHoursSelect').value;
    if (!departmentId) { showToast('Pick a department first.'); return; }
    const hours = parseFloat($('deptHoursValue').value) || 0;
    const { error } = await sb.from('project_department_hours')
      .upsert({ job_id: jobId, department_id: departmentId, allocated_hours: hours, created_by: currentUser.id }, { onConflict: 'job_id,department_id' });
    if (error) { showToast(`Couldn't set hours: ${error.message}`); return; }
    $('deptHoursValue').value = '';
    showToast('Department hours updated.');
    openProjectDetail(jobId, currentProjectReport?.project?.name || null);
  });
}

// ---------- Bill of Quantities (BOQ) — itemized rows per project ----------
async function renderBoq(jobId) {
  const wrap = $('boqListArea');
  const isAdmin = currentProfile?.role === 'admin';
  $('newBoqItemCard').style.display = isAdmin ? 'block' : 'none';
  const { data: items, error } = await sb
    .from('boq_items')
    .select('*')
    .eq('job_id', jobId)
    .order('sort_order', { ascending: true });
  if (error) {
    wrap.innerHTML = `<div class="empty">Couldn't load the BOQ: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = items || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">No items yet.</div>';
    $('boqTotalRow').innerHTML = '';
    return;
  }
  let total = 0;
  wrap.innerHTML = rows.map((it) => {
    const amount = Number(it.quantity) * Number(it.unit_rate);
    total += amount;
    return `
      <div class="entry" data-boq-item="${escapeHtml(it.id)}">
        <div class="entry-body">
          <div class="entry-desc">${escapeHtml(it.description)}</div>
          <div class="entry-meta">${it.quantity} ${escapeHtml(it.unit || '')} × ${it.unit_rate} = ${amount.toFixed(2)}</div>
        </div>
        ${isAdmin ? `<button type="button" class="ghost" data-delete-boq-item="${escapeHtml(it.id)}">✕</button>` : ''}
      </div>
    `;
  }).join('');
  $('boqTotalRow').innerHTML = `<strong style="font-size:14px;">Total: ${total.toFixed(2)}</strong>`;
  wrap.querySelectorAll('[data-delete-boq-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await sb.from('boq_items').delete().eq('id', btn.dataset.deleteBoqItem);
      renderBoq(jobId);
    });
  });
}

if ($('addBoqItemBtn')) {
  $('addBoqItemBtn').addEventListener('click', async () => {
    const jobId = currentProjectJobId;
    if (!jobId) return;
    const description = $('boqItemDescription').value.trim();
    if (!description) { showToast('Enter a description.'); return; }
    const quantity = parseFloat($('boqItemQuantity').value) || 0;
    const unitRate = parseFloat($('boqItemRate').value) || 0;
    const { error } = await sb.from('boq_items').insert({
      job_id: jobId,
      description,
      unit: $('boqItemUnit').value.trim() || null,
      quantity,
      unit_rate: unitRate,
      created_by: currentUser.id,
    });
    if (error) { showToast(`Couldn't add item: ${error.message}`); return; }
    ['boqItemDescription', 'boqItemUnit', 'boqItemQuantity', 'boqItemRate'].forEach((id) => { $(id).value = ''; });
    renderBoq(jobId);
  });
}

// ---------- Share a project's status into one of the viewer's own groups ----------
async function populateShareGroupPicker() {
  const select = $('shareProjectGroupSelect');
  if (!select) return;
  select.innerHTML = '<option value="">Loading your groups…</option>';
  const { data, error } = await sb.from('chats').select('id, name').eq('type', 'group');
  const groups = error ? [] : (data || []);
  if (!groups.length) {
    select.innerHTML = '<option value="">You\'re not in any group chats yet</option>';
    return;
  }
  select.innerHTML = groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name || 'Group')}</option>`).join('');
}

// Renders the same information the Project Detail screen shows (both rings
// + the "who worked on this" list) onto a canvas and exports it as a PNG,
// so sharing to a group sends an actual picture of the view instead of a
// few lines of plain text.
function drawShareRing(ctx, cx, cy, used, allocated, label) {
  const rOuter = 58, rInner = 42, stroke = 12;
  const usedPct = allocated > 0 ? Math.min(used / allocated, 1) : (used > 0 ? 1 : 0);
  const overHours = Math.max(0, used - allocated);
  const overPct = allocated > 0 && overHours > 0 ? Math.min(overHours / allocated, 1) : 0;
  const TAU = Math.PI * 2, START = -Math.PI / 2;

  ctx.lineCap = 'round';

  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = stroke;
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, 0, TAU);
  ctx.stroke();

  ctx.strokeStyle = '#63d197';
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, START, START + usedPct * TAU);
  ctx.stroke();

  if (overHours > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = stroke - 4;
    ctx.beginPath();
    ctx.arc(cx, cy, rInner, 0, TAU);
    ctx.stroke();

    ctx.strokeStyle = '#f2b755';
    ctx.beginPath();
    ctx.arc(cx, cy, rInner, START, START + overPct * TAU);
    ctx.stroke();
  }

  const over = Math.max(0, Math.round((used - allocated) * 100) / 100);
  const remaining = Math.max(0, Math.round((allocated - used) * 100) / 100);
  ctx.textAlign = 'center';
  ctx.fillStyle = over > 0 ? '#f2b755' : '#f5f4f0';
  ctx.font = '700 15px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText(over > 0 ? `−${over}h` : `${remaining}h left`, cx, cy + 5);

  ctx.fillStyle = '#f5f4f0';
  ctx.font = '700 14px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText(label, cx, cy + rOuter + 26);
  ctx.fillStyle = '#a8a6a2';
  ctx.font = '12px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText(`${used}h used of ${allocated}h`, cx, cy + rOuter + 44);
  ctx.textAlign = 'left';
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function buildProjectShareImage(data) {
  const { project, totals, contributors = [] } = data;
  const W = 720, HEADER_H = 260, ROW_H = 56;
  const H = HEADER_H + Math.max(contributors.length, 1) * ROW_H + 90;

  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = '#0d0d0e';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  roundRectPath(ctx, 16, 16, W - 32, H - 32, 20);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  roundRectPath(ctx, 16, 16, W - 32, H - 32, 20);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f5f4f0';
  ctx.font = '700 22px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText(project.name ? `${project.jobId} — ${project.name}` : project.jobId, 40, 52);
  ctx.fillStyle = '#a8a6a2';
  ctx.font = '13px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText('C-TORQ Digital Organization — project status', 40, 76);

  drawShareRing(ctx, W / 2 - 110, 168, totals.engineerHours, project.allocatedEngineer, 'Engineer');
  drawShareRing(ctx, W / 2 + 110, 168, totals.technicianHours, project.allocatedTechnician, 'Technician');

  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.beginPath();
  ctx.moveTo(40, HEADER_H - 14);
  ctx.lineTo(W - 40, HEADER_H - 14);
  ctx.stroke();

  ctx.fillStyle = '#f5f4f0';
  ctx.font = '700 14px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText('Who worked on this', 40, HEADER_H + 8);

  const allocatedForRole = {
    engineer: Number(project.allocatedEngineer) || 0,
    technician: Number(project.allocatedTechnician) || 0,
  };
  const maxHours = Math.max(...contributors.map((c) => c.hours), 1);

  let y = HEADER_H + 40;
  if (!contributors.length) {
    ctx.fillStyle = '#a8a6a2';
    ctx.font = '13px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('No one has logged hours on this project yet.', 40, y);
  } else {
    for (const c of contributors) {
      const barX = 40, barW = W - 80, barY = y + 12, barH = 8;

      ctx.font = '700 14px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillStyle = '#f5f4f0';
      ctx.fillText(c.name, barX, y);
      const nameW = ctx.measureText(c.name).width;

      ctx.font = '11px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillStyle = '#a8a6a2';
      ctx.fillText(POSITION_LABEL[c.position] || c.position, barX + nameW + 10, y);

      ctx.textAlign = 'right';
      ctx.font = '800 13.5px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillStyle = '#f5f4f0';
      ctx.fillText(`${c.hours}h`, W - 40, y);
      ctx.textAlign = 'left';

      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
      ctx.fill();

      const allocated = allocatedForRole[c.position];
      const pct = allocated > 0 ? Math.min(c.hours / allocated, 1) : (c.hours / maxHours);
      const fillW = Math.max(barH, barW * pct);
      const grad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
      grad.addColorStop(0, '#e08a5f');
      grad.addColorStop(1, '#cc785c');
      ctx.fillStyle = grad;
      roundRectPath(ctx, barX, barY, fillW, barH, barH / 2);
      ctx.fill();

      y += ROW_H;
    }
  }

  ctx.fillStyle = '#6b6965';
  ctx.font = '11px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText(new Date().toLocaleString(), 40, H - 30);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

if ($('shareProjectBtn')) {
  $('shareProjectBtn').addEventListener('click', async () => {
    const chatId = $('shareProjectGroupSelect').value;
    if (!chatId) { showToast('Pick a group to share to.'); return; }
    if (!currentProjectReport) { showToast('Still loading project data — try again in a second.'); return; }

    const btn = $('shareProjectBtn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing image…';

    try {
      const blob = await buildProjectShareImage(currentProjectReport);
      if (!blob) throw new Error('Could not generate the image.');

      const { project } = currentProjectReport;
      const safeJobId = String(project.jobId).replace(/[^a-z0-9_.-]/gi, '_');
      const fileName = `project-${safeJobId}-${Date.now()}.png`;
      const path = `${chatId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}_${fileName}`;

      const { error: upErr } = await sb.storage.from('chat-attachments').upload(path, blob, { contentType: 'image/png' });
      if (upErr) throw upErr;

      const caption = `📊 Project status: ${project.jobId}${project.name ? ' — ' + project.name : ''}`;
      const { data: newMsg, error } = await sb.from('messages').insert({
        chat_id: chatId, sender_id: currentUser.id, content: caption,
        attachment_path: path, attachment_name: fileName, attachment_mime: 'image/png',
      }).select().single();
      if (error) throw error;

      if (newMsg) {
        const { data: { session } } = await getSessionSafe();
        sb.functions.invoke('send-push', {
          body: { chatId, messageId: newMsg.id },
          headers: { Authorization: `Bearer ${session?.access_token}` },
        }).catch(() => {});
      }
      showToast('Shared to group.');
    } catch (err) {
      showToast(`Couldn't share: ${err.message || err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}

// =====================================================================
// REPORTS — per-person monthly timesheet report (hours, overtime, leave)
// =====================================================================

let reportMonth = null;          // 'YYYY-MM', defaults to current month
let reportTargetEmail = null;    // null = viewing your own report
let reportPersonPopulated = false;

const GAUGE_MAX = {
  totalHours: 200, overtimeHours: 40, daysWorked: 26,
  sickLeaveDays: 5, holidayDays: 6, emergencyLeaveDays: 3, allowanceHours: 20,
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
      <td>${r.lunchMinutes ? r.lunchMinutes + ' min' : '—'}</td>
      <td>${r.allowanceLocation ? escapeHtml(r.allowanceLocation) + (r.allowanceHours ? ` (+${r.allowanceHours}h)` : '') : '—'}</td>
    </tr>
  `).join('');
  wrap.innerHTML = `
    <table class="report-table">
      <thead><tr><th>Date</th><th>Mode</th><th>Project</th><th>Hours</th><th>Overtime</th><th>Lunch</th><th>Allowance</th></tr></thead>
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
    gaugeCard('Allowance', t.allowanceHours || 0, GAUGE_MAX.allowanceHours, 'h', 'var(--ok)'),
  ].join('');
  $('hoursChart').innerHTML = hoursBarChart(data.dayRows);
  renderReportTable(data);
}

async function fetchAndRenderReport() {
  if (!currentUser) return;
  $('gaugeGrid').innerHTML = '<div class="empty">Loading…</div>';
  $('reportTableWrap').innerHTML = '';
  try {
    const { data: { session } } = await getSessionSafe();
    const { data, error } = await sb.functions.invoke('get-report', {
      body: { targetEmail: reportTargetEmail, month: reportMonth },
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (error || data?.error) throw new Error(data?.error || await readFunctionsError(error));
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

// WhatsApp-style relative time for the chat list: just the time for
// today, "Yesterday" for the day before, short weekday for the last week,
// and a short date beyond that.
function chatListTimeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
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
          <div class="chat-list-row1">
            <div class="chat-list-name">${escapeHtml(name)}</div>
            <div class="chat-list-time">${escapeHtml(chatListTimeLabel(c.lastAt))}</div>
          </div>
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
// Free-tier Supabase Storage hard-caps every single upload at 50MB, project-
// wide, regardless of any bucket setting — so this is checked client-side
// up front with a clear message, rather than letting a big file fail late
// with a confusing storage error. If you ever move to a paid plan and raise
// the bucket's file_size_limit, raise this number to match.
const MAX_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024;
// Supabase's own guidance: plain upload() is fine under ~6MB; above that,
// use resumable (TUS) uploads so a dropped connection can pick back up
// instead of failing outright and making the person start over.
const TUS_CHUNK_THRESHOLD_BYTES = 6 * 1024 * 1024;

$('chatAttachBtn').addEventListener('click', () => $('chatFileInput').click());
$('chatFileInput').addEventListener('change', () => {
  const file = $('chatFileInput').files[0];
  if (!file) return;
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
    showToast(`That file is ${(file.size / (1024 * 1024)).toFixed(1)}MB — the largest file this app can send right now is 50MB.`);
    $('chatFileInput').value = '';
    return;
  }
  pendingChatAttachment = file;
  const preview = $('chatAttachPreview');
  preview.style.display = 'flex';
  preview.innerHTML = `📎 ${escapeHtml(file.name)} (${(file.size / (1024 * 1024)).toFixed(1)}MB) <button type="button" id="chatAttachRemoveBtn">✕</button>`;
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

// Resumable (TUS) upload for larger files (photos/videos/zips over the ~6MB
// "safe zone" for a plain upload()). Uploads in fixed 6MB chunks — that
// exact size is required by Supabase's resumable endpoint — and can resume
// a dropped upload instead of restarting from zero on a shaky connection.
// Shared by Team Chat attachments AND Daily Progress / Project Report
// attachments — only the bucket differs.
// onProgress(fraction) is called repeatedly with a 0–1 value for UI feedback.
function uploadFileResumable(file, bucket, path, accessToken, onProgress) {
  return new Promise((resolve, reject) => {
    if (!window.tus) {
      reject(new Error('Large-file upload support failed to load — fully close and reopen the app, then try again.'));
      return;
    }
    let projectRef;
    try {
      projectRef = new URL(window.CTORQ_CONFIG.SUPABASE_URL).hostname.split('.')[0];
    } catch {
      reject(new Error('Missing Supabase configuration for large-file upload.'));
      return;
    }
    const upload = new window.tus.Upload(file, {
      endpoint: `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: window.CTORQ_CONFIG.SUPABASE_ANON_KEY,
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: (file.type || 'application/octet-stream'),
        cacheControl: '3600',
      },
      chunkSize: 6 * 1024 * 1024, // required exact value for Supabase's resumable endpoint
      onError: (error) => reject(error),
      onProgress: (bytesUploaded, bytesTotal) => {
        if (onProgress) onProgress(bytesUploaded / bytesTotal);
      },
      onSuccess: () => resolve(),
    });
    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length) upload.resumeFromPreviousUpload(previousUploads[0]);
      upload.start();
    }).catch(reject);
  });
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

      if (file.size > TUS_CHUNK_THRESHOLD_BYTES) {
        // Larger file (video, uncompressed photo, PDF, etc.) — use resumable
        // chunked upload with visible progress instead of a single request
        // that either succeeds or fails silently on a weak connection.
        const { data: { session } } = await getSessionSafe();
        if (!session?.access_token) throw new Error('Not signed in — please sign out and back in.');
        sendBtn.textContent = 'Uploading… 0%';
        await uploadFileResumable(file, 'chat-attachments', path, session.access_token, (fraction) => {
          sendBtn.textContent = `Uploading… ${Math.round(fraction * 100)}%`;
        });
      } else {
        const { error: upErr } = await withTimeout(
          sb.storage.from('chat-attachments').upload(path, file),
          25000,
          'Upload'
        );
        if (upErr) throw upErr;
      }
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
      const { data: { session } } = await getSessionSafe();
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

// ---------- Glass-styled dropdowns ----------
// Native <select> option lists are drawn by the OS/browser, not the page —
// on some devices (notably Android Chrome) that popup ignores our CSS
// entirely and shows a plain white system list, even though the closed box
// itself looks right. To make every dropdown's OPEN list follow the glass
// design too, this wraps a real <select> with a small custom button + our
// own glass-styled list, while keeping the original <select> in the page
// (just visually hidden) so nothing else has to change — every existing
// `.value` read, `addEventListener('change', ...)`, and dynamic option
// repopulation (`select.innerHTML = ...`) keeps working exactly as before.
function initGlassSelect(select) {
  if (!select || select.dataset.glassInit) return;
  select.dataset.glassInit = '1';

  const wrap = document.createElement('div');
  wrap.className = 'glass-select-wrap';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add('glass-select-native');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'glass-select-btn';
  wrap.appendChild(btn);

  const list = document.createElement('div');
  list.className = 'glass-select-list job-search-results';
  list.style.display = 'none';
  wrap.appendChild(list);

  function syncBtn() {
    const opt = select.options[select.selectedIndex];
    btn.textContent = opt ? (opt.textContent || opt.value || ' ') : ' ';
    btn.disabled = select.disabled;
    btn.classList.toggle('disabled', select.disabled);
  }
  function closeList() {
    list.style.display = 'none';
    document.removeEventListener('mousedown', onOutside, true);
  }
  function onOutside(e) {
    if (!wrap.contains(e.target)) closeList();
  }
  function openList() {
    if (select.disabled) return;
    list.innerHTML = Array.from(select.options).map((opt, i) => `
      <div class="job-search-item glass-select-item${i === select.selectedIndex ? ' selected' : ''}" data-index="${i}">
        <div class="jid">${escapeHtml(opt.textContent || ' ')}</div>
      </div>
    `).join('') || '<div class="job-search-empty">No options</div>';
    list.querySelectorAll('.glass-select-item[data-index]').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number(item.dataset.index);
        if (select.selectedIndex !== idx) {
          select.selectedIndex = idx;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeList();
        syncBtn();
      });
    });
    list.style.display = 'block';
    document.addEventListener('mousedown', onOutside, true);
  }
  btn.addEventListener('click', () => { list.style.display === 'block' ? closeList() : openList(); });

  // Options on many of these selects are (re)populated dynamically after
  // data loads elsewhere in the app — watch for that so the button label
  // stays correct without touching any of those call sites.
  new MutationObserver(syncBtn).observe(select, { childList: true, subtree: true });
  select.addEventListener('change', syncBtn);
  syncBtn();
}

function initAllGlassSelects(root) {
  (root || document).querySelectorAll('select:not([data-glass-init])').forEach(initGlassSelect);
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
      <div class="entry entry-clickable" data-entry-id="${escapeHtml(en.id)}" title="Tap to review the full details">
        <span class="type-icon">${icon}</span>
        <div class="entry-body">
          <div class="entry-meta">${escapeHtml(meta)}</div>
          <div class="entry-desc">${escapeHtml(en.description || '')}</div>
        </div>
        <span class="chip ${en.status}">${en.status}</span>
      </div>
    `;
  }).join('');
  list.querySelectorAll('[data-entry-id]').forEach((row) => {
    row.addEventListener('click', () => openEntryDetail(row.dataset.entryId));
  });
}
$('syncNowBtn').addEventListener('click', () => syncQueue());

// =====================================================================
// SYNC — server-side via submit-entry Edge Function
// =====================================================================

let syncing = false;

// Daily Progress / Project Report attachments are stored locally as base64
// (same as ever) so an entry can still be created offline at a job site with
// no signal. The actual upload to Supabase Storage only happens here, right
// before syncing — this is the one place that already knows we're online.
// Once uploaded, the base64 is replaced with a lightweight Storage
// reference, so submit-entry never has to push a big file through GitHub's
// Contents API (which hard-caps around 100MB and recommends staying under
// 1MB) — GitHub only ever sees a small JSON record with a link to the file.
const ENTRY_ATTACHMENT_BUCKET = 'entry-attachments';
const MAX_ENTRY_ATTACHMENT_BYTES = 50 * 1024 * 1024; // matches the Free-tier Storage ceiling

function base64ToBlob(base64, mime) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: mime || 'application/octet-stream' });
}

async function uploadEntryAttachmentsIfNeeded(entry, accessToken) {
  if (entry.category !== 'daily-progress' && entry.category !== 'project-report') return entry.attachments || [];
  if (!Array.isArray(entry.attachments) || !entry.attachments.length) return entry.attachments || [];

  const safeUser = String(entry.userLabel || '').replace(/[^a-z0-9_-]/gi, '_') || 'unknown';
  const refs = [];
  for (let i = 0; i < entry.attachments.length; i++) {
    const att = entry.attachments[i];
    if (att?.storage && att?.path) { refs.push(att); continue; } // already uploaded on a previous, partially-failed sync attempt
    if (!att?.base64 || !att?.name) continue;

    const blob = base64ToBlob(att.base64, att.mime);
    if (blob.size > MAX_ENTRY_ATTACHMENT_BYTES) {
      throw new Error(`"${att.name}" is over 50MB — remove it from this entry and try again with a smaller file.`);
    }
    const safeName = String(att.name).replace(/[^a-z0-9_.-]/gi, '_');
    const path = `${entry.category}/${safeUser}/${entry.id}_${i}_${safeName}`;

    if (blob.size > TUS_CHUNK_THRESHOLD_BYTES) {
      await uploadFileResumable(blob, ENTRY_ATTACHMENT_BUCKET, path, accessToken, () => {});
    } else {
      const { error } = await sb.storage.from(ENTRY_ATTACHMENT_BUCKET).upload(path, blob, {
        contentType: att.mime || 'application/octet-stream',
        upsert: true, // safe to retry the same path if a previous sync attempt got this far but failed later
      });
      if (error) throw error;
    }
    refs.push({ name: att.name, mime: att.mime || 'application/octet-stream', path, bucket: ENTRY_ATTACHMENT_BUCKET, storage: true });
  }
  return refs;
}

async function syncQueue() {
  if (syncing || !navigator.onLine || !currentUser) return;
  syncing = true;
  try {
    const { data: { session } } = await getSessionSafe();
    if (!session) return;

    const entries = await getAllEntries();
    const pending = entries.filter(e => e.status !== 'synced');
    for (const entry of pending) {
      try {
        entry.attachments = await uploadEntryAttachmentsIfNeeded(entry, session.access_token);
        // Timeout guard: this runs automatically every few minutes with no
        // one watching. Without a limit, one hung request here would keep
        // "syncing" stuck true forever, silently disabling every future
        // auto-sync until the app was fully reloaded.
        const { data, error } = await withTimeout(
          sb.functions.invoke('submit-entry', {
            body: entry,
            headers: { Authorization: `Bearer ${session.access_token}` }
          }),
          20000,
          'Submit entry'
        );
        if (error || data?.error) throw new Error(data?.error || await readFunctionsError(error));
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

// Cleans up AEON Ai's reply so it reads like a real person typed it, both on
// screen and out loud — the model is already instructed not to use markdown/
// symbols, but this is a second, guaranteed line of defense so a stray "**"
// or "(" never shows up as literal text or gets read aloud as "asterisk" /
// "open paren" by the browser's speech engine.
function humanizeAiReply(text) {
  if (!text) return text;
  return String(text)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[*_#~>`]/g, '')
    .replace(/[()]/g, '')
    .replace(/@/g, ' at ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    const { data: { session } } = await getSessionSafe();
    // Same reasoning as chat send/upload above: sb.functions.invoke() has no
    // built-in ceiling of its own, so if the edge function or the network
    // ever genuinely hangs instead of erroring, "Thinking…" would sit there
    // forever with the input still locked. This guarantees a real answer or
    // a clear failure message within 30s, always — never an endless spinner.
    const { data, error } = await withTimeout(
      sb.functions.invoke('ai-chat', {
        body: { message: text, history: aiHistory },
        headers: { Authorization: `Bearer ${session.access_token}` }
      }),
      30000,
      'AEON Ai'
    );
    if (error || data?.error) throw new Error(data?.error || await readFunctionsError(error));
    const cleanReply = humanizeAiReply(data.reply);
    loadingEl.textContent = cleanReply;
    loadingEl.className = 'ai-msg assistant';
    aiHistory.push({ role: 'user', text }, { role: 'assistant', text: cleanReply });
    aiHistory = aiHistory.slice(-16);
    speakText(cleanReply);
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

// ---------- Service worker + update status icon ----------
// The little refresh icon next to the Online pill, Windows-Update-style:
//   idle (no dot)   — nothing pending; tap does a manual "check now"
//   red dot         — a new build finished downloading and is ready; tap
//                     applies it (spins briefly, then reloads onto it)
//   green dot       — just updated, confirming you're on the new build
//                     (fades back to idle after a few seconds)
let pendingUpdateReady = false;
let pendingUpdateVersion = '';
let pendingUpdateNotes = '';
let swRegistration = null;

function setUpdateDot(state) {
  const dot = $('updateStatusDot');
  if (!dot) return;
  dot.className = 'update-status-dot' + (state === 'none' ? '' : ' dot-' + state);
  dot.style.display = state === 'none' ? 'none' : 'block';
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').then((reg) => {
      swRegistration = reg;
      // Proactively re-check for a newer deploy whenever the tab regains
      // focus — catches a tab that's been sitting open/backgrounded for a
      // while, rather than only ever checking on a fresh page load.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(console.error);
  });

  // RELIABILITY: the app shell uses stale-while-revalidate caching for
  // instant, consistent open speed — but that means a tab that's already
  // open keeps running whatever JS it already loaded, even after a newer
  // version has finished downloading in the background. Once a new service
  // worker actually takes control of THIS page, a fresh build is ready —
  // rather than silently reloading out from under someone (which could
  // interrupt typing or wipe an in-progress clock-in view), light up the
  // update icon's red dot and let them apply it when it's a good moment.
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (pendingUpdateReady) return;
    pendingUpdateReady = true;
    try {
      // Cache-busted + no-store so this reads the genuinely new file over
      // the network, not whatever this tab (or the old service worker)
      // already had cached.
      const res = await fetch('./app.js?_=' + Date.now(), { cache: 'no-store' });
      const text = await res.text();
      pendingUpdateVersion = (text.match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1] || '';
      pendingUpdateNotes = (text.match(/const APP_UPDATE_NOTES\s*=\s*'([^']*)'/) || [])[1] || '';
    } catch { /* light up the dot anyway, just without the version/notes detail */ }
    setUpdateDot('red');
  });

  // If we just reloaded to apply an update (see applyPendingUpdate below),
  // show a brief green "you're up to date" confirmation on this fresh load.
  if (localStorage.getItem('ctorq-just-updated')) {
    localStorage.removeItem('ctorq-just-updated');
    setUpdateDot('green');
    setTimeout(() => setUpdateDot('none'), 5000);
  }
}

function applyPendingUpdate() {
  const btn = $('updateStatusBtn');
  showToast(pendingUpdateVersion
    ? `Updating to ${pendingUpdateVersion}${pendingUpdateNotes ? ' — ' + pendingUpdateNotes : ''}`
    : 'Updating to the latest version…');
  if (btn) btn.classList.add('updating');
  try { localStorage.setItem('ctorq-just-updated', '1'); } catch { /* ignore */ }
  setTimeout(() => location.reload(), 600);
}

$('updateStatusBtn')?.addEventListener('click', async () => {
  const btn = $('updateStatusBtn');
  if (btn.classList.contains('updating') || btn.classList.contains('checking')) return;
  if (pendingUpdateReady) { applyPendingUpdate(); return; }

  // No update pending yet — do a manual check-now instead.
  btn.classList.add('checking');
  try { if (swRegistration) await swRegistration.update(); } catch { /* ignore */ }
  setTimeout(() => {
    btn.classList.remove('checking');
    if (!pendingUpdateReady) showToast(`You're up to date — ${APP_VERSION}`);
    // If a real update WAS found, the controllerchange handler above will
    // have already flipped the dot red on its own.
  }, 1200);
});

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

// Give every plain <select> already in the page the glass-styled dropdown
// treatment. Selects created dynamically later (Team roster role/department
// pickers, Job Allocation driver pickers) are wired individually right
// after they're rendered — see initGlassSelect() calls near those renders.
initAllGlassSelects();
