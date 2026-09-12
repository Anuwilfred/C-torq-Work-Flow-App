// Bump this alongside CACHE_NAME in service-worker.js on every deploy — shown
// in Settings so it's possible to check, at a glance, exactly which build is
// actually live on a given device (screenshot it instead of guessing).
// VERSIONING RULE: always increment ONLY the last number by exactly 1
// (v3.35.1 -> v3.35.2 -> v3.35.3 ...), every single release, no matter how
// big the change is. Never bump the first two numbers — that used to happen
// for "big" features and made version jumps look confusing/skipped.
const APP_VERSION = 'v3.47.3';
// One short line describing what changed this round — read by OTHER, older
// tabs (via a plain-text fetch of this exact file) so the update icon's
// toast can say what's new before anyone taps to refresh.
const APP_UPDATE_NOTES = "Field Activities' 'Log a visit' now has a live location search box too — type/pick a specific address for the visit, or leave it blank to keep using automatic GPS.";
if (document.getElementById('appVersionLabel')) document.getElementById('appVersionLabel').textContent = `App version ${APP_VERSION}`;

// ---------- Self-heal a stale cached app shell ----------
// WHY THIS EXISTS: the service worker below uses stale-while-revalidate for
// instant, consistent open speed — it deliberately shows whatever's already
// cached FIRST, then quietly fetches a fresh copy in the background for next
// time. That's great for speed, but it means the very first normal (not
// incognito) load right after a new deploy can still run yesterday's app.js
// for that one session — the new service worker only finishes taking over
// AFTER that load already started. Incognito never has this problem because
// it has nothing cached yet, so it always goes straight to the network —
// which is exactly why "it works in incognito but not my normal tab" was
// happening even though the deploy itself was correct.
// This checks the genuinely live file on every load (bypassing any cache)
// and, if it's a different build than what's currently running, reloads
// ONCE automatically — silently self-correcting instead of leaving someone
// stuck on old, possibly-broken code until they notice the update icon.
(function healStaleAppShell() {
  // NOTE: this guard used to live in sessionStorage. On an iPhone, if this
  // site is used as a Home Screen (installed) app, iOS can and does kill the
  // whole page process to reclaim memory whenever it's backgrounded — the
  // next tap re-launches it as a genuinely fresh process with sessionStorage
  // wiped, so a sessionStorage-based "only reload once" guard doesn't
  // actually hold across that kind of relaunch. localStorage survives it,
  // which is why both guards below now use that instead.
  const RELOAD_GUARD_KEY = 'ctorq-auto-heal-reload-for-version';
  // HARD CAP, independent of which version was seen: a CDN (GitHub Pages
  // runs behind Fastly) can serve slightly different content from different
  // edge nodes for a few minutes right after a fresh deploy — especially
  // likely on a mobile connection (5G/LTE), which can hit a different edge
  // node on every single request. That means the per-VERSION guard above
  // can be defeated: fetch sees v-old, reloads; next load's fetch happens
  // to hit a different edge and sees a DIFFERENT stale version, which
  // doesn't match the guard's remembered value, so it reloads again — on
  // and on. That reload loop is exactly what makes Safari show "A problem
  // repeatedly occurred" and give up on the page entirely. This counter
  // makes sure that no matter what version is (mis)detected, this tab never
  // auto-reloads itself more than twice within a few minutes before just
  // giving up and showing whatever did load (the ordinary update-available
  // icon still offers a manual refresh after that). The counter resets
  // itself once RELOAD_COUNT_WINDOW_MS has passed since the last reload, so
  // it never permanently blocks a genuinely new update days later.
  const RELOAD_COUNT_KEY = 'ctorq-auto-heal-reload-count';
  const RELOAD_COUNT_TS_KEY = 'ctorq-auto-heal-reload-count-ts';
  const RELOAD_COUNT_WINDOW_MS = 3 * 60 * 1000;
  const MAX_AUTO_RELOADS = 2;
  function recentReloadCount() {
    const ts = parseInt(localStorage.getItem(RELOAD_COUNT_TS_KEY) || '0', 10);
    if (!ts || Date.now() - ts > RELOAD_COUNT_WINDOW_MS) return 0;
    return parseInt(localStorage.getItem(RELOAD_COUNT_KEY) || '0', 10);
  }
  function bumpReloadCount() {
    try {
      localStorage.setItem(RELOAD_COUNT_KEY, String(recentReloadCount() + 1));
      localStorage.setItem(RELOAD_COUNT_TS_KEY, String(Date.now()));
    } catch (e) { /* ignore */ }
  }
  // WHY THE WAIT BELOW: reloading the instant a version mismatch is found
  // (which can happen within the first fraction of a second of a cold load,
  // well before the auth code further down even starts) could interrupt
  // Supabase's own session/token-refresh request mid-flight. Supabase
  // rotates the refresh token on every use — if the server already issued a
  // new one but the reload cut the page off before the browser could save
  // it, the next load is left with an old, now-invalid refresh token and
  // gets silently signed out. This is what was causing "an update makes me
  // have to log in again." Waiting for the auth check to fully settle first
  // (flag set in the startup IIFE further down) means the reload only ever
  // happens once nothing is mid-flight to interrupt.
  function reloadWhenAuthSettled(liveVersion) {
    const deadline = Date.now() + 20000; // don't wait forever if something's stuck
    (function poll() {
      if (window.__ctorqAuthSettled || Date.now() > deadline) {
        try { localStorage.setItem(RELOAD_GUARD_KEY, liveVersion); } catch (e) { /* ignore */ }
        bumpReloadCount();
        location.reload();
        return;
      }
      setTimeout(poll, 250);
    })();
  }
  fetch('./app.js?_=' + Date.now(), { cache: 'no-store' })
    .then((res) => res.text())
    .then((text) => {
      const liveVersion = (text.match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
      if (!liveVersion || liveVersion === APP_VERSION) return;
      if (recentReloadCount() >= MAX_AUTO_RELOADS) return; // hit the hard cap — stop, don't loop
      // Only ever auto-reload once per mismatched version per tab — if it
      // somehow mismatches again right after reloading (e.g. genuinely
      // offline/flaky network serving a half-cached response), don't loop
      // forever; just let the person keep using whatever did load.
      if (localStorage.getItem(RELOAD_GUARD_KEY) === liveVersion) return;
      reloadWhenAuthSettled(liveVersion);
    })
    .catch(() => { /* offline or blocked — nothing to self-heal against, just continue */ });
})();

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

// TRUE OFFLINE OPEN: getSession()/getUser() above already read from local
// storage first, but they still go through Supabase's own internal lock and
// — for a token that looks expired — try to refresh it over the network
// before returning anything. On a device with genuinely zero connectivity
// (not just slow), that refresh attempt can hang for the entire timeout
// with nothing to fall back on, even though a perfectly usable session is
// sitting right there in storage. This reads that same stored session
// directly — no lock, no refresh attempt, no network at all — so a cold
// open with zero signal still has a way in, using whatever was saved from
// the last time this device successfully signed in.
function getStoredSessionUser() {
  try {
    const key = Object.keys(localStorage).find((k) => k.startsWith('sb-') && k.includes('-auth-token'));
    if (!key) return null;
    const raw = JSON.parse(localStorage.getItem(key));
    return raw?.user || raw?.currentSession?.user || null;
  } catch (e) { return null; }
}

let currentUser = null;
let currentProfile = null;
// Declared up here (not down near the rest of the presence/chat code where
// it's used) because startPresence() is called from enterApp() during
// sign-in, and on some slower/flakier connections that first sign-in event
// can fire before the script has finished running all the way down to
// where this used to be declared — a `let` can't be touched before its own
// declaration line runs, so that raced into "Cannot access 'presenceChannel'
// before initialization" and enterApp's catch-all treated it as a broken
// session, sending people back to the login screen even though nothing was
// actually wrong with their sign-in.
let presenceChannel = null;
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
  if (name === 'admin') { renderLocationList(); renderRecalledEntriesList(); }
  if (name === 'reports') initReportsTab();
  if (name === 'settings') refreshPushStatus();
  if (name === 'home') { renderJobBoard(); renderQuoteOfDay(); }
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
  const type = $('type').value;
  const isTimesheet = type === 'timesheet';
  $('timesheetBlock').style.display = isTimesheet ? 'block' : 'none';
  $('simpleBlock').style.display = isTimesheet ? 'none' : 'block';
  // Approximate progress only makes sense for Daily Progress; Project
  // Closed only makes sense for Project Report — each type gets its own
  // extra field(s) inside the shared simpleBlock.
  if ($('progressOnlyFields')) $('progressOnlyFields').style.display = type === 'progress' ? 'block' : 'none';
  if ($('reportOnlyFields')) $('reportOnlyFields').style.display = type === 'data' ? 'block' : 'none';
  if (isTimesheet) refreshModeVisibility();
}
$('type').addEventListener('change', refreshTypeVisibility);

// Reason box only shows up when the project is flagged as NOT closed — it's
// optional either way, this just avoids showing an empty "why not" box when
// the answer was Yes.
if ($('projectClosedSelect')) {
  $('projectClosedSelect').addEventListener('change', () => {
    if ($('projectClosedReasonWrap')) {
      $('projectClosedReasonWrap').style.display = $('projectClosedSelect').value === 'no' ? 'block' : 'none';
    }
  });
}

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
//
// CROSS-DEVICE SYNC: localStorage alone only survives on the SAME device —
// clocking in on a laptop and then opening the phone showed "not clocked
// in" on the phone, because nothing backed this up anywhere shared. Every
// saveClockState() call below now also pushes to a `clock_sessions` table
// (one row per person) via pushClockStateToCloud(), and on sign-in
// fetchAndMergeClockState() pulls that row down and — comparing
// timestamps — applies whichever copy (this device's or the cloud's) is
// actually newer. A realtime subscription (startClockSessionWatch()) then
// keeps every other signed-in device for this same person live-updated the
// moment something changes, the same pattern already used for org-wide
// Appearance settings.
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
  // Stamped on every save so two copies of this state (this device's vs.
  // the cloud's) can be compared to see which one actually happened more
  // recently — see fetchAndMergeClockState()/the realtime handler below.
  state.updatedAt = new Date().toISOString();
  try { localStorage.setItem(CLOCK_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  pushClockStateToCloud(state);
}
function resetClockState() {
  saveClockState({ status: 'idle', clockInAt: null, clockOutAt: null, breaks: [], totalBreakMinutes: 0, segmentStart: null, interruptionMinutes: 0, qsrSegmentStart: null, qsrSegmentPausedAt: null, qsrJobId: null, qsrJobName: null });
  renderClockUI();
  renderQuickSwitchRing();
}

// ---- Cloud sync (clock_sessions table) --------------------------------
let clockSyncDirty = false;   // true if the last push attempt failed (offline etc.) — retried when connectivity returns
let clockSyncPushTimer = null;
let clockSessionChannel = null;

// Applies a remote state WITHOUT re-pushing it back up (that would just
// bounce the same update back and forth between devices) — used both by
// the initial fetch/merge and by the realtime handler.
function applyRemoteClockState(state) {
  try { localStorage.setItem(CLOCK_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  renderClockUI();
  renderQuickSwitchRing();
  rehydrateEntryFormFromClockState();
  refreshModeVisibility();
}

function pushClockStateToCloud(state) {
  if (!currentUser) return; // not signed in yet (e.g. very first load) — initClockSync() will push once signed in
  clearTimeout(clockSyncPushTimer);
  // Small debounce so a rapid burst of changes (e.g. break start immediately
  // followed by other UI updates) collapses into one network call instead
  // of firing on every single one.
  clockSyncPushTimer = setTimeout(async () => {
    try {
      const { error } = await sb.from('clock_sessions')
        .upsert({ user_id: currentUser.id, state, updated_at: state.updatedAt || new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
      clockSyncDirty = false;
    } catch (err) {
      // Most likely offline — don't lose the change, just remember to
      // retry once we're back online (see the 'online' listener below).
      clockSyncDirty = true;
      console.warn('pushClockStateToCloud failed (will retry when online):', err);
    }
  }, 300);
}

// Called once at sign-in, before the rest of the app reads clock state —
// fetches this person's clock_sessions row and, if it's newer than
// whatever's saved locally on THIS device, applies it. If the local copy
// is newer instead (e.g. clocked in here while offline, not yet synced),
// pushes it up so the cloud catches up.
async function fetchAndMergeClockState() {
  if (!currentUser) return;
  try {
    const { data, error } = await sb.from('clock_sessions').select('*').eq('user_id', currentUser.id).maybeSingle();
    if (error) throw error;
    const local = getClockState();
    if (data && data.state) {
      const remoteTime = data.updated_at ? new Date(data.updated_at).getTime() : 0;
      const localTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
      if (remoteTime > localTime) {
        applyRemoteClockState(data.state);
        return;
      }
    }
    // Local is newer (or no cloud row exists yet) — make sure the cloud
    // has this device's current state.
    if (local && local.status && local.status !== 'idle') pushClockStateToCloud(local);
  } catch (err) {
    console.warn('fetchAndMergeClockState failed (staying with local/last-known state):', err);
  }
}

function startClockSessionWatch() {
  if (clockSessionChannel || !currentUser) return;
  clockSessionChannel = sb
    .channel(`clock-session-watch-${currentUser.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'clock_sessions', filter: `user_id=eq.${currentUser.id}` }, (payload) => {
      const remote = payload.new?.state;
      if (!remote) return;
      const local = getClockState();
      const remoteTime = payload.new.updated_at ? new Date(payload.new.updated_at).getTime() : 0;
      const localTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
      // Guards against applying our own echoed-back push, and against a
      // slightly-delayed push from this same device arriving out of order.
      if (remoteTime > localTime) applyRemoteClockState(remote);
    })
    .subscribe();
}
function stopClockSessionWatch() {
  if (clockSessionChannel) { sb.removeChannel(clockSessionChannel); clockSessionChannel = null; }
}
function initClockSync() {
  return fetchAndMergeClockState().then(startClockSessionWatch);
}
// If a push failed earlier (offline), try again as soon as the browser
// says we're back online — otherwise a change made with no signal could
// sit un-synced until the next unrelated clock action.
window.addEventListener('online', () => {
  if (clockSyncDirty) pushClockStateToCloud(getClockState());
});
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
    // This came from the clock-in itself, not a fresh free-typed guess — it
    // was already a real, picked Job ID back when clock-in happened, so
    // there's nothing to re-confirm here. Without this, reopening the app
    // (or just Submit re-checking the form) demanded picking the exact same
    // Job ID from the dropdown all over again before it would let the entry
    // through.
    jobIdConfirmed = true;
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
    const mapLink = $('locationMapLink');
    if (mapLink && state.clockInLat) {
      mapLink.href = liveMapUrl(state.clockInLat, state.clockInLng);
      mapLink.style.display = 'inline-block';
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
    ? jobSearchOptions.filter((r) => jobMatchesQuery(r, query))
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
    description: combineDescription(qsrNotesSelected, $('qsrNotes')?.value || ''),
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
// A real, zoomable/pannable map — the static preview image is only ever a
// small flat snapshot, so this is what actually lets someone double-check
// "is this really where they were" (opens in a new tab, no API key needed).
function liveMapUrl(lat, lng) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
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
          const mapLink = $('locationMapLink');
          if (mapLink) {
            mapLink.href = liveMapUrl(latitude, longitude);
            mapLink.style.display = 'inline-block';
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

// One real interactive Leaflet map with every driver pinned on it at
// once — refreshed each time this panel opens or Refresh is tapped. Not a
// moving live feed (see the honesty note above: a closed app can't be
// tracked), but it's a real pan/zoomable map instead of a single static
// image from one small free image-rendering service, which could fail to
// load with no visible reason. Kept as one map instance, re-used across
// refreshes (removed and recreated only if it doesn't exist yet) so
// re-opening the panel doesn't leak map instances.
let liveDriversMapInstance = null;

async function renderLiveDrivers() {
  const wrap = $('liveDriversList');
  const mapWrap = $('liveDriversMapArea');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await sb
    .from('driver_locations')
    .select('person_id, lat, lng, address, updated_at, profiles(full_name, email)')
    .order('updated_at', { ascending: false });
  if (error) {
    wrap.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`;
    if (mapWrap) mapWrap.style.display = 'none';
    return;
  }
  if (!data || !data.length) {
    wrap.innerHTML = '<div class="empty">No driver locations yet — a driver needs to open the app at least once with location access allowed. (Make sure at least one person has the "Driver" role set in Admin → Team.)</div>';
    if (mapWrap) mapWrap.style.display = 'none';
    return;
  }
  if (mapWrap && typeof L !== 'undefined') {
    mapWrap.style.display = 'block';
    if (!liveDriversMapInstance) {
      liveDriversMapInstance = L.map(mapWrap);
      // Esri's World Street Map (no API key/signup needed) instead of the
      // plain OSM tiles — OSM's default style renders place labels in each
      // area's local language (Arabic here, since these are UAE
      // locations), while Esri's basemap renders labels in Latin/English
      // script worldwide, which is what's actually wanted here.
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles © Esri',
      }).addTo(liveDriversMapInstance);
      liveDriversMapInstance._markerLayer = L.layerGroup().addTo(liveDriversMapInstance);
    }
    liveDriversMapInstance._markerLayer.clearLayers();
    const points = data.filter((d) => d.lat && d.lng);
    points.forEach((d) => {
      const name = d.profiles?.full_name || d.profiles?.email || 'Driver';
      const marker = L.marker([d.lat, d.lng]).addTo(liveDriversMapInstance._markerLayer);
      // Always-visible name label above the pin, so you can tell whose pin
      // is whose at a glance. Tap the pin itself to open a popup with the
      // full details (address + last updated).
      marker.bindTooltip(
        `<div class="live-driver-tag"><b>${escapeHtml(name)}</b></div>`,
        { permanent: true, direction: 'top', offset: [0, -30], className: 'live-driver-tooltip' }
      );
      marker.bindPopup(
        `<div class="live-driver-tag"><b>${escapeHtml(name)}</b><br>${escapeHtml(d.address || '')}<br><span style="opacity:.7">${escapeHtml(minutesAgoLabel(d.updated_at))}</span></div>`
      );
    });
    if (points.length) {
      const bounds = L.latLngBounds(points.map((d) => [d.lat, d.lng]));
      // A moment for the now-visible container to get its real size before
      // Leaflet measures it — invalidateSize() first, then fit.
      setTimeout(() => {
        liveDriversMapInstance.invalidateSize();
        liveDriversMapInstance.fitBounds(bounds.pad(0.2), { maxZoom: 15 });
      }, 50);
    }
  } else if (mapWrap) {
    mapWrap.style.display = 'none';
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
      ${lat ? `<a class="clock-loc-map-link" href="${liveMapUrl(lat, lng)}" target="_blank" rel="noopener">🗺️ Open in Maps</a>` : ''}
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

    // DATA QUALITY FIX: a typed-but-unmatched Job ID used to be saved as-is —
    // that's how a single letter-O/digit-0 typo turned one real project into
    // two in reports. If anything is typed here, it must resolve to a real
    // job (picked from the list, or typed exactly) before this can be saved.
    if ($('jobId').value.trim() && !jobIdConfirmed) {
      showToast('Pick the Job ID from the list below the field — free-typed Job IDs cause duplicate/mismatched projects.');
      return null;
    }

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

    // DATA QUALITY FIX: nothing used to stop an entry saving with a blank
    // clock-in or clock-out time (it just showed as "?" everywhere, and
    // silently broke every hour total that read it). Both are required now.
    const startTimeVal = $('startTime').value;
    if (!startTimeVal || !endTimeVal) {
      showToast('Clock in and clock out (or use Start/Stop) before submitting — both times are required.');
      return null;
    }

    // DATA QUALITY FIX: an end time earlier than the start time used to be
    // silently treated as "ran past midnight" by every hour calculation,
    // with nobody ever told — including a genuine typo that produced a
    // ~14-hour phantom overnight shift. Now it has to be confirmed.
    let isOvernightShift = false;
    const startMins = timeToMinutesLocal(startTimeVal);
    const endMins = timeToMinutesLocal(endTimeVal);
    if (startMins !== null && endMins !== null && endMins < startMins) {
      const confirmed = confirm(
        `Your clock-out time (${timeLabel12h(endTimeVal)}) is earlier than your clock-in time (${timeLabel12h(startTimeVal)}). ` +
        `Was this a genuine overnight shift that ran past midnight?\n\nTap OK if yes — it will be recorded as an overnight shift. ` +
        `Tap Cancel to go back and fix the time instead.`
      );
      if (!confirmed) {
        showToast('Please fix the clock-out time before submitting.');
        return null;
      }
      isOvernightShift = true;
    }

    // Quick note is optional again — it was made mandatory in an earlier
    // round, but that turned out to be more friction than it was worth.

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
      startTime: startTimeVal,
      endTime: endTimeVal,
      overnight: isOvernightShift,
      lunchMinutes: lunchMinutesRaw + qsrDeductedMinutes,
      lunchMinutesRaw,
      qsrDeductedMinutes,
      breakStart,
      breakEnd,
      description: combineDescription(workNotesSelected, $('workNotes').value),
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
  if ($('jobIdSimple') && $('jobIdSimple').value.trim() && !jobIdSimpleConfirmed) {
    showToast('Pick the Job ID from the list below the field — free-typed Job IDs cause duplicate/mismatched projects.');
    return null;
  }
  const descriptionSimpleCombined = combineDescription(descriptionSimpleSelected, $('descriptionSimple').value);
  if (!$('projectSimple').value.trim() || !$('dateSimple').value || !descriptionSimpleCombined) {
    showToast('Fill in project, date and description.');
    return null;
  }
  // Approximate percentage (Daily Progress only) — optional, left blank/null
  // if not entered. Clamp to 0-100 so a typo like "650" can't sneak through.
  let percentage = null;
  if (type === 'progress' && $('progressPercent') && $('progressPercent').value !== '') {
    const raw = Number($('progressPercent').value);
    if (!isNaN(raw)) percentage = Math.max(0, Math.min(100, raw));
  }

  // Project Closed Yes/No (Project Report only) — projectClosed is a real
  // boolean once answered, or null if left unanswered (older/legacy-style
  // submissions). The reason box is optional and only meaningful when the
  // answer is "No".
  let projectClosed = null;
  let projectClosedReason = '';
  if (type === 'data' && $('projectClosedSelect')) {
    const v = $('projectClosedSelect').value;
    if (v === 'yes') projectClosed = true;
    else if (v === 'no') projectClosed = false;
    if (projectClosed === false && $('projectClosedReason')) {
      projectClosedReason = $('projectClosedReason').value.trim();
    }
  }

  return {
    ...base,
    category: type === 'progress' ? 'daily-progress' : 'project-report',
    jobId: $('jobIdSimple') && $('jobIdSimple').value.trim() ? $('jobIdSimple').value.trim() : null,
    project: $('projectSimple').value.trim(),
    date: $('dateSimple').value,
    time: $('timeSimple') && $('timeSimple').value ? $('timeSimple').value : null,
    description: descriptionSimpleCombined,
    percentage,
    projectClosed,
    projectClosedReason,
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
    if (draft.type === 'progress' && draft.percentage !== null && draft.percentage !== undefined) {
      rows.push(rowHtml('Progress', `${draft.percentage}%`));
    }
    if (draft.type === 'data' && draft.projectClosed !== null && draft.projectClosed !== undefined) {
      rows.push(rowHtml('Project closed?', draft.projectClosed ? 'Yes' : 'No'));
      if (draft.projectClosed === false && draft.projectClosedReason) {
        rows.push(rowHtml('Reason', draft.projectClosedReason));
      }
    }
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

// DATA QUALITY FIX: nothing used to stop the exact same job/date/time-window
// entry being submitted more than once (e.g. tapping Submit again before
// the last one finished, or resuming a job that was actually already
// logged) — checked against this device's own entry history, since that's
// where a repeat submit would show up without needing a server round trip.
async function findLikelyDuplicateEntry(draft) {
  if (draft.category !== 'timesheet' || !draft.jobId) return null;
  const existing = await getAllEntries();
  return existing.find((e) =>
    e.id !== draft.id &&
    e.category === 'timesheet' &&
    e.jobId === draft.jobId &&
    e.date === draft.date &&
    e.startTime === draft.startTime &&
    e.endTime === draft.endTime &&
    e.status !== 'recalled'
  ) || null;
}

$('reviewConfirmBtn').addEventListener('click', async () => {
  if (!pendingEntryDraft) return;
  const dupe = await findLikelyDuplicateEntry(pendingEntryDraft);
  if (dupe) {
    const proceed = confirm(
      `You already have an entry logged for ${pendingEntryDraft.jobId} on ${pendingEntryDraft.date} with the same clock-in and clock-out time ` +
      `(${timeLabel12h(pendingEntryDraft.startTime)}–${timeLabel12h(pendingEntryDraft.endTime)}). Submit this one anyway?`
    );
    if (!proceed) {
      // This used to return here with zero feedback — nothing on screen
      // changed, no toast, nothing — which looked exactly like the app had
      // silently frozen instead of having correctly done what was asked
      // (not submit a likely-duplicate entry).
      showToast('Not submitted — this looked like a duplicate of an entry you already have.');
      return;
    }
  }
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

// Show/hide password — an open-eye icon toggles the field to plain text so
// people can check what they actually typed, a closed-eye (slashed) icon
// switches it back to masked dots. Delegated to any element with class
// .pw-toggle, targeting the input named in its data-pw-target, so this
// covers Login, New password, and Confirm password with one handler.
const PW_EYE_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const PW_EYE_CLOSED = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
document.querySelectorAll('.pw-toggle').forEach((btn) => {
  btn.innerHTML = PW_EYE_CLOSED;
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.pwTarget);
    if (!input) return;
    const nowVisible = input.type === 'password';
    input.type = nowVisible ? 'text' : 'password';
    btn.innerHTML = nowVisible ? PW_EYE_OPEN : PW_EYE_CLOSED;
    btn.classList.toggle('is-visible', nowVisible);
    btn.setAttribute('aria-label', nowVisible ? 'Hide password' : 'Show password');
  });
});

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
  if ($('weatherBadge')) $('weatherBadge').style.display = 'none';
  weatherData = null;
  projectsHoursCache = {};
  projectsStageCache = {};
  if ($('adminMoreRow')) $('adminMoreRow').style.display = 'none';
  closeAiChat();
  closeChatOverlay();
  closePanel('projects');
  closePanel('projectDetail');
  closePanel('learning');
  closePanel('health');
  closePanel('weather');
  stopPresence();
  if (appAppearanceChannel) { sb.removeChannel(appAppearanceChannel); appAppearanceChannel = null; }
  stopClockSessionWatch();
  stopLastSeenHeartbeat();
  stopGlobalMessageWatch();
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
  if (!user && result.__timedOut) {
    // Both tries timed out without the server ever confirming or denying
    // anything — most likely genuinely offline (or a signal too weak to
    // complete the round-trip at all) rather than actually signed out.
    // Fall back to reading the stored session directly, bypassing the
    // SDK's own network-dependent check entirely, so a cold open with zero
    // connectivity still gets in using whatever this device last signed in
    // as — loadProfile() below has its own cached-profile fallback too, so
    // the whole app shell can come up fully offline this way.
    user = getStoredSessionUser();
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
    $('authMsg').textContent = result.__timedOut
      ? "Couldn't reach the server and no saved sign-in was found on this device — check your connection and try again."
      : 'Your session expired — please log in again.';
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
  // Renewal Manager: visible to admins, and also to anyone the admin has
  // explicitly delegated the 'renewal' Map Access feature to — matching
  // RLS on visa_renewals/employee_details, which now grants that same
  // group full read/write on the underlying data (see
  // supabase/renewal_delegation_and_audit_migration.sql). A delegated
  // person gets the exact same full board an admin sees; every edit/renew/
  // delete they make is written to visa_renewals_audit_log so an admin can
  // see who changed what.
  if ($('renewalManagerHomeTile')) $('renewalManagerHomeTile').style.display = hasFeature('renewal') ? 'flex' : 'none';
  $('newGroupBtn').style.display = 'inline-block';
  if ($('newsComposeCard')) $('newsComposeCard').style.display = 'block';
  checkForUnreadNews();
  applyFeatureAccess();
  startPresence();
  initGlobalAppearance();
  startLastSeenHeartbeat();
  startGlobalMessageWatch();
  loadWeather();
  populateAllowanceDropdown();
  // Rehydrate BEFORE checking today's allocation, so an already-in-progress
  // clock-in (possibly on a different job than today's fresh allocation)
  // wins — renderMyTodayAssignment only fills Job ID if it's still empty.
  // Waits on initClockSync() too, so if this person clocked in on a
  // different device, THAT state (not just whatever's stale on this
  // device) is what gets rehydrated into the form.
  Promise.all([populateJobIdDropdown(), initClockSync()])
    .then(() => { rehydrateEntryFormFromClockState(); return renderMyTodayAssignment(); })
    .then(renderJobBoard)
    .then(renderAdminScheduleBoard);
  renderMyTripsToday();
  initOwnTripLogging();
  refreshGeneralDescriptionChips();
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
    // A published allocation is a real Job ID an admin already assigned —
    // not a free-typed guess — so it doesn't need re-confirming from the
    // dropdown before Submit will accept it.
    jobIdConfirmed = true;
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

// Client-side counterpart to the "HH:MM" -> minutes-since-midnight helper
// every Edge Function already has server-side — used at submit time to
// detect an end-time-earlier-than-start-time entry so it can be confirmed
// as a genuine overnight shift instead of silently accepted as one.
function timeToMinutesLocal(hhmm) {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
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
    .select('project, location, attendance_time, assignment_type, is_driver, notes, person_id, profiles!daily_assignments_person_id_fkey(full_name, email)')
    .eq('work_date', todayKey);
  if (error || !data || !data.length) { card.style.display = 'none'; return; }

  // Group every row by job id — each published job becomes one message box,
  // listing its driver(s) and everyone else ticked onto it. A worker can
  // also be the driver (is_driver=true on their 'job' row), so we collect
  // driver names separately from the plain-worker list rather than treating
  // the two as mutually exclusive.
  const byJob = new Map();
  data.forEach((r) => {
    if (!byJob.has(r.project)) byJob.set(r.project, { location: '', attendanceTime: '', notes: '', drivers: [], workers: [] });
    const g = byJob.get(r.project);
    if (r.location && !g.location) g.location = r.location;
    if (r.attendance_time && !g.attendanceTime) g.attendanceTime = r.attendance_time;
    if (r.notes && !g.notes) g.notes = r.notes;
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
      ${g.notes ? `<div class="job-board-line">📝 ${escapeHtml(g.notes)}</div>` : ''}
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

// Matches on ANY word related to the job — not just the Job ID/name — so
// typing a customer name, vessel name, who's responsible, or a delivery
// note also finds the right job. All fields are optional/best-effort.
//
// Also typo-tolerant: if nothing matches as a plain substring, falls back to
// a fuzzy word-level check (small misspellings, letters swapped, words run
// together) so e.g. typing "Alseer" still finds a job for "Al Seer Marine".
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
function fuzzyAllowance(len) {
  if (len <= 4) return 1;
  if (len <= 7) return 2;
  return 3;
}
// True if every "word" in the typed query is found — exactly, as a
// substring, or as a close misspelling — somewhere in the haystack text.
function fuzzyTextMatch(haystack, query) {
  const hay = String(haystack || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!hay) return false;
  const hayTokens = hay.split(' ').filter(Boolean);
  const qTokens = String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!qTokens.length) return false;
  return qTokens.every((qt) => {
    if (qt.length < 3) return hay.includes(qt); // very short tokens: exact substring only, fuzzy is too noisy
    if (hay.includes(qt)) return true;
    const allowed = fuzzyAllowance(qt.length);
    return hayTokens.some((ht) => Math.abs(ht.length - qt.length) <= allowed && levenshtein(ht, qt) <= allowed);
  });
}
function jobMatchesQuery(r, query) {
  if (String(r.job_id || '').toLowerCase().includes(query)
    || String(r.name || '').toLowerCase().includes(query)
    || String(r.client || '').toLowerCase().includes(query)
    || String(r.responsibility || '').toLowerCase().includes(query)
    || String(r.delivery_status || '').toLowerCase().includes(query)) return true;
  const haystack = [r.job_id, r.name, r.client, r.responsibility, r.delivery_status].filter(Boolean).join(' ');
  return fuzzyTextMatch(haystack, query);
}

// RELIABILITY: this used to just come back empty on any network failure —
// which, combined with Job ID now being locked to picking a real project
// (see jobIdConfirmed below), meant opening the app offline left the Job ID
// search with nothing in it and no way to log a job-tied entry at all until
// back online. Same fix as the profile cache: keep the last successful list
// in localStorage and fall back to it whenever the live fetch fails.
const JOB_OPTIONS_CACHE_KEY = 'ctorq-job-options';
function cacheJobOptions(rows) {
  try { localStorage.setItem(JOB_OPTIONS_CACHE_KEY, JSON.stringify(rows)); } catch (e) { /* ignore */ }
}
function getCachedJobOptions() {
  try {
    const raw = localStorage.getItem(JOB_OPTIONS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

async function populateJobIdDropdown() {
  const { data, error } = await sb.from('projects').select('job_id, name, client, responsibility, delivery_status').eq('status', 'active').order('job_id');
  if (error) {
    jobSearchOptions = getCachedJobOptions();
    console.warn('[Jobs] using cached job list (network unavailable):', error);
  } else {
    jobSearchOptions = data || [];
    cacheJobOptions(jobSearchOptions);
  }
}

// DATA QUALITY FIX: free-typed Job IDs used to be accepted as-is, which is
// how look-alike typos (letter-O vs digit-0, e.g. "TVD/OS/26/0037" vs
// "TVD/0S/26/0037") turned one real project into two in reports. Now a
// non-empty Job ID field must resolve to a REAL project before submit is
// allowed — either by tapping a suggestion, or by typing the exact ID of a
// job that already exists. `jobIdConfirmed`/`jobIdSimpleConfirmed` track
// that; buildDraftFromForm() checks them before saving.
let jobIdConfirmed = false;
let jobIdSimpleConfirmed = false;

function jobIdExactMatch(value) {
  const q = String(value || '').trim().toLowerCase();
  if (!q) return null;
  return jobSearchOptions.find((r) => String(r.job_id).toLowerCase() === q) || null;
}

function renderJobSearchResults(matches) {
  const box = $('jobIdResults');
  if (!box) return;
  if (!matches.length) {
    box.innerHTML = '<div class="job-search-empty">No matching job found — pick one from the list, or clear this field to leave it blank.</div>';
  } else {
    box.innerHTML = matches.slice(0, 50).map((r) => `
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
      jobIdConfirmed = true;
      autoFillProjectFromJobId(item.dataset.jobId);
      box.style.display = 'none';
    });
  });
}

if ($('jobId')) {
  $('jobId').addEventListener('input', () => {
    jobIdConfirmed = false; // any manual edit un-confirms it until it resolves to a real job again
    const q = $('jobId').value.trim().toLowerCase();
    if (!q) { $('jobIdResults').style.display = 'none'; return; }
    const matches = jobSearchOptions.filter((r) => jobMatchesQuery(r, q));
    renderJobSearchResults(matches);
  });
  $('jobId').addEventListener('focus', () => {
    if ($('jobId').value.trim()) $('jobId').dispatchEvent(new Event('input'));
  });
  $('jobId').addEventListener('blur', () => {
    // Small delay so a click/mousedown on a result registers first.
    setTimeout(() => { if ($('jobIdResults')) $('jobIdResults').style.display = 'none'; }, 150);
    // Typing the exact ID of a real job (not just tapping a suggestion) is
    // also accepted — it's unambiguous, so there's no typo risk.
    const match = jobIdExactMatch($('jobId').value);
    if (match) { jobIdConfirmed = true; $('jobId').value = match.job_id; }
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
    box.innerHTML = '<div class="job-search-empty">No matching job found — pick one from the list, or clear this field to leave it blank.</div>';
  } else {
    box.innerHTML = matches.slice(0, 50).map((r) => `
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
      jobIdSimpleConfirmed = true;
      const jobMatch = jobSearchOptions.find((r) => r.job_id === item.dataset.jobId);
      if ($('projectSimple') && !$('projectSimple').value.trim()) $('projectSimple').value = jobMatch?.name || item.dataset.jobId;
      box.style.display = 'none';
    });
  });
}
if ($('jobIdSimple')) {
  $('jobIdSimple').addEventListener('input', () => {
    jobIdSimpleConfirmed = false;
    const q = $('jobIdSimple').value.trim().toLowerCase();
    if (!q) { $('jobIdSimpleResults').style.display = 'none'; return; }
    const matches = jobSearchOptions.filter((r) => jobMatchesQuery(r, q));
    renderJobSearchResultsSimple(matches);
  });
  $('jobIdSimple').addEventListener('focus', () => {
    if ($('jobIdSimple').value.trim()) $('jobIdSimple').dispatchEvent(new Event('input'));
  });
  $('jobIdSimple').addEventListener('blur', () => {
    setTimeout(() => { if ($('jobIdSimpleResults')) $('jobIdSimpleResults').style.display = 'none'; }, 150);
    const match = jobIdExactMatch($('jobIdSimple').value);
    if (match) { jobIdSimpleConfirmed = true; $('jobIdSimple').value = match.job_id; }
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

// If we just landed here from a failed invite/reset link (expired,
// already used, or superseded by a later resend), Supabase redirects back
// with an #error=... hash instead of a real session. Left unhandled, this
// silently falls back to a plain login form with no explanation — surface
// it clearly instead.
if (location.hash && location.hash.includes('error=')) {
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const errorCode = hashParams.get('error_code');
  const errorDescription = hashParams.get('error_description');
  let authHashMsg = 'That link is no longer valid — ask your admin to send you a new invite.';
  if (errorCode === 'otp_expired') {
    authHashMsg = 'This invite link has expired. Ask your admin to send you a new one.';
  } else if (errorDescription) {
    authHashMsg = decodeURIComponent(errorDescription.replace(/\+/g, ' '));
  }
  showAuthView('loginView');
  $('authMsg').textContent = authHashMsg;
  // Strip the hash so refreshing the page doesn't show this message again.
  history.replaceState(null, '', location.pathname + location.search);
}

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
    // Still nothing after the retry — most likely genuinely offline rather
    // than actually signed out. Read the stored session directly instead
    // of giving up: no lock, no network attempt, just whatever this device
    // last signed in as, so a cold open with zero connectivity still gets
    // in (loadProfile() below falls back to its own cached copy too).
    const offlineUser = getStoredSessionUser();
    if (offlineUser) {
      const profile = await loadProfile(offlineUser);
      currentUser = offlineUser;
      currentProfile = profile;
      if (profile && profile.status === 'invited') {
        $('setPasswordIntro').textContent = 'Welcome! Set a password to finish joining.';
        showAuthView('setPasswordView');
        $('authScreen').style.display = 'flex';
      } else {
        await enterApp(offlineUser);
      }
      return;
    }
    // No stored session to fall back to either — nothing left to do but
    // show the login screen. Do NOT clear the stored session here — we
    // don't actually know it's invalid, just that checking it is taking
    // unusually long. Wiping it now would force a real login even though
    // the session might be perfectly fine a few seconds later.
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
 } finally {
  // Tells healStaleAppShell (top of this file) it's now safe to reload —
  // see the comment there for why reloading before this point was quietly
  // logging people out.
  window.__ctorqAuthSettled = true;
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
// ADMIN — invite teammates by email (bulk row builder, see further below
// for the row rendering / per-row Access modal / Invite All logic — those
// need FEATURE_LIST and fetchRoles(), defined just after this block).
// =====================================================================

// Cost categories for Profit Analyzer's "Invest amount" breakdown — man
// hours is filled in automatically from the labor ledger; the rest are
// picked when an admin logs an extra cost (project_extra_costs.category).
const COST_CATEGORY_LABEL = {
  man_hours: '👷 Man hours', procurement: '📦 Procurement', transportation_logistics: '🚚 Transportation & logistics',
  rent: '🏠 Rent', interest: '🏦 Interest', other: '➕ Other',
};

const POSITION_LABEL = {
  engineer: 'Engineer', supervisor: 'Supervisor', foreman: 'Lead Foreman', technician: 'Technician', helper: 'Helper', other: 'Other',
  manager: 'Manager', lead: 'Lead', sales: 'Sales', estimation: 'Estimation', marketing: 'Marketing', engineering: 'Engineering', design: 'Design', driver: 'Driver',
};

// Departments that break allocated hours down by role (matches your JOB
// DATA sheet's Engineers/Supervisor/Foremen/Technicians columns) — keyed
// by department name, lowercased. A department NOT in this map (e.g.
// Marketing, Sales, Administrative) keeps the old single-ring behavior:
// one "general" hour budget, no role split.
const DEPARTMENT_ROLE_MAP = {
  'software': ['engineer'],
  'design': ['engineer'],
  'electrical': ['engineer', 'supervisor', 'foreman', 'technician', 'helper'],
  'commissioning and service': ['engineer', 'technician', 'helper'],
  'workshop': ['engineer', 'supervisor', 'technician', 'helper'],
};
function rolesForDepartmentName(name) {
  return DEPARTMENT_ROLE_MAP[(name || '').trim().toLowerCase()] || null;
}

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
  { key: 'datafeed', label: 'Data Feed (add/remove people & jobs, manage job types)' },
  { key: 'liveDrivers', label: 'Live Drivers (see driver locations)' },
  { key: 'appearance', label: 'Appearance (theme, background, daily quote)' },
  { key: 'renewal', label: 'My Document Renewal Status (AEON Ai can tell them their own passport, visa, work permit and other document expiry — never anyone else\'s)' },
  { key: 'allData', label: 'Full Data Access (AEON Ai can see everyone\'s data + money/quotations for this person)' },
  { key: 'profit', label: 'Profit Analyzer (project cost/profit breakdown, hourly rates, payments)' },
  { key: 'leaveRequest', label: 'Leave / Vacation requests (inside Special Request)' },
  { key: 'documentRequest', label: 'Request Document (inside Special Request)' },
  { key: 'fieldActivities', label: 'Field Activities (mission start/stop + client visit logging — for marketing/field people)' },
  { key: 'companyFinder', label: 'Company Finder (search real companies by industry/location, add as Client) — private, off by default' },
];

// Hides every dashboard element tagged data-feature="X" (nav tabs, home
// tiles) plus the two floating orbs (chat, ai) unless X is in this person's
// allowed_features — a system admin (profiles.role === 'admin') always sees
// everything, regardless of what's ticked in Map Access.
// Global, reusable version of the same admin-or-delegated check used by
// applyFeatureAccess() below — hoisted out so other code (Renewal Manager
// tile gate, admin-only History button, etc.) can call it directly instead
// of duplicating the isAdmin/allowed_features logic inline.
function hasFeature(key) {
  const isAdmin = currentProfile?.role === 'admin';
  const allowed = Array.isArray(currentProfile?.allowed_features) ? currentProfile.allowed_features : [];
  return isAdmin || allowed.includes(key);
}

function applyFeatureAccess() {
  const has = hasFeature;

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
  if (n === 'supervisor') return 'supervisor';
  if (n.includes('foreman')) return 'foreman'; // matches "Foreman" or "Lead Foreman" — checked before the plain 'lead' match below
  if (n === 'technician') return 'technician';
  if (n === 'helper') return 'helper';
  if (n === 'manager') return 'manager';
  if (n === 'lead') return 'lead';
  if (n === 'sales') return 'sales';
  if (n.includes('estimat')) return 'estimation'; // matches "Estimation" or "Estimator"
  if (n === 'marketing') return 'marketing';
  if (n.includes('engineering')) return 'engineering'; // distinct from the plain 'engineer' role above
  if (n === 'design') return 'design';
  if (n === 'driver') return 'driver';
  return 'other';
}

async function fetchRoles() {
  const { data, error } = await sb.from('roles').select('id, name').order('name');
  return error ? [] : (data || []);
}

async function buildRoleSelectHtml(selectedId = '') {
  const roles = await fetchRoles();
  return '<option value="">No role yet</option>' +
    roles.map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
}

$('addRoleBtn')?.addEventListener('click', async () => {
  const name = $('newRoleName').value.trim();
  if (!name) return;
  const { error } = await sb.from('roles').insert({ name });
  if (error) { showToast(`Couldn't add role: ${error.message}`); return; }
  $('newRoleName').value = '';
  showToast('Role added.');
  renderTeamList();
});

// ---------------------------------------------------------------------
// BULK INVITE ROW BUILDER — add several people at once before sending
// anything. Each row has its own email, role, Map Access (via a small
// popup reusing the same FEATURE_LIST checklist as Map Access), a delete
// button, and its own Invite button; Invite All at the bottom sends
// everyone still on the list in one go.
// ---------------------------------------------------------------------

let pendingInviteRows = []; // { id, allowedFeatures: [], customized: bool }
let inviteRowSeq = 0;

// Rows you've started typing (email, role, access) but not sent yet used to
// live only in page memory — closing the app, losing signal, or the tab
// just reloading wiped them out with no warning. They're now mirrored to
// localStorage on every change and restored the next time this device
// opens the Employee & Invitation Manager, same as everything else in this
// app that's meant to survive being offline.
const PENDING_INVITES_KEY = 'ctorq-pending-invites';
let pendingInvitesRestored = false;

function savePendingInvitesToStorage() {
  try {
    const rows = pendingInviteRows.map((r) => {
      const div = document.querySelector(`[data-invite-row="${r.id}"]`);
      return {
        id: r.id,
        fullName: div ? div.querySelector('.invite-row-name').value : (r.fullName || ''),
        email: div ? div.querySelector('.invite-row-email').value : (r.email || ''),
        roleId: div ? div.querySelector('.invite-row-role').value : (r.roleId || ''),
        allowedFeatures: r.allowedFeatures || [],
        customized: !!r.customized,
      };
    });
    localStorage.setItem(PENDING_INVITES_KEY, JSON.stringify(rows));
  } catch (e) { /* worst case, pending rows just don't survive a reload */ }
}

function loadPendingInvitesFromStorage() {
  try {
    const raw = localStorage.getItem(PENDING_INVITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

async function restorePendingInvitesIfNeeded() {
  if (pendingInvitesRestored) return;
  pendingInvitesRestored = true;
  const saved = loadPendingInvitesFromStorage();
  for (const row of saved) await addInviteRow(row);
}

function updateInviteRowsEmptyState() {
  const empty = $('pendingInviteRowsEmpty');
  if (empty) empty.style.display = pendingInviteRows.length ? 'none' : '';
}

async function addInviteRow(saved = null) {
  let rowId = saved?.id;
  if (!rowId) {
    rowId = `row_${++inviteRowSeq}`;
  } else {
    // Restoring a saved row that already has a numbered id — make sure the
    // next brand-new row picks a number after this one, so two rows can
    // never end up sharing an id.
    const num = parseInt(String(rowId).replace('row_', ''), 10);
    if (!isNaN(num) && num > inviteRowSeq) inviteRowSeq = num;
  }
  pendingInviteRows.push({ id: rowId, allowedFeatures: saved?.allowedFeatures || [], customized: !!saved?.customized });
  const roleHtml = await buildRoleSelectHtml(saved?.roleId || '');
  const div = document.createElement('div');
  div.className = 'entry team-entry';
  div.dataset.inviteRow = rowId;
  const accessCount = saved?.allowedFeatures?.length || 0;
  div.innerHTML = `
    <input type="text" class="invite-row-name" placeholder="Full name" style="flex:1; min-width:120px;" value="${saved?.fullName ? escapeHtml(saved.fullName) : ''}" />
    <input type="email" class="invite-row-email" placeholder="name@example.com" style="flex:1; min-width:150px;" value="${saved?.email ? escapeHtml(saved.email) : ''}" />
    <select class="position-select invite-row-role">${roleHtml}</select>
    <button type="button" class="secondary invite-row-access" data-row="${rowId}">🔐 Access${accessCount ? ` (${accessCount})` : ''}</button>
    <button type="button" class="primary invite-row-send" data-row="${rowId}">✉️ Invite</button>
    <button type="button" class="ghost invite-row-delete" data-row="${rowId}">✕</button>
  `;
  $('pendingInviteRows').appendChild(div);
  initAllGlassSelects(div);
  updateInviteRowsEmptyState();

  div.querySelector('.invite-row-name').addEventListener('input', savePendingInvitesToStorage);
  div.querySelector('.invite-row-email').addEventListener('input', savePendingInvitesToStorage);
  div.querySelector('.invite-row-role').addEventListener('change', savePendingInvitesToStorage);
  div.querySelector('.invite-row-access').addEventListener('click', () => openInviteAccessModal(rowId));
  div.querySelector('.invite-row-delete').addEventListener('click', () => {
    pendingInviteRows = pendingInviteRows.filter((r) => r.id !== rowId);
    div.remove();
    updateInviteRowsEmptyState();
    savePendingInvitesToStorage();
  });
  div.querySelector('.invite-row-send').addEventListener('click', () => sendInviteRow(rowId));
  savePendingInvitesToStorage();
}

$('addInviteRowBtn')?.addEventListener('click', () => addInviteRow());

// Mobile keyboard autofill/autocomplete (tapping a suggested address, or
// browser-saved contact autofill) can silently drop invisible characters
// into a field — zero-width spaces, a non-breaking space, a leading BOM —
// that plain .trim() does NOT remove (it only strips normal whitespace).
// Supabase's own email validator does no trimming at all, so one of these
// invisible characters makes it reject an address that looks completely
// normal on screen. This is what was causing "invalid email format" on the
// first attempt but not the second (retyping by hand skips autofill).
function sanitizeInviteText(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ') // zero-width chars/BOM/nbsp -> space
    .replace(/[\x00-\x1F\x7F]/g, '') // stray control characters
    .trim();
}

async function sendInviteRow(rowId) {
  const div = document.querySelector(`[data-invite-row="${rowId}"]`);
  if (!div) return;
  const row = pendingInviteRows.find((r) => r.id === rowId);
  const fullName = sanitizeInviteText(div.querySelector('.invite-row-name').value);
  const email = sanitizeInviteText(div.querySelector('.invite-row-email').value);
  const roleId = div.querySelector('.invite-row-role').value || null;
  if (!email) { showToast('Enter an email for this row first.'); return; }

  const sendBtn = div.querySelector('.invite-row-send');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  const { data: { session } } = await getSessionSafe();
  const body = { email, roleId, fullName: fullName || undefined };
  if (row?.customized) body.allowedFeatures = row.allowedFeatures;
  const { data, error } = await sb.functions.invoke('invite-user', {
    body,
    headers: { Authorization: `Bearer ${session.access_token}` }
  });

  if (error || data?.error) {
    showToast(`Invite failed for ${email}: ${data?.error || await readFunctionsError(error)}`);
    sendBtn.disabled = false;
    sendBtn.textContent = '✉️ Invite';
    return { ok: false, email };
  }

  showToast(`Invite sent to ${email}.`);
  pendingInviteRows = pendingInviteRows.filter((r) => r.id !== rowId);
  div.remove();
  updateInviteRowsEmptyState();
  savePendingInvitesToStorage();
  renderTeamList();
  return { ok: true, email };
}

$('inviteAllBtn')?.addEventListener('click', async () => {
  const rowIds = pendingInviteRows.map((r) => r.id);
  if (!rowIds.length) { showToast('No pending invites to send.'); return; }
  const btn = $('inviteAllBtn');
  btn.disabled = true;
  btn.textContent = 'Inviting…';
  let sent = 0, failed = 0;
  for (const rowId of rowIds) {
    // sendInviteRow removes the row from pendingInviteRows/DOM as it goes,
    // so this loop is safe to run over the original snapshot of ids.
    const result = await sendInviteRow(rowId);
    if (result?.ok) sent++; else failed++;
  }
  btn.disabled = false;
  btn.textContent = 'Invite All';
  showToast(`${sent} invited${failed ? `, ${failed} failed` : ''}.`);
});

// ---------------------------------------------------------------------
// Per-row Map Access popup for a not-yet-sent invite (mirrors
// openMapAccessModal below, but writes into the in-memory row instead of
// an existing profile).
// ---------------------------------------------------------------------

let inviteAccessRowId = null;

function openInviteAccessModal(rowId) {
  inviteAccessRowId = rowId;
  const row = pendingInviteRows.find((r) => r.id === rowId);
  const current = row?.allowedFeatures || [];
  $('inviteAccessList').innerHTML = FEATURE_LIST.map((f) => `
    <label class="map-access-row">
      <input type="checkbox" value="${f.key}" ${current.includes(f.key) ? 'checked' : ''} />
      <span>${escapeHtml(f.label)}</span>
    </label>
  `).join('');

  const featureCbs = () => [...$('inviteAccessList').querySelectorAll('input[type="checkbox"]')];
  const allCb = $('inviteAccessAllCb');
  allCb.checked = featureCbs().every((cb) => cb.checked);
  allCb.onchange = () => { featureCbs().forEach((cb) => { cb.checked = allCb.checked; }); };
  featureCbs().forEach((cb) => {
    cb.addEventListener('change', () => { allCb.checked = featureCbs().every((c) => c.checked); });
  });

  openPanel('inviteAccess');
}

$('inviteAccessSaveBtn')?.addEventListener('click', () => {
  if (!inviteAccessRowId) return;
  const checked = [...$('inviteAccessList').querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
  const row = pendingInviteRows.find((r) => r.id === inviteAccessRowId);
  if (row) { row.allowedFeatures = checked; row.customized = true; }
  const btn = document.querySelector(`.invite-row-access[data-row="${inviteAccessRowId}"]`);
  if (btn) btn.textContent = checked.length ? `🔐 Access (${checked.length})` : '🔐 Access';
  savePendingInvitesToStorage();
  showToast('Access set for this invite.');
  closePanel('inviteAccess');
});

async function renderTeamList() {
  const list = $('teamList');
  const [{ data, error }, { rows: depts }, roles] = await Promise.all([
    sb.from('profiles').select('id, email, full_name, role, status, position, role_id, allowed_features, department_id, created_at, last_seen').order('created_at', { ascending: false }),
    fetchDepartments(),
    fetchRoles(),
  ]);
  if (error) { list.innerHTML = `<div class="empty">Couldn't load team list.</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="empty">No one invited yet.</div>'; return; }
  const deptOptions = '<option value="">No department</option>' + (depts || []).map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  const roleOptions = '<option value="">No role</option>' + roles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  list.innerHTML = data.map(p => {
    const isOnline = onlineUserIds.has(p.id);
    return `
    <div class="entry team-entry">
      <span class="type-icon">${p.role === 'admin' ? '👑' : '🙂'}<span class="presence-dot ${isOnline ? 'online' : ''}" data-presence-user="${p.id}"></span></span>
      <div class="entry-body">
        <input type="text" class="team-name-input" data-name-user="${p.id}" value="${escapeHtml(p.full_name || '')}" placeholder="Add a name…" style="font-weight:600; border:none; background:transparent; padding:2px 0; width:100%; font-size:14px;" />
        <div class="entry-desc">${escapeHtml(p.email)}</div>
        <div class="last-seen-text ${isOnline ? 'online' : ''}" data-last-seen-for="${p.id}" data-last-seen="${p.last_seen || ''}">${isOnline ? 'Online now' : lastSeenLabel(p.last_seen)}</div>
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
      ${(() => {
          const isOwner = p.email === PROTECTED_OWNER_EMAIL;
          const isSelf = p.id === currentUser?.id;
          const guard = isOwner ? 'disabled title="Account owner — can\'t be deleted"'
            : isSelf ? 'disabled title="Can\'t delete your own account"' : '';
          return `<button type="button" class="secondary danger" data-delete-member="${p.id}" data-delete-member-name="${escapeHtml(p.full_name || p.email)}" ${guard}>🗑️ Delete</button>`;
        })()}
      <span class="chip ${p.status === 'active' ? 'synced' : 'pending'}">${p.status}</span>
    </div>
  `;
  }).join('');
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
  // Lets an admin fix "shows as email" for anyone invited before the Name
  // field existed, or just correct a typo — saves on blur (tap away) so it
  // doesn't fire on every keystroke. This reflects everywhere full_name is
  // shown: chat, timesheets, the synced Google Sheet, everywhere.
  list.querySelectorAll('[data-name-user]').forEach((input) => {
    input.addEventListener('blur', async () => {
      const newName = input.value.trim();
      const person = data.find((p) => p.id === input.dataset.nameUser);
      if (person && newName === (person.full_name || '')) return; // unchanged
      const { error: updErr } = await sb.from('profiles').update({ full_name: newName || null }).eq('id', input.dataset.nameUser);
      if (updErr) { showToast(`Couldn't update name: ${updErr.message}`); return; }
      showToast('Name updated.');
      if (person) person.full_name = newName;
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
  list.querySelectorAll('[data-delete-member]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      // Re-checked here too, same reasoning as Remove Admin above — never
      // let a delete fire on the protected owner or the current user even
      // if the disabled attribute were somehow bypassed.
      const target = data.find((p) => p.id === btn.dataset.deleteMember);
      if (target?.email === PROTECTED_OWNER_EMAIL) { showToast("The account owner can't be deleted."); return; }
      if (target?.id === currentUser?.id) { showToast("You can't delete your own account."); return; }
      const name = btn.dataset.deleteMemberName || 'this person';
      if (!confirm(`Permanently delete ${name}? This removes their login and profile entirely — this cannot be undone. (Their past timesheet/report entries are kept.) If you just want to stop them signing in, use Deactivate instead.`)) return;
      const { data: { session } } = await getSessionSafe();
      const { data: resData, error: fnErr } = await sb.functions.invoke('manage-team-member', {
        body: { userId: btn.dataset.deleteMember, action: 'delete' },
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (fnErr || resData?.error) { showToast(`Couldn't delete: ${resData?.error || await readFunctionsError(fnErr)}`); return; }
      showToast('Deleted.');
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
  const { data, error } = await sb.from('location_allowances').select('id, name, extra_hours, money_rate').order('name');
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
        <div class="entry-meta">+${r.extra_hours} hour${Number(r.extra_hours) === 1 ? '' : 's'} allowance · $${Number(r.money_rate || 0).toFixed(2)}/hour</div>
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
    const rate = $('newLocationRate') && $('newLocationRate').value !== '' ? parseFloat($('newLocationRate').value) : 0;
    if (!name) { showToast('Enter a location name.'); return; }
    if (isNaN(hours) || hours < 0) { showToast('Enter a valid number of extra hours.'); return; }
    if (isNaN(rate) || rate < 0) { showToast('Enter a valid money rate (or leave it as 0).'); return; }
    const { error } = await sb.from('location_allowances').insert({ name, extra_hours: hours, money_rate: rate, created_by: currentUser.id });
    if (error) { showToast(`Couldn't add location: ${error.message}`); return; }
    $('newLocationName').value = '';
    $('newLocationHours').value = '';
    if ($('newLocationRate')) $('newLocationRate').value = '';
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
      ? jobSearchOptions.filter((r) => jobMatchesQuery(r, q))
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
  allocationDraftJobs.push({ idx: allocDraftIdxCounter++, jobId, jobName: jobName || '', location: '', attendanceTime: '', driverId: '', workers: new Set(), descSelected: new Set() });
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

          <label style="margin-top:10px;">Job description for this allocation (tap any that apply, optional)</label>
          <div id="allocDraftDesc_${job.idx}" class="chip-picker"></div>

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
      if (!job.descSelected) job.descSelected = new Set(); // defensive — older in-memory drafts from before this existed
      renderChipPicker(`allocDraftDesc_${job.idx}`, 'general', job.descSelected);
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
    const notes = job.descSelected && job.descSelected.size ? Array.from(job.descSelected).join(', ') : null;
    job.workers.forEach((personId) => {
      // If this same person is also the job's driver, fold that into their
      // one 'job' row via is_driver — a second row for the same person on
      // the same date/slot would violate the unique constraint.
      const alsoDriver = !!job.driverId && job.driverId === personId;
      rows.push({ person_id: personId, work_date: date, slot: 'day', project: job.jobId, location: job.location.trim() || null, attendance_time: job.attendanceTime || null, assignment_type: 'job', is_driver: alsoDriver, notes, created_by: currentUser.id });
    });
    if (job.driverId && !job.workers.has(job.driverId)) {
      rows.push({ person_id: job.driverId, work_date: date, slot: 'day', project: job.jobId, location: job.location.trim() || null, attendance_time: job.attendanceTime || null, assignment_type: 'transportation', is_driver: true, notes, created_by: currentUser.id });
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
  const { data, error } = await sb.from('daily_assignments').select('person_id, project, assignment_type, location, attendance_time, is_driver, notes').eq('work_date', date).eq('slot', 'day');
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
  // Notes/description was shared across everyone on the job, same as
  // location/time above — split it back into individual chips (anything
  // that no longer matches a current option just won't show as selected,
  // but existing published text isn't lost since it re-saves as-is if
  // untouched).
  const existingNotes = people.find((r) => r.notes)?.notes || '';
  const descSelected = new Set(existingNotes.split(',').map((s) => s.trim()).filter(Boolean));

  allocationDraftJobs.push({
    idx: allocDraftIdxCounter++, jobId, jobName: jobInfo?.name || '',
    location, attendanceTime, driverId, workers, descSelected,
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
  renderChipPicker('tripTaskChips', 'driver', tripTaskSelected);
  renderJobDescList();
}

// =====================================================================
// JOB DESCRIPTIONS — admin-managed tap-to-select options that replace
// free typing in New Entry / Daily Progress / Report / Quick Job Switch
// (scope 'general') and driver trips (scope 'driver'). Selecting one or
// more just fills the same plain-text description field everything
// downstream already expects — nothing about storage/sync changes, this
// is purely a faster way to fill it in than typing every time. Soft-
// disable (not delete) keeps history intact, same pattern as Deactivate
// for people.
// =====================================================================

// Groups for the (now dozens-long) General description list — Software,
// Panel wiring, Marketing etc. were all one flat wall of chips before,
// which was hard to scan. 'other' is the catch-all for anything not
// explicitly tagged with a category yet. Driver scope stays flat/ungrouped
// (that list is short).
// Job description categories are admin-manageable (Admin -> Employee Role &
// Invitation Management -> Manage Job Categories) and backed by the
// job_description_categories table instead of a hardcoded list, so adding,
// renaming, or deleting a category here reflects immediately everywhere
// categories show up (chip pickers, the job description list, and each
// project's "Time by task" breakdown). The category "key" saved on each
// job_descriptions row is a stable slug, not a foreign key, so renaming a
// category's label later never orphans anything.
let jobDescCategoriesCache = null;
async function fetchJobDescCategories(forceRefresh = false) {
  if (jobDescCategoriesCache && !forceRefresh) return jobDescCategoriesCache;
  const { data, error } = await sb.from('job_description_categories').select('key, label, icon, sort_order').order('sort_order', { ascending: true });
  jobDescCategoriesCache = error ? [] : (data || []);
  return jobDescCategoriesCache;
}

// { software: {icon,label}, ... } plus a safety-net 'other' entry so lookups
// never blow up even if that row is somehow missing or not loaded yet.
function jobDescCategoryMetaMap(categories) {
  const map = {};
  (categories || []).forEach((c) => { map[c.key] = { icon: c.icon || '✨', label: c.label || c.key }; });
  if (!map.other) map.other = { icon: '✨', label: 'Other' };
  return map;
}

// Builds a stable slug key from a typed category name, e.g. "Quality
// Control" -> "quality_control", for use as the new category's DB key.
function slugifyCategoryKey(label) {
  const slug = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'category';
}

async function fetchJobDescriptions(scope, activeOnly = true) {
  let q = sb.from('job_descriptions').select('id, label, active, category').eq('scope', scope).order('label', { ascending: true });
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q;
  return error ? [] : (data || []);
}

async function renderChipPicker(containerId, scope, selectedSet) {
  const box = $(containerId);
  if (!box) return;
  const options = await fetchJobDescriptions(scope, true);
  if (!options.length) {
    box.innerHTML = '<span class="chip-picker-empty">No options yet — an admin can add some in Admin → Employee Role &amp; Invitation Management → Manage Job Descriptions.</span>';
    return;
  }

  if (scope !== 'general') {
    // Driver task list is short enough it doesn't need grouping.
    box.innerHTML = options.map((o) => `
      <button type="button" class="desc-chip ${selectedSet.has(o.label) ? 'selected' : ''}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>
    `).join('');
  } else {
    const categories = await fetchJobDescCategories();
    const catMeta = jobDescCategoryMetaMap(categories);
    const categoryOrder = categories.map((c) => c.key).concat(categories.some((c) => c.key === 'other') ? [] : ['other']);
    const byCategory = {};
    options.forEach((o) => {
      const cat = catMeta[o.category] ? o.category : 'other';
      (byCategory[cat] = byCategory[cat] || []).push(o);
    });
    box.innerHTML = categoryOrder.filter((cat) => byCategory[cat]?.length).map((cat) => {
      const items = byCategory[cat];
      const meta = catMeta[cat];
      const selectedCount = items.filter((o) => selectedSet.has(o.label)).length;
      return `
        <div class="desc-category-group">
          <button type="button" class="desc-category-header">
            <span class="desc-category-icon">${meta.icon}</span>
            <span class="desc-category-name">${escapeHtml(meta.label)}</span>
            <span class="desc-category-count">${items.length}${selectedCount ? ` · ${selectedCount} selected` : ''}</span>
            <span class="desc-category-chevron">▾</span>
          </button>
          <div class="desc-category-body">
            <div class="chip-picker">
              ${items.map((o) => `<button type="button" class="desc-chip ${selectedSet.has(o.label) ? 'selected' : ''}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`).join('')}
            </div>
          </div>
        </div>
      `;
    }).join('');
    box.querySelectorAll('.desc-category-header').forEach((header) => {
      header.addEventListener('click', () => {
        const body = header.nextElementSibling;
        const open = body.classList.toggle('show');
        header.classList.toggle('open', open);
      });
    });
  }

  box.querySelectorAll('.desc-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const label = chip.dataset.label;
      if (selectedSet.has(label)) selectedSet.delete(label); else selectedSet.add(label);
      chip.classList.toggle('selected');
      // Keep the category header's "N selected" count live without doing a
      // full re-render (which would also collapse whatever's open).
      const group = chip.closest('.desc-category-group');
      if (group) {
        const countEl = group.querySelector('.desc-category-count');
        const total = group.querySelectorAll('.desc-chip').length;
        const selected = group.querySelectorAll('.desc-chip.selected').length;
        if (countEl) countEl.textContent = `${total}${selected ? ` · ${selected} selected` : ''}`;
      }
    });
  });
}

// Combines whatever chips are ticked with any extra free-typed text into
// the one plain-text value everything downstream (submit-entry, sync-to-
// drive, entryDetailRows) already expects — no schema/pipeline changes.
function combineDescription(selectedSet, extraText) {
  const parts = [...Array.from(selectedSet), (extraText || '').trim()].filter(Boolean);
  return parts.join(', ');
}

const workNotesSelected = new Set();
const descriptionSimpleSelected = new Set();
const qsrNotesSelected = new Set();
const tripTaskSelected = new Set();
const ownTripTaskSelected = new Set();

async function refreshGeneralDescriptionChips() {
  await Promise.all([
    renderChipPicker('workNotesChips', 'general', workNotesSelected),
    renderChipPicker('descriptionSimpleChips', 'general', descriptionSimpleSelected),
    renderChipPicker('qsrNotesChips', 'general', qsrNotesSelected),
  ]);
}

// ---------------------------------------------------------------------
// ADMIN: manage the Job Descriptions list itself (add + edit + enable/disable).
// Lives in Admin -> Employee Role & Invitation Management.
// ---------------------------------------------------------------------
let editingJobDescId = null; // which row (if any) is currently showing its edit box

async function renderJobDescList() {
  const box = $('jobDescList');
  if (!box) return;
  const scope = $('newJobDescScope')?.value || 'general';
  const [items, categories] = await Promise.all([
    fetchJobDescriptions(scope, false), // admin sees inactive too
    scope === 'general' ? fetchJobDescCategories() : Promise.resolve([]),
  ]);
  const catMeta = jobDescCategoryMetaMap(categories);
  const categoryOrder = categories.map((c) => c.key).concat(categories.some((c) => c.key === 'other') ? [] : ['other']);
  if (!items.length) { box.innerHTML = '<div class="empty">No job descriptions added yet for this list.</div>'; return; }
  box.innerHTML = items.map((it) => {
    if (editingJobDescId === it.id) {
      return `
        <div class="jobdesc-row ${it.active ? '' : 'inactive'}">
          <input type="text" class="jobdesc-edit-input" data-edit-input="${it.id}" value="${escapeHtml(it.label)}" />
          <button type="button" class="secondary" data-save-jobdesc="${it.id}">💾 Save</button>
          <button type="button" class="secondary" data-cancel-jobdesc="${it.id}">✖ Cancel</button>
        </div>
      `;
    }
    const categoryPicker = scope === 'general' ? `
        <select class="jobdesc-category-select" data-recat-jobdesc="${it.id}">
          ${categoryOrder.map((cat) => `<option value="${cat}" ${((it.category && catMeta[it.category] ? it.category : 'other') === cat) ? 'selected' : ''}>${catMeta[cat].icon} ${catMeta[cat].label}</option>`).join('')}
        </select>` : '';
    return `
      <div class="jobdesc-row ${it.active ? '' : 'inactive'}">
        <span class="jobdesc-label">${escapeHtml(it.label)}</span>
        ${categoryPicker}
        <button type="button" class="secondary" data-edit-jobdesc="${it.id}">✏️ Edit</button>
        <button type="button" class="secondary" data-toggle-jobdesc="${it.id}" data-active="${it.active}">${it.active ? '⛔ Disable' : '✅ Enable'}</button>
        <button type="button" class="secondary" data-delete-jobdesc="${it.id}">🗑️ Delete</button>
      </div>
    `;
  }).join('');

  box.querySelectorAll('[data-recat-jobdesc]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.recatJobdesc;
      const category = sel.value;
      const { error } = await sb.from('job_descriptions').update({ category }).eq('id', id);
      if (error) { showToast(`Couldn't update category: ${error.message}`); return; }
      showToast('Category updated.');
      refreshGeneralDescriptionChips();
    });
  });

  box.querySelectorAll('[data-toggle-jobdesc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.toggleJobdesc;
      const nowActive = btn.dataset.active !== 'true';
      const { error } = await sb.from('job_descriptions').update({ active: nowActive }).eq('id', id);
      if (error) { showToast(`Couldn't update: ${error.message}`); return; }
      showToast(nowActive ? 'Enabled.' : 'Disabled.');
      renderJobDescList();
      refreshGeneralDescriptionChips();
      renderChipPicker('tripTaskChips', 'driver', tripTaskSelected);
      renderChipPicker('ownTripTaskChips', 'driver', ownTripTaskSelected);
    });
  });

  box.querySelectorAll('[data-edit-jobdesc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingJobDescId = btn.dataset.editJobdesc;
      renderJobDescList();
    });
  });

  box.querySelectorAll('[data-cancel-jobdesc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingJobDescId = null;
      renderJobDescList();
    });
  });

  box.querySelectorAll('[data-save-jobdesc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saveJobdesc;
      const input = box.querySelector(`[data-edit-input="${id}"]`);
      const newLabel = (input?.value || '').trim();
      if (!newLabel) { showToast('Description cannot be empty.'); return; }
      const { error } = await sb.from('job_descriptions').update({ label: newLabel }).eq('id', id);
      if (error) { showToast(`Couldn't save: ${error.message}`); return; }
      showToast('Saved.');
      editingJobDescId = null;
      renderJobDescList();
      refreshGeneralDescriptionChips();
      renderChipPicker('tripTaskChips', 'driver', tripTaskSelected);
      renderChipPicker('ownTripTaskChips', 'driver', ownTripTaskSelected);
    });
  });

  box.querySelectorAll('[data-delete-jobdesc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteJobdesc;
      if (!confirm('Delete this job description permanently? Entries that already used it keep their saved text, but it will disappear from the tap-to-select list everywhere.')) return;
      const { error } = await sb.from('job_descriptions').delete().eq('id', id);
      if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
      showToast('Deleted.');
      renderJobDescList();
      refreshGeneralDescriptionChips();
      renderChipPicker('tripTaskChips', 'driver', tripTaskSelected);
      renderChipPicker('ownTripTaskChips', 'driver', ownTripTaskSelected);
    });
  });
}

async function populateJobDescCategorySelect() {
  const sel = $('newJobDescCategory');
  if (!sel) return;
  const categories = await fetchJobDescCategories();
  sel.innerHTML = categories.map((c) => `<option value="${c.key}">${c.icon} ${escapeHtml(c.label)}</option>`).join('');
}

function refreshJobDescCategoryVisibility() {
  const scope = $('newJobDescScope')?.value || 'general';
  const show = scope === 'general';
  if ($('newJobDescCategory')) $('newJobDescCategory').style.display = show ? '' : 'none';
  if ($('newJobDescCategoryLabel')) $('newJobDescCategoryLabel').style.display = show ? '' : 'none';
}
refreshJobDescCategoryVisibility();
populateJobDescCategorySelect();
$('newJobDescScope')?.addEventListener('change', () => { renderJobDescList(); refreshJobDescCategoryVisibility(); });

$('addJobDescBtn')?.addEventListener('click', async () => {
  const label = $('newJobDescLabel').value.trim();
  const scope = $('newJobDescScope')?.value || 'general';
  const category = scope === 'general' ? ($('newJobDescCategory')?.value || 'other') : null;
  if (!label) return;
  const { error } = await sb.from('job_descriptions').insert({ label, scope, category });
  if (error) { showToast(`Couldn't add: ${error.message}`); return; }
  $('newJobDescLabel').value = '';
  showToast('Added.');
  renderJobDescList();
  refreshGeneralDescriptionChips();
  renderChipPicker('tripTaskChips', 'driver', tripTaskSelected);
  renderChipPicker('ownTripTaskChips', 'driver', ownTripTaskSelected);
});

// ---------------------------------------------------------------------
// ADMIN: manage the categories themselves (add / rename / re-icon / delete).
// Deleting a category re-tags every job description using it to 'other'
// first, so nothing is ever silently orphaned; 'other' itself can't be
// deleted since it's the fallback everything else falls back to.
// ---------------------------------------------------------------------
let editingJobDescCategoryKey = null;

async function renderJobDescCategoryList() {
  const box = $('jobDescCategoryList');
  if (!box) return;
  const categories = await fetchJobDescCategories(true);
  if (!categories.length) { box.innerHTML = '<div class="empty">No categories yet.</div>'; return; }
  box.innerHTML = categories.map((c) => {
    if (editingJobDescCategoryKey === c.key) {
      return `
        <div class="jobdesc-row">
          <input type="text" class="jobdesc-edit-input" data-cat-edit-icon="${c.key}" value="${escapeHtml(c.icon)}" maxlength="8" style="max-width:70px; flex:none;" />
          <input type="text" class="jobdesc-edit-input" data-cat-edit-label="${c.key}" value="${escapeHtml(c.label)}" />
          <button type="button" class="secondary" data-cat-save="${c.key}">💾 Save</button>
          <button type="button" class="secondary" data-cat-cancel="${c.key}">✖ Cancel</button>
        </div>
      `;
    }
    return `
      <div class="jobdesc-row">
        <span class="jobdesc-label">${c.icon} ${escapeHtml(c.label)}</span>
        <button type="button" class="secondary" data-cat-edit="${c.key}">✏️ Edit</button>
        ${c.key !== 'other' ? `<button type="button" class="secondary" data-cat-delete="${c.key}">🗑️ Delete</button>` : ''}
      </div>
    `;
  }).join('');

  box.querySelectorAll('[data-cat-edit]').forEach((btn) => {
    btn.addEventListener('click', () => { editingJobDescCategoryKey = btn.dataset.catEdit; renderJobDescCategoryList(); });
  });
  box.querySelectorAll('[data-cat-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => { editingJobDescCategoryKey = null; renderJobDescCategoryList(); });
  });
  box.querySelectorAll('[data-cat-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.catSave;
      const iconInput = box.querySelector(`[data-cat-edit-icon="${key}"]`);
      const labelInput = box.querySelector(`[data-cat-edit-label="${key}"]`);
      const icon = (iconInput?.value || '✨').trim() || '✨';
      const label = (labelInput?.value || '').trim();
      if (!label) { showToast('Category name cannot be empty.'); return; }
      const { error } = await sb.from('job_description_categories').update({ icon, label }).eq('key', key);
      if (error) { showToast(`Couldn't save: ${error.message}`); return; }
      showToast('Saved.');
      editingJobDescCategoryKey = null;
      await fetchJobDescCategories(true);
      renderJobDescCategoryList();
      renderJobDescList();
      populateJobDescCategorySelect();
      refreshGeneralDescriptionChips();
    });
  });
  box.querySelectorAll('[data-cat-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.catDelete;
      if (!confirm('Delete this category? Any job description currently tagged with it will move to "Other" instead of disappearing.')) return;
      const { error: reassignError } = await sb.from('job_descriptions').update({ category: 'other' }).eq('category', key);
      if (reassignError) { showToast(`Couldn't reassign existing items: ${reassignError.message}`); return; }
      const { error } = await sb.from('job_description_categories').delete().eq('key', key);
      if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
      showToast('Category deleted — anything using it moved to Other.');
      await fetchJobDescCategories(true);
      renderJobDescCategoryList();
      renderJobDescList();
      populateJobDescCategorySelect();
      refreshGeneralDescriptionChips();
    });
  });
}
renderJobDescCategoryList();

$('addJobDescCategoryBtn')?.addEventListener('click', async () => {
  const iconInput = $('newJobDescCategoryIcon');
  const labelInput = $('newJobDescCategoryLabelInput');
  const label = (labelInput?.value || '').trim();
  const icon = (iconInput?.value || '✨').trim() || '✨';
  if (!label) { showToast('Enter a category name.'); return; }
  const key = slugifyCategoryKey(label);
  const existing = await fetchJobDescCategories(true);
  if (existing.some((c) => c.key === key)) { showToast('A category with that name (or a very similar one) already exists.'); return; }
  // 'other' is always sort_order 999 so it stays last — new categories
  // should slot in before it, not after.
  const nonOther = existing.filter((c) => c.key !== 'other');
  const sortOrder = nonOther.length ? Math.max(...nonOther.map((c) => c.sort_order || 0)) + 1 : 1;
  const { error } = await sb.from('job_description_categories').insert({ key, label, icon, sort_order: sortOrder });
  if (error) { showToast(`Couldn't add category: ${error.message}`); return; }
  if (iconInput) iconInput.value = '';
  if (labelInput) labelInput.value = '';
  showToast('Category added.');
  await fetchJobDescCategories(true);
  renderJobDescCategoryList();
  renderJobDescList();
  populateJobDescCategorySelect();
  refreshGeneralDescriptionChips();
});

// ---------------------------------------------------------------------
// ADMIN: manage the Document Types catalog (document_types) — what shows
// up as pickable chips under Special Request -> Request Document. Deleting
// a type is blocked (by the FK on document_requests.document_type_id) if
// anyone has ever requested that type — disable it instead in that case.
// ---------------------------------------------------------------------
let docTypesCache = null;
async function fetchDocumentTypes(forceRefresh = false) {
  if (docTypesCache && !forceRefresh) return docTypesCache;
  const { data, error } = await sb.from('document_types').select('id, name, icon, active, sort_order').order('sort_order', { ascending: true });
  docTypesCache = error ? [] : (data || []);
  return docTypesCache;
}

let editingDocTypeId = null;
async function renderDocumentTypeList() {
  const box = $('docTypeList');
  if (!box) return;
  const types = await fetchDocumentTypes(true);
  if (!types.length) { box.innerHTML = '<div class="empty">No document types yet — add one above.</div>'; return; }
  box.innerHTML = types.map((t) => {
    if (editingDocTypeId === t.id) {
      return `
        <div class="jobdesc-row">
          <input type="text" class="jobdesc-edit-input" data-doctype-edit-icon="${t.id}" value="${escapeHtml(t.icon)}" maxlength="8" style="max-width:70px; flex:none;" />
          <input type="text" class="jobdesc-edit-input" data-doctype-edit-name="${t.id}" value="${escapeHtml(t.name)}" />
          <button type="button" class="secondary" data-doctype-save="${t.id}">💾 Save</button>
          <button type="button" class="secondary" data-doctype-cancel="${t.id}">✖ Cancel</button>
        </div>
      `;
    }
    return `
      <div class="jobdesc-row">
        <span class="jobdesc-label">${t.icon} ${escapeHtml(t.name)}${t.active ? '' : ' <em style="opacity:.6;">(disabled)</em>'}</span>
        <button type="button" class="secondary" data-doctype-edit="${t.id}">✏️ Edit</button>
        <button type="button" class="secondary" data-doctype-toggle="${t.id}">${t.active ? '🚫 Disable' : '✅ Enable'}</button>
        <button type="button" class="secondary" data-doctype-delete="${t.id}">🗑️ Delete</button>
      </div>
    `;
  }).join('');

  box.querySelectorAll('[data-doctype-edit]').forEach((btn) => {
    btn.addEventListener('click', () => { editingDocTypeId = btn.dataset.doctypeEdit; renderDocumentTypeList(); });
  });
  box.querySelectorAll('[data-doctype-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => { editingDocTypeId = null; renderDocumentTypeList(); });
  });
  box.querySelectorAll('[data-doctype-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.doctypeSave;
      const iconInput = box.querySelector(`[data-doctype-edit-icon="${id}"]`);
      const nameInput = box.querySelector(`[data-doctype-edit-name="${id}"]`);
      const icon = (iconInput?.value || '📄').trim() || '📄';
      const name = (nameInput?.value || '').trim();
      if (!name) { showToast('Document type name cannot be empty.'); return; }
      const { error } = await sb.from('document_types').update({ icon, name }).eq('id', id);
      if (error) { showToast(`Couldn't save: ${error.message}`); return; }
      showToast('Saved.');
      editingDocTypeId = null;
      renderDocumentTypeList();
    });
  });
  box.querySelectorAll('[data-doctype-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.doctypeToggle;
      const current = types.find((t) => t.id === id);
      const { error } = await sb.from('document_types').update({ active: !current.active }).eq('id', id);
      if (error) { showToast(`Couldn't update: ${error.message}`); return; }
      renderDocumentTypeList();
    });
  });
  box.querySelectorAll('[data-doctype-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.doctypeDelete;
      if (!confirm('Delete this document type? This only works if nobody has ever requested it — disable it instead if they have.')) return;
      const { error } = await sb.from('document_types').delete().eq('id', id);
      if (error) { showToast("Couldn't delete — someone has already requested this type. Disable it instead."); return; }
      showToast('Document type deleted.');
      renderDocumentTypeList();
    });
  });
}

$('addDocTypeBtn')?.addEventListener('click', async () => {
  const iconInput = $('newDocTypeIcon');
  const nameInput = $('newDocTypeName');
  const name = (nameInput?.value || '').trim();
  const icon = (iconInput?.value || '📄').trim() || '📄';
  if (!name) { showToast('Enter a document type name.'); return; }
  const existing = await fetchDocumentTypes(true);
  const sortOrder = existing.length ? Math.max(...existing.map((t) => t.sort_order || 0)) + 1 : 1;
  const { error } = await sb.from('document_types').insert({ name, icon, sort_order: sortOrder });
  if (error) { showToast(`Couldn't add: ${error.message}`); return; }
  if (iconInput) iconInput.value = '';
  if (nameInput) nameInput.value = '';
  showToast('Document type added.');
  renderDocumentTypeList();
});

// ---------------------------------------------------------------------
// ADMIN: manage the shared Project Stage roadmap (project_stage_templates)
// — the ordered list every project's "Project timeline" road is built
// from, and which department is responsible for acknowledging/handing off
// each stage. Add/reorder/remove here; a project's own progress
// (project_stages) is untouched by later edits here since it snapshots
// each stage's department at the moment that job's timeline was started.
// ---------------------------------------------------------------------
async function populateStageDepartmentSelect() {
  const sel = $('newStageDepartment');
  if (!sel) return;
  const { data, error } = await sb.from('departments').select('id, name').order('name', { ascending: true });
  const depts = error ? [] : (data || []);
  sel.innerHTML = '<option value="">No department yet</option>' + depts.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
}

async function renderProjectStageTemplateList() {
  const box = $('projectStageTemplateList');
  if (!box) return;
  const [{ data: templates, error }, { data: deptRows }] = await Promise.all([
    sb.from('project_stage_templates').select('id, stage_key, label, department_id, sort_order').order('sort_order', { ascending: true }),
    sb.from('departments').select('id, name').order('name', { ascending: true }),
  ]);
  const depts = deptRows || [];
  if (error || !templates || !templates.length) { box.innerHTML = '<div class="empty">No stages yet — add the first one above.</div>'; return; }

  box.innerHTML = templates.map((t, i) => `
    <div class="jobdesc-row" style="flex-wrap:wrap;">
      <input type="number" class="stage-pos-input" min="1" max="${templates.length}" value="${i + 1}" data-stage-pos="${t.id}"
        title="Type a position number to move this stage there" />
      <span class="jobdesc-label" style="flex:1 1 170px;">${escapeHtml(t.label)}</span>
      <select data-stage-dept="${t.id}" style="flex:1 1 150px;">
        <option value="">No department</option>
        ${depts.map((d) => `<option value="${d.id}" ${t.department_id === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
      </select>
      <button type="button" class="secondary" data-stage-up="${t.id}" ${i === 0 ? 'disabled' : ''} title="Move earlier">↑</button>
      <button type="button" class="secondary" data-stage-down="${t.id}" ${i === templates.length - 1 ? 'disabled' : ''} title="Move later">↓</button>
      <button type="button" class="secondary" data-stage-delete="${t.id}" title="Remove stage">🗑️</button>
    </div>
  `).join('');

  box.querySelectorAll('[data-stage-dept]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.stageDept;
      const { error: updErr } = await sb.from('project_stage_templates').update({ department_id: sel.value || null }).eq('id', id);
      if (updErr) { showToast(`Couldn't save: ${updErr.message}`); return; }
      showToast('Saved — new projects (and any stage not started yet) will use this.');
    });
  });
  box.querySelectorAll('[data-stage-pos]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const id = inp.dataset.stagePos;
      const idx = templates.findIndex((t) => t.id === id);
      if (idx === -1) return;
      let newPos = parseInt(inp.value, 10);
      if (!newPos || newPos < 1) newPos = 1;
      if (newPos > templates.length) newPos = templates.length;
      if (newPos === idx + 1) { renderProjectStageTemplateList(); return; }
      const reordered = templates.filter((t) => t.id !== id);
      reordered.splice(newPos - 1, 0, templates[idx]);
      const updates = reordered
        .map((t, i) => ({ id: t.id, oldOrder: t.sort_order, newOrder: i + 1 }))
        .filter((u) => u.oldOrder !== u.newOrder);
      await Promise.all(updates.map((u) => sb.from('project_stage_templates').update({ sort_order: u.newOrder }).eq('id', u.id)));
      showToast(`Moved to position ${newPos}.`);
      renderProjectStageTemplateList();
    });
  });
  box.querySelectorAll('[data-stage-up]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = templates.findIndex((t) => t.id === btn.dataset.stageUp);
      if (idx <= 0) return;
      const a = templates[idx], b = templates[idx - 1];
      await Promise.all([
        sb.from('project_stage_templates').update({ sort_order: b.sort_order }).eq('id', a.id),
        sb.from('project_stage_templates').update({ sort_order: a.sort_order }).eq('id', b.id),
      ]);
      renderProjectStageTemplateList();
    });
  });
  box.querySelectorAll('[data-stage-down]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = templates.findIndex((t) => t.id === btn.dataset.stageDown);
      if (idx === -1 || idx >= templates.length - 1) return;
      const a = templates[idx], b = templates[idx + 1];
      await Promise.all([
        sb.from('project_stage_templates').update({ sort_order: b.sort_order }).eq('id', a.id),
        sb.from('project_stage_templates').update({ sort_order: a.sort_order }).eq('id', b.id),
      ]);
      renderProjectStageTemplateList();
    });
  });
  box.querySelectorAll('[data-stage-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this stage from the roadmap? Projects whose timeline already reached this stage keep their own record — this only affects new/not-yet-started stages going forward.')) return;
      const { error: delErr } = await sb.from('project_stage_templates').delete().eq('id', btn.dataset.stageDelete);
      if (delErr) { showToast(`Couldn't remove: ${delErr.message}`); return; }
      showToast('Stage removed.');
      renderProjectStageTemplateList();
    });
  });
}

// Lets an admin set/change each department's head right here in Data Feed —
// the same head_id also shown/editable from Team → the department detail
// view, and the same field advance-project-stage checks to decide who may
// acknowledge/hand off that department's stage. Kept here so every
// important roadmap setting lives in one place without a trip to Admin.
async function renderDepartmentHeadsList() {
  const box = $('departmentHeadsList');
  if (!box) return;
  const [{ data: depts, error }, { data: people }] = await Promise.all([
    sb.from('departments').select('id, name, head_id').order('name', { ascending: true }),
    sb.from('profiles').select('id, email, full_name').eq('status', 'active').order('full_name', { ascending: true }),
  ]);
  if (error || !depts || !depts.length) {
    box.innerHTML = '<div class="empty">No departments yet — add one in Team → Departments first.</div>';
    return;
  }
  const activePeople = people || [];
  const peopleOptions = activePeople.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name || p.email)}</option>`).join('');
  box.innerHTML = depts.map((d) => `
    <div class="jobdesc-row">
      <span class="jobdesc-label" style="flex:1 1 140px;">${escapeHtml(d.name)}</span>
      <select data-dept-head="${d.id}" style="flex:1 1 200px;">
        <option value="">— No head assigned —</option>
        ${peopleOptions}
      </select>
    </div>
  `).join('');
  box.querySelectorAll('[data-dept-head]').forEach((sel) => {
    const dept = depts.find((d) => d.id === sel.dataset.deptHead);
    sel.value = dept?.head_id || '';
    sel.addEventListener('change', async () => {
      const { error: updErr } = await sb.from('departments').update({ head_id: sel.value || null }).eq('id', sel.dataset.deptHead);
      if (updErr) { showToast(`Couldn't save: ${updErr.message}`); return; }
      showToast(`Saved — ${dept?.name || 'this department'}'s head can now acknowledge/hand off their stage.`);
    });
  });
}

// ---------- Hourly Rates (Data Feed → feeds Profit Analyzer) ----------
let hourlyRatePeopleCache = [];
let hourlyRateFilterQuery = '';
async function renderHourlyRateList() {
  const box = $('hourlyRateList');
  if (!box) return;
  box.innerHTML = '<div class="empty">Loading…</div>';
  const { data: people, error } = await sb.from('profiles')
    .select('id, email, full_name, hourly_rate, status')
    .eq('status', 'active')
    .order('full_name', { ascending: true });
  if (error) {
    box.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`;
    return;
  }
  hourlyRatePeopleCache = people || [];
  renderHourlyRateListFiltered();
}
function renderHourlyRateListFiltered() {
  const box = $('hourlyRateList');
  if (!box) return;
  const q = hourlyRateFilterQuery.trim().toLowerCase();
  const rows = q
    ? hourlyRatePeopleCache.filter((p) => (p.full_name || p.email || '').toLowerCase().includes(q))
    : hourlyRatePeopleCache;
  if (!rows.length) {
    box.innerHTML = '<div class="empty">No one matches that search.</div>';
    return;
  }
  box.innerHTML = rows.map((p) => `
    <div class="jobdesc-row">
      <span class="jobdesc-label" style="flex:1 1 160px;">${escapeHtml(p.full_name || p.email)}</span>
      <span class="hint" style="flex:0 0 auto;">$</span>
      <input type="number" min="0" step="0.01" data-hourly-rate="${p.id}" value="${Number(p.hourly_rate || 0)}" style="flex:1 1 100px; max-width:110px;" />
      <span class="hint" style="flex:0 0 auto;">/hr</span>
    </div>
  `).join('');
  box.querySelectorAll('[data-hourly-rate]').forEach((input) => {
    input.addEventListener('change', async () => {
      const val = Math.max(0, Number(input.value) || 0);
      input.value = val;
      const { error: updErr } = await sb.from('profiles').update({ hourly_rate: val }).eq('id', input.dataset.hourlyRate);
      if (updErr) { showToast(`Couldn't save: ${updErr.message}`); return; }
      const person = hourlyRatePeopleCache.find((p) => p.id === input.dataset.hourlyRate);
      if (person) person.hourly_rate = val;
      showToast(`Saved — ${person?.full_name || person?.email || 'their'} rate is now $${val.toFixed(2)}/hr.`);
    });
  });
}
if ($('hourlyRateSearch')) {
  $('hourlyRateSearch').addEventListener('input', (e) => {
    hourlyRateFilterQuery = e.target.value;
    renderHourlyRateListFiltered();
  });
}

$('addStageTemplateBtn')?.addEventListener('click', async () => {
  const labelInput = $('newStageLabel');
  const deptSelect = $('newStageDepartment');
  const posInput = $('newStagePosition');
  const label = (labelInput?.value || '').trim();
  if (!label) { showToast('Enter a stage name.'); return; }
  const { data: existing } = await sb.from('project_stage_templates').select('id, stage_key, sort_order').order('sort_order', { ascending: true });
  const rows = existing || [];
  let key = slugifyCategoryKey(label);
  if (rows.some((r) => r.stage_key === key)) key = `${key}_${Date.now().toString(36)}`;

  // Optional typed position: where in the list (1-based) the new stage
  // should land. Anything left blank (or out of range) just appends to the
  // end, same as before.
  let pos = parseInt(posInput?.value, 10);
  const insertAt = (pos && pos >= 1) ? Math.min(pos, rows.length + 1) : rows.length + 1;

  // Renumber every existing stage from/after that spot down by one so the
  // new stage can take that exact position number.
  const toShift = rows
    .map((r, i) => ({ id: r.id, oldOrder: r.sort_order, newOrder: (i + 1) >= insertAt ? i + 2 : i + 1 }))
    .filter((u) => u.oldOrder !== u.newOrder);
  await Promise.all(toShift.map((u) => sb.from('project_stage_templates').update({ sort_order: u.newOrder }).eq('id', u.id)));

  const { error } = await sb.from('project_stage_templates').insert({
    stage_key: key, label, department_id: deptSelect?.value || null, sort_order: insertAt,
  });
  if (error) { showToast(`Couldn't add stage: ${error.message}`); return; }
  if (labelInput) labelInput.value = '';
  if (posInput) posInput.value = '';
  showToast(insertAt <= rows.length ? `Stage added at position ${insertAt}.` : 'Stage added.');
  renderProjectStageTemplateList();
});

async function populateDriverSelects() {
  const { data, error } = await sb.from('profiles').select('id, email, full_name').eq('status', 'active').order('full_name', { ascending: true });
  const people = error ? [] : (data || []);
  const options = people.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name || p.email)}</option>`).join('');
  if ($('tripDriverSelect')) $('tripDriverSelect').innerHTML = '<option value="">Choose a driver</option>' + options;
  if ($('activityDriverSelect')) $('activityDriverSelect').innerHTML = '<option value="">Choose a driver</option>' + options;
  if ($('eveningDriverSelect')) $('eveningDriverSelect').innerHTML = '<option value="">Choose a driver</option>' + options;
  if ($('tripAssignedBySelect')) $('tripAssignedBySelect').innerHTML = '<option value="">Choose who\'s sending the driver</option>' + options;
  if ($('ownTripAssignedBySelect')) $('ownTripAssignedBySelect').innerHTML = '<option value="">Choose who asked you</option>' + options;
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
  const { data, error } = await sb.from('driver_trips').insert({
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
    assigned_by: $('tripAssignedBySelect').value || currentUser.id,
    description: Array.from(tripTaskSelected).join(', ') || null,
    status: 'planned',
    created_by: currentUser.id,
  }).select('id').single();
  if (error) { showToast(`Couldn't add trip: ${error.message}`); return; }
  $('tripFrom').value = '';
  $('tripTo').value = '';
  $('tripTime').value = '';
  $('tripKm').value = '';
  $('tripJobId').value = '';
  tripTaskSelected.clear();
  renderChipPicker('tripTaskChips', 'driver', tripTaskSelected);
  showToast('Trip added — notifying the driver…');
  if (data?.id) {
    const { data: { session } } = await getSessionSafe();
    sb.functions.invoke('send-push', {
      body: { kind: 'trip', tripId: data.id },
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).catch(() => {}); // best-effort — a missed push shouldn't block the trip already being saved
  }
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
// day, each with its own from/to and time. A trip an allocator just
// assigned shows as "planned" (a clear NEW badge) until the driver taps
// Start; the driver can also log their own trip below (see
// initOwnTripLogging) for anything nobody pre-assigned.
let tripPeopleNameCache = null;
async function getPersonName(id) {
  if (!id) return '';
  if (!tripPeopleNameCache) {
    const { data } = await sb.from('profiles').select('id, full_name, email');
    tripPeopleNameCache = new Map((data || []).map((p) => [p.id, p.full_name || p.email]));
  }
  return tripPeopleNameCache.get(id) || '';
}

async function renderMyTripsToday() {
  const card = $('myTripsCard');
  const area = $('myTripsArea');
  if (!card || !area || !currentUser) return;
  const todayKey = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('driver_trips')
    .select('id, trip_time, job_id, from_label, to_label, description, status, assigned_by')
    .eq('driver_id', currentUser.id)
    .eq('work_date', todayKey)
    .order('trip_time', { ascending: true });
  if (error || !data || !data.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const rows = await Promise.all(data.map(async (r) => {
    const status = r.status || 'planned';
    const assignedName = await getPersonName(r.assigned_by);
    const actionBtn = status === 'planned'
      ? `<button type="button" class="secondary" data-start-trip="${r.id}" style="margin-top:6px;">▶ Start trip</button>`
      : status === 'in_progress'
        ? `<button type="button" class="secondary" data-complete-trip="${r.id}" style="margin-top:6px;">✅ Complete</button>`
        : '';
    return `
      <div class="entry">
        <span class="type-icon">🚗</span>
        <div class="entry-body">
          <div class="entry-desc">${r.trip_time ? escapeHtml(String(r.trip_time).slice(0, 5)) + ' — ' : ''}${escapeHtml(r.from_label || '?')} → ${escapeHtml(r.to_label || '?')}<span class="trip-status-badge ${status}">${status === 'planned' ? 'NEW' : status === 'in_progress' ? 'In progress' : 'Done'}</span></div>
          <div class="entry-meta">${r.description ? escapeHtml(r.description) + ' · ' : ''}${assignedName ? 'Assigned by ' + escapeHtml(assignedName) : ''}${r.job_id ? ' · Job ' + escapeHtml(r.job_id) : ''}</div>
          ${actionBtn}
        </div>
      </div>
    `;
  }));
  area.innerHTML = rows.join('');
  area.querySelectorAll('[data-start-trip]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { error: updErr } = await sb.from('driver_trips').update({ status: 'in_progress', started_at: new Date().toISOString() }).eq('id', btn.dataset.startTrip);
      if (updErr) { showToast(`Couldn't start trip: ${updErr.message}`); return; }
      showToast('Trip started.');
      renderMyTripsToday();
    });
  });
  area.querySelectorAll('[data-complete-trip]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { error: updErr } = await sb.from('driver_trips').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', btn.dataset.completeTrip);
      if (updErr) { showToast(`Couldn't complete trip: ${updErr.message}`); return; }
      showToast('Trip completed.');
      renderMyTripsToday();
    });
  });
}

// ---------------------------------------------------------------------
// Driver self-entry — "+ Log a trip": for when nobody pre-assigned
// anything and the driver just got told (in person/by phone) to go
// somewhere. Picks who asked + a task + from/to, then Start Trip saves it
// already in-progress — no separate "planned" step needed since the
// driver is the one starting it right now.
// ---------------------------------------------------------------------
function initOwnTripLogging() {
  const toggleBtn = $('logOwnTripBtn');
  const form = $('ownTripForm');
  if (!toggleBtn || !form || toggleBtn.dataset.wired) return;
  toggleBtn.dataset.wired = 'true';
  toggleBtn.addEventListener('click', () => {
    const showing = form.style.display !== 'none';
    form.style.display = showing ? 'none' : 'block';
    if (!showing) renderChipPicker('ownTripTaskChips', 'driver', ownTripTaskSelected);
  });
  wireAddressSearch('ownTripFrom', 'ownTripFromResults');
  wireAddressSearch('ownTripTo', 'ownTripToResults');

  $('ownTripStartBtn')?.addEventListener('click', async () => {
    const fromLabel = $('ownTripFrom').value.trim();
    const toLabel = $('ownTripTo').value.trim();
    if (!fromLabel || !toLabel) { showToast('Fill in From and To first.'); return; }
    const { error } = await sb.from('driver_trips').insert({
      driver_id: currentUser.id,
      work_date: new Date().toISOString().slice(0, 10),
      trip_time: toTimeInputValue(new Date()),
      from_label: fromLabel,
      from_lat: $('ownTripFrom').dataset.lat ? parseFloat($('ownTripFrom').dataset.lat) : null,
      from_lon: $('ownTripFrom').dataset.lon ? parseFloat($('ownTripFrom').dataset.lon) : null,
      to_label: toLabel,
      to_lat: $('ownTripTo').dataset.lat ? parseFloat($('ownTripTo').dataset.lat) : null,
      to_lon: $('ownTripTo').dataset.lon ? parseFloat($('ownTripTo').dataset.lon) : null,
      km: $('ownTripKm').value ? parseFloat($('ownTripKm').value) : null,
      assigned_by: $('ownTripAssignedBySelect').value || null,
      description: Array.from(ownTripTaskSelected).join(', ') || null,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      created_by: currentUser.id,
    });
    if (error) { showToast(`Couldn't start trip: ${error.message}`); return; }
    $('ownTripFrom').value = '';
    $('ownTripTo').value = '';
    $('ownTripKm').value = '';
    $('ownTripAssignedBySelect').value = '';
    ownTripTaskSelected.clear();
    form.style.display = 'none';
    showToast('Trip started.');
    renderMyTripsToday();
  });
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
  profitAnalyzer: ['profitAnalyzerOverlay', 'profitAnalyzerOverlayBackdrop'],
  profitDetail: ['profitDetailOverlay', 'profitDetailOverlayBackdrop'],
  renewalManager: ['renewalManagerOverlay', 'renewalManagerOverlayBackdrop'],
  renewalEdit: ['renewalEditOverlay', 'renewalEditOverlayBackdrop'],
  renewalHistory: ['renewalHistoryOverlay', 'renewalHistoryOverlayBackdrop'],
  fieldActivities: ['fieldActivitiesOverlay', 'fieldActivitiesOverlayBackdrop'],
  companyFinder: ['companyFinderOverlay', 'companyFinderOverlayBackdrop'],
  tank: ['tankOverlay', 'tankOverlayBackdrop'],
  mapAccess: ['mapAccessOverlay', 'mapAccessOverlayBackdrop'],
  people: ['peopleOverlay', 'peopleOverlayBackdrop'],
  inviteAccess: ['inviteAccessOverlay', 'inviteAccessOverlayBackdrop'],
  allocation: ['allocationOverlay', 'allocationOverlayBackdrop'],
  myjobs: ['myJobsOverlay', 'myJobsOverlayBackdrop'],
  entryDetail: ['entryDetailOverlay', 'entryDetailOverlayBackdrop'],
  datafeed: ['dataFeedOverlay', 'dataFeedOverlayBackdrop'],
  recalledEdit: ['recalledEditOverlay', 'recalledEditOverlayBackdrop'],
  liveDrivers: ['liveDriversOverlay', 'liveDriversOverlayBackdrop'],
  specialRequest: ['specialRequestOverlay', 'specialRequestOverlayBackdrop'],
  weather: ['weatherOverlay', 'weatherOverlayBackdrop'],
  about: ['aboutOverlay', 'aboutOverlayBackdrop'],
  appearance: ['appearanceOverlay', 'appearanceOverlayBackdrop'],
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
    if ($('syncJobHoursCard')) $('syncJobHoursCard').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
    renderDepartmentsList();
  }
  if (name === 'clients') {
    $('newClientCard').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
    renderClientsList();
    wireNewClientAddressSearch();
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
  if (name === 'renewalManager') {
    renderRenewalManager();
  }
  if (name === 'profitAnalyzer') {
    renderProfitAnalyzerList();
    renderCompanyProfitAnalysis();
  }
  if (name === 'allocation') {
    openAllocationPanel();
  }
  if (name === 'myjobs') {
    renderMyJobsPanel();
  }
  if (name === 'specialRequest') {
    renderSpecialRequestForm();
    renderMySpecialRequests();
    renderSpecialRequestApprovals();
    renderMyLeaveRequests();
    renderLeaveApprovals();
    renderLeaveCalendar();
    renderDocumentRequestForm();
    renderMyDocumentRequests();
    renderDocumentRequestApprovals();
  }
  if (name === 'fieldActivities') {
    renderFieldActivitiesPanel();
  }
  if (name === 'companyFinder') {
    renderCompanyFinderIndustryChips();
    wireAddressSearch('companyFinderLocation', 'companyFinderLocationResults');
  }
  if (name === 'people') {
    renderTeamList();
    restorePendingInvitesIfNeeded();
  }
  if (name === 'health') renderHealthPanel();
  if (name === 'learning') renderLearningPanel();
  if (name === 'weather') renderWeatherDetail();
  if (name === 'about') renderAboutPanel();
  if (name === 'appearance') renderAppearancePanel();
  if (name === 'datafeed') {
    // Manage Job Types & Categories lives right here now — refresh both
    // lists (and the add-new category dropdown) every time the panel opens
    // so they're never showing stale data from before.
    populateJobDescCategorySelect();
    renderJobDescList();
    renderJobDescCategoryList();
    populateStageDepartmentSelect();
    renderProjectStageTemplateList();
    renderDepartmentHeadsList();
    renderHourlyRateList();
    renderDocumentTypeList();
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
// ABOUT + TUTORIAL — a beginner-friendly entry point (Home → About) that
// shows the currently-running app version, then a "Start Tutorial" button
// that launches a guided spotlight tour pointing out where every feature
// on the Home screen lives.
// =====================================================================

function renderAboutPanel() {
  if ($('aboutVersionText')) $('aboutVersionText').textContent = `Version ${APP_VERSION}`;
  if ($('aboutUpdateNotes')) $('aboutUpdateNotes').textContent = APP_UPDATE_NOTES || 'No release notes for this version.';
  // aboutHeroLogoMark itself is kept in sync by applyAppearance() (called on
  // load, on every global-appearance fetch/save/realtime push, and every
  // 15 min) — nothing extra to do for the logo here.
}

// =====================================================================
// APPEARANCE — personal, per-device preferences (localStorage only, never
// synced to any other person or device): Quote of the Day, Day/Night
// scheme, background (curated gradient themes or rotating real sports
// photos), and an in-app logo/header-mark picker.
// =====================================================================

// ~30 general positive/respect/teamwork/growth quotes (safe, commonly-known
// attributions) + ~10 Thirukkural-inspired lines. The Thirukkural entries
// are deliberately phrased as a paraphrase of well-established themes
// (courtesy, gratitude, learning, patience, friendship) rather than a
// verbatim translation of one specific numbered couplet, since asserting an
// exact couplet number from memory risks misattribution.
const QUOTES = [
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "Alone we can do so little; together we can do so much.", author: "Helen Keller" },
  { text: "Great things are done by a series of small things brought together.", author: "Vincent van Gogh" },
  { text: "Teamwork makes the dream work.", author: "John C. Maxwell" },
  { text: "The best way to find yourself is to lose yourself in the service of others.", author: "Mahatma Gandhi" },
  { text: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
  { text: "Kind words can be short and easy to speak, but their echoes are truly endless.", author: "Mother Teresa" },
  { text: "We rise by lifting others.", author: "Robert Ingersoll" },
  { text: "The strength of the team is each individual member.", author: "Phil Jackson" },
  { text: "If you want to go fast, go alone. If you want to go far, go together.", author: "African Proverb" },
  { text: "Respect for ourselves guides our morals; respect for others guides our manners.", author: "Laurence Sterne" },
  { text: "Honesty is the first chapter in the book of wisdom.", author: "Thomas Jefferson" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { text: "A leader is best when people barely know he exists.", author: "Lao Tzu" },
  { text: "Trust is built with consistency.", author: "Lincoln Chafee" },
  { text: "Gratitude turns what we have into enough.", author: "Anonymous" },
  { text: "Small daily improvements are the key to staggering long-term results.", author: "Anonymous" },
  { text: "None of us is as smart as all of us.", author: "Ken Blanchard" },
  { text: "Patience, persistence and perspiration make an unbeatable combination for success.", author: "Napoleon Hill" },
  { text: "A calm mind brings inner strength and self-confidence.", author: "Dalai Lama" },
  { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
  { text: "Every accomplishment starts with the decision to try.", author: "John F. Kennedy" },
  { text: "Well done is better than well said.", author: "Benjamin Franklin" },
  { text: "The customer's perception is your reality.", author: "Kate Zabriskie" },
  { text: "Punctuality is the soul of business.", author: "Thomas Chandler Haliburton" },
  { text: "Courtesy costs nothing, but buys everything.", author: "Anonymous" },
  { text: "A company's culture is the foundation for future innovation.", author: "Anonymous" },
  { text: "Progress is impossible without change.", author: "George Bernard Shaw" },
  { text: "A team that trusts each other wins together.", author: "Anonymous" },
  { text: "Kindness offered without expectation is the truest form of wealth.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "Even a small act of courtesy leaves a lasting impression.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "A gracious word costs nothing yet earns lasting goodwill.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "Learning is the one wealth that no one can ever take away from you.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "Patience under provocation is the mark of true strength.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "Friendship is tested not in comfort, but in times of difficulty.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "A grateful heart never forgets a kindness done to it.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "Speak only what is truthful, and speak it with care for others.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "Hard work done with sincerity always finds its reward.", author: "Thirukkural (Thiruvalluvar)" },
  { text: "Respect given to others returns multiplied to oneself.", author: "Thirukkural (Thiruvalluvar)" },
];

// Curated gradient color-mood themes — each just overrides the three
// --bg-grad-* variables the body background (styles.css) already reads.
const THEME_PRESETS = [
  { id: 'classic', label: 'Classic', swatch: 'linear-gradient(135deg,#e08a5f,#5e8094)' },
  { id: 'sunset', label: 'Sunset', swatch: 'linear-gradient(135deg,#e86e59,#db5078)' },
  { id: 'ocean', label: 'Ocean', swatch: 'linear-gradient(135deg,#388ec4,#2ec4b6)' },
  { id: 'forest', label: 'Forest', swatch: 'linear-gradient(135deg,#5aa866,#3c785a)' },
  { id: 'dusk', label: 'Dusk', swatch: 'linear-gradient(135deg,#8264c8,#5a289c)' },
];

// Real CC0 sports photos (Pexels — free to use, no attribution required),
// verified as currently-live photo IDs before being hard-coded here. One is
// picked per day (deterministic, same for this person's every device/session
// on a given calendar day), rotating automatically at local midnight, with a
// manual "Shuffle" that only overrides today's pick.
const SPORTS_PHOTOS = {
  soccer: [274422, 6800039, 38558648, 11221499],
  basketball: [13179883, 6076497, 965622, 34345752],
  running: [37718409, 936094, 14346273, 8455978],
  cycling: [21588830, 5735768, 30316476, 32917702],
  tennis: [31589110, 8224677, 2996260, 34247999],
  motogp: [38374472, 12735081, 142828, 11735218],
  f1: [28680795, 29252129, 28832062, 35210800],
  cars: [34243843, 36683301, 39081071, 12505996],
  boats: [19750411, 296236, 38755472, 296237],
  ships: [33315751, 37828492, 36195494, 262353],
  rockets: [7327336, 586054, 5420670, 23788],
  flights: [37589299, 28500925, 14482714, 32037884],
};
const SPORTS_PHOTO_CATEGORY_LABELS = {
  mixed: 'Mixed (all)', soccer: 'Soccer', basketball: 'Basketball', running: 'Running', cycling: 'Cycling', tennis: 'Tennis',
  motogp: 'MotoGP', f1: 'Formula 1', cars: 'Cars', boats: 'Boats', ships: 'Ships', rockets: 'Rockets', flights: 'Flights',
};
function sportsPhotoUrl(id) { return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=1920`; }
function sportsPhotoIdsForCategory(cat) {
  if (cat && SPORTS_PHOTOS[cat]) return SPORTS_PHOTOS[cat];
  return Object.values(SPORTS_PHOTOS).flat();
}

// In-app logo/header-mark (NOT the home-screen PWA icon — that needs new
// icon files + a redeploy, out of scope here). Just the one design, mirroring
// the actual icon.svg so it always matches the real app icon — the Badge/
// Spark alternates from an earlier pass were removed per feedback.
const LOGO_PRESETS = [
  {
    id: 'ring', label: 'Ring',
    svg: '<svg viewBox="0 0 128 128" width="100%" height="100%"><rect width="128" height="128" rx="24" fill="#1a1a19"/><circle cx="64" cy="64" r="38" fill="none" stroke="url(#ctorqRingGrad)" stroke-width="20" stroke-linecap="round" stroke-dasharray="185 60"/><defs><linearGradient id="ctorqRingGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4cbdb9"/><stop offset="1" stop-color="#00706d"/></linearGradient></defs></svg>',
  },
];

// LOCAL, personal-per-device preferences only: Day/Night scheme, which
// color-theme swatch shows, and bgOverridePhoto (opt out of the admin's
// "Action photos" background on just this device and use the swatch below
// instead). Everything else (background mode/photos, logo, whether the
// quote shows at all) is org-wide and lives in Supabase — see the GLOBAL
// appearance block just below.
const APPEARANCE_KEY = 'ctorqAppearance';
function getAppearancePrefs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || 'null'); } catch { saved = null; }
  return {
    scheme: 'dark', bgTheme: 'classic', bgOverridePhoto: false,
    ...(saved || {}),
  };
}
function saveAppearancePrefs(patch) {
  const next = { ...getAppearancePrefs(), ...patch };
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next)); } catch { /* private browsing etc — just won't persist */ }
  applyAppearance();
  return next;
}

// GLOBAL, org-wide appearance (background theme/photo mode + the app logo)
// — admin-controlled, stored in the `app_appearance` singleton table, and
// pushed live to every signed-in person via Supabase Realtime so a change
// shows up immediately without anyone needing to reload.
const GLOBAL_APPEARANCE_CACHE_KEY = 'ctorqGlobalAppearanceCache';
const GLOBAL_APPEARANCE_DEFAULTS = {
  bgMode: 'gradient', bgPhotoCategory: 'mixed',
  bgPhotoManualIdx: null, bgPhotoManualDay: null, customLogo: null, showQuote: true,
  aiIconGif: null,
};
let globalAppearance = null;
function dbRowToGlobalAppearance(row) {
  if (!row) return null;
  return {
    bgMode: row.bg_mode, bgPhotoCategory: row.bg_photo_category,
    bgPhotoManualIdx: row.bg_photo_manual_idx, bgPhotoManualDay: row.bg_photo_manual_day,
    customLogo: row.custom_logo, showQuote: row.show_quote,
    aiIconGif: row.ai_icon_gif,
  };
}
function getGlobalAppearance() {
  return globalAppearance || GLOBAL_APPEARANCE_DEFAULTS;
}
// A fast local mirror of the last-known org settings, so the no-flash
// <head> init script (index.html) can stamp the right background/scheme
// attributes before the real Supabase fetch below even resolves.
function cacheGlobalAppearanceLocally(g) {
  try { localStorage.setItem(GLOBAL_APPEARANCE_CACHE_KEY, JSON.stringify(g)); } catch { /* ignore */ }
}
async function fetchGlobalAppearance() {
  try {
    const { data, error } = await sb.from('app_appearance').select('*').eq('id', true).maybeSingle();
    if (error) throw error;
    globalAppearance = dbRowToGlobalAppearance(data) || GLOBAL_APPEARANCE_DEFAULTS;
    cacheGlobalAppearanceLocally(globalAppearance);
  } catch (err) {
    console.warn('fetchGlobalAppearance failed (using last-known/local defaults):', err);
  }
  applyAppearance();
  if ($('appearanceOverlay')?.classList.contains('show')) renderAppearancePanel();
}
// Admin-only write — RLS on app_appearance only allows role='admin' to
// UPDATE, so this quietly fails (with a toast) if called by anyone else.
async function saveGlobalAppearance(patch) {
  const dbPatch = { updated_at: new Date().toISOString(), updated_by: currentUser?.id || null };
  if ('bgMode' in patch) dbPatch.bg_mode = patch.bgMode;
  if ('bgPhotoCategory' in patch) dbPatch.bg_photo_category = patch.bgPhotoCategory;
  if ('bgPhotoManualIdx' in patch) dbPatch.bg_photo_manual_idx = patch.bgPhotoManualIdx;
  if ('bgPhotoManualDay' in patch) dbPatch.bg_photo_manual_day = patch.bgPhotoManualDay;
  if ('customLogo' in patch) dbPatch.custom_logo = patch.customLogo;
  if ('showQuote' in patch) dbPatch.show_quote = patch.showQuote;
  if ('aiIconGif' in patch) dbPatch.ai_icon_gif = patch.aiIconGif;
  const { data, error } = await sb.from('app_appearance').update(dbPatch).eq('id', true).select().single();
  if (error) { showToast('Could not save — ' + error.message); return; }
  globalAppearance = dbRowToGlobalAppearance(data);
  cacheGlobalAppearanceLocally(globalAppearance);
  applyAppearance();
}
let appAppearanceChannel = null;
function startAppAppearanceWatch() {
  if (appAppearanceChannel || !currentUser) return;
  appAppearanceChannel = sb
    .channel('app-appearance-watch')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_appearance' }, (payload) => {
      globalAppearance = dbRowToGlobalAppearance(payload.new);
      cacheGlobalAppearanceLocally(globalAppearance);
      applyAppearance();
      if ($('appearanceOverlay')?.classList.contains('show')) renderAppearancePanel();
    })
    .subscribe();
}
function initGlobalAppearance() {
  fetchGlobalAppearance();
  startAppAppearanceWatch();
}

// Deterministic "one pick per day" index — same calendar day always yields
// the same index (so every device/session for this person matches, and it
// naturally advances at local midnight), until a manual shuffle overrides it.
function todayDayOfYear() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now - start) / 86400000);
}
function dayOfYearIndex(len, salt = 0) {
  if (!len) return 0;
  return (todayDayOfYear() + salt) % len;
}
// A manual "shuffle" only overrides TODAY's automatic pick — stamped with
// the day it was made so it naturally expires and resumes rotating once a
// new calendar day begins, without needing any cleanup elsewhere.
function activeManualPhotoIdx(prefs) {
  if (typeof prefs.bgPhotoManualIdx !== 'number') return null;
  if (prefs.bgPhotoManualDay !== todayDayOfYear()) return null;
  return prefs.bgPhotoManualIdx;
}

// Applies BOTH the local personal prefs (scheme, color theme) and the
// current global org-wide appearance (background mode/photos, logo, AI icon,
// quote visibility) — always reads fresh from
// getAppearancePrefs()/getGlobalAppearance() rather than taking params, so
// any caller (a save, a realtime push, the 15-min tick) can just call
// applyAppearance() with no arguments and get the right result.
function applyAppearance() {
  const local = getAppearancePrefs();
  const g = getGlobalAppearance();
  const root = document.documentElement;
  // A person can personally opt out of the admin's automatic "Action
  // photos" background and use their own solid color instead — this only
  // ever affects their own device (bgOverridePhoto is a local pref, never
  // written to app_appearance), so it never changes what anyone else sees.
  const effectiveBgMode = (g.bgMode === 'photo' && local.bgOverridePhoto) ? 'gradient' : g.bgMode;
  root.setAttribute('data-scheme', local.scheme);
  root.setAttribute('data-bg-theme', local.bgTheme);
  root.setAttribute('data-bg-mode', effectiveBgMode);

  const logoContent = g.customLogo
    ? `<img src="${g.customLogo}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:inherit; display:block;" />`
    : LOGO_PRESETS[0].svg;
  ['appLogoMark', 'authBrandLogoMark', 'aboutHeroLogoMark'].forEach((id) => {
    const el = $(id);
    if (el) el.innerHTML = logoContent;
  });

  // AEON Ai orb icon — admin can replace the default CSS orb with an
  // uploaded GIF/image, org-wide. When set, swap in a plain <img> that fills
  // the button; when cleared, restore the default animated CSS flame layers.
  const orb = $('aiOrb');
  if (orb) {
    if (g.aiIconGif) {
      orb.classList.add('ai-orb-custom');
      orb.style.backgroundImage = `url("${g.aiIconGif}")`;
    } else {
      orb.classList.remove('ai-orb-custom');
      orb.style.backgroundImage = '';
    }
  }

  const layer = $('bgPhotoLayer');
  if (layer && effectiveBgMode === 'photo') {
    const ids = sportsPhotoIdsForCategory(g.bgPhotoCategory);
    const manualIdx = activeManualPhotoIdx(g);
    const idx = (manualIdx !== null) ? manualIdx : dayOfYearIndex(ids.length);
    const photoId = ids[idx % ids.length];
    layer.style.backgroundImage = `url("${sportsPhotoUrl(photoId)}")`;
  }

  // Quote of the Day can be turned off entirely (Appearance → Today's
  // quote → Hide) — this only hides the dashboard card on this person's own
  // device; the daily rotation itself keeps running underneath so it's back
  // instantly if re-enabled.
  const quoteCard = $('quoteOfDayCard');
  if (quoteCard) quoteCard.style.display = (g.showQuote === false) ? 'none' : '';
  renderQuoteOfDay();
}

function renderQuoteOfDay() {
  const idx = dayOfYearIndex(QUOTES.length);
  const q = QUOTES[idx];
  if ($('quoteOfDayText')) $('quoteOfDayText').textContent = q.text;
  if ($('quoteOfDayAuthor')) $('quoteOfDayAuthor').textContent = `— ${q.author}`;
  if ($('appearanceQuoteText')) $('appearanceQuoteText').textContent = q.text;
  if ($('appearanceQuoteAuthor')) $('appearanceQuoteAuthor').textContent = `— ${q.author}`;
}

let appearancePanelWired = false;
function renderAppearancePanel() {
  const prefs = getAppearancePrefs();
  const g = getGlobalAppearance();
  const isAdmin = currentProfile?.role === 'admin';

  // Scheme buttons (local, personal)
  document.querySelectorAll('#schemePickerRow [data-scheme-choice]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.schemeChoice === prefs.scheme);
  });
  // Quote of the Day show/hide buttons — org-wide, admin-only (everyone else
  // never sees this card at all; they just see whatever's currently set).
  if ($('quoteAdminCard')) $('quoteAdminCard').style.display = isAdmin ? 'block' : 'none';
  document.querySelectorAll('#quoteTogglePickerRow [data-quote-choice]').forEach((btn) => {
    const wantsShow = btn.dataset.quoteChoice === 'show';
    btn.classList.toggle('active', wantsShow === (g.showQuote !== false));
  });

  // Background mode, Logo, and AI icon are org-wide and admin-only to edit —
  // everyone else never sees these cards at all (they still just see
  // whatever the admin picked, applied by applyAppearance()).
  if ($('bgAdminCard')) $('bgAdminCard').style.display = isAdmin ? 'block' : 'none';
  if ($('logoAdminCard')) $('logoAdminCard').style.display = isAdmin ? 'block' : 'none';
  if ($('aiIconAdminCard')) $('aiIconAdminCard').style.display = isAdmin ? 'block' : 'none';

  // Background-mode buttons
  document.querySelectorAll('#bgModePickerRow [data-bgmode-choice]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.bgmodeChoice === g.bgMode);
  });
  if ($('bgPhotoOptionsArea')) $('bgPhotoOptionsArea').style.display = g.bgMode === 'photo' ? 'block' : 'none';

  // Color Theme — personal, per-device, open to anyone with Appearance
  // access (not admin-gated), and always visible now. When the admin's
  // Background mode is "Color theme" the swatches just apply directly like
  // before. When it's "Action photos", the override row below lets this one
  // person switch to their own solid color instead, without touching what
  // anyone else sees — that choice lives in local bgOverridePhoto, never
  // written to the org-wide app_appearance table.
  if ($('colorThemeCard')) $('colorThemeCard').style.display = 'block';
  if ($('colorThemeOverrideRow')) $('colorThemeOverrideRow').style.display = g.bgMode === 'photo' ? 'flex' : 'none';
  document.querySelectorAll('#colorThemeOverrideRow [data-bgoverride-choice]').forEach((btn) => {
    const wantsOn = btn.dataset.bgoverrideChoice === 'on';
    btn.classList.toggle('active', wantsOn === !!prefs.bgOverridePhoto);
  });

  // Theme swatches (rebuild once, otherwise just refresh 'active')
  const swatchRow = $('bgThemeSwatchRow');
  if (swatchRow && !swatchRow.dataset.built) {
    swatchRow.innerHTML = THEME_PRESETS.map((t) =>
      `<button type="button" class="theme-swatch-btn" data-theme-choice="${t.id}" title="${escapeHtml(t.label)}" style="background:${t.swatch}"></button>`
    ).join('');
    swatchRow.dataset.built = '1';
  }
  if (swatchRow) {
    swatchRow.querySelectorAll('[data-theme-choice]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeChoice === prefs.bgTheme);
    });
  }

  // Photo category dropdown
  const catSelect = $('bgPhotoCategorySelect');
  if (catSelect && !catSelect.dataset.built) {
    catSelect.innerHTML = Object.entries(SPORTS_PHOTO_CATEGORY_LABELS).map(([id, label]) =>
      `<option value="${id}">${escapeHtml(label)}</option>`
    ).join('');
    catSelect.dataset.built = '1';
  }
  if (catSelect) catSelect.value = g.bgPhotoCategory;
  const previewImg = $('bgPhotoPreviewImg');
  if (previewImg) {
    const ids = sportsPhotoIdsForCategory(g.bgPhotoCategory);
    const manualIdx = activeManualPhotoIdx(g);
    const idx = (manualIdx !== null) ? manualIdx : dayOfYearIndex(ids.length);
    previewImg.src = sportsPhotoUrl(ids[idx % ids.length]);
  }

  // Logo upload preview
  const logoPreview = $('logoUploadPreview');
  if (logoPreview) {
    logoPreview.innerHTML = g.customLogo
      ? `<img src="${g.customLogo}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:inherit; display:block;" />`
      : LOGO_PRESETS[0].svg;
  }

  // AI orb icon upload preview
  const aiIconPreview = $('aiIconUploadPreview');
  if (aiIconPreview) {
    aiIconPreview.innerHTML = g.aiIconGif
      ? `<img src="${g.aiIconGif}" alt="" style="width:100%; height:100%; object-fit:cover; border-radius:50%; display:block;" />`
      : `<span style="font-size:28px;">🤖</span>`;
  }
  if ($('aiIconResetBtn')) $('aiIconResetBtn').style.display = g.aiIconGif ? 'block' : 'none';

  renderQuoteOfDay();

  if (appearancePanelWired) return;
  appearancePanelWired = true;

  document.querySelectorAll('#schemePickerRow [data-scheme-choice]').forEach((btn) => {
    btn.addEventListener('click', () => { saveAppearancePrefs({ scheme: btn.dataset.schemeChoice }); renderAppearancePanel(); });
  });
  document.querySelectorAll('#quoteTogglePickerRow [data-quote-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      saveGlobalAppearance({ showQuote: btn.dataset.quoteChoice === 'show' }).then(renderAppearancePanel);
    });
  });
  document.querySelectorAll('#bgModePickerRow [data-bgmode-choice]').forEach((btn) => {
    btn.addEventListener('click', () => { saveGlobalAppearance({ bgMode: btn.dataset.bgmodeChoice }).then(renderAppearancePanel); });
  });
  document.querySelectorAll('#colorThemeOverrideRow [data-bgoverride-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      saveAppearancePrefs({ bgOverridePhoto: btn.dataset.bgoverrideChoice === 'on' });
      renderAppearancePanel();
    });
  });
  if (swatchRow) {
    swatchRow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-choice]');
      if (!btn) return;
      saveAppearancePrefs({ bgTheme: btn.dataset.themeChoice });
      renderAppearancePanel();
    });
  }
  if (catSelect) {
    catSelect.addEventListener('change', () => {
      saveGlobalAppearance({ bgPhotoCategory: catSelect.value, bgPhotoManualIdx: null, bgPhotoManualDay: null }).then(renderAppearancePanel);
    });
  }
  if ($('bgPhotoShuffleBtn')) {
    $('bgPhotoShuffleBtn').addEventListener('click', () => {
      const ids = sportsPhotoIdsForCategory(getGlobalAppearance().bgPhotoCategory);
      const rand = Math.floor(Math.random() * ids.length);
      saveGlobalAppearance({ bgPhotoManualIdx: rand, bgPhotoManualDay: todayDayOfYear() }).then(renderAppearancePanel);
    });
  }
  const logoInput = $('logoUploadInput');
  if (logoInput) {
    logoInput.addEventListener('change', () => {
      const file = logoInput.files && logoInput.files[0];
      if (!file) return;
      if (file.size > 1.5 * 1024 * 1024) {
        showToast('That image is too large — please use something under 1.5MB.');
        logoInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        saveGlobalAppearance({ customLogo: reader.result }).then(() => {
          renderAppearancePanel();
          showToast('Logo updated for everyone.');
        });
      };
      reader.onerror = () => showToast('Could not read that image — please try another file.');
      reader.readAsDataURL(file);
    });
  }
  const aiIconInput = $('aiIconUploadInput');
  if (aiIconInput) {
    aiIconInput.addEventListener('change', () => {
      const file = aiIconInput.files && aiIconInput.files[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) {
        showToast('That GIF is too large — please use something under 3MB.');
        aiIconInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        saveGlobalAppearance({ aiIconGif: reader.result }).then(() => {
          renderAppearancePanel();
          showToast('AI icon updated for everyone.');
        });
      };
      reader.onerror = () => showToast('Could not read that file — please try another one.');
      reader.readAsDataURL(file);
    });
  }
  if ($('aiIconResetBtn')) {
    $('aiIconResetBtn').addEventListener('click', () => {
      saveGlobalAppearance({ aiIconGif: null }).then(() => {
        if (aiIconInput) aiIconInput.value = '';
        renderAppearancePanel();
        showToast('Reverted to the default AI icon for everyone.');
      });
    });
  }
  if ($('logoResetBtn')) {
    $('logoResetBtn').addEventListener('click', () => {
      saveGlobalAppearance({ customLogo: null }).then(() => {
        if (logoInput) logoInput.value = '';
        renderAppearancePanel();
        showToast('Reverted to the default logo for everyone.');
      });
    });
  }
}

// Apply saved appearance immediately on load (local scheme/quote prefs are
// available synchronously; global background/logo fall back to defaults —
// or the last-known cache the no-flash <head> script already applied —
// until initGlobalAppearance()'s fetch resolves after sign-in). Re-picks the
// daily quote/photo automatically once a new calendar day is reached
// without needing the tab to be closed and reopened.
applyAppearance();
setInterval(() => {
  applyAppearance();
  if ($('home')?.classList.contains('active')) renderQuoteOfDay();
}, 15 * 60 * 1000);

// Each step points at one element already on the Home screen (a home tile,
// a nav tab, or a header icon). `optional` steps are silently skipped if
// their target isn't in the DOM or isn't currently visible (e.g. an
// admin-only button for a non-admin, or a weather badge that hasn't loaded
// yet) — see tutorialVisibleSteps().
const TUTORIAL_STEPS = [
  { selector: 'nav.tabs [data-tab="home"]', icon: '🏠', title: 'Welcome!', text: "This is Home — everything in the app is one tap away from here. Let's take a quick look around." },
  { selector: '#updateStatusBtn', icon: '🔄', title: 'App updates', text: 'Tap here anytime to check whether a newer version is ready to install.' },
  { selector: '#weatherBadge', icon: '🌤️', title: 'Weather', text: "Your local weather at a glance — tap it for the full forecast." },
  { selector: '#adminHomeBtn', icon: '⚙️', title: 'Admin tools', text: 'Admin-only management screens — Team, Projects, Departments, and more — live behind this button.' },
  { selector: '.home-tile[data-tab="entry"]', icon: '📝', title: 'New Entry', text: 'Log your timesheet, a daily progress update, or a project report here.' },
  { selector: '.home-tile[data-tab="queue"]', icon: '📋', title: 'Queue', text: "Everything you've submitted, and its current status, lives here." },
  { selector: '.home-tile[data-open="specialRequest"]', icon: '🕐', title: 'Special Request', text: 'Request extra hours, leave, or another kind of special approval.' },
  { selector: '.home-tile[data-tab="reports"]', icon: '📊', title: 'Reports', text: 'Review the daily progress reports you and your team have submitted.' },
  { selector: '.home-tile[data-open="projects"]', icon: '📁', title: 'Active Projects', text: 'Browse every ongoing project, with allocated vs. used hours at a glance.' },
  { selector: '#homeChatTile', icon: '💬', title: 'Chat', text: 'Message your team directly, right inside the app.' },
  { selector: '.home-tile[data-open="myjobs"]', icon: '🗂️', title: 'My Jobs', text: "See what job you're allocated to right now." },
  { selector: '.home-tile[data-open="liveDrivers"]', icon: '🚗', title: 'Live Drivers', text: 'Track drivers and their trips live on the map.' },
  { selector: '.home-tile[data-open="departments"]', icon: '🏢', title: 'Departments', text: "See who's in each department and what they're working on today." },
  { selector: '.home-tile[data-open="learning"]', icon: '🎓', title: 'Learning', text: 'Free courses and certifications — AI, coding, safety, PLC, HMI, and more.' },
  { selector: '.home-tile[data-open="health"]', icon: '💪', title: 'Health', text: 'Simple wellbeing tips and trusted health resources.' },
  { selector: '.home-tile[data-open="clients"]', icon: '🤝', title: 'Clients', text: 'Manage client records.' },
  { selector: '.home-tile[data-open="quotations"]', icon: '🧾', title: 'Quotations', text: 'Create and track quotations and BOQs.' },
  { selector: '.home-tile[data-open="tank"]', icon: '🛢️', title: 'Project Tank', text: 'A quick visual read on your overall project pipeline.' },
  { selector: '.home-tile[data-open="allocation"]', icon: '🚚', title: 'Job Allocation', text: "See — or if you're an admin, publish — who's assigned to which job today." },
  { selector: '.home-tile[data-open="datafeed"]', icon: '📥', title: 'Data Feed', text: 'Add or remove people and jobs, and manage the job types/categories used everywhere else.' },
  { selector: '.home-tile[data-tab="settings"]', icon: '⚙️', title: 'Settings', text: 'Your account, password, and notification preferences.' },
  { selector: '#aiOrb', icon: '🤖', title: 'AEON Ai', text: 'This floating button is always one tap away — ask it about your timesheets, leave, reports, or anything you need help with.' },
  { selector: '#newsHandle', icon: '📰', title: 'News Room', text: 'Pull this tab on the left edge (or tap it) to read company announcements and updates.' },
  { selector: '#qsrHandle', icon: '🎮', title: 'Quick Job Switch', text: 'Once you\'re clocked in, this handle appears on the right edge — use it to jump between jobs during the day without leaving your current screen.' },
  { selector: '.home-tile[data-open="about"]', icon: '✅', title: "You're all set!", text: "Come back to About anytime — from here you can always re-check the app version or replay this tour." },
];

let tutorialStepIndex = 0;
let tutorialResizeHandler = null;

function tutorialVisibleSteps() {
  return TUTORIAL_STEPS.filter((step) => {
    const el = document.querySelector(step.selector);
    if (!el) return false;
    if (el.offsetParent === null) return false; // hidden (display:none, feature-gated, or an ancestor is hidden)
    return true;
  });
}

function startTutorial() {
  closePanel('about');
  document.querySelector('nav.tabs [data-tab="home"]')?.click();
  tutorialStepIndex = 0;
  $('tutorialOverlay').style.display = 'block';
  // Give the Home tab a moment to become visible/laid out before measuring
  // the first target element's position.
  setTimeout(() => showTutorialStep(), 120);
}

function endTutorial() {
  $('tutorialOverlay').style.display = 'none';
  if (tutorialResizeHandler) {
    window.removeEventListener('resize', tutorialResizeHandler);
    tutorialResizeHandler = null;
  }
}

function showTutorialStep() {
  const steps = tutorialVisibleSteps();
  if (!steps.length || tutorialStepIndex >= steps.length) { endTutorial(); return; }
  if (tutorialStepIndex < 0) tutorialStepIndex = 0;
  const step = steps[tutorialStepIndex];
  const el = document.querySelector(step.selector);
  if (!el) { tutorialStepIndex++; showTutorialStep(); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Let the smooth-scroll settle before measuring the target's final position.
  setTimeout(() => positionTutorialStep(el, step, steps.length), 240);
}

function positionTutorialStep(el, step, total) {
  const rect = el.getBoundingClientRect();
  const pad = 8;
  const spot = $('tutorialSpotlight');
  spot.style.left = `${Math.max(4, rect.left - pad)}px`;
  spot.style.top = `${Math.max(4, rect.top - pad)}px`;
  spot.style.width = `${rect.width + pad * 2}px`;
  spot.style.height = `${rect.height + pad * 2}px`;

  $('tutorialCardIcon').textContent = step.icon || '✨';
  $('tutorialCardTitle').textContent = step.title;
  $('tutorialCardText').textContent = step.text;
  $('tutorialStepNum').textContent = String(tutorialStepIndex + 1);
  $('tutorialStepTotal').textContent = String(total);
  $('tutorialBackBtn').style.visibility = tutorialStepIndex === 0 ? 'hidden' : 'visible';
  $('tutorialNextBtn').textContent = (tutorialStepIndex === total - 1) ? 'Finish' : 'Next';

  // Keep the card from covering whatever it's pointing at: pin it to the
  // top of the screen when the target sits in the lower half, and vice versa.
  const card = $('tutorialCard');
  const inLowerHalf = rect.top > window.innerHeight / 2;
  card.classList.toggle('tutorial-card-top', inLowerHalf);
  card.classList.toggle('tutorial-card-bottom', !inLowerHalf);

  if (tutorialResizeHandler) window.removeEventListener('resize', tutorialResizeHandler);
  tutorialResizeHandler = () => positionTutorialStep(el, step, total);
  window.addEventListener('resize', tutorialResizeHandler);
}

if ($('startTutorialBtn')) $('startTutorialBtn').addEventListener('click', startTutorial);
if ($('tutorialNextBtn')) $('tutorialNextBtn').addEventListener('click', () => { tutorialStepIndex++; showTutorialStep(); });
if ($('tutorialBackBtn')) $('tutorialBackBtn').addEventListener('click', () => { tutorialStepIndex--; showTutorialStep(); });
if ($('tutorialSkipBtn')) $('tutorialSkipBtn').addEventListener('click', endTutorial);

// =====================================================================
// DEPARTMENTS — admin creates/manages a list of departments; every person
// is assigned to one (Admin → Team). Anyone can browse the list and open a
// department to see who's in it and what each person's Job Allocation says
// they're doing today.
// =====================================================================

let departmentsCache = null; // [{id, name}], refetched each time the picker is (re)opened

async function fetchDepartments() {
  try {
    const { data, error } = await sb.from('departments').select('id, name, head_id').order('name', { ascending: true });
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

// Pulls allocated hours straight from the JOB DATA Google Sheet into
// project_department_hours — no manual typing of hours per job. Reads the
// same sheet every time it's tapped, so re-running it after you update the
// sheet just overwrites with the latest numbers.
if ($('syncJobHoursBtn')) {
  $('syncJobHoursBtn').addEventListener('click', async () => {
    const btn = $('syncJobHoursBtn');
    const resultBox = $('syncJobHoursResult');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    resultBox.innerHTML = '<div class="empty">Reading the sheet…</div>';
    try {
      const { data: { session } } = await getSessionSafe();
      const { data, error } = await withTimeout(
        sb.functions.invoke('sync-job-hours', { headers: { Authorization: `Bearer ${session.access_token}` } }),
        45000,
        'Sync'
      );
      if (error || data?.error) {
        resultBox.innerHTML = `<div class="empty">Couldn't sync: ${escapeHtml(data?.error || await readFunctionsError(error))}</div>`;
        return;
      }
      const s = data.summary || {};
      const warnings = (data.warnings || []).slice(0, 8);
      resultBox.innerHTML = `
        <div class="entry-meta">✅ ${s.upserted || 0} hour budgets updated across ${s.jobsMatched || 0} jobs.</div>
        ${s.skippedNoProject ? `<div class="entry-meta">⚠️ ${s.skippedNoProject} row(s) skipped — Job No not found in Projects.</div>` : ''}
        ${s.skippedNoDept ? `<div class="entry-meta">⚠️ ${s.skippedNoDept} row(s) skipped — Department name didn't match any department in the app.</div>` : ''}
        ${warnings.length ? `<div class="entry-meta" style="margin-top:6px;">${warnings.map((w) => escapeHtml(w)).join('<br>')}</div>` : ''}
      `;
      showToast('Sheet synced.');
    } catch (err) {
      resultBox.innerHTML = `<div class="empty">Couldn't sync: ${escapeHtml(String(err?.message || err))}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Sync now from Google Sheet';
    }
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

let currentDepartmentDetailId = null;

async function openDepartmentDetail(deptId, deptName) {
  currentDepartmentDetailId = deptId;
  $('departmentDetailTitle').textContent = deptName;
  $('departmentDetailCount').textContent = '';
  $('departmentMembersArea').innerHTML = '<div class="empty">Loading…</div>';
  openPanel('departmentDetail');

  const isAdmin = currentProfile?.role === 'admin';
  if ($('departmentHeadCard')) $('departmentHeadCard').style.display = isAdmin ? 'block' : 'none';
  if (isAdmin) {
    const [{ data: dept }, { data: activePeople }] = await Promise.all([
      sb.from('departments').select('head_id').eq('id', deptId).maybeSingle(),
      sb.from('profiles').select('id, email, full_name').eq('status', 'active').order('full_name', { ascending: true }),
    ]);
    const sel = $('departmentHeadSelect');
    if (sel) {
      sel.innerHTML = '<option value="">— No head assigned —</option>' +
        (activePeople || []).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.full_name || p.email)}</option>`).join('');
      sel.value = dept?.head_id || '';
    }
  }

  const { data: people, error: peopleErr } = await sb
    .from('profiles')
    .select('id, email, full_name, position, last_seen')
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
    const isOnline = onlineUserIds.has(p.id);
    return `
      <div class="entry">
        <span class="type-icon">🙂<span class="presence-dot ${isOnline ? 'online' : ''}" data-presence-user="${p.id}"></span></span>
        <div class="entry-body">
          <div class="entry-desc">${escapeHtml(p.full_name || p.email)} <span class="chip synced" style="margin-left:6px;">${escapeHtml(posLabel)}</span></div>
          <div class="entry-meta">${jobText}</div>
          <div class="last-seen-text ${isOnline ? 'online' : ''}" data-last-seen-for="${p.id}" data-last-seen="${p.last_seen || ''}">${isOnline ? 'Online now' : lastSeenLabel(p.last_seen)}</div>
        </div>
      </div>
    `;
  }).join('');
}

if ($('saveDepartmentHeadBtn')) {
  $('saveDepartmentHeadBtn').addEventListener('click', async () => {
    if (!currentDepartmentDetailId) return;
    const btn = $('saveDepartmentHeadBtn');
    const headId = $('departmentHeadSelect').value || null;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const { error } = await sb.from('departments').update({ head_id: headId }).eq('id', currentDepartmentDetailId);
    btn.disabled = false;
    btn.textContent = 'Save';
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    showToast('Department head updated.');
  });
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
    <div class="entry" style="align-items:flex-start;">
      <span class="type-icon">🤝</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(c.name)}</div>
        <div class="entry-meta">${[c.contact_name, c.email, c.phone].filter(Boolean).map(escapeHtml).join(' · ') || 'No contact details yet'}</div>
        ${c.address ? `<div class="entry-meta">📍 ${escapeHtml(c.address)}${c.lat && c.lng ? ` · <a href="${liveMapUrl(c.lat, c.lng)}" target="_blank" rel="noopener">View map</a>` : ''}</div>` : ''}
      </div>
      ${isAdmin ? `
        <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
          <button type="button" class="ghost" data-set-client-location="${escapeHtml(c.id)}" title="Search / update this client's location">📍</button>
          <button type="button" class="ghost" data-delete-client="${escapeHtml(c.id)}">✕</button>
        </div>
      ` : ''}
    </div>
  `).join('');
  wrap.querySelectorAll('[data-delete-client]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await sb.from('clients').delete().eq('id', btn.dataset.deleteClient);
      renderClientsList();
    });
  });
  wrap.querySelectorAll('[data-set-client-location]').forEach((btn) => {
    btn.addEventListener('click', () => setClientLocation(btn.dataset.setClientLocation));
  });
}

// Lets an admin search a real address for an EXISTING client (new clients
// get this at creation time via the Address field below) — reuses the
// same Google Places text search that powers Company Finder.
async function setClientLocation(clientId) {
  const q = prompt("Search an address for this client (e.g. 'Jebel Ali Free Zone, Dubai'):");
  if (!q || !q.trim()) return;
  const { ok, places, error } = await companyTextSearch(q.trim(), { maxResults: 1 });
  if (!ok || !places.length) { showToast(error || "Couldn't find that address."); return; }
  const p = places[0];
  const { error: upErr } = await sb.from('clients').update({
    address: p.formattedAddress || q.trim(),
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
  }).eq('id', clientId);
  if (upErr) { showToast(`Couldn't save location: ${upErr.message}`); return; }
  showToast('Location updated.');
  renderClientsList();
}

// Same live as-you-type address dropdown used for driver trips / Job
// Allocation locations (wireAddressSearch, defined further down) — picking
// a suggestion stores lat/lon on the input itself via .dataset, which
// createClientBtn below reads directly. Wired lazily wherever it's used,
// since wireAddressSearch is declared later in this file but hoisting
// makes that fine, and the function no-ops safely if called before the
// panel's elements exist.
function wireNewClientAddressSearch() { wireAddressSearch('newClientAddress', 'newClientAddressResults'); }

if ($('createClientBtn')) {
  $('createClientBtn').addEventListener('click', async () => {
    const name = $('newClientName').value.trim();
    if (!name) { showToast('Enter a client name.'); return; }
    const addressInput = $('newClientAddress');
    const { error } = await sb.from('clients').insert({
      name,
      contact_name: $('newClientContact').value.trim() || null,
      email: $('newClientEmail').value.trim() || null,
      phone: $('newClientPhone').value.trim() || null,
      notes: $('newClientNotes').value.trim() || null,
      address: addressInput.value.trim() || null,
      lat: addressInput.dataset.lat ? parseFloat(addressInput.dataset.lat) : null,
      lng: addressInput.dataset.lon ? parseFloat(addressInput.dataset.lon) : null,
      created_by: currentUser.id,
    });
    if (error) { showToast(`Couldn't add client: ${error.message}`); return; }
    ['newClientName', 'newClientContact', 'newClientEmail', 'newClientPhone', 'newClientNotes', 'newClientAddress'].forEach((id) => { $(id).value = ''; });
    addressInput.dataset.lat = '';
    addressInput.dataset.lon = '';
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
// RENEWAL MANAGER — admin-only sticky-note board tracking every employee's
// passport / visa & EID / work permit / other-travel-visa / seamen book /
// CID clearance / CICPA renewal dates, synced from the HR Google Sheet by
// the sync-renewals Edge Function (see supabase/functions/sync-renewals).
//
// Thresholds (per explicit product decision): a card turns red once its
// document is within 30 days of expiry, and starts blinking once within 10
// days — both are just CSS classes applied from the same daysLeft number,
// nothing server-side. "Renewed" is a plain status flip (admin-only, via
// RLS on visa_renewals) that sinks the item to the renewed section at the
// bottom of the full list below the sticky stack; if the underlying sheet
// cell for that item is later edited again, sync-renewals resets it straight
// back to 'pending' on its own (see that function's comments) — re-editing
// always wins over a prior acknowledgment.
// =====================================================================

const RENEWAL_RED_DAYS = 30;
const RENEWAL_BLINK_DAYS = 10;
// Severity bands for the sticky-note colour gradient — calm (far away) through
// to critical/blinking (the two original decisions: red by 30 days, blinking
// alert by 10 days). Everything above 30 days is graded too (calm/watch) so
// the board reads as a light-to-red severity ramp instead of a flat two-colour
// switch. Order matters: first match wins, so keep tightest ranges first.
const RENEWAL_SEVERITY_BANDS = [
  { key: 'sev-critical', maxDays: RENEWAL_BLINK_DAYS, blink: true },
  { key: 'sev-near', maxDays: RENEWAL_RED_DAYS, blink: false },
  { key: 'sev-watch', maxDays: 90, blink: false },
  { key: 'sev-calm', maxDays: Infinity, blink: false },
];
function renewalSeverity(days) {
  if (days === null) return { key: 'sev-unknown', blink: false };
  for (const band of RENEWAL_SEVERITY_BANDS) {
    if (days <= band.maxDays) return band;
  }
  return RENEWAL_SEVERITY_BANDS[RENEWAL_SEVERITY_BANDS.length - 1];
}
const RENEWAL_DOC_LABELS = {
  passport: 'Passport',
  visa_eid: 'Visa & EID',
  work_permit: 'Work Permit',
  other_travel: 'Other Travel Visa',
  seamen_book: 'Seamen Book',
  cid_clearance: 'CID Clearance',
  cicpa: 'CICPA',
};

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function formatRenewalDate(dateStr) {
  if (!dateStr) return 'No date found — check sheet entry';
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function fetchRenewalRows() {
  const { data, error } = await sb.from('visa_renewals').select('*');
  if (error) { console.error('fetchRenewalRows failed:', error); return []; }
  return data || [];
}

// Per-employee fields that don't belong to any single document type (Date
// of Birth, Joining Date, Nationality, UID No, Visa/Permit Sponsor, Mobile
// No., Vehicle No.) — synced by sync-renewals into employee_details.
// Fetched alongside visa_renewals rows and cached the same way, keyed by
// employee_code for quick lookup when rendering a person's detail card.
let employeeDetailsCache = {};
async function fetchEmployeeDetailsMap() {
  const { data, error } = await sb.from('employee_details').select('*');
  if (error) { console.error('fetchEmployeeDetailsMap failed:', error); return {}; }
  const byCode = {};
  for (const row of data || []) byCode[row.employee_code] = row;
  return byCode;
}

function formatRenewalPastDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function sortRenewalRows(rows) {
  // Nulls (no parseable date) sort to the very end, after every dated item —
  // treated as "furthest away" rather than "most urgent".
  return [...rows].sort((a, b) => {
    const da = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
    const db = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
    return da - db;
  });
}

// The sheet's own raw cell text (row.raw_value) often carries real detail
// that the automated date-parser throws away — which country a travel
// visa is for, "multi-entry", a second onshore/offshore date, and so on
// (e.g. "Kenya visa-27.08.27 Schengen visa-26.05.27 Canada Visa-26.08.27").
// Only worth showing as its own line when it says more than the plain
// parsed date already does.
function renewalDetailText(row) {
  if (!row.raw_value) return '';
  const plainDate = row.expiry_date ? formatRenewalDate(row.expiry_date) : '';
  const normalized = row.raw_value.trim();
  if (!normalized) return '';
  if (plainDate && normalized === plainDate) return '';
  return normalized;
}

function renewalStickyHtml(row, index) {
  const days = daysUntil(row.expiry_date);
  const sev = renewalSeverity(days);
  const overdue = days !== null && days < 0;
  const daysLabel = days === null ? '—' : overdue ? `${Math.abs(days)}d overdue` : `${days}d left`;
  const detail = renewalDetailText(row);
  return `
    <div class="renewal-sticky ${sev.key} ${sev.blink ? 'is-blink' : ''}" data-renewal-id="${row.id}">
      <div class="renewal-sticky-top">
        <div>
          <div class="renewal-sticky-name">${escapeHtml(row.employee_name)}</div>
          <div class="renewal-sticky-doc">${escapeHtml(RENEWAL_DOC_LABELS[row.document_type] || row.document_type)} · ${escapeHtml(row.employee_code)}</div>
        </div>
        <div class="renewal-sticky-days ${overdue ? 'overdue' : ''}">${daysLabel}</div>
      </div>
      <div class="renewal-sticky-meta">Expiry: ${formatRenewalDate(row.expiry_date)}</div>
      ${detail ? `<div class="renewal-sticky-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
      <div class="renewal-sticky-actions">
        <button type="button" class="secondary renewal-renew-btn" data-renew-id="${row.id}">✅ Renewed</button>
      </div>
    </div>
  `;
}

function renewalRowHtml(row) {
  const isRenewed = row.status === 'renewed';
  const days = daysUntil(row.expiry_date);
  const sev = renewalSeverity(days);
  const detail = renewalDetailText(row);
  return `
    <div class="renewal-row ${isRenewed ? 'is-renewed' : sev.key}">
      <div class="renewal-row-left">
        <div class="renewal-row-name">${escapeHtml(row.employee_name)}</div>
        <div class="renewal-row-doc">${escapeHtml(RENEWAL_DOC_LABELS[row.document_type] || row.document_type)} · ${escapeHtml(row.employee_code)}</div>
        ${detail ? `<div class="renewal-row-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
      </div>
      <div class="renewal-row-right">
        <div class="renewal-row-date">${formatRenewalDate(row.expiry_date)}${days !== null && !isRenewed ? ` (${days}d)` : ''}</div>
        ${isRenewed
          ? '<span class="hint">✅ Renewed</span>'
          : `<button type="button" class="secondary renewal-renew-btn" data-renew-id="${row.id}">Renew</button>`}
      </div>
    </div>
  `;
}

// Kept in memory after every load/refresh so the person-search box (top of
// the panel) can filter and show full per-person detail instantly, without
// a extra round-trip to Supabase for every keystroke or click.
let renewalRowsCache = [];
// Employee code of whichever person's detail card is currently open, so a
// Renew click (or a background refresh) can re-render that card in place
// instead of leaving it showing stale data.
let renewalDetailOpenFor = null;

async function renderRenewalManager() {
  const urgentArea = $('renewalUrgentArea');
  const fullListArea = $('renewalFullListArea');
  const statusLine = $('renewalSyncStatus');
  if (!urgentArea || !fullListArea) return;
  urgentArea.innerHTML = '<div class="empty">Loading…</div>';
  fullListArea.innerHTML = '';

  const [rows, detailsMap] = await Promise.all([fetchRenewalRows(), fetchEmployeeDetailsMap()]);
  renewalRowsCache = rows;
  employeeDetailsCache = detailsMap;
  if (renewalDetailOpenFor) renderRenewalPersonDetail(renewalDetailOpenFor, { silent: true });
  if (!rows.length) {
    urgentArea.innerHTML = '<div class="empty">No renewal data yet — tap "Refresh from sheet" once the Renewal Manager sheet has been shared with the service account.</div>';
    if (statusLine) statusLine.textContent = 'Nothing synced yet.';
    return;
  }

  const pending = sortRenewalRows(rows.filter((r) => r.status !== 'renewed'));
  const renewed = rows.filter((r) => r.status === 'renewed')
    .sort((a, b) => new Date(b.renewed_at || 0).getTime() - new Date(a.renewed_at || 0).getTime());

  urgentArea.innerHTML = pending.length
    ? `<div class="renewal-stack">${pending.map(renewalStickyHtml).join('')}</div>`
    : '<div class="empty">Nothing pending — everything is renewed. 🎉</div>';

  fullListArea.innerHTML = [...pending, ...renewed].map(renewalRowHtml).join('');

  const lastSynced = rows.reduce((max, r) => {
    const t = r.last_synced_at ? new Date(r.last_synced_at).getTime() : 0;
    return t > max ? t : max;
  }, 0);
  if (statusLine) {
    statusLine.textContent = lastSynced
      ? `${rows.length} tracked · last synced ${new Date(lastSynced).toLocaleString()}`
      : `${rows.length} tracked`;
  }

  urgentArea.querySelectorAll('.renewal-renew-btn').forEach((btn) => {
    btn.addEventListener('click', () => markRenewalRenewed(btn.dataset.renewId));
  });
  fullListArea.querySelectorAll('.renewal-renew-btn').forEach((btn) => {
    btn.addEventListener('click', () => markRenewalRenewed(btn.dataset.renewId));
  });
}

// Append-only "who changed what" trail — written alongside every real
// human action (renew/edit/delete) a person takes through the app, NOT by
// sync-renewals' automated sheet sync, so an admin only ever sees actual
// people's actions here (see supabase/renewal_delegation_and_audit_migration.sql
// for the visa_renewals_audit_log table + RLS). Failures are logged but
// never block the underlying action — a missing audit row shouldn't stop
// someone from renewing/editing/deleting a real record.
async function logRenewalAudit(action, row, { oldValues = null, newValues = null } = {}) {
  try {
    await sb.from('visa_renewals_audit_log').insert({
      visa_renewal_id: row?.id || null,
      employee_code: row?.employee_code || null,
      employee_name: row?.employee_name || null,
      document_type: row?.document_type || null,
      action,
      changed_by: currentUser?.id || null,
      changed_by_email: currentUser?.email || null,
      old_values: oldValues,
      new_values: newValues,
    });
  } catch (err) {
    console.warn('logRenewalAudit failed (continuing anyway):', err);
  }
}

async function markRenewalRenewed(id) {
  if (!id) return;
  const before = renewalRowsCache.find((r) => r.id === id) || null;
  const patch = {
    status: 'renewed',
    renewed_at: new Date().toISOString(),
    renewed_by: currentUser?.email || null,
  };
  const { error } = await sb.from('visa_renewals').update(patch).eq('id', id);
  if (error) { showToast(`Couldn't update: ${error.message}`); return; }
  logRenewalAudit('renew', before, {
    oldValues: before ? { status: before.status, renewed_at: before.renewed_at } : null,
    newValues: patch,
  });
  showToast('Marked renewed.');
  renderRenewalManager();
}

// ---------- Edit ----------
// Editable fields kept deliberately narrow: the expiry date itself, plus
// whichever document-number field applies to that document type. Employee
// name/code and document type stay fixed — those come from the sheet sync
// and are the join key back to that person's other rows.
const RENEWAL_NUMBER_FIELD = {
  passport: { key: 'passport_number', label: 'Passport No' },
  visa_eid: { key: 'eid_number', label: 'EID No' },
};
let renewalEditId = null;
function openRenewalEditForm(id) {
  const row = renewalRowsCache.find((r) => r.id === id);
  if (!row) return;
  renewalEditId = id;
  if ($('renewalEditPersonName')) $('renewalEditPersonName').textContent = `${row.employee_name} — ${RENEWAL_DOC_LABELS[row.document_type] || row.document_type}`;
  if ($('renewalEditExpiry')) $('renewalEditExpiry').value = row.expiry_date || '';
  const numField = RENEWAL_NUMBER_FIELD[row.document_type];
  const numRow = $('renewalEditNumberRow');
  if (numRow) {
    if (numField) {
      numRow.style.display = 'block';
      if ($('renewalEditNumberLabel')) $('renewalEditNumberLabel').textContent = numField.label;
      if ($('renewalEditNumberInput')) $('renewalEditNumberInput').value = row[numField.key] || '';
    } else {
      numRow.style.display = 'none';
    }
  }
  if (numField && $('renewalEditVisaNumberRow')) {
    // visa_eid also carries a separate Visa No alongside EID No.
    const showVisaNo = row.document_type === 'visa_eid';
    $('renewalEditVisaNumberRow').style.display = showVisaNo ? 'block' : 'none';
    if (showVisaNo && $('renewalEditVisaNumberInput')) $('renewalEditVisaNumberInput').value = row.visa_number || '';
  } else if ($('renewalEditVisaNumberRow')) {
    $('renewalEditVisaNumberRow').style.display = 'none';
  }
  openPanel('renewalEdit');
}

async function saveRenewalEdit() {
  if (!renewalEditId) return;
  const before = renewalRowsCache.find((r) => r.id === renewalEditId);
  if (!before) return;
  const patch = { expiry_date: $('renewalEditExpiry')?.value || null };
  const numField = RENEWAL_NUMBER_FIELD[before.document_type];
  if (numField) patch[numField.key] = $('renewalEditNumberInput')?.value.trim() || null;
  if (before.document_type === 'visa_eid') patch.visa_number = $('renewalEditVisaNumberInput')?.value.trim() || null;

  const { error } = await sb.from('visa_renewals').update(patch).eq('id', renewalEditId);
  if (error) { showToast(`Couldn't save: ${error.message}`); return; }
  logRenewalAudit('edit', before, {
    oldValues: { expiry_date: before.expiry_date, ...(numField ? { [numField.key]: before[numField.key] } : {}), ...(before.document_type === 'visa_eid' ? { visa_number: before.visa_number } : {}) },
    newValues: patch,
  });
  showToast('Saved.');
  closePanel('renewalEdit');
  renewalEditId = null;
  await renderRenewalManager();
  if (renewalDetailOpenFor) renderRenewalPersonDetail(renewalDetailOpenFor, { silent: true });
}

// ---------- Delete ----------
async function deleteRenewalRow(id) {
  const row = renewalRowsCache.find((r) => r.id === id);
  if (!row) return;
  const label = `${row.employee_name} — ${RENEWAL_DOC_LABELS[row.document_type] || row.document_type}`;
  if (!confirm(`Delete this record?\n\n${label}\n\nThis can't be undone (though it stays in the edit history).`)) return;
  const { error } = await sb.from('visa_renewals').delete().eq('id', id);
  if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
  logRenewalAudit('delete', row, { oldValues: row, newValues: null });
  showToast('Deleted.');
  await renderRenewalManager();
  if (renewalDetailOpenFor) renderRenewalPersonDetail(renewalDetailOpenFor, { silent: true });
}

// ---------- Person search (top of the panel) ----------
// Free-text filter over the in-memory rows cache — matches employee name
// or code, groups multiple rows (one per document type) back into a
// single result per person, and shows the top handful of matches as the
// admin types.
function renderRenewalPersonResults(query) {
  const resultsArea = $('renewalPersonResults');
  if (!resultsArea) return;
  const q = query.trim().toLowerCase();
  if (!q) { resultsArea.innerHTML = ''; return; }

  const byCode = new Map();
  for (const row of renewalRowsCache) {
    if (!byCode.has(row.employee_code)) {
      byCode.set(row.employee_code, { employee_code: row.employee_code, employee_name: row.employee_name, count: 0 });
    }
    byCode.get(row.employee_code).count += 1;
  }
  const matches = [...byCode.values()].filter((p) =>
    (p.employee_name || '').toLowerCase().includes(q) || (p.employee_code || '').toLowerCase().includes(q)
  ).slice(0, 8);

  if (!matches.length) {
    resultsArea.innerHTML = '<div class="hint" style="padding:6px 2px;">No one matches that search.</div>';
    return;
  }
  resultsArea.innerHTML = matches.map((p) => `
    <button type="button" class="secondary renewal-person-result" data-person-code="${escapeHtml(p.employee_code)}" style="display:flex; justify-content:space-between; width:100%; margin-bottom:6px;">
      <span>${escapeHtml(p.employee_name)}</span>
      <span class="hint">${escapeHtml(p.employee_code)} · ${p.count} tracked</span>
    </button>
  `).join('');
  resultsArea.querySelectorAll('.renewal-person-result').forEach((btn) => {
    btn.addEventListener('click', () => renderRenewalPersonDetail(btn.dataset.personCode));
  });
}

// Full detail card for one person — every document type in
// RENEWAL_DOC_LABELS gets its own row, even ones this person has no sheet
// data for at all, so it's obvious at a glance what's missing vs. what's
// tracked and fine.
// numbersHtml: passport_number rides on the 'passport' row, eid_number +
// visa_number ride on the 'visa_eid' row (populated by sync-renewals) —
// shown as a small line under the label so the actual document number is
// visible right next to its expiry, not just buried in raw_value.
function renewalDocNumbersHtml(row) {
  if (!row) return '';
  const parts = [];
  if (row.passport_number) parts.push(`Passport No: ${escapeHtml(row.passport_number)}`);
  if (row.eid_number) parts.push(`EID No: ${escapeHtml(row.eid_number)}`);
  if (row.visa_number) parts.push(`Visa No: ${escapeHtml(row.visa_number)}`);
  if (!parts.length) return '';
  return `<div class="renewal-person-doc-numbers hint">${parts.join(' · ')}</div>`;
}

function renewalPersonDocRowHtml(row, label) {
  if (!row) {
    return `
      <div class="renewal-person-doc-row is-missing">
        <div class="renewal-person-doc-label">${escapeHtml(label)}</div>
        <div class="hint">Not tracked for this person</div>
      </div>
    `;
  }
  const isRenewed = row.status === 'renewed';
  const days = daysUntil(row.expiry_date);
  const sev = renewalSeverity(days);
  const overdue = days !== null && days < 0;
  const daysLabel = days === null ? '' : overdue ? `${Math.abs(days)}d overdue` : `${days}d left`;
  const detail = renewalDetailText(row);
  return `
    <div class="renewal-person-doc-row ${isRenewed ? 'is-renewed' : sev.key}">
      <div class="renewal-person-doc-label">${escapeHtml(label)}</div>
      ${renewalDocNumbersHtml(row)}
      <div class="renewal-person-doc-main">
        <span class="renewal-person-doc-date">${formatRenewalDate(row.expiry_date)}</span>
        ${isRenewed
          ? '<span class="hint">✅ Renewed</span>'
          : `<span class="renewal-sticky-days ${overdue ? 'overdue' : ''}">${daysLabel}</span>`}
      </div>
      ${detail ? `<div class="renewal-person-doc-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
      <div style="margin-top:4px; display:flex; gap:6px; flex-wrap:wrap;">
        ${!isRenewed ? `<button type="button" class="secondary renewal-renew-btn" data-renew-id="${row.id}">✅ Renewed</button>` : ''}
        <button type="button" class="ghost renewal-edit-btn" data-edit-id="${row.id}">✏️ Edit</button>
        <button type="button" class="ghost renewal-delete-btn" data-delete-id="${row.id}">🗑️</button>
      </div>
    </div>
  `;
}

// Personal-info block (Date of Birth, Joining Date, Nationality, UID No,
// Visa/Permit Sponsor, Mobile No., Vehicle No.) shown above the document
// rows in the person detail card — pulled from employeeDetailsCache, which
// is populated once per employee (independent of document type).
function renewalPersonInfoHtml(details) {
  if (!details) return '';
  const fields = [
    ['Mobile No.', details.mobile_no],
    ['Date of Birth', formatRenewalPastDate(details.date_of_birth)],
    ['Joining Date', formatRenewalPastDate(details.joining_date)],
    ['Nationality', details.nationality],
    ['UID No', details.uid_no],
    ['Visa/Permit Sponsor', details.visa_permit_sponsor],
    ['Vehicle No.', details.vehicle_no],
  ].filter(([, v]) => v);
  if (!fields.length) return '';
  return `
    <div class="renewal-person-info-grid">
      ${fields.map(([label, value]) => `
        <div class="renewal-person-info-item">
          <div class="hint">${escapeHtml(label)}</div>
          <div>${escapeHtml(String(value))}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// Deterministic-looking barcode drawn straight to canvas — no external
// library, so it works fully offline like the rest of this PWA. The bar
// widths/gaps are seeded off the employee code itself (same code always
// draws the same pattern), standing in for a real ID barcode per the HUD
// redesign — this replaces the old placeholder "face" entirely.
function seedHudRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function () {
    h += 0x6D2B79F5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function drawHudBarcode(canvas, code) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const rand = seedHudRandom(code || 'CTORQ');
  const barH = h - 22;
  let x = 8;
  ctx.fillStyle = '#39ffb0';
  while (x < w - 8) {
    const bw = 2 + Math.floor(rand() * 4);
    if (rand() > 0.4) ctx.fillRect(x, 4, bw, barH);
    x += bw + 2;
  }
  ctx.font = '11px Consolas, "Courier New", monospace';
  ctx.fillStyle = '#39ffb0';
  ctx.textAlign = 'center';
  ctx.fillText(code || '', w / 2, h - 4);
}

function renderRenewalPersonDetail(employeeCode, opts) {
  const { silent } = opts || {};
  const detailArea = $('renewalPersonDetail');
  if (!detailArea) return;
  if (!employeeCode) { detailArea.innerHTML = ''; renewalDetailOpenFor = null; return; }

  const personRows = renewalRowsCache.filter((r) => r.employee_code === employeeCode);
  if (!personRows.length) { detailArea.innerHTML = ''; renewalDetailOpenFor = null; return; }

  renewalDetailOpenFor = employeeCode;
  const name = personRows[0].employee_name;
  const byDocType = {};
  for (const row of personRows) byDocType[row.document_type] = row;
  const details = employeeDetailsCache[employeeCode];

  const rowsHtml = Object.entries(RENEWAL_DOC_LABELS)
    .map(([key, label]) => renewalPersonDocRowHtml(byDocType[key], label))
    .join('');
  const infoHtml = renewalPersonInfoHtml(details);

  // HUD redesign — hollow glowing panel with corner brackets, a scan-line
  // reveal sweep, and a barcode standing in for a photo. Scoped entirely
  // under .renewal-hud in styles.css so nothing else in the app is touched.
  detailArea.innerHTML = `
    <div class="renewal-hud">
      <div class="renewal-hud-corner tl"></div>
      <div class="renewal-hud-corner tr"></div>
      <div class="renewal-hud-corner bl"></div>
      <div class="renewal-hud-corner br"></div>
      <div class="renewal-hud-sweep"></div>
      <div class="renewal-hud-scan"></div>
      <div class="renewal-hud-head">
        <div class="renewal-hud-id">
          <canvas class="renewal-hud-barcode" width="160" height="46"></canvas>
          <div class="renewal-hud-name">${escapeHtml(name)}</div>
          <div class="renewal-hud-code">${escapeHtml(employeeCode)}</div>
        </div>
        <div class="renewal-hud-head-actions">
          ${currentProfile?.role === 'admin' ? `<button type="button" class="ghost renewal-hud-history" id="renewalPersonDetailHistory">🕘 History</button>` : ''}
          <button type="button" class="ghost renewal-hud-close" id="renewalPersonDetailClose">✕</button>
        </div>
      </div>
      ${infoHtml}
      <div class="renewal-hud-docs">
        ${rowsHtml}
      </div>
    </div>
  `;
  drawHudBarcode(detailArea.querySelector('.renewal-hud-barcode'), employeeCode);
  if (!silent) playHudConfirmSound();
  detailArea.querySelectorAll('.renewal-renew-btn').forEach((btn) => {
    btn.addEventListener('click', () => markRenewalRenewed(btn.dataset.renewId));
  });
  detailArea.querySelectorAll('.renewal-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openRenewalEditForm(btn.dataset.editId));
  });
  detailArea.querySelectorAll('.renewal-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteRenewalRow(btn.dataset.deleteId));
  });
  const historyBtn = $('renewalPersonDetailHistory');
  if (historyBtn) historyBtn.addEventListener('click', () => openRenewalHistory(employeeCode, name));
  const closeBtn = $('renewalPersonDetailClose');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    renewalDetailOpenFor = null;
    detailArea.innerHTML = '';
    const searchInput = $('renewalPersonSearch');
    const resultsArea = $('renewalPersonResults');
    if (searchInput) searchInput.value = '';
    if (resultsArea) resultsArea.innerHTML = '';
  });
}

// ---------- Edit History (admin-only) ----------
async function fetchRenewalAuditLog(employeeCode) {
  const { data, error } = await sb.from('visa_renewals_audit_log')
    .select('*')
    .eq('employee_code', employeeCode)
    .order('changed_at', { ascending: false })
    .limit(100);
  if (error) { console.error('fetchRenewalAuditLog failed:', error); return []; }
  return data || [];
}

function renewalAuditActionLabel(action) {
  if (action === 'renew') return '✅ Marked renewed';
  if (action === 'edit') return '✏️ Edited';
  if (action === 'delete') return '🗑️ Deleted';
  return action;
}

async function openRenewalHistory(employeeCode, personName) {
  if ($('renewalHistoryPersonName')) $('renewalHistoryPersonName').textContent = personName || employeeCode;
  const list = $('renewalHistoryList');
  if (list) list.innerHTML = '<div class="empty">Loading…</div>';
  openPanel('renewalHistory');
  const rows = await fetchRenewalAuditLog(employeeCode);
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No edits logged yet for this person.</div>';
    return;
  }
  list.innerHTML = rows.map((r) => `
    <div class="renewal-history-row">
      <div class="renewal-history-top">
        <span>${renewalAuditActionLabel(r.action)} — ${escapeHtml(RENEWAL_DOC_LABELS[r.document_type] || r.document_type || '')}</span>
        <span class="hint">${new Date(r.changed_at).toLocaleString()}</span>
      </div>
      <div class="hint">by ${escapeHtml(r.changed_by_email || 'Unknown')}</div>
    </div>
  `).join('');
}

if ($('renewalPersonSearch')) {
  $('renewalPersonSearch').addEventListener('input', (e) => renderRenewalPersonResults(e.target.value));
}

if ($('renewalEditSaveBtn')) {
  $('renewalEditSaveBtn').addEventListener('click', saveRenewalEdit);
}

if ($('renewalRefreshBtn')) {
  $('renewalRefreshBtn').addEventListener('click', async () => {
    const btn = $('renewalRefreshBtn');
    const statusLine = $('renewalSyncStatus');
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    if (statusLine) statusLine.textContent = 'Reading the sheet…';
    try {
      const { data: { session } } = await getSessionSafe();
      const { data, error } = await withTimeout(
        sb.functions.invoke('sync-renewals', { headers: { Authorization: `Bearer ${session.access_token}` } }),
        45000,
        'Sync'
      );
      if (error || data?.error) {
        showToast(`Couldn't sync: ${data?.error || await readFunctionsError(error)}`);
      } else {
        showToast(`Synced: ${data.upserted || 0} new, ${data.changed || 0} updated.`);
      }
    } catch (err) {
      showToast(`Couldn't sync: ${String(err?.message || err)}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Refresh from sheet';
      renderRenewalManager();
    }
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
      .select('job_id, name, status, received_date, client')
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

// Closed jobs stay hidden from this list by default (and were already
// invisible to the Job ID search everywhere — see populateJobIdDropdown's
// .eq('status','active')) so the list doesn't keep growing forever with
// finished work. Nothing about a closed job's history is touched — this is
// the non-destructive alternative to actually deleting a project.
let showClosedProjects = false;
if ($('showClosedProjectsToggle')) {
  $('showClosedProjectsToggle').addEventListener('change', (e) => {
    showClosedProjects = e.target.checked;
    renderProjectsList();
  });
}

// Free-text filter over the (potentially long) projects list — matches
// Job ID, name, or client, case-insensitively, as the admin types.
let projectSearchQuery = '';
if ($('projectsSearchInput')) {
  $('projectsSearchInput').addEventListener('input', (e) => {
    projectSearchQuery = e.target.value.trim().toLowerCase();
    renderProjectsList();
  });
}

async function toggleProjectStatus(jobId, currentStatus) {
  const nextStatus = currentStatus === 'active' ? 'closed' : 'active';
  const { error } = await sb.from('projects').update({ status: nextStatus }).eq('job_id', jobId);
  if (error) { showToast(`Couldn't update status: ${error.message}`); return; }
  showToast(nextStatus === 'closed' ? `${jobId} marked closed.` : `${jobId} reopened.`);
  renderProjectsList();
  populateJobIdDropdown();
}

// Small "Allocated" ring + "Used" ring shown right on each Projects list
// row, so you can see progress without opening every project. Batched via
// get-projects-hours-summary (one call for the whole visible list, not one
// per row) and cached here — only re-fetched for job_ids not seen yet.
let projectsHoursCache = {}; // jobId -> { allocatedHours, usedHours }
async function refreshProjectsHoursCache(jobIds) {
  if (!jobIds || !jobIds.length) return;
  try {
    const { data, error } = await sb.functions.invoke('get-projects-hours-summary', { body: { jobIds } });
    if (error) throw error;
    projectsHoursCache = { ...projectsHoursCache, ...(data?.hours || {}) };
  } catch (err) {
    console.warn('refreshProjectsHoursCache failed (row rings will just stay blank):', err);
  }
}
function miniProjectHoursRings(jobId) {
  const h = projectsHoursCache[jobId];
  const allocated = h?.allocatedHours || 0;
  const used = h?.usedHours || 0;
  const hasAllocated = !!h && allocated > 0;
  const hasUsed = !!h && (allocated > 0 || used > 0);
  const isOver = hasUsed && allocated > 0 && used > allocated;
  const ringOpts = { size: 44, stroke: 5 };
  return `
    <div class="mini-ring-pair">
      <div class="mini-ring-block">
        ${ringSvg(allocated, allocated, hasAllocated, ringOpts)}
        <div class="mini-ring-value ${hasAllocated ? 'under' : 'dim'}">${hasAllocated ? `${allocated}h` : '—'}</div>
        <div class="mini-ring-label">Allocated</div>
      </div>
      <div class="mini-ring-block">
        ${ringSvg(used, allocated, hasUsed, { ...ringOpts, underColor: 'var(--accent)' })}
        <div class="mini-ring-value ${!hasUsed ? 'dim' : (isOver ? 'over' : 'used-ok')}">${hasUsed ? `${used}h` : '—'}</div>
        <div class="mini-ring-label">Used</div>
      </div>
    </div>
  `;
}
// After the list itself renders (fast, from data already on hand), quietly
// fill in just the rings for whichever rows aren't in the cache yet — a
// second render pass, targeted at only the ring cells so the rest of the
// list (scroll position, search focus) is undisturbed.
function updateProjectRingsInPlace(jobIds) {
  jobIds.forEach((jobId) => {
    const cell = document.querySelector(`[data-mini-rings-for="${cssEscapeAttr(jobId)}"]`);
    if (cell) cell.innerHTML = miniProjectHoursRings(jobId);
  });
}
function cssEscapeAttr(v) {
  return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
}

// Small "who's got it right now" chip shown right on each Projects list row —
// same batching approach as the hours rings above (get-projects-stage-summary
// answers for the whole visible list in one call instead of one per row).
// Shows the department currently sitting with the job, the current stage's
// label, and exactly when it landed with them — which is also the moment the
// PREVIOUS department marked their part finished and handed off, since
// advance-project-stage stamps both sides of a hand-off with the same
// timestamp (see fetchStageState/renderProjectStages above).
let projectsStageCache = {}; // jobId -> { status, stageLabel, departmentName, since }
async function refreshProjectsStageCache(jobIds) {
  if (!jobIds || !jobIds.length) return;
  try {
    const { data, error } = await sb.functions.invoke('get-projects-stage-summary', { body: { jobIds } });
    if (error) throw error;
    projectsStageCache = { ...projectsStageCache, ...(data?.stages || {}) };
  } catch (err) {
    console.warn('refreshProjectsStageCache failed (row status chips will just stay blank):', err);
  }
}
// "Sep 5, 2:14 PM" — compact enough for a list-row chip.
function formatStageSince(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function miniProjectStageChip(jobId) {
  const s = projectsStageCache[jobId];
  if (!s) return `<div class="mini-stage-chip dim">Loading…</div>`;
  if (s.status === 'no_template' || s.status === 'not_started') return '';
  if (s.status === 'complete') return `<div class="mini-stage-chip done">✅ All stages complete</div>`;
  const since = formatStageSince(s.since);
  return `
    <div class="mini-stage-chip active" title="${escapeHtml(s.stageLabel || '')}">
      <div class="mini-stage-dept">🟥 On: ${escapeHtml(s.departmentName || 'Unassigned department')}</div>
      <div class="mini-stage-meta">${escapeHtml(s.stageLabel || '')}${since ? ` • since ${since}` : ''}</div>
    </div>
  `;
}
function updateProjectStageChipsInPlace(jobIds) {
  jobIds.forEach((jobId) => {
    const cell = document.querySelector(`[data-mini-stage-for="${cssEscapeAttr(jobId)}"]`);
    if (cell) cell.innerHTML = miniProjectStageChip(jobId);
  });
}

async function renderProjectsList(isRetry = false) {
  const wrap = $('projectsListArea');
  if (!wrap) return;
  if (!isRetry) wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { rows: allRows, error } = await fetchProjects();
  if (error) {
    if (!isRetry) { await new Promise((r) => setTimeout(r, 400)); return renderProjectsList(true); }
    wrap.innerHTML = `<div class="empty">Couldn't load projects: ${escapeHtml(error.message || String(error))}</div>`;
    return;
  }
  let rows = showClosedProjects ? allRows : allRows.filter((r) => (r.status || 'active') === 'active');
  if (!allRows.length) { wrap.innerHTML = '<div class="empty">No projects yet' + (currentProfile?.role === 'admin' ? ' — add one above.' : ' yet.') + '</div>'; return; }
  if (!rows.length) { wrap.innerHTML = '<div class="empty">No active projects — tap "Show closed jobs" above to see them.</div>'; return; }
  if (projectSearchQuery) {
    rows = rows.filter((r) =>
      (r.job_id || '').toLowerCase().includes(projectSearchQuery) ||
      (r.name || '').toLowerCase().includes(projectSearchQuery) ||
      (r.client || '').toLowerCase().includes(projectSearchQuery)
    );
    if (!rows.length) { wrap.innerHTML = `<div class="empty">No projects match "${escapeHtml(projectSearchQuery)}".</div>`; return; }
  }
  const isAdmin = currentProfile?.role === 'admin';
  wrap.innerHTML = rows.map((r) => {
    const isClosed = (r.status || 'active') !== 'active';
    return `
    <div class="entry" data-project-row="${escapeHtml(r.job_id)}" data-project-name="${escapeHtml(r.name || '')}" style="cursor:pointer;">
      <span class="type-icon">📁</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(r.job_id)}${r.name ? ' — ' + escapeHtml(r.name) : ''}${isClosed ? ' <span style="opacity:0.6; font-weight:400;">(Closed)</span>' : ''}</div>
        ${r.client ? `<div class="entry-meta">${escapeHtml(r.client)}</div>` : ''}
        ${r.received_date ? `<div class="entry-meta">${escapeHtml(r.received_date)}</div>` : ''}
        <div class="mini-stage-cell" data-mini-stage-for="${escapeHtml(r.job_id)}">${miniProjectStageChip(r.job_id)}</div>
      </div>
      <div class="mini-rings-cell" data-mini-rings-for="${escapeHtml(r.job_id)}">${miniProjectHoursRings(r.job_id)}</div>
      ${isAdmin ? `<button type="button" class="ghost" data-toggle-status="${escapeHtml(r.job_id)}" data-status="${escapeHtml(r.status || 'active')}" style="font-size:11px;">${isClosed ? 'Reopen' : 'Close'}</button>` : ''}
      ${isAdmin ? `<button type="button" class="ghost" data-delete-project="${escapeHtml(r.job_id)}">✕</button>` : ''}
    </div>
  `;
  }).join('');
  wrap.querySelectorAll('[data-project-row]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-project]') || e.target.closest('[data-toggle-status]')) return;
      openProjectDetail(row.dataset.projectRow, row.dataset.projectName);
    });
  });
  wrap.querySelectorAll('[data-toggle-status]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleProjectStatus(btn.dataset.toggleStatus, btn.dataset.status);
    });
  });
  wrap.querySelectorAll('[data-delete-project]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Permanently delete ${btn.dataset.deleteProject}? If you just want it off this list, use Close instead — that can be undone.`)) return;
      await sb.from('projects').delete().eq('job_id', btn.dataset.deleteProject);
      renderProjectsList();
      populateJobIdDropdown();
    });
  });

  // The list itself just opened at full speed using whatever's already
  // cached; now quietly fetch hours for any rows not seen before (first
  // open covers everyone currently visible in one batch — a later search/
  // filter re-render normally finds nothing missing here at all).
  const visibleIds = rows.map((r) => r.job_id);
  const missingIds = visibleIds.filter((id) => !projectsHoursCache[id]);
  if (missingIds.length) {
    refreshProjectsHoursCache(missingIds).then(() => {
      if ($('projectsOverlay')?.classList.contains('show')) updateProjectRingsInPlace(visibleIds);
    });
  }
  const missingStageIds = visibleIds.filter((id) => !projectsStageCache[id]);
  if (missingStageIds.length) {
    refreshProjectsStageCache(missingStageIds).then(() => {
      if ($('projectsOverlay')?.classList.contains('show')) updateProjectStageChipsInPlace(visibleIds);
    });
  }
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
// Apple-Watch-style dual ring: green fills 0→100% of allocated hours used;
// once used exceeds allocated, the green ring stays full and a second,
// smaller orange ring fills to show the overage.
function ringSvg(used, allocated, hasData = true, opts = {}) {
  const size = opts.size || 140;
  const stroke = opts.stroke || Math.round(size * 0.1);
  const rOuter = (size - stroke) / 2;
  const rInner = rOuter - stroke - 6;
  const cOuter = 2 * Math.PI * rOuter;
  const cInner = 2 * Math.PI * rInner;
  const cx = size / 2, cy = size / 2;
  if (!hasData) {
    // No hours logged or allotted for this department on this project yet —
    // draw a flat, fully-muted ring instead of the usual green/orange
    // progress rings so it reads as "present but inactive" rather than
    // vanishing from the screen entirely.
    return `
      <svg viewBox="0 0 ${size} ${size}" class="ring-svg">
        <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--glass-border)" stroke-width="${stroke}" />
        <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="${stroke}" />
      </svg>
    `;
  }
  // "Over budget" only means something once a budget actually exists. With
  // no allocated hours set yet (allocated === 0), ANY hours logged used to
  // read as "infinitely over" and light up red — wrong: that's just "no
  // budget set yet", not an overrun. Only compute overHours when there's a
  // real allocated number to be over.
  const usedPct = allocated > 0 ? Math.min(used / allocated, 1) : (used > 0 ? 1 : 0);
  const overHours = allocated > 0 ? Math.max(0, used - allocated) : 0;
  const overPct = allocated > 0 && overHours > 0 ? Math.min(overHours / allocated, 1) : 0;
  const outerOffset = cOuter * (1 - usedPct);
  const innerOffset = cInner * (1 - overPct);
  // forceOver: used by the big "all departments" ring to turn red even when
  // this particular total isn't itself over budget, because at least one
  // individual department underneath it is — the whole point of that ring
  // is "is anything wrong anywhere on this job", not just the grand total.
  const isOver = overHours > 0 || !!opts.forceOver;
  // Over-allocation is a red ring (not the old orange/warn) so it reads as
  // "needs attention" at a glance rather than just "getting close". The
  // "under budget" color defaults to green everywhere, but callers can pass
  // opts.underColor to use a different color for that state instead (e.g.
  // the Projects list's "Used" mini ring uses the app's orange accent here,
  // to read as visually distinct from the "Allocated" ring next to it).
  return `
    <svg viewBox="0 0 ${size} ${size}" class="ring-svg${isOver ? ' ring-svg-over' : ''}">
      <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--glass-border)" stroke-width="${stroke}" />
      <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="${isOver ? 'var(--err)' : (opts.underColor || 'var(--ok)')}" stroke-width="${stroke}"
        stroke-dasharray="${cOuter}" stroke-dashoffset="${outerOffset}" stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy})" />
      ${overHours > 0 ? `
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="var(--glass-border)" stroke-width="${stroke - 4}" />
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="var(--err)" stroke-width="${stroke - 4}"
        stroke-dasharray="${cInner}" stroke-dashoffset="${innerOffset}" stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy})" />` : ''}
    </svg>
  `;
}

function ringCard(roleLabel, used, allocated, hasData = true) {
  // A budget of 0 (nothing set yet) is NOT the same as being over budget —
  // it just means no one has told this ring what the budget is. Only treat
  // it as "over" once there's a real allocated number to compare against.
  const noBudgetSet = hasData && allocated <= 0 && used > 0;
  const over = allocated > 0 ? Math.max(0, Math.round((used - allocated) * 100) / 100) : 0;
  const remaining = allocated > 0 ? Math.max(0, Math.round((allocated - used) * 100) / 100) : 0;
  const centerText = !hasData ? '—' : noBudgetSet ? `${used}h` : (over > 0 ? `−${over}h` : `${remaining}h left`);
  const centerClass = !hasData ? 'dim' : noBudgetSet ? 'nobudget' : (over > 0 ? 'over' : 'under');
  const subText = !hasData ? 'No hours logged or allotted yet' : noBudgetSet ? `${used}h logged — no budget set yet` : `${used}h used of ${allocated}h`;
  return `
    <div class="ring-card${hasData ? '' : ' ring-card-dim'}">
      <div class="ring-role">${escapeHtml(roleLabel)}</div>
      ${ringSvg(used, allocated, hasData)}
      <div class="ring-center-value ${centerClass}">${centerText}</div>
      <div class="ring-sub">${subText}</div>
    </div>
  `;
}

// One BIG ring above the whole department grid — the total allocated vs
// total used hours across EVERY department on this job. Turns red the
// instant ANY single department is over its own budget (not just when the
// grand total is over — a department can be over even while the overall
// total still looks fine, because another department has spare budget
// offsetting it, and that should still be flagged here).
function bigTotalRingBlock(totalAllocated, totalUsed, overDeptNames) {
  const anyOver = overDeptNames.length > 0;
  const totalOverHours = totalAllocated > 0 ? Math.max(0, Math.round((totalUsed - totalAllocated) * 100) / 100) : 0;
  const remaining = totalAllocated > 0 ? Math.max(0, Math.round((totalAllocated - totalUsed) * 100) / 100) : 0;
  const centerText = totalOverHours > 0
    ? `−${totalOverHours}h`
    : (totalAllocated > 0 ? `${remaining}h left` : `${Math.round(totalUsed * 100) / 100}h logged`);
  const centerClass = anyOver || totalOverHours > 0 ? 'over' : (totalAllocated > 0 ? 'under' : 'dim');
  const subText = totalAllocated > 0
    ? `${Math.round(totalUsed * 100) / 100}h used of ${Math.round(totalAllocated * 100) / 100}h total`
    : `${Math.round(totalUsed * 100) / 100}h logged — no budgets set yet`;
  return `
    <div class="big-total-ring-card${anyOver || totalOverHours > 0 ? ' over' : ''}">
      <div class="big-total-ring-label">Total — every department on this job</div>
      ${ringSvg(totalUsed, totalAllocated, true, { size: 190, forceOver: anyOver })}
      <div class="big-total-ring-value ${centerClass}">${centerText}</div>
      <div class="ring-sub">${subText}</div>
      <div class="big-total-ring-stats">
        <div class="big-total-ring-stat">
          <div class="big-total-ring-stat-label">Total allocated</div>
          <div class="big-total-ring-stat-value">${totalAllocated > 0 ? `${Math.round(totalAllocated * 100) / 100}h` : 'Not set'}</div>
        </div>
        <div class="big-total-ring-stat">
          <div class="big-total-ring-stat-label">Total consumed</div>
          <div class="big-total-ring-stat-value">${Math.round(totalUsed * 100) / 100}h</div>
        </div>
      </div>
      ${overDeptNames.length ? `<div class="big-total-ring-warning">⚠️ Over budget: ${overDeptNames.map((n) => escapeHtml(n)).join(', ')}</div>` : ''}
    </div>
  `;
}

// A department renders as ONE ring (old behavior) unless it has real
// role-level rows (Electrical: Engineer/Supervisor/Lead Foreman/Technician/
// Helper, etc.) — in that case it renders as a titled group of smaller
// rings, one per role that actually has allocated or used hours, so an
// org manager can see at a glance exactly which role on which department
// is running over, not just the department as a whole.
const ROLE_RING_COLORS = {
  engineer: '#e08a5f',
  supervisor: '#63d197',
  foreman: '#7aa2e3',
  technician: '#c792ea',
  helper: '#f2b755',
};
function ringRoleColor(position) { return ROLE_RING_COLORS[position] || '#e08a5f'; }

// ONE combined ring per department (not a separate ring per role) — the
// outer ring's fill is split into colored arc segments, one per role, so
// "which role used how much of the department's total budget" is visible
// at a glance in a single ring, directly comparable department-to-department,
// with the exact breakdown spelled out in the legend underneath.
function segmentedRingSvg(roles, totalAllocated, totalUsed) {
  const size = 140, stroke = 14;
  const rOuter = (size - stroke) / 2;
  const rInner = rOuter - stroke - 6;
  const cOuter = 2 * Math.PI * rOuter;
  const cInner = 2 * Math.PI * rInner;
  const cx = size / 2, cy = size / 2;
  // Same "no false over-budget" rule as the single ring: only real once a
  // budget is actually set.
  const overHours = totalAllocated > 0 ? Math.max(0, totalUsed - totalAllocated) : 0;
  const overPct = totalAllocated > 0 && overHours > 0 ? Math.min(overHours / totalAllocated, 1) : 0;
  const innerOffset = cInner * (1 - overPct);

  // Walk each role's share of the outer ring, capped so the segments drawn
  // never exceed one full turn — anything past the budget is represented by
  // the separate inner overage ring instead, same as the single-ring case.
  let cursor = 0;
  let remaining = 1;
  const segments = [];
  roles.filter((r) => r.usedHours > 0).forEach((r) => {
    if (remaining <= 0) return;
    const frac = totalAllocated > 0
      ? Math.min(r.usedHours / totalAllocated, remaining)
      : (totalUsed > 0 ? Math.min(r.usedHours / totalUsed, remaining) : 0);
    if (frac <= 0) return;
    segments.push({ position: r.position, start: cursor, end: cursor + frac });
    cursor += frac;
    remaining -= frac;
  });

  const segmentCircles = segments.map((s) => {
    const segLen = (s.end - s.start) * cOuter;
    return `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="${ringRoleColor(s.position)}" stroke-width="${stroke}"
      stroke-dasharray="${segLen} ${cOuter - segLen}" stroke-dashoffset="${cOuter * (1 - s.start)}" stroke-linecap="butt"
      transform="rotate(-90 ${cx} ${cy})" />`;
  }).join('');

  return `
    <svg viewBox="0 0 ${size} ${size}" class="ring-svg${overHours > 0 ? ' ring-svg-over' : ''}">
      <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--glass-border)" stroke-width="${stroke}" />
      ${segmentCircles}
      ${overHours > 0 ? `
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="var(--glass-border)" stroke-width="${stroke - 4}" />
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="var(--err)" stroke-width="${stroke - 4}"
        stroke-dasharray="${cInner}" stroke-dashoffset="${innerOffset}" stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy})" />` : ''}
    </svg>
  `;
}

// The people who actually logged hours against this job FROM this
// department — shown right inside the department's own card, so "who used
// how much" doesn't require scrolling down to the separate contributors
// list and cross-referencing department names by eye.
function deptPeopleListHtml(people) {
  if (!people || !people.length) return '';
  const sorted = [...people].sort((a, b) => b.hours - a.hours);
  return `
    <div class="dept-people-list">
      ${sorted.map((p) => `
        <div class="dept-people-row">
          <span class="dept-people-dot" style="background:${ringRoleColor(p.position)}"></span>
          <span class="dept-people-name">${escapeHtml(p.name)}</span>
          <span class="dept-people-hours">${p.hours}h</span>
        </div>
      `).join('')}
    </div>
  `;
}

function deptRingBlock(dept) {
  const roleRows = (dept.roles || []).filter((r) => r.position !== 'general' && (r.allocatedHours > 0 || r.usedHours > 0));
  const peopleHtml = deptPeopleListHtml(dept.people);
  if (!roleRows.length) {
    return peopleHtml
      ? `<div class="dept-ring-single-wrap">${ringCard(dept.name, dept.usedHours, dept.allocatedHours, dept.hasData)}${peopleHtml}</div>`
      : ringCard(dept.name, dept.usedHours, dept.allocatedHours, dept.hasData);
  }
  const totalAllocated = dept.allocatedHours;
  const totalUsed = dept.usedHours;
  const noBudgetSet = totalAllocated <= 0 && totalUsed > 0;
  const over = totalAllocated > 0 ? Math.max(0, Math.round((totalUsed - totalAllocated) * 100) / 100) : 0;
  const remaining = totalAllocated > 0 ? Math.max(0, Math.round((totalAllocated - totalUsed) * 100) / 100) : 0;
  const centerText = noBudgetSet ? `${totalUsed}h` : (over > 0 ? `−${over}h` : (totalAllocated > 0 ? `${remaining}h left` : '—'));
  const centerClass = noBudgetSet ? 'nobudget' : (over > 0 ? 'over' : (totalAllocated > 0 ? 'under' : 'dim'));
  const subText = noBudgetSet ? `${totalUsed}h logged — no budget set yet` : `${totalUsed}h used of ${totalAllocated}h`;
  return `
    <div class="dept-ring-group">
      <div class="dept-ring-group-title">${escapeHtml(dept.name)}</div>
      ${segmentedRingSvg(roleRows, totalAllocated, totalUsed)}
      <div class="ring-center-value ${centerClass}">${centerText}</div>
      <div class="ring-sub">${subText}</div>
      <div class="dept-role-legend">
        ${roleRows.map((r) => `
          <div class="dept-role-legend-row">
            <span class="dept-role-dot" style="background:${ringRoleColor(r.position)}"></span>
            ${escapeHtml(POSITION_LABEL[r.position] || r.position)}: ${r.usedHours}h${r.allocatedHours > 0 ? ` of ${r.allocatedHours}h` : ' (no budget set)'}
          </div>
        `).join('')}
      </div>
      ${peopleHtml}
    </div>
  `;
}

function renderProjectContributors(data) {
  const wrap = $('projectContributors');
  const contributors = data.contributors || [];
  if (!contributors.length) { wrap.innerHTML = '<div class="empty">No one has logged hours on this project yet.</div>'; return; }
  // Bar width = this person's hours as a % of THEIR OWN (department, role)
  // bucket's allocated budget for this project (capped at 100%) -- not
  // relative to other contributors. Relative-to-max was wrong: with a
  // single contributor it always came out to 100%, making the bar look
  // "full" even at 1 of 40 hours.
  const allocatedByKey = {};
  (data.project?.departments || []).forEach((d) => {
    (d.roles && d.roles.length ? d.roles : [{ position: 'general', allocatedHours: d.allocatedHours }])
      .forEach((r) => { allocatedByKey[`${d.id}::${r.position}`] = Number(r.allocatedHours) || 0; });
  });
  wrap.innerHTML = contributors.map((c) => {
    const bucketPosition = c.position || 'general';
    const allocated = allocatedByKey[`${c.departmentId}::${bucketPosition}`] || 0;
    const roleLabel = bucketPosition !== 'general' ? (POSITION_LABEL[bucketPosition] || bucketPosition) : '';
    const over = allocated > 0 ? Math.max(0, Math.round((c.hours - allocated) * 100) / 100) : 0;
    // With no budget set, there's nothing real to show a % bar against —
    // showing one anyway (sized relative to other contributors) was
    // misleading, making whoever logged the most hours look "100% full"
    // even though no budget exists at all. Show a plain note instead.
    const pct = allocated > 0 ? Math.min(Math.round((c.hours / allocated) * 100), 100) : 0;
    return `
    <div class="contrib-row${over > 0 ? ' contrib-over' : ''}">
      <div class="contrib-top">
        <span class="contrib-name">${escapeHtml(c.name)} <span class="chip synced" style="margin-left:6px;">${escapeHtml(c.departmentName)}${roleLabel ? ' · ' + escapeHtml(roleLabel) : ''}</span></span>
        <span class="contrib-hours">${c.hours}h${allocated > 0 ? ` <span class="contrib-allocated">of ${allocated}h</span>` : ''}</span>
      </div>
      ${allocated > 0
        ? `<div class="contrib-bar-track"><div class="contrib-bar-fill${over > 0 ? ' over' : ''}" style="width:${pct}%"></div></div>`
        : `<div class="contrib-nobudget-note">${c.hours}h logged — no budget set for this role yet</div>`}
      ${over > 0 ? `<div class="contrib-over-note">⚠️ Over allocated hours by ${over}h</div>` : ''}
    </div>
  `;
  }).join('');
}

// =====================================================================
// PROJECT STAGE TIMELINE — a horizontal winding-road roadmap shown right
// under the allocated/used hours rings on the Project Detail screen.
//
// The list of stages (and which department owns each one) is a single
// shared, admin-managed template — project_stage_templates, see Data Feed
// -> Manage Project Stages — not hardcoded here. A project's actual
// progress lives in project_stages: one row per (job, stage), created the
// moment an admin starts that job's timeline. The real workflow:
//   1. Admin taps "Start project timeline" -> stage 1's clock starts.
//   2. Only the CURRENT active stage's department HEAD (or an admin) can
//      tap "Mark finished & hand off" -> that stage is stamped complete,
//      the next stage's clock starts, and that department's head gets a
//      push notification it's now their turn. Everyone else can only view.
//   3. Repeat until the last stage is completed.
// Every stage's real started_at/completed_at is kept, so a finished
// stage's actual duration is shown, and this keeps working even if an
// admin edits the shared template later — each project's rows keep their
// own department snapshot from when its timeline started.
// All the actual writes go through the advance-project-stage Edge
// Function, which enforces admin-only "start" and department-head-only
// "advance" — the direct-write RLS on project_stages is admin-only as a
// break-glass fallback, not the real gate.
// =====================================================================

async function fetchStageTemplates() {
  const { data, error } = await sb
    .from('project_stage_templates')
    .select('id, stage_key, label, department_id, sort_order')
    .order('sort_order', { ascending: true });
  if (error) return [];
  return data || [];
}

async function fetchDepartmentHeads() {
  const { data, error } = await sb.from('departments').select('id, name, head_id');
  if (error) return {};
  const byId = {};
  (data || []).forEach((d) => { byId[d.id] = d; });
  return byId;
}

async function fetchStageState(jobId) {
  const [{ data: project }, { data: rows }] = await Promise.all([
    sb.from('projects').select('stages_started_at').eq('job_id', jobId).maybeSingle(),
    sb.from('project_stages').select('*').eq('job_id', jobId),
  ]);
  const byKey = {};
  (rows || []).forEach((r) => { byKey[r.stage_key] = r; });
  return { stagesStartedAt: project?.stages_started_at || null, byKey };
}

// Wraps the advance-project-stage Edge Function call — shows the real
// server-side error (e.g. "not your department's turn") via a toast rather
// than swallowing it, and returns null on failure so callers can just
// check the result.
async function callAdvanceStage(jobId, action, stageKey) {
  const { data: { session } } = await getSessionSafe();
  if (!session) { showToast('Please log in first.'); return null; }
  try {
    const { data, error } = await sb.functions.invoke('advance-project-stage', {
      body: { jobId, action, stageKey },
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (error || data?.ok === false) throw new Error(data?.error || await readFunctionsError(error));
    return data;
  } catch (err) {
    showToast(err.message || String(err));
    return null;
  }
}

// "6m" / "2h 15m" / "1d 4h" — however long a stage actually took, or has
// been active so far.
function formatStageDuration(ms) {
  if (ms == null || ms < 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

// A label longer than a line or two gets split near its middle space so it
// fits inside a fixed-width callout box instead of overflowing it.
function splitStageLabel(label, maxChars) {
  if (label.length <= maxChars) return [label];
  const mid = Math.floor(label.length / 2);
  let bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === ' ') {
      const d = Math.abs(i - mid);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
  }
  if (bestIdx === -1) return [label];
  return [label.slice(0, bestIdx), label.slice(bestIdx + 1)];
}

// Horizontal winding-road timeline: one milestone marker per stage sitting
// on a curving "road", with its label in its OWN solid callout box
// alternating above/below (never plain floating text over the blurred
// glass background — that's what made earlier text hard to read). The road
// itself glows the accent color for every stretch where both ends are
// done, so overall progress reads at a glance without checking every node.
function drawStageLadder(container, templates, byKey, activeIdx) {
  const R = 18;
  const SEG = 150;
  const PAD_X = 90;
  const ROAD_Y = 160;
  const AMP = 44;
  const BOX_OFFSET = 68;
  const width = PAD_X * 2 + SEG * (templates.length - 1);
  const height = 320;

  const pts = templates.map((t, i) => ({
    key: t.stage_key,
    x: PAD_X + i * SEG,
    y: ROAD_Y + Math.sin(i * 1.15) * AMP,
  }));
  const curveD = (arr) => {
    let d = `M ${arr[0].x} ${arr[0].y}`;
    for (let i = 1; i < arr.length; i++) {
      const p0 = arr[i - 1], p1 = arr[i];
      const midX = (p0.x + p1.x) / 2;
      d += ` C ${midX} ${p0.y}, ${midX} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    return d;
  };

  container.innerHTML = '';
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, style: 'overflow:visible; display:block;' });
  const defs = svgEl('defs', {});
  const gGray = svgEl('radialGradient', { id: 'stageGGray', cx: '35%', cy: '30%', r: '75%' });
  gGray.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#8a8985', 'stop-opacity': 0.55 }));
  gGray.appendChild(svgEl('stop', { offset: '60%', 'stop-color': '#5f5e5a', 'stop-opacity': 0.4 }));
  gGray.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#5f5e5a', 'stop-opacity': 0.25 }));
  // Done = green (completed & handed off). Active = light red (currently
  // sitting with a department, awaiting their hand-off). Not-yet-reached
  // stages stay the neutral gray gradient above.
  const gGreen = svgEl('radialGradient', { id: 'stageGGreen', cx: '35%', cy: '30%', r: '75%' });
  gGreen.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#9fe0ae', 'stop-opacity': 1 }));
  gGreen.appendChild(svgEl('stop', { offset: '60%', 'stop-color': '#4caf6a', 'stop-opacity': 0.95 }));
  gGreen.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#3a8a54', 'stop-opacity': 0.75 }));
  const gRed = svgEl('radialGradient', { id: 'stageGRed', cx: '35%', cy: '30%', r: '75%' });
  gRed.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#f5b3b3', 'stop-opacity': 1 }));
  gRed.appendChild(svgEl('stop', { offset: '60%', 'stop-color': '#e06565', 'stop-opacity': 0.95 }));
  gRed.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#c74a4a', 'stop-opacity': 0.75 }));
  defs.appendChild(gGray); defs.appendChild(gGreen); defs.appendChild(gRed);
  const glow = svgEl('filter', { id: 'stageGlow', x: '-80%', y: '-80%', width: '260%', height: '260%' });
  glow.appendChild(svgEl('feGaussianBlur', { stdDeviation: 3.4, result: 'blur' }));
  const merge = svgEl('feMerge', {});
  merge.appendChild(svgEl('feMergeNode', { in: 'blur' }));
  merge.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
  glow.appendChild(merge);
  defs.appendChild(glow);
  svg.appendChild(defs);

  // ---- the road itself: dark asphalt base + a dashed centerline ----
  svg.appendChild(svgEl('path', { d: curveD(pts), fill: 'none', stroke: '#1c1b19', 'stroke-width': 21, 'stroke-linecap': 'round' }));
  svg.appendChild(svgEl('path', { d: curveD(pts), fill: 'none', stroke: '#403c37', 'stroke-width': 15, 'stroke-linecap': 'round' }));
  svg.appendChild(svgEl('path', { d: curveD(pts), fill: 'none', stroke: 'rgba(255,255,255,0.6)', 'stroke-width': 2.2, 'stroke-dasharray': '9 12', 'stroke-linecap': 'round' }));

  // ---- green glow overlay for every stretch that's fully done ----
  for (let i = 1; i < pts.length; i++) {
    if (byKey[pts[i - 1].key]?.completed && byKey[pts[i].key]?.completed) {
      svg.appendChild(svgEl('path', {
        d: curveD([pts[i - 1], pts[i]]), fill: 'none', stroke: '#4caf6a',
        'stroke-width': 7, 'stroke-linecap': 'round', filter: 'url(#stageGlow)', opacity: 0.95,
      }));
    }
  }

  // ---- pulsing "handed off to here" segment: the stretch of road leading
  // into whichever stage is currently active. Draws the eye straight to the
  // stage that JUST received the hand-off. ----
  if (activeIdx > 0 && activeIdx < pts.length) {
    svg.appendChild(svgEl('path', {
      d: curveD([pts[activeIdx - 1], pts[activeIdx]]), fill: 'none', stroke: '#e06565',
      class: 'stage-handoff-pulse',
      'stroke-width': 7, 'stroke-linecap': 'round', filter: 'url(#stageGlow)',
    }));
  }

  // ---- one milestone marker + callout box per stage (read-only — the
  // actual hand-off action lives in the summary card rendered below this
  // road, not on the road itself) ----
  pts.forEach((p, i) => {
    const key = p.key;
    const row = byKey[key];
    const done = !!row?.completed;
    const isActive = i === activeIdx;
    const label = templates[i].label;
    const boxAbove = i % 2 === 0;
    const boxY = p.y + (boxAbove ? -BOX_OFFSET : BOX_OFFSET);

    // Compute the callout box's real size FIRST so the connector line below
    // can end exactly at the box's near edge — otherwise, whenever the box
    // grows taller (a 2-line label, or a duration line), the line's old
    // fixed-length end point falls short of or short-cuts through the box
    // and visually overlaps the duration/label text.
    const lines = splitStageLabel(label, 20);
    const lineW = Math.max(...lines.map((l) => l.length));
    const boxW = Math.min(206, Math.max(104, lineW * 6.7 + 26));
    let boxH = lines.length > 1 ? 46 : 32;
    const durationText = done && row.started_at && row.completed_at
      ? formatStageDuration(new Date(row.completed_at) - new Date(row.started_at))
      : (isActive && row?.started_at ? `${formatStageDuration(Date.now() - new Date(row.started_at))} so far` : '');
    if (durationText) boxH += 14;

    svg.appendChild(svgEl('line', {
      x1: p.x, y1: p.y, x2: p.x, y2: boxY + (boxAbove ? boxH / 2 : -boxH / 2),
      stroke: done ? '#4caf6a' : (isActive ? '#e06565' : 'rgba(207,205,201,0.45)'), 'stroke-width': 2.2,
      class: isActive ? 'stage-handoff-pulse' : '',
    }));

    const g = svgEl('g', { class: `stage-node${done ? ' done' : ''}${isActive ? ' active' : ''}` });
    g.appendChild(svgEl('circle', { class: 'stage-body', cx: p.x, cy: p.y, r: R, filter: (done || isActive) ? 'url(#stageGlow)' : '' }));
    g.appendChild(svgEl('ellipse', { class: 'stage-shine', cx: p.x - 6, cy: p.y - 7, rx: 5.5, ry: 3.2 }));
    if (done) {
      const check = svgEl('text', { class: 'stage-check', x: p.x, y: p.y + 4.5, 'text-anchor': 'middle' });
      check.textContent = '✓';
      g.appendChild(check);
    } else {
      const num = svgEl('text', { class: 'stage-num', x: p.x, y: p.y + 4.5, 'text-anchor': 'middle' });
      num.textContent = String(i + 1);
      g.appendChild(num);
    }
    svg.appendChild(g);

    // Solid callout box for the label — this is the actual fix for text
    // vanishing into whatever colorful/blurred content sits behind it.
    // Once a stage has real timing, its box also shows how long it took
    // (or, for the active stage, how long it's been active so far).
    const box = svgEl('rect', {
      class: `stage-box${done ? ' done' : ''}${isActive ? ' active' : ''}`,
      x: p.x - boxW / 2, y: boxY - boxH / 2, width: boxW, height: boxH, rx: 9,
    });
    svg.appendChild(box);

    const t = svgEl('text', {
      class: 'stage-lbl', x: p.x,
      y: boxY - boxH / 2 + (lines.length > 1 ? 16 : 18),
      'text-anchor': 'middle',
    });
    lines.forEach((line, li) => {
      const tspan = svgEl('tspan', { x: p.x, dy: li === 0 ? 0 : 15 });
      tspan.textContent = line;
      t.appendChild(tspan);
    });
    svg.appendChild(t);

    if (durationText) {
      const dur = svgEl('text', { class: `stage-duration${done ? ' done' : ''}`, x: p.x, y: boxY + boxH / 2 - 7, 'text-anchor': 'middle' });
      dur.textContent = durationText;
      svg.appendChild(dur);
    }
  });

  container.appendChild(svg);
}

async function renderProjectStages(jobId) {
  const area = $('projectStageArea');
  if (!area) return;
  const isAdmin = currentProfile?.role === 'admin';

  const templates = await fetchStageTemplates();
  if (!templates.length) {
    area.innerHTML = `
      <div class="card glass">
        <strong style="font-size:14px;">Project timeline</strong>
        <p class="hint" style="margin-top:4px;">${isAdmin ? 'No roadmap stages are set up yet — add some in Data Feed → Manage Project Stages.' : 'No roadmap has been set up for this yet.'}</p>
      </div>
    `;
    return;
  }

  const [{ stagesStartedAt, byKey }, deptHeads] = await Promise.all([
    fetchStageState(jobId),
    fetchDepartmentHeads(),
  ]);

  if (!stagesStartedAt) {
    area.innerHTML = `
      <div class="card glass">
        <strong style="font-size:14px;">Project timeline</strong>
        <p class="hint" style="margin-top:4px;">${isAdmin ? "This job's timeline hasn't started yet. Starting it kicks off the clock on the first stage and notifies that department." : "This job's timeline hasn't started yet."}</p>
        ${isAdmin ? '<button type="button" id="startStageTimelineBtn" class="secondary" style="margin-top:10px; width:auto; padding:9px 18px;">🚦 Start project timeline</button>' : ''}
      </div>
    `;
    $('startStageTimelineBtn')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Starting…';
      const res = await callAdvanceStage(jobId, 'start');
      if (res) { showToast('Timeline started.'); delete projectsStageCache[jobId]; renderProjectStages(jobId); }
      else { e.target.disabled = false; e.target.textContent = '🚦 Start project timeline'; }
    });
    return;
  }

  const activeIdx = templates.findIndex((t) => !byKey[t.stage_key]?.completed);
  const roadmapComplete = activeIdx === -1;

  area.innerHTML = `
    <div class="card glass">
      <strong style="font-size:14px;">Project timeline</strong>
      <p class="hint" style="margin-top:4px;">Scroll sideways to see the whole road. ${roadmapComplete ? 'Every stage is complete.' : "The highlighted stage is what's active right now."}</p>
      <div id="stageSvgWrap" class="stage-road-scroll"></div>
      <div id="stageActiveArea" style="margin-top:12px;"></div>
    </div>
  `;
  drawStageLadder($('stageSvgWrap'), templates, byKey, activeIdx);

  const activeArea = $('stageActiveArea');
  if (!activeArea || roadmapComplete) return;

  const current = templates[activeIdx];
  const currentRow = byKey[current.stage_key];
  const deptId = currentRow?.department_id ?? current.department_id;
  const dept = deptId ? deptHeads[deptId] : null;
  const canAct = isAdmin || (dept && dept.head_id === currentUser?.id);
  const elapsed = currentRow?.started_at ? formatStageDuration(Date.now() - new Date(currentRow.started_at)) : '';

  activeArea.innerHTML = `
    <div class="stage-active-card">
      <div class="stage-active-top">
        <span class="stage-active-label">🟥 Active now: ${escapeHtml(current.label)}</span>
        <span class="stage-active-dept">${escapeHtml(dept?.name || 'No department assigned')}</span>
      </div>
      ${elapsed ? `<div class="stage-active-elapsed">${elapsed} so far</div>` : ''}
      ${canAct
        ? '<button type="button" id="advanceStageBtn" class="secondary" style="margin-top:8px; width:auto; padding:9px 18px;">✅ Mark finished &amp; hand off</button>'
        : `<div class="hint" style="margin-top:6px;">Only ${escapeHtml(dept?.name || 'the assigned department')}'s head (or an admin) can acknowledge this stage.</div>`}
    </div>
  `;
  $('advanceStageBtn')?.addEventListener('click', async (e) => {
    if (!confirm(`Mark "${current.label}" finished and hand off to the next stage?`)) return;
    e.target.disabled = true; e.target.textContent = 'Handing off…';
    const res = await callAdvanceStage(jobId, 'advance', current.stage_key);
    if (res) { showToast(res.roadmapComplete ? 'Roadmap complete!' : 'Handed off to the next stage.'); delete projectsStageCache[jobId]; renderProjectStages(jobId); }
    else { e.target.disabled = false; e.target.textContent = '✅ Mark finished & hand off'; }
  });
}

let currentProjectReport = null;
let currentProjectJobId = null;

// Non-destructive Close/Reopen control, shown right at the top of Project
// Detail so it's visible however the screen was opened (list row, search,
// My Jobs, etc.) without needing status threaded through every call site —
// it just looks the current status up fresh each time.
async function renderProjectStatusArea(jobId) {
  const area = $('projectStatusArea');
  if (!area) return;
  const { data: row } = await sb.from('projects').select('status, responsibility, delivery_status').eq('job_id', jobId).maybeSingle();
  const status = row?.status || 'active';
  const isClosed = status !== 'active';
  const isAdmin = currentProfile?.role === 'admin';
  // Responsibility/Delivery (synced from the JOB DATA google sheet) only
  // matter while a job is still active — once closed, who's responsible or
  // when it's due is no longer relevant, so it's hidden then.
  const showDelivery = !isClosed && (row?.responsibility || row?.delivery_status);
  area.innerHTML = `
    <div class="card glass" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <span style="font-size:13px;">Status: <strong>${isClosed ? 'Closed' : 'Active'}</strong></span>
      ${isAdmin ? `<button type="button" class="secondary" id="projectStatusToggleBtn" style="width:auto; padding:8px 16px;">${isClosed ? 'Reopen' : 'Mark as Closed'}</button>` : ''}
    </div>
    ${showDelivery ? `
    <div class="card glass" style="margin-top:8px; display:flex; flex-direction:column; gap:4px;">
      ${row.responsibility ? `<span style="font-size:13px;">Responsibility: <strong>${escapeHtml(row.responsibility)}</strong></span>` : ''}
      ${row.delivery_status ? `<span style="font-size:13px;">Delivery: <strong>${escapeHtml(row.delivery_status)}</strong></span>` : ''}
    </div>` : ''}
  `;
  $('projectStatusToggleBtn')?.addEventListener('click', async () => {
    await toggleProjectStatus(jobId, status);
    renderProjectStatusArea(jobId);
  });
}

async function openProjectDetail(jobId, name) {
  currentProjectReport = null;
  currentProjectJobId = jobId;
  $('projectDetailTitle').textContent = name ? `${jobId} — ${name}` : jobId;
  $('projectRingsArea').innerHTML = '<div class="empty">Loading…</div>';
  $('projectContributors').innerHTML = '';
  if ($('projectTaskBreakdownArea')) $('projectTaskBreakdownArea').innerHTML = '';
  $('projectStageArea').innerHTML = '';
  $('boqListArea').innerHTML = '';
  $('boqTotalRow').innerHTML = '';
  $('deptHoursListArea').innerHTML = '';
  if ($('projectStatusArea')) $('projectStatusArea').innerHTML = '';
  if ($('deleteProjectCard')) $('deleteProjectCard').style.display = currentProfile?.role === 'admin' ? 'block' : 'none';
  openPanel('projectDetail');
  renderProjectStatusArea(jobId);
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
  const contributors = data.contributors || [];

  // Group contributors by department so each department's own card can show
  // exactly who (from that department) logged time against this job, not
  // just a total number.
  const peopleByDept = {};
  contributors.forEach((c) => {
    (peopleByDept[c.departmentId] || (peopleByDept[c.departmentId] = [])).push({ name: c.name, hours: c.hours, position: c.position });
  });

  // Show EVERY department in the organization here, not just the ones this
  // project happens to have hours logged/allotted for — departments with no
  // data render as a dulled-out ring so it's obvious at a glance which
  // departments haven't touched this job yet, instead of them just being
  // silently missing from the screen.
  const { rows: allDepartments } = await fetchDepartments();
  const byId = {};
  departments.forEach((d) => { byId[d.id] = d; });
  const merged = allDepartments.map((dept) => {
    const existing = byId[dept.id];
    const usedHours = existing ? Number(existing.usedHours) || 0 : 0;
    const allocatedHours = existing ? Number(existing.allocatedHours) || 0 : 0;
    const roles = existing?.roles || [];
    return { id: dept.id, name: dept.name, usedHours, allocatedHours, roles, people: peopleByDept[dept.id] || [], hasData: usedHours > 0 || allocatedHours > 0 };
  });
  // Cover the edge case of a department that has report data but was since
  // deleted/renamed out of the departments table — still show it rather than
  // silently dropping real hours off the screen.
  departments.forEach((d) => {
    if (!allDepartments.some((ad) => ad.id === d.id)) merged.push({ ...d, people: peopleByDept[d.id] || [], hasData: true });
  });
  // Departments with real data float to the top; dulled/empty ones sink down.
  merged.sort((a, b) => (b.hasData === a.hasData ? 0 : b.hasData ? 1 : -1));

  // The big ring compares against the JOB's own total (from the Google
  // Sheet's Total Hours column), not a sum of per-department budgets — a
  // department can still be flagged red below even while the job total
  // looks fine, if that department (or a role inside it) has its own
  // manually-set budget exceeded, or if any ROLE exceeds its job-wide
  // allocated hours from the sheet.
  const totalAllocated = Number(data.project.totalAllocatedHours) || 0;
  const totalUsed = Number(data.project.totalUsedHours) || 0;
  const jobRoles = data.project.jobRoles || [];
  const overRoleNames = jobRoles
    .filter((r) => r.allocatedHours > 0 && r.usedHours > r.allocatedHours)
    .map((r) => POSITION_LABEL[r.position] || r.position);
  const overDeptNames = merged
    .filter((d) => {
      const deptOver = d.allocatedHours > 0 && d.usedHours > d.allocatedHours;
      const roleOver = (d.roles || []).some((r) => r.allocatedHours > 0 && r.usedHours > r.allocatedHours);
      return deptOver || roleOver;
    })
    .map((d) => d.name);
  const overNames = [...overRoleNames, ...overDeptNames];

  $('projectRingsArea').innerHTML = merged.length
    ? bigTotalRingBlock(totalAllocated, totalUsed, overNames) + `<div class="project-rings">${merged.map((d) => deptRingBlock(d)).join('')}</div>`
    : '<div class="empty">No departments set up yet — add one from Admin → Team → Departments.</div>';
  renderProjectContributors(data);
  await renderProjectTaskBreakdown(data);
  renderDeptHoursManager(jobId, departments);
}

// Color palette for the Project Analytics bars below — cycles by index so
// colors stay stable per category/department/person regardless of name,
// without needing a matching CSS variable for every hue. Plain hex so the
// same palette can be reused by the canvas-based share image (see
// buildProjectShareImage) where CSS variables aren't available.
const PA_PALETTE = ['#e08a5f', '#5fb8e0', '#a78bfa', '#5fd0a8', '#f2b755', '#f27d70', '#7ea8f2', '#e05fb0'];
function paColor(i) { return PA_PALETTE[((i % PA_PALETTE.length) + PA_PALETTE.length) % PA_PALETTE.length]; }

// "Project Analytics" — the combined "where did the time actually go" view
// for this job: which task/category people logged hours against (matched
// server-side in get-project-report from job_hours_ledger's free-text
// description against the tap-to-select job type list), which department
// used the most time, and who the top contributors are. All three reuse
// data get-project-report already returned in one call for this screen —
// the only extra lookup is the category list (icons/colors), which is
// cached after the first fetch. Bars are sized relative to this job's own
// busiest item in each section (there's no "budget" per task, unlike the
// department rings above) — this is a "where did the time go" read, not a
// pass/fail one.
// Shared "rounded vertical bar" chart for Time by task / Time by department /
// Top contributors — same visual language as the "Hours per day" chart in
// the report data area (hoursBarChart above), reused here so Project
// Analytics reads consistently instead of the old thin horizontal pill
// bars. Each item is {label, hours, color, valueSuffix?}; bar height is
// relative to the tallest item in THIS chart. Full label + hours is always
// on a hover/long-press tooltip (title attr), same pattern as hoursBarChart,
// since the on-screen label under a narrow column gets line-clamped to 2
// lines for longer names.
function paVerticalBarChart(items) {
  if (!items.length) return '';
  const chartH = 90;
  const maxV = Math.max(...items.map((it) => it.hours || 0), 0.01);
  const cols = items.map((it) => {
    const px = Math.max(4, Math.round(((it.hours || 0) / maxV) * chartH));
    const valueText = `${it.hours}h${it.valueSuffix || ''}`;
    return `
      <div class="pa-vbar-col" title="${escapeHtml(it.label)}: ${escapeHtml(valueText)}">
        <div class="pa-vbar-value">${escapeHtml(valueText)}</div>
        <div class="pa-vbar-track" style="height:${chartH}px">
          <div class="pa-vbar-fill" style="height:${px}px; background:linear-gradient(180deg, ${it.color}, ${it.color}99);"></div>
        </div>
        <div class="pa-vbar-label">${escapeHtml(it.label)}</div>
      </div>
    `;
  }).join('');
  return `<div class="pa-vbar-chart">${cols}</div>`;
}

async function renderProjectTaskBreakdown(data) {
  const wrap = $('projectTaskBreakdownArea');
  if (!wrap) return;
  const tasks = data.taskBreakdown || [];
  const untagged = Number(data.untaggedHours) || 0;
  const contributors = data.contributors || [];
  const departments = (data.project?.departments || []).filter((d) => (Number(d.usedHours) || 0) > 0);

  if (!tasks.length && !contributors.length && untagged <= 0) {
    wrap.innerHTML = '<div class="empty">No hours logged yet.</div>';
    return;
  }

  const categories = await fetchJobDescCategories();
  const catMeta = jobDescCategoryMetaMap(categories);
  const categoryKeyOrder = categories.map((c) => c.key).concat(categories.some((c) => c.key === 'other') ? [] : ['other']);
  const catColorIndex = {};
  categoryKeyOrder.forEach((key, i) => { catColorIndex[key] = i; });

  // ---- stat chips across the top: the four numbers ops usually wants first ----
  const topTask = tasks.length ? [...tasks].sort((a, b) => b.hours - a.hours)[0] : null;
  const catTotals = {};
  tasks.forEach((t) => {
    const cat = catMeta[t.category] ? t.category : 'other';
    catTotals[cat] = (catTotals[cat] || 0) + t.hours;
  });
  const topCatKey = Object.keys(catTotals).sort((a, b) => catTotals[b] - catTotals[a])[0] || null;
  const topDept = departments.length ? [...departments].sort((a, b) => b.usedHours - a.usedHours)[0] : null;
  const topContributor = contributors.length ? [...contributors].sort((a, b) => b.hours - a.hours)[0] : null;

  const statChips = [
    topTask ? { label: 'Busiest task', value: topTask.label, sub: `${Math.round(topTask.hours * 100) / 100}h` } : null,
    topCatKey ? { label: 'Busiest category', value: `${catMeta[topCatKey].icon} ${catMeta[topCatKey].label}`, sub: `${Math.round(catTotals[topCatKey] * 100) / 100}h` } : null,
    topDept ? { label: 'Busiest department', value: topDept.name, sub: `${Math.round(topDept.usedHours * 100) / 100}h` } : null,
    topContributor ? { label: 'Top contributor', value: topContributor.name, sub: `${topContributor.hours}h` } : null,
  ].filter(Boolean);
  const statsHtml = statChips.length ? `<div class="pa-stats-row">${statChips.map((s) => `
    <div class="pa-stat-chip">
      <div class="pa-stat-label">${escapeHtml(s.label)}</div>
      <div class="pa-stat-value">${escapeHtml(s.value)}</div>
      <div class="pa-stat-sub">${escapeHtml(s.sub)}</div>
    </div>
  `).join('')}</div>` : '';

  // ---- Time by task — flattened, sorted by hours, colored by category ----
  // Rounded bar chart up top as the headline visual (matches "Hours per
  // day" in the reports area); the original per-item rows stay underneath
  // as the full detail list — same "headline chart, detail list below" idea
  // already used by the Category share ring section.
  let taskChartHtml = '';
  if (tasks.length) {
    const sortedTasks = [...tasks].sort((a, b) => b.hours - a.hours).slice(0, 12);
    const maxTaskHours = Math.max(...sortedTasks.map((t) => t.hours), 0.01);
    taskChartHtml = `
      <div class="pa-section">
        <div class="pa-section-title">📊 Time by task</div>
        ${paVerticalBarChart(sortedTasks.map((t) => {
          const cat = catMeta[t.category] ? t.category : 'other';
          return { label: t.label, hours: t.hours, color: paColor(catColorIndex[cat] ?? 0) };
        }))}
        <div class="pa-bar-list">
          ${sortedTasks.map((t) => {
            const cat = catMeta[t.category] ? t.category : 'other';
            const color = paColor(catColorIndex[cat] ?? 0);
            return `
              <div class="pa-bar-row">
                <div class="pa-bar-top">
                  <span class="pa-bar-label"><span class="pa-bar-dot" style="background:${color};"></span>${escapeHtml(t.label)}</span>
                  <span class="pa-bar-hours">${t.hours}h</span>
                </div>
                <div class="pa-bar-track"><div class="pa-bar-fill" style="width:${Math.max(4, Math.round((t.hours / maxTaskHours) * 100))}%; background:linear-gradient(90deg, ${color}, ${color}cc);"></div></div>
              </div>
            `;
          }).join('')}
        </div>
        ${untagged > 0 ? `<div class="pa-untagged-note">+ ${untagged}h logged with free-typed notes, not matching a specific task yet</div>` : ''}
      </div>
    `;
  } else if (untagged > 0) {
    taskChartHtml = `
      <div class="pa-section">
        <div class="pa-section-title">📊 Time by task</div>
        <div class="pa-untagged-note">${untagged}h logged so far, but not tagged with any specific task yet — those entries used free-typed notes instead of the tap-to-select list.</div>
      </div>
    `;
  }

  // ---- Time by department — mini chart, reuses the same data as the rings above ----
  let deptChartHtml = '';
  if (departments.length) {
    const sortedDepts = [...departments].sort((a, b) => b.usedHours - a.usedHours).slice(0, 8);
    const maxDeptHours = Math.max(...sortedDepts.map((d) => d.usedHours), 0.01);
    deptChartHtml = `
      <div class="pa-section">
        <div class="pa-section-title">🏢 Time by department</div>
        ${paVerticalBarChart(sortedDepts.map((d, i) => ({
          label: d.name,
          hours: d.usedHours,
          color: paColor(i + 4),
          valueSuffix: d.allocatedHours > 0 ? ` / ${d.allocatedHours}h` : '',
        })))}
        <div class="pa-bar-list">
          ${sortedDepts.map((d, i) => {
            const color = paColor(i + 4);
            return `
              <div class="pa-bar-row">
                <div class="pa-bar-top">
                  <span class="pa-bar-label"><span class="pa-bar-dot" style="background:${color};"></span>${escapeHtml(d.name)}</span>
                  <span class="pa-bar-hours">${d.usedHours}h${d.allocatedHours > 0 ? `<span class="pa-bar-sub"> / ${d.allocatedHours}h</span>` : ''}</span>
                </div>
                <div class="pa-bar-track"><div class="pa-bar-fill" style="width:${Math.max(4, Math.round((d.usedHours / maxDeptHours) * 100))}%; background:linear-gradient(90deg, ${color}, ${color}cc);"></div></div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // ---- Top contributors — who actually put in the hours ----
  let peopleChartHtml = '';
  if (contributors.length) {
    const sortedPeople = [...contributors].sort((a, b) => b.hours - a.hours).slice(0, 6);
    const maxPersonHours = Math.max(...sortedPeople.map((c) => c.hours), 0.01);
    peopleChartHtml = `
      <div class="pa-section">
        <div class="pa-section-title">🙋 Top contributors</div>
        ${paVerticalBarChart(sortedPeople.map((c, i) => ({
          label: c.departmentName ? `${c.name} · ${c.departmentName}` : c.name,
          hours: c.hours,
          color: paColor(i + 2),
        })))}
        <div class="pa-bar-list">
          ${sortedPeople.map((c, i) => {
            const color = paColor(i + 2);
            return `
              <div class="pa-bar-row">
                <div class="pa-bar-top">
                  <span class="pa-bar-label"><span class="pa-bar-dot" style="background:${color};"></span>${escapeHtml(c.name)}<span class="pa-bar-sub">${escapeHtml(c.departmentName || '')}</span></span>
                  <span class="pa-bar-hours">${c.hours}h</span>
                </div>
                <div class="pa-bar-track"><div class="pa-bar-fill" style="width:${Math.max(4, Math.round((c.hours / maxPersonHours) * 100))}%; background:linear-gradient(90deg, ${color}, ${color}cc);"></div></div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  wrap.innerHTML = statsHtml + taskChartHtml + deptChartHtml + peopleChartHtml;

  // The ring, trend graph, and department/people chart below live in their
  // OWN persistent divs (outside wrap's innerHTML) so they can show/hide
  // their section independently of the bars above re-rendering.
  renderProjectCategoryRing(tasks, catMeta, categoryKeyOrder, departments);
  renderProjectHoursTrend(data.dailyTrend || [], data.project?.totalAllocatedHours);
  renderProjectDeptPeopleChart(data.project?.departments || [], contributors);
}

// "Category share" — Apple Watch/Health-style concentric Activity rings:
// up to 3 nested rings (like Move/Exercise/Stand), each a thick round-capped
// arc sitting over a dim track of the SAME hue, sized by that slice's share
// of the job's total hours, with a bold total in the center. The full list
// (not just the 3 shown as rings) is always listed below so nothing is
// hidden — the rings are the headline, the list is the detail, exactly
// like Apple Health's summary-then-breakdown layout.
//
// Sliced by tagged TASK CATEGORY when that data exists. Tagging a task is
// optional though (free-typed notes skip it entirely), and on a project
// where nobody's used the tap-to-select list yet that meant this ring had
// nothing to show even though the job clearly has real hours logged —
// reading as broken rather than "no data yet". So when there's no tagged
// category data, it falls back to a DEPARTMENT share instead (which every
// logged hour always has), using the same colors as the "Time by
// department" bars above for consistency. Only shows the empty
// "environment" placeholder when there's truly nothing logged at all.
function renderProjectCategoryRing(tasks, catMeta, categoryKeyOrder, departments) {
  const section = $('projectRingSection');
  const area = $('projectRingArea');
  const titleEl = $('projectRingTitle');
  if (!section || !area) return;
  const realTasks = (tasks || []).filter((t) => t.hours > 0);
  const deptsWithHours = (departments || []).filter((d) => (Number(d.usedHours) || 0) > 0);
  const mode = realTasks.length > 0 ? 'category' : (deptsWithHours.length > 0 ? 'department' : 'empty');
  if (mode === 'empty' && !categoryKeyOrder.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  if (titleEl) titleEl.textContent = mode === 'department' ? '🍩 Department share' : '🍩 Category share';

  const CX = 110, CY = 110;
  // Outermost ring first (biggest share reads as the most prominent ring,
  // same visual hierarchy as Apple's Move ring being the outer one).
  const RINGS = [{ r: 92, sw: 19 }, { r: 70, sw: 19 }, { r: 48, sw: 19 }];
  let ringsHtml = '';
  let legendHtml = '';
  let totalHours = 0;

  if (mode === 'category' || mode === 'department') {
    // Build one common "slices" shape regardless of which data source is
    // driving the ring, so the drawing logic below never has to care.
    let slices;
    if (mode === 'category') {
      const catTotals = {};
      realTasks.forEach((t) => {
        const cat = catMeta[t.category] ? t.category : 'other';
        catTotals[cat] = (catTotals[cat] || 0) + t.hours;
      });
      slices = categoryKeyOrder
        .filter((c) => catTotals[c] > 0)
        .map((cat, i) => ({ key: cat, label: `${catMeta[cat]?.icon || ''} ${catMeta[cat]?.label || cat}`.trim(), hours: catTotals[cat], colorIdx: i }))
        .sort((a, b) => b.hours - a.hours);
    } else {
      // Same sort + color-index convention as the "Time by department" bar
      // chart above (paColor(i + 4)) so a department reads the same color
      // in both places on this card.
      slices = [...deptsWithHours]
        .sort((a, b) => b.usedHours - a.usedHours)
        .map((d, i) => ({ key: d.id, label: d.name, hours: Number(d.usedHours) || 0, colorIdx: i + 4 }));
    }

    totalHours = Math.round(slices.reduce((s, sl) => s + sl.hours, 0) * 100) / 100;
    slices.forEach((sl, i) => {
      const hours = Math.round(sl.hours * 100) / 100;
      const frac = totalHours > 0 ? hours / totalHours : 0;
      const color = paColor(sl.colorIdx);
      const pct = Math.round(frac * 100);
      if (i < RINGS.length) {
        const { r, sw } = RINGS[i];
        const circumference = 2 * Math.PI * r;
        const dash = Math.max(frac * circumference, frac > 0 ? sw * 0.6 : 0); // tiny nub stays visible even for a sliver of a share
        ringsHtml += `
          <circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" opacity="0.2" />
          <circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"
            stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}"
            transform="rotate(-90 ${CX} ${CY})" class="pa-ring-arc" />`;
      }
      legendHtml += `
        <div class="pa-ring-legend-row${i < RINGS.length ? ' pa-ring-legend-active' : ''}">
          <span class="pa-ring-dot" style="background:${color};"></span>
          <span class="pa-ring-legend-label">${escapeHtml(sl.label)}</span>
          <span class="pa-ring-legend-value">${hours}h <span class="pa-ring-legend-pct">${pct}%</span></span>
        </div>`;
    });
    if (slices.length > RINGS.length) {
      legendHtml += `<div class="pa-ring-legend-note">Rings above show the top ${RINGS.length} — every ${mode} is still listed here.</div>`;
    }
  } else {
    RINGS.forEach(({ r, sw }, i) => {
      const color = paColor(i);
      const circumference = 2 * Math.PI * r;
      const dash = circumference / 3;
      ringsHtml += `
        <circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" opacity="0.14" />
        <circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" opacity="0.4"
          stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" transform="rotate(-90 ${CX} ${CY})" />`;
    });
    categoryKeyOrder.forEach((cat, i) => {
      const color = paColor(i);
      legendHtml += `
        <div class="pa-ring-legend-row muted">
          <span class="pa-ring-dot" style="background:${color};"></span>
          <span class="pa-ring-legend-label">${escapeHtml(catMeta[cat]?.icon || '')} ${escapeHtml(catMeta[cat]?.label || cat)}</span>
          <span class="pa-ring-legend-value">—</span>
        </div>`;
    });
  }

  const hasData = mode !== 'empty';
  area.innerHTML = `
    <div class="pa-ring-wrap">
      <div class="pa-ring-svg-wrap">
        <svg viewBox="0 0 220 220" class="pa-ring-svg">${ringsHtml}</svg>
        <div class="pa-ring-center">
          <div class="pa-ring-center-value">${hasData ? totalHours : 0}h</div>
          <div class="pa-ring-center-label">${hasData ? 'logged' : 'waiting for hours'}</div>
        </div>
      </div>
      <div class="pa-ring-legend">${legendHtml}</div>
    </div>
  `;
}

// "Hours logged over time" — a hand-drawn SVG line/area chart (cumulative
// hours logged on this job, day by day) instead of a 3D surface. Replaces
// the old department×task surface: that chart's real value (spotting a
// department running hot) is already covered by the rings/bars above it,
// while this answers the one thing they couldn't — is the job's overall
// pace on track to land inside its allocated hours. Every label is a
// solid-background pill/box (foreignObject + normal HTML), never bare SVG
// text over the glass card, so it stays legible regardless of what's
// behind it.
function renderProjectHoursTrend(dailyTrend, totalAllocatedHours) {
  const section = $('projectTrendSection');
  const area = $('projectTrendArea');
  if (!section || !area) return;
  const points = (dailyTrend || []).filter((d) => d && d.date);
  if (!points.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  if (points.length < 2) {
    area.innerHTML = '<div class="empty">Only one day logged so far — a trend line needs at least two.</div>';
    return;
  }

  const allocated = Number(totalAllocatedHours) || 0;
  const lastCumulative = points[points.length - 1].cumulativeHours;
  const maxY = Math.max(lastCumulative, allocated) * 1.12 || 1;

  const W = 600, H = 220, PAD_L = 46, PAD_R = 16, PAD_T = 16, PAD_B = 30;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const xAt = (i) => PAD_L + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => PAD_T + plotH - (Math.max(0, v) / maxY) * plotH;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(p.cumulativeHours).toFixed(1)}`).join(' ');
  const floorY = (PAD_T + plotH).toFixed(1);
  const areaPath = `${linePath} L ${xAt(points.length - 1).toFixed(1)} ${floorY} L ${xAt(0).toFixed(1)} ${floorY} Z`;

  const GRID_STEPS = 4;
  let gridHtml = '';
  for (let g = 0; g <= GRID_STEPS; g++) {
    const val = (maxY / GRID_STEPS) * g;
    const y = yAt(val);
    gridHtml += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="rgba(207,205,201,0.14)" stroke-width="1" />`;
    gridHtml += `<foreignObject x="0" y="${(y - 9).toFixed(1)}" width="${PAD_L - 6}" height="18"><div xmlns="http://www.w3.org/1999/xhtml" class="pa-trend-ytick">${Math.round(val)}h</div></foreignObject>`;
  }
  const budgetLineHtml = allocated > 0 ? `<line x1="${PAD_L}" y1="${yAt(allocated).toFixed(1)}" x2="${W - PAD_R}" y2="${yAt(allocated).toFixed(1)}" stroke="#f2b755" stroke-width="1.6" stroke-dasharray="6 5" />` : '';

  const fmtDate = (d) => { try { return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return d; } };
  const firstDateLabel = fmtDate(points[0].date);
  const lastDateLabel = fmtDate(points[points.length - 1].date);

  area.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="pa-trend-svg">
      <defs>
        <linearGradient id="paTrendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent, #e08a5f)" stop-opacity="0.45" />
          <stop offset="100%" stop-color="var(--accent, #e08a5f)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${gridHtml}
      ${budgetLineHtml}
      <path d="${areaPath}" fill="url(#paTrendFill)" stroke="none" />
      <path d="${linePath}" fill="none" stroke="var(--accent, #e08a5f)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="${xAt(points.length - 1).toFixed(1)}" cy="${yAt(lastCumulative).toFixed(1)}" r="5.5" fill="var(--accent, #e08a5f)" stroke="#141414" stroke-width="2" />
      <foreignObject x="${(PAD_L - 4).toFixed(1)}" y="${(H - PAD_B + 6).toFixed(1)}" width="130" height="20"><div xmlns="http://www.w3.org/1999/xhtml" class="pa-trend-xtick">${escapeHtml(firstDateLabel)}</div></foreignObject>
      <foreignObject x="${(W - PAD_R - 126).toFixed(1)}" y="${(H - PAD_B + 6).toFixed(1)}" width="130" height="20"><div xmlns="http://www.w3.org/1999/xhtml" class="pa-trend-xtick" style="text-align:right;">${escapeHtml(lastDateLabel)}</div></foreignObject>
    </svg>
    <div class="pa-trend-total"><span class="pa-trend-total-value">${lastCumulative}h</span> logged to date${allocated > 0 ? ` <span class="pa-trend-total-sub">of ${allocated}h allocated</span>` : ''}</div>
    <div class="pa-trend-legend">
      <span class="pa-trend-legend-item"><span class="pa-trend-swatch"></span>Hours logged (cumulative)</span>
      ${allocated > 0 ? `<span class="pa-trend-legend-item"><span class="pa-trend-swatch dashed"></span>Allocated budget (${allocated}h)</span>` : ''}
    </div>
  `;
}

// "Department breakdown" — one stacked bar per department, each bar split
// into a colored segment per person who logged hours in it (self-scaled to
// that department's own total, so it directly answers "inside THIS
// department, who used the time" — the department-to-department comparison
// is already covered by the "Time by department" bars above this card).
function renderProjectDeptPeopleChart(departments, contributors) {
  const section = $('projectDeptPeopleSection');
  const area = $('projectDeptPeopleArea');
  if (!section || !area) return;

  const byDept = {};
  (contributors || []).forEach((c) => {
    const key = c.departmentId || 'unassigned';
    if (!byDept[key]) byDept[key] = { name: c.departmentName || 'No department set', people: [] };
    byDept[key].people.push(c);
  });
  const deptRows = Object.values(byDept)
    .map((d) => ({ ...d, total: Math.round(d.people.reduce((s, p) => s + (Number(p.hours) || 0), 0) * 100) / 100 }))
    .filter((d) => d.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  if (!deptRows.length) { section.style.display = 'none'; return; }
  section.style.display = '';

  area.innerHTML = deptRows.map((d) => {
    const sortedPeople = [...d.people].sort((a, b) => b.hours - a.hours);
    const segmentsHtml = sortedPeople.map((p, i) => {
      const pct = d.total > 0 ? (p.hours / d.total) * 100 : 0;
      return `<div class="pa-stack-seg" style="width:${Math.max(pct, 1.5).toFixed(2)}%; background:${paColor(i)};" title="${escapeHtml(p.name)} — ${p.hours}h"></div>`;
    }).join('');
    const legendHtml = sortedPeople.map((p, i) => `
      <span class="pa-stack-legend-item">
        <span class="pa-stack-dot" style="background:${paColor(i)};"></span>${escapeHtml(p.name)} <span class="pa-stack-legend-hours">${p.hours}h</span>
      </span>
    `).join('');
    return `
      <div class="pa-stack-row">
        <div class="pa-stack-top">
          <span class="pa-stack-dept-name">${escapeHtml(d.name)}</span>
          <span class="pa-stack-dept-hours">${d.total}h</span>
        </div>
        <div class="pa-stack-track">${segmentsHtml}</div>
        <div class="pa-stack-legend">${legendHtml}</div>
      </div>
    `;
  }).join('');
}

// Admin-only cleanup tool for exactly the kind of mistake that started this
// whole round: a mistyped Job ID (letter-O vs digit-0, etc.) creating a
// duplicate project. Requires typing the Job ID out to confirm — this is
// permanent and there's no undo. Deleting the project row itself cascades
// to remove its department-hour budgets (project_department_hours has an
// "on delete cascade" foreign key), but job_hours_ledger and
// project_share_log key on job_id as plain text (not a foreign key), so
// those are cleaned up here explicitly — otherwise they'd linger as
// invisible orphaned history for a project that no longer exists.
$('deleteProjectBtn')?.addEventListener('click', async () => {
  if (!currentProjectJobId) return;
  const jobId = currentProjectJobId;
  const typed = prompt(`This permanently deletes ${jobId} and its department hour budgets. This cannot be undone.\n\nType the Job ID exactly to confirm:`);
  if (typed === null) return;
  if (typed.trim() !== jobId) { showToast('Job ID did not match — nothing was deleted.'); return; }

  const btn = $('deleteProjectBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await sb.from('job_hours_ledger').delete().eq('job_id', jobId);
    await sb.from('project_share_log').delete().eq('job_id', jobId);
    const { error } = await sb.from('projects').delete().eq('job_id', jobId);
    if (error) throw error;
    showToast(`${jobId} deleted.`);
    closePanel('projectDetail');
    renderProjectsList();
  } catch (err) {
    showToast(`Couldn't delete: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete this project';
  }
});

// ---------- Department hours — admin sets an hour budget PER DEPARTMENT
// (optionally per ROLE within that department — Engineer/Supervisor/Lead
// Foreman/Technician/Helper, for the departments that use that split) for
// this project. Same add/list/delete pattern as BOQ items below. ----------
let deptHoursDeptNameById = {}; // refreshed each render, used to drive the Role dropdown

function updateDeptHoursPositionOptions() {
  const deptId = $('deptHoursSelect')?.value;
  const deptName = deptHoursDeptNameById[deptId] || '';
  const roles = rolesForDepartmentName(deptName);
  const wrap = $('deptHoursPositionWrap');
  const posSelect = $('deptHoursPosition');
  if (!wrap || !posSelect) return;
  if (roles && roles.length) {
    wrap.style.display = 'block';
    posSelect.innerHTML = roles.map((r) => `<option value="${r}">${escapeHtml(POSITION_LABEL[r] || r)}</option>`).join('');
  } else {
    wrap.style.display = 'none';
    posSelect.innerHTML = '';
  }
}

async function renderDeptHoursManager(jobId, departments) {
  const isAdmin = currentProfile?.role === 'admin';
  $('newDeptHoursCard').style.display = isAdmin ? 'block' : 'none';

  const { rows: allDepartments } = await fetchDepartments();
  deptHoursDeptNameById = {};
  allDepartments.forEach((d) => { deptHoursDeptNameById[d.id] = d.name; });
  const select = $('deptHoursSelect');
  if (select) {
    select.innerHTML = allDepartments.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')
      || '<option value="">No departments yet — add one from Admin → Team → Departments</option>';
    updateDeptHoursPositionOptions();
  }

  const list = $('deptHoursListArea');
  // Each department may have one 'general' row, or several role rows —
  // flatten to one line per (department, role) that actually has hours.
  const rows = [];
  departments.forEach((d) => {
    (d.roles && d.roles.length ? d.roles : [{ position: 'general', allocatedHours: d.allocatedHours, usedHours: d.usedHours }])
      .forEach((r) => {
        if (r.allocatedHours > 0) rows.push({ departmentId: d.id, departmentName: d.name, position: r.position, allocatedHours: r.allocatedHours, usedHours: r.usedHours });
      });
  });
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No department hours set yet.</div>';
  } else {
    list.innerHTML = rows.map((r) => `
      <div class="entry" data-dept-hours-row="${escapeHtml(r.departmentId)}:${escapeHtml(r.position)}">
        <div class="entry-body">
          <div class="entry-desc">${escapeHtml(r.departmentName)}${r.position !== 'general' ? ` — ${escapeHtml(POSITION_LABEL[r.position] || r.position)}` : ''}</div>
          <div class="entry-meta">${r.allocatedHours}h allocated · ${r.usedHours}h used</div>
        </div>
        ${isAdmin ? `<button type="button" class="ghost" data-delete-dept-hours="${escapeHtml(r.departmentId)}" data-delete-dept-hours-position="${escapeHtml(r.position)}">✕</button>` : ''}
      </div>
    `).join('');
    list.querySelectorAll('[data-delete-dept-hours]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await sb.from('project_department_hours').delete()
          .eq('job_id', jobId)
          .eq('department_id', btn.dataset.deleteDeptHours)
          .eq('position', btn.dataset.deleteDeptHoursPosition);
        openProjectDetail(jobId, currentProjectReport?.project?.name || null);
      });
    });
  }
}

if ($('deptHoursSelect')) {
  $('deptHoursSelect').addEventListener('change', updateDeptHoursPositionOptions);
}

if ($('addDeptHoursBtn')) {
  $('addDeptHoursBtn').addEventListener('click', async () => {
    const jobId = currentProjectJobId;
    if (!jobId) return;
    const departmentId = $('deptHoursSelect').value;
    if (!departmentId) { showToast('Pick a department first.'); return; }
    const position = $('deptHoursPositionWrap')?.style.display !== 'none' ? ($('deptHoursPosition')?.value || 'general') : 'general';
    const hours = parseFloat($('deptHoursValue').value) || 0;
    const { error } = await sb.from('project_department_hours')
      .upsert({ job_id: jobId, department_id: departmentId, position, allocated_hours: hours, created_by: currentUser.id }, { onConflict: 'job_id,department_id,position' });
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

// =====================================================================
// PROFIT ANALYZER — quoted price vs. what's actually been spent/collected
// on a project, broken down by department and person (hours × hourly_rate
// from Data Feed), plus a company-wide profit trend over a chosen year
// range. Charts use Chart.js (loaded via CDN in index.html, cached by the
// service worker like the other third-party libs).
// =====================================================================

function formatUSD(n) {
  const num = Number(n) || 0;
  const sign = num < 0 ? '-' : '';
  return `${sign}$${Math.abs(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// PostgREST caps a single response at 1000 rows by default — fine for one
// project's ledger rows, not safe to assume for a company-wide, multi-year
// query. This pages through with .range() until a short page confirms
// there's nothing left, same idea as sync-to-drive's own pagination.
async function fetchAllPaginated(table, selectStr, applyFilters) {
  let all = [];
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    let q = sb.from(table).select(selectStr).range(from, from + pageSize - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) { console.error(`fetchAllPaginated(${table}) failed:`, error); break; }
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Quoted price: prefers the accepted Quotation for this job (falling back
// to the most recent Quotation of any status), and falls back to the BOQ
// total if this job has no Quotation at all — some projects are quoted one
// way, some the other.
async function fetchQuotedPrice(jobId) {
  // Sheet-sourced quote (JOB DATA "Quoted price" column, synced straight into
  // projects.quoted_price by sync-job-hours) is now the primary source — no
  // manual entry needed. Only fall back to the old manual Quotation/BOQ
  // derivation for jobs the sheet hasn't quoted yet.
  const { data: proj } = await sb.from('projects').select('quoted_price').eq('job_id', jobId).maybeSingle();
  if (proj && proj.quoted_price !== null && proj.quoted_price !== undefined && Number(proj.quoted_price) > 0) {
    return { source: 'sheet', amount: Number(proj.quoted_price) || 0 };
  }
  const { data: quotes } = await sb.from('quotations')
    .select('id, status, issue_date')
    .eq('job_id', jobId)
    .order('issue_date', { ascending: false });
  if (quotes && quotes.length) {
    const chosen = quotes.find((q) => q.status === 'accepted') || quotes[0];
    const { data: items } = await sb.from('quotation_items').select('quantity, unit_price').eq('quotation_id', chosen.id);
    const amount = (items || []).reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);
    return { source: 'quotation', amount };
  }
  const { data: boq } = await sb.from('boq_items').select('quantity, unit_rate').eq('job_id', jobId);
  if (boq && boq.length) {
    const amount = boq.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_rate) || 0), 0);
    return { source: 'boq', amount };
  }
  return { source: null, amount: 0 };
}

// Role-wide (not department-scoped) budget-vs-actual + efficiency bonus.
// Budget per role comes from project_position_hours (Engineers/Supervisor/
// Foremen/Technicians/Departments columns synced from the JOB DATA sheet —
// see sync-job-hours). Actual hours/cost per role come from job_hours_ledger
// joined to each person's profiles.position. When a role finishes UNDER its
// quoted hours, the saved hours + cost become a bonus split proportionally
// to hours logged among the people who actually worked that role on this job.
async function fetchRoleBreakdown(jobId) {
  const [{ data: posHours }, { data: ledgerRows }, { data: people }] = await Promise.all([
    sb.from('project_position_hours').select('position, allocated_hours').eq('job_id', jobId),
    sb.from('job_hours_ledger').select('person_id, hours').eq('job_id', jobId),
    sb.from('profiles').select('id, full_name, email, position, hourly_rate'),
  ]);

  const peopleMap = new Map((people || []).map((p) => [p.id, p]));
  const allocatedByPosition = new Map((posHours || []).filter((r) => r.position !== 'general').map((r) => [r.position, Number(r.allocated_hours) || 0]));

  const buckets = new Map(); // position -> { hours, cost, people: Map(personId -> {name, hours, rate, cost}) }
  (ledgerRows || []).forEach((row) => {
    const person = peopleMap.get(row.person_id);
    const position = person?.position || 'other';
    const hours = Number(row.hours) || 0;
    const rate = Number(person?.hourly_rate || 0);
    const cost = hours * rate;
    if (!buckets.has(position)) buckets.set(position, { hours: 0, cost: 0, people: new Map() });
    const bucket = buckets.get(position);
    bucket.hours += hours;
    bucket.cost += cost;
    const key = row.person_id || 'unknown';
    if (!bucket.people.has(key)) bucket.people.set(key, { id: key, name: person?.full_name || person?.email || 'Unknown', hours: 0, rate, cost: 0 });
    const pRec = bucket.people.get(key);
    pRec.hours += hours;
    pRec.cost += cost;
  });

  // Union of every position that has either a budget or actual hours, so a
  // fully-budgeted-but-not-yet-worked role (or vice versa) still shows up.
  const allPositions = new Set([...allocatedByPosition.keys(), ...buckets.keys()]);

  const roles = [...allPositions].map((position) => {
    const bucket = buckets.get(position) || { hours: 0, cost: 0, people: new Map() };
    const allocated = allocatedByPosition.get(position) || 0;
    const variance = allocated - bucket.hours; // positive = under budget (gained time), negative = exceeded
    const peopleArr = [...bucket.people.values()].sort((a, b) => b.hours - a.hours);

    // Bonus only applies when there's a real budget to have beaten and the
    // role actually logged hours (no budget = nothing to compare against;
    // no hours logged = no one to credit).
    const bonusPool = allocated > 0 && bucket.hours > 0 && variance > 0 ? variance : 0;
    const peopleWithBonus = peopleArr.map((p) => {
      const share = bucket.hours > 0 ? p.hours / bucket.hours : 0;
      const bonusHours = bonusPool * share;
      const bonusCost = bonusHours * p.rate;
      return { ...p, bonusHours, bonusCost };
    });

    return {
      position,
      label: POSITION_LABEL[position] || position,
      allocated,
      actualHours: bucket.hours,
      actualCost: bucket.cost,
      variance,
      bonusHours: bonusPool,
      bonusCost: peopleWithBonus.reduce((s, p) => s + p.bonusCost, 0),
      people: peopleWithBonus,
    };
  }).sort((a, b) => (b.allocated + b.actualHours) - (a.allocated + a.actualHours));

  return roles;
}

async function fetchProjectCostBreakdown(jobId) {
  const [
    { data: ledgerRows },
    { data: allocRows },
    { data: depts },
    { data: people },
    quoted,
    { data: extraCosts },
    { data: payments },
    roles,
  ] = await Promise.all([
    sb.from('job_hours_ledger').select('person_id, department_id, hours').eq('job_id', jobId),
    sb.from('project_department_hours').select('department_id, allocated_hours').eq('job_id', jobId),
    sb.from('departments').select('id, name'),
    sb.from('profiles').select('id, full_name, email, hourly_rate'),
    fetchQuotedPrice(jobId),
    sb.from('project_extra_costs').select('*').eq('job_id', jobId).order('entry_date', { ascending: false }),
    sb.from('project_payments').select('*').eq('job_id', jobId).order('entry_date', { ascending: false }),
    fetchRoleBreakdown(jobId),
  ]);

  const peopleMap = new Map((people || []).map((p) => [p.id, p]));
  const deptMap = new Map((depts || []).map((d) => [d.id, d.name]));
  const allocByDept = {};
  (allocRows || []).forEach((r) => {
    allocByDept[r.department_id] = (allocByDept[r.department_id] || 0) + (Number(r.allocated_hours) || 0);
  });

  const deptBuckets = {};
  let totalLaborCost = 0;
  let totalHours = 0;
  (ledgerRows || []).forEach((row) => {
    const deptId = row.department_id || '_none';
    const person = peopleMap.get(row.person_id);
    const rate = Number(person?.hourly_rate || 0);
    const hours = Number(row.hours) || 0;
    const cost = hours * rate;
    totalLaborCost += cost;
    totalHours += hours;
    if (!deptBuckets[deptId]) {
      deptBuckets[deptId] = { name: deptMap.get(deptId) || 'Unassigned', hours: 0, cost: 0, allocated: allocByDept[deptId] || 0, people: new Map() };
    }
    const bucket = deptBuckets[deptId];
    bucket.hours += hours;
    bucket.cost += cost;
    const key = row.person_id || 'unknown';
    if (!bucket.people.has(key)) bucket.people.set(key, { name: person?.full_name || person?.email || 'Unknown', hours: 0, rate, cost: 0 });
    const pRec = bucket.people.get(key);
    pRec.hours += hours;
    pRec.cost += cost;
  });

  const extraCostsTotal = (extraCosts || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const collected = (payments || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const totalUsed = totalLaborCost + extraCostsTotal;

  // Invest amount = everything the company has put into this job so far —
  // man hours (automatic, from the ledger) plus every categorized extra
  // cost (procurement, transportation & logistics, rent, interest, other).
  const costByCategory = { man_hours: totalLaborCost, procurement: 0, transportation_logistics: 0, rent: 0, interest: 0, other: 0 };
  (extraCosts || []).forEach((r) => {
    const cat = COST_CATEGORY_LABEL[r.category] ? r.category : 'other';
    costByCategory[cat] = (costByCategory[cat] || 0) + (Number(r.amount) || 0);
  });
  const investBreakdown = Object.entries(costByCategory)
    .filter(([, amount]) => amount > 0)
    .map(([category, amount]) => ({ category, label: COST_CATEGORY_LABEL[category] || category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    jobId,
    quoted,
    expected: quoted.amount,
    collected,
    totalLaborCost,
    extraCostsTotal,
    totalUsed,
    totalHours,
    investBreakdown,
    profitActual: collected - totalUsed,
    profitProjected: quoted.amount - totalUsed,
    departments: Object.entries(deptBuckets)
      .map(([id, b]) => ({
        id, name: b.name, hours: b.hours, cost: b.cost, allocated: b.allocated,
        people: [...b.people.values()].sort((a, b2) => b2.cost - a.cost),
      }))
      .sort((a, b) => b.cost - a.cost),
    extraCosts: extraCosts || [],
    payments: payments || [],
    roles,
  };
}

function profitDeptRowHtml(d) {
  const overBudget = d.allocated > 0 && d.hours > d.allocated;
  return `
    <div class="profit-dept-tile">
      <div class="profit-dept-tile-head">
        <strong style="font-size:13px;">${escapeHtml(d.name)}</strong>
        <span class="hint">${d.hours.toFixed(1)}h${d.allocated ? ` / ${d.allocated.toFixed(1)}h budget` : ''}</span>
      </div>
      <div class="profit-dept-tile-cost" style="color:${overBudget ? '#ff5470' : '#39ffb0'};">${formatUSD(d.cost)}</div>
      ${overBudget ? `<div class="hint" style="color:#ff5470;">Over budget by ${(d.hours - d.allocated).toFixed(1)}h</div>` : ''}
      <div class="profit-dept-tile-people">
        ${d.people.length ? d.people.map((p) => `
          <div class="profit-dept-tile-person">
            <span>${escapeHtml(p.name)}</span>
            <span class="hint">${p.hours.toFixed(1)}h × ${formatUSD(p.rate)}/hr = ${formatUSD(p.cost)}</span>
          </div>
        `).join('') : '<div class="empty" style="padding:4px 0;">No one logged hours here yet.</div>'}
      </div>
    </div>
  `;
}

function profitRoleRowHtml(r) {
  const hasBudget = r.allocated > 0;
  const over = hasBudget && r.variance < 0;
  const under = hasBudget && r.variance > 0;
  const varianceLabel = !hasBudget
    ? 'No budget set for this role yet'
    : over
      ? `Exceeded quoted hours by ${Math.abs(r.variance).toFixed(1)}h`
      : under
        ? `${r.variance.toFixed(1)}h under quote — bonus earned`
        : 'Right on quote';
  const varianceColor = over ? '#ff5470' : under ? '#39ffb0' : '#cfe8ff';
  return `
    <div class="card glass" style="margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:6px;">
        <strong style="font-size:13px;">${escapeHtml(r.label)}</strong>
        <span class="hint">${r.actualHours.toFixed(1)}h${hasBudget ? ` / ${r.allocated.toFixed(1)}h quoted` : ''} · ${formatUSD(r.actualCost)}</span>
      </div>
      <div class="hint" style="color:${varianceColor}; margin-top:2px;">${varianceLabel}</div>
      ${r.bonusHours > 0 ? `<div class="hint" style="color:#39ffb0; margin-top:2px;">🏆 Efficiency bonus pool: ${r.bonusHours.toFixed(1)}h · ${formatUSD(r.bonusCost)}</div>` : ''}
      ${r.people.length ? `
      <div style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">
        ${r.people.map((p) => `
          <div style="display:flex; justify-content:space-between; font-size:12.5px; gap:8px;">
            <span>${escapeHtml(p.name)}</span>
            <span class="hint">${p.hours.toFixed(1)}h × ${formatUSD(p.rate)}/hr = ${formatUSD(p.cost)}${p.bonusHours > 0 ? ` · 🏆 +${p.bonusHours.toFixed(1)}h / ${formatUSD(p.bonusCost)} bonus` : ''}</span>
          </div>
        `).join('')}
      </div>` : ''}
    </div>
  `;
}

function profitExtraCostRowHtml(c) {
  const catLabel = COST_CATEGORY_LABEL[c.category] || COST_CATEGORY_LABEL.other;
  return `
    <div class="entry" data-extra-cost="${c.id}">
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(c.description)}</div>
        <div class="entry-meta">${catLabel} · ${formatUSD(c.amount)} · ${new Date(`${c.entry_date}T00:00:00`).toLocaleDateString()}</div>
      </div>
      <button type="button" class="ghost" data-delete-extra-cost="${c.id}">✕</button>
    </div>
  `;
}

function profitPaymentRowHtml(p) {
  return `
    <div class="entry" data-payment="${p.id}">
      <div class="entry-body">
        <div class="entry-desc">${formatUSD(p.amount)}${p.note ? ` — ${escapeHtml(p.note)}` : ''}</div>
        <div class="entry-meta">${new Date(`${p.entry_date}T00:00:00`).toLocaleDateString()}</div>
      </div>
      <button type="button" class="ghost" data-delete-payment="${p.id}">✕</button>
    </div>
  `;
}

let profitDeptDoughnutChart = null;
let profitDeptBarChart = null;
let profitRoleBarChart = null;
let profitSummaryBarChart = null;
let profitInvestDoughnutChart = null;
// Extra costs / Payments start collapsed — reduces clutter on the detail
// screen since most of the time an admin is just checking the numbers, not
// logging a new cost. Persisted at module scope so the collapse state
// survives the re-render that happens after adding/deleting an entry.
let profitExtraCostsExpanded = false;
let profitPaymentsExpanded = false;

function renderProfitCharts(data) {
  if (typeof Chart === 'undefined') return;
  if (profitDeptDoughnutChart) { profitDeptDoughnutChart.destroy(); profitDeptDoughnutChart = null; }
  if (profitDeptBarChart) { profitDeptBarChart.destroy(); profitDeptBarChart = null; }
  if (profitRoleBarChart) { profitRoleBarChart.destroy(); profitRoleBarChart = null; }
  if (profitSummaryBarChart) { profitSummaryBarChart.destroy(); profitSummaryBarChart = null; }
  if (profitInvestDoughnutChart) { profitInvestDoughnutChart.destroy(); profitInvestDoughnutChart = null; }

  const palette = ['#39ffb0', '#4dabff', '#ffb84d', '#ff5470', '#b98bff', '#5df2c8', '#f2d94d', '#ff8a5c'];

  // Single-project headline: Quoted / Invested / Collected / Profit, all in
  // one glanceable bar — the "more graphs" the numbers alone don't give you.
  const summaryBarEl = $('profitSummaryBar');
  if (summaryBarEl) {
    profitSummaryBarChart = new Chart(summaryBarEl.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['Quoted', 'Invested', 'Collected', 'Profit'],
        datasets: [{
          data: [data.expected, data.totalUsed, data.collected, data.profitActual],
          backgroundColor: ['#4dabff', '#ffb84d', '#39ffb0', data.profitActual >= 0 ? '#39ffb0' : '#ff5470'],
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Quoted vs invested vs collected vs profit', color: '#cfe8ff' },
        },
        scales: {
          x: { ticks: { color: '#cfe8ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
          y: { ticks: { color: '#cfe8ff', callback: (v) => formatUSD(v) }, grid: { color: 'rgba(255,255,255,0.08)' } },
        },
      },
    });
  }

  // Invest amount breakdown by category — man hours vs procurement vs
  // transportation & logistics vs rent vs interest vs other.
  const investDoughnutEl = $('profitInvestDoughnut');
  const investBreakdown = data.investBreakdown || [];
  if (investDoughnutEl && investBreakdown.length) {
    profitInvestDoughnutChart = new Chart(investDoughnutEl.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: investBreakdown.map((b) => b.label),
        datasets: [{ data: investBreakdown.map((b) => b.amount), backgroundColor: investBreakdown.map((_, i) => palette[i % palette.length]), borderColor: 'rgba(10,10,20,0.6)', borderWidth: 1 }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#cfe8ff', boxWidth: 10, font: { size: 10 } } },
          title: { display: true, text: 'Invest amount by category', color: '#cfe8ff' },
        },
      },
    });
  }

  const doughnutEl = $('profitDeptDoughnut');
  const barEl = $('profitDeptBar');
  const depts = data.departments;
  if (doughnutEl && barEl && depts.length) {
    profitDeptDoughnutChart = new Chart(doughnutEl.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: depts.map((d) => d.name),
        datasets: [{ data: depts.map((d) => d.cost), backgroundColor: depts.map((_, i) => palette[i % palette.length]), borderColor: 'rgba(10,10,20,0.6)', borderWidth: 1 }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#cfe8ff', boxWidth: 10, font: { size: 10 } } },
          title: { display: true, text: 'Labor cost by department', color: '#cfe8ff' },
        },
      },
    });

    profitDeptBarChart = new Chart(barEl.getContext('2d'), {
      type: 'bar',
      data: {
        labels: depts.map((d) => d.name),
        datasets: [
          { label: 'Budgeted hrs', data: depts.map((d) => d.allocated), backgroundColor: 'rgba(77,171,255,0.5)' },
          { label: 'Used hrs', data: depts.map((d) => d.hours), backgroundColor: depts.map((d) => (d.allocated && d.hours > d.allocated ? '#ff5470' : '#39ffb0')) },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#cfe8ff', boxWidth: 10, font: { size: 10 } } },
          title: { display: true, text: 'Budgeted vs used hours', color: '#cfe8ff' },
        },
        scales: {
          x: { ticks: { color: '#cfe8ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
          y: { ticks: { color: '#cfe8ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
        },
      },
    });
  }

  const roleBarEl = $('profitRoleBar');
  const roles = (data.roles || []).filter((r) => r.allocated > 0 || r.actualHours > 0);
  if (roleBarEl && roles.length) {
    profitRoleBarChart = new Chart(roleBarEl.getContext('2d'), {
      type: 'bar',
      data: {
        labels: roles.map((r) => r.label),
        datasets: [
          { label: 'Quoted hrs', data: roles.map((r) => r.allocated), backgroundColor: 'rgba(77,171,255,0.5)' },
          { label: 'Actual hrs', data: roles.map((r) => r.actualHours), backgroundColor: roles.map((r) => (r.allocated && r.actualHours > r.allocated ? '#ff5470' : '#39ffb0')) },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#cfe8ff', boxWidth: 10, font: { size: 10 } } },
          title: { display: true, text: 'Quoted vs actual hours by role', color: '#cfe8ff' },
        },
        scales: {
          x: { ticks: { color: '#cfe8ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
          y: { ticks: { color: '#cfe8ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
        },
      },
    });
  }
}

function wireProfitDetailButtons(jobId, jobName) {
  const addCostBtn = $('profitAddCostBtn');
  if (addCostBtn) addCostBtn.addEventListener('click', async () => {
    const description = $('profitCostDesc').value.trim();
    const amount = parseFloat($('profitCostAmount').value) || 0;
    const entryDate = $('profitCostDate').value || new Date().toISOString().slice(0, 10);
    const category = $('profitCostCategory')?.value || 'other';
    if (!description || amount <= 0) { showToast('Enter a description and an amount.'); return; }
    const { error } = await sb.from('project_extra_costs').insert({ job_id: jobId, description, amount, entry_date: entryDate, category, created_by: currentUser?.id || null });
    if (error) { showToast(`Couldn't add: ${error.message}`); return; }
    showToast('Cost added.');
    renderProfitDetail(jobId, jobName);
  });

  const addPayBtn = $('profitAddPaymentBtn');
  if (addPayBtn) addPayBtn.addEventListener('click', async () => {
    const amount = parseFloat($('profitPayAmount').value) || 0;
    const entryDate = $('profitPayDate').value || new Date().toISOString().slice(0, 10);
    const note = $('profitPayNote').value.trim() || null;
    if (amount <= 0) { showToast('Enter an amount.'); return; }
    const { error } = await sb.from('project_payments').insert({ job_id: jobId, amount, entry_date: entryDate, note, created_by: currentUser?.id || null });
    if (error) { showToast(`Couldn't log payment: ${error.message}`); return; }
    showToast('Payment logged.');
    renderProfitDetail(jobId, jobName);
  });

  document.querySelectorAll('[data-delete-extra-cost]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this cost entry?')) return;
      await sb.from('project_extra_costs').delete().eq('id', btn.dataset.deleteExtraCost);
      renderProfitDetail(jobId, jobName);
    });
  });
  document.querySelectorAll('[data-delete-payment]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this payment record?')) return;
      await sb.from('project_payments').delete().eq('id', btn.dataset.deletePayment);
      renderProfitDetail(jobId, jobName);
    });
  });
}

async function renderProfitDetail(jobId, jobName) {
  if ($('profitDetailTitle')) $('profitDetailTitle').textContent = jobName || jobId;
  const body = $('profitDetailBody');
  if (body) body.innerHTML = '<div class="empty">Loading…</div>';
  const data = await fetchProjectCostBreakdown(jobId);
  if (!body) return;

  const profitColor = data.profitActual >= 0 ? '#39ffb0' : '#ff5470';
  const projectedColor = data.profitProjected >= 0 ? '#39ffb0' : '#ff5470';

  body.innerHTML = `
    <div class="profit-stat-grid">
      <div class="profit-stat-card">
        <div class="hint">💵 Quoted price${data.quoted.source ? ` (${data.quoted.source === 'sheet' ? 'JOB DATA sheet' : data.quoted.source === 'quotation' ? 'Quotation' : 'BOQ'})` : ''}</div>
        <div class="profit-stat-value">${formatUSD(data.expected)}</div>
      </div>
      <div class="profit-stat-card">
        <div class="hint">📥 Collected</div>
        <div class="profit-stat-value" style="color:#39ffb0;">${formatUSD(data.collected)}</div>
      </div>
      <div class="profit-stat-card">
        <div class="hint">💰 Invest amount (labor + procurement + logistics + rent + interest)</div>
        <div class="profit-stat-value" style="color:#ffb84d;">${formatUSD(data.totalUsed)}</div>
      </div>
      <div class="profit-stat-card">
        <div class="hint">${data.profitActual >= 0 ? '📈' : '📉'} Profit so far</div>
        <div class="profit-stat-value" style="color:${profitColor};">${formatUSD(data.profitActual)}</div>
      </div>
    </div>
    <p class="hint" style="margin-top:8px;">Projected profit if fully paid: <strong style="color:${projectedColor};">${formatUSD(data.profitProjected)}</strong> · Labor cost: ${formatUSD(data.totalLaborCost)} (${data.totalHours.toFixed(1)}h) · Extra costs: ${formatUSD(data.extraCostsTotal)}</p>

    <div class="profit-chart-row">
      <div class="profit-chart-card"><canvas id="profitSummaryBar" height="220"></canvas></div>
      <div class="profit-chart-card"><canvas id="profitInvestDoughnut" height="220"></canvas></div>
    </div>

    <div style="margin-top:18px;">
      <strong style="font-size:14px;">💰 Invest amount — where the money went</strong>
      <p class="hint" style="margin-top:2px;">Man hours is automatic from logged hours. Procurement, transportation &amp; logistics, rent, and interest come from the categorized costs you log below.</p>
      <div id="profitInvestList" style="margin-top:8px; display:flex; flex-direction:column; gap:4px;">
        ${(data.investBreakdown || []).length ? data.investBreakdown.map((b) => `
          <div style="display:flex; justify-content:space-between; font-size:13px; gap:8px;">
            <span>${b.label}</span>
            <span class="hint">${formatUSD(b.amount)}</span>
          </div>
        `).join('') : '<div class="empty">Nothing invested yet.</div>'}
      </div>
    </div>

    <div class="profit-chart-row">
      <div class="profit-chart-card"><canvas id="profitDeptDoughnut" height="220"></canvas></div>
      <div class="profit-chart-card"><canvas id="profitDeptBar" height="220"></canvas></div>
    </div>

    <div style="margin-top:18px;">
      <strong style="font-size:14px;">👷 Department tiles — who spent what</strong>
      <div id="profitDeptList" class="profit-dept-grid" style="margin-top:8px;">${data.departments.length ? data.departments.map(profitDeptRowHtml).join('') : '<div class="empty">No hours logged yet.</div>'}</div>
    </div>

    <div style="margin-top:20px;">
      <strong style="font-size:14px;">🧮 Role totals, quoted-vs-actual &amp; bonus</strong>
      <p class="hint" style="margin-top:2px;">Whole-project totals per role (Engineer, Technician, Supervisor, Foreman, Manager…), compared against the hours quoted for that role in the JOB DATA sheet. A role that finishes under its quoted hours turns the saved time into a bonus, split by hours logged among the people who worked it.</p>
      <div class="profit-chart-card" style="margin-top:10px;"><canvas id="profitRoleBar" height="220"></canvas></div>
      <div id="profitRoleList" style="margin-top:8px;">${(data.roles || []).length ? data.roles.map(profitRoleRowHtml).join('') : '<div class="empty">No role budget or hours yet — fill in the JOB DATA sheet and refresh from Data Feed.</div>'}</div>
    </div>

    <div style="margin-top:20px;">
      <button type="button" class="secondary" id="profitExtraCostsToggle" style="width:100%; text-align:left; display:flex; justify-content:space-between; align-items:center;">
        <span><strong style="font-size:14px;">➕ Extra costs</strong> <span class="hint">(${data.extraCosts.length})</span></span>
        <span>${profitExtraCostsExpanded ? '▾ Hide' : '▸ Show'}</span>
      </button>
      <div id="profitExtraCostsBody" style="display:${profitExtraCostsExpanded ? 'block' : 'none'}; margin-top:8px;">
        <p class="hint">Procurement, transportation &amp; logistics, rent, interest, or any other project spend outside labor.</p>
        <div class="location-row" style="margin-top:8px;">
          <input id="profitCostDesc" type="text" placeholder="Description" style="flex:2 1 160px;" />
          <select id="profitCostCategory" style="flex:1 1 150px;">
            <option value="procurement">📦 Procurement</option>
            <option value="transportation_logistics">🚚 Transportation &amp; logistics</option>
            <option value="rent">🏠 Rent</option>
            <option value="interest">🏦 Interest</option>
            <option value="other" selected>➕ Other</option>
          </select>
          <input id="profitCostAmount" type="number" min="0" step="0.01" placeholder="Amount" style="flex:1 1 100px;" />
          <input id="profitCostDate" type="date" style="flex:1 1 130px;" />
          <button type="button" id="profitAddCostBtn" class="secondary">+ Add</button>
        </div>
        <div id="profitCostList" style="margin-top:8px;">${data.extraCosts.length ? data.extraCosts.map(profitExtraCostRowHtml).join('') : '<div class="empty">None logged yet.</div>'}</div>
      </div>
    </div>

    <div style="margin-top:20px;">
      <button type="button" class="secondary" id="profitPaymentsToggle" style="width:100%; text-align:left; display:flex; justify-content:space-between; align-items:center;">
        <span><strong style="font-size:14px;">💳 Payments collected</strong> <span class="hint">(${data.payments.length})</span></span>
        <span>${profitPaymentsExpanded ? '▾ Hide' : '▸ Show'}</span>
      </button>
      <div id="profitPaymentsBody" style="display:${profitPaymentsExpanded ? 'block' : 'none'}; margin-top:8px;">
        <div class="location-row">
          <input id="profitPayAmount" type="number" min="0" step="0.01" placeholder="Amount" style="flex:1 1 100px;" />
          <input id="profitPayDate" type="date" style="flex:1 1 130px;" />
          <input id="profitPayNote" type="text" placeholder="Note (optional)" style="flex:2 1 160px;" />
          <button type="button" id="profitAddPaymentBtn" class="secondary">+ Log</button>
        </div>
        <div id="profitPaymentList" style="margin-top:8px;">${data.payments.length ? data.payments.map(profitPaymentRowHtml).join('') : '<div class="empty">None logged yet.</div>'}</div>
      </div>
    </div>
  `;

  $('profitExtraCostsToggle')?.addEventListener('click', () => {
    profitExtraCostsExpanded = !profitExtraCostsExpanded;
    renderProfitDetail(jobId, jobName);
  });
  $('profitPaymentsToggle')?.addEventListener('click', () => {
    profitPaymentsExpanded = !profitPaymentsExpanded;
    renderProfitDetail(jobId, jobName);
  });

  wireProfitDetailButtons(jobId, jobName);
  renderProfitCharts(data);
}

function openProfitDetail(jobId, jobName) {
  openPanel('profitDetail');
  renderProfitDetail(jobId, jobName);
}
if ($('profitDetailBackBtn')) {
  $('profitDetailBackBtn').addEventListener('click', () => { closePanel('profitDetail'); openPanel('profitAnalyzer'); });
}

let profitProjectsCache = [];
let profitSearchQuery = '';
async function renderProfitAnalyzerList() {
  const box = $('profitProjectList');
  if (!box) return;
  box.innerHTML = '<div class="empty">Loading…</div>';
  const { rows, error } = await fetchProjects();
  if (error) { box.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  profitProjectsCache = rows;
  renderProfitAnalyzerListFiltered();
}
function renderProfitAnalyzerListFiltered() {
  const box = $('profitProjectList');
  if (!box) return;
  const q = profitSearchQuery.trim().toLowerCase();
  const rows = q
    ? profitProjectsCache.filter((p) => (p.job_id || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q) || (p.client || '').toLowerCase().includes(q))
    : profitProjectsCache;
  if (!rows.length) { box.innerHTML = '<div class="empty">No projects match.</div>'; return; }
  box.innerHTML = rows.map((p) => `
    <div class="entry" data-profit-project="${escapeHtml(p.job_id)}" style="cursor:pointer;">
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(p.name || p.job_id)}</div>
        <div class="entry-meta">${escapeHtml(p.job_id)}${p.client ? ` · ${escapeHtml(p.client)}` : ''} · ${escapeHtml(p.status || '')}</div>
      </div>
      <span class="hint">View →</span>
    </div>
  `).join('');
  box.querySelectorAll('[data-profit-project]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = profitProjectsCache.find((row) => row.job_id === el.dataset.profitProject);
      openProfitDetail(el.dataset.profitProject, p?.name);
    });
  });
}
if ($('profitProjectSearch')) {
  $('profitProjectSearch').addEventListener('input', (e) => {
    profitSearchQuery = e.target.value;
    renderProfitAnalyzerListFiltered();
  });
}

// ---------- Company-wide profit analysis (year range) ----------
let companyProfitChart = null;
function populateProfitYearSelects() {
  const fromSel = $('profitYearFrom');
  const toSel = $('profitYearTo');
  if (!fromSel || !toSel || fromSel.options.length) return;
  const nowYear = new Date().getFullYear();
  const years = [];
  for (let y = nowYear; y >= nowYear - 6; y--) years.push(y);
  const optsHtml = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  fromSel.innerHTML = optsHtml;
  toSel.innerHTML = optsHtml;
  fromSel.value = String(nowYear);
  toSel.value = String(nowYear);
}

async function renderCompanyProfitAnalysis() {
  populateProfitYearSelects();
  const fromYear = Number($('profitYearFrom')?.value) || new Date().getFullYear();
  const toYear = Number($('profitYearTo')?.value) || fromYear;
  const lowYear = Math.min(fromYear, toYear);
  const highYear = Math.max(fromYear, toYear);
  const startDate = `${lowYear}-01-01`;
  const endDate = `${highYear}-12-31`;

  const summaryBox = $('profitCompanySummary');
  if (summaryBox) summaryBox.innerHTML = '<div class="empty">Loading…</div>';

  const [ledgerRows, payments, extraCosts, peopleRes] = await Promise.all([
    fetchAllPaginated('job_hours_ledger', 'person_id, hours, entry_date', (q) => q.gte('entry_date', startDate).lte('entry_date', endDate)),
    fetchAllPaginated('project_payments', 'amount, entry_date', (q) => q.gte('entry_date', startDate).lte('entry_date', endDate)),
    fetchAllPaginated('project_extra_costs', 'amount, entry_date', (q) => q.gte('entry_date', startDate).lte('entry_date', endDate)),
    sb.from('profiles').select('id, hourly_rate'),
  ]);
  const rateMap = new Map((peopleRes.data || []).map((p) => [p.id, Number(p.hourly_rate || 0)]));

  const months = [];
  for (let yy = lowYear; yy <= highYear; yy++) {
    for (let m = 1; m <= 12; m++) months.push(`${yy}-${String(m).padStart(2, '0')}`);
  }
  const bucket = new Map(months.map((m) => [m, { collected: 0, cost: 0 }]));
  const monthKey = (d) => (d ? d.slice(0, 7) : null);

  ledgerRows.forEach((r) => {
    const k = monthKey(r.entry_date);
    if (!bucket.has(k)) return;
    bucket.get(k).cost += (Number(r.hours) || 0) * (rateMap.get(r.person_id) || 0);
  });
  extraCosts.forEach((r) => {
    const k = monthKey(r.entry_date);
    if (!bucket.has(k)) return;
    bucket.get(k).cost += Number(r.amount) || 0;
  });
  payments.forEach((r) => {
    const k = monthKey(r.entry_date);
    if (!bucket.has(k)) return;
    bucket.get(k).collected += Number(r.amount) || 0;
  });

  const totalCollected = payments.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const totalCost = ledgerRows.reduce((s, r) => s + (Number(r.hours) || 0) * (rateMap.get(r.person_id) || 0), 0)
    + extraCosts.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const netProfit = totalCollected - totalCost;

  if (summaryBox) {
    summaryBox.innerHTML = `
      <div class="profit-stat-grid">
        <div class="profit-stat-card"><div class="hint">📥 Collected</div><div class="profit-stat-value" style="color:#39ffb0;">${formatUSD(totalCollected)}</div></div>
        <div class="profit-stat-card"><div class="hint">📤 Cost</div><div class="profit-stat-value" style="color:#ffb84d;">${formatUSD(totalCost)}</div></div>
        <div class="profit-stat-card"><div class="hint">${netProfit >= 0 ? '📈' : '📉'} Net profit</div><div class="profit-stat-value" style="color:${netProfit >= 0 ? '#39ffb0' : '#ff5470'};">${formatUSD(netProfit)}</div></div>
      </div>
    `;
  }

  const chartEl = $('profitCompanyChart');
  if (chartEl && typeof Chart !== 'undefined') {
    if (companyProfitChart) { companyProfitChart.destroy(); companyProfitChart = null; }
    const sameYear = lowYear === highYear;
    const labels = months.map((m) => {
      const [yy, mm] = m.split('-');
      return new Date(Number(yy), Number(mm) - 1, 1).toLocaleDateString(undefined, sameYear ? { month: 'short' } : { month: 'short', year: '2-digit' });
    });
    companyProfitChart = new Chart(chartEl.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Collected', data: months.map((m) => bucket.get(m).collected), borderColor: '#39ffb0', backgroundColor: 'rgba(57,255,176,0.15)', fill: true, tension: 0.35 },
          { label: 'Cost', data: months.map((m) => bucket.get(m).cost), borderColor: '#ff5470', backgroundColor: 'rgba(255,84,112,0.12)', fill: true, tension: 0.35 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: '#cfe8ff', boxWidth: 10, font: { size: 10 } } } },
        scales: {
          x: { ticks: { color: '#cfe8ff', maxRotation: months.length > 12 ? 60 : 0 }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y: { ticks: { color: '#cfe8ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
        },
      },
    });
  }
}
if ($('profitApplyYearRangeBtn')) {
  $('profitApplyYearRangeBtn').addEventListener('click', renderCompanyProfitAnalysis);
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
  const overHours = allocated > 0 ? Math.max(0, used - allocated) : 0;
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

// BUG FIX: this hadn't been updated for the per-department hour tracking
// rework earlier in this project — it was still reading project.allocated
// Engineer/Technician and totals.engineerHours/technicianHours, which no
// longer exist on get-project-report's response (it now returns
// project.departments, a dynamic list). Every "Share to group" image was
// silently rendering with blank/undefined numbers. Rewritten to draw one
// ring per actual department instead of two fixed ones.
async function buildProjectShareImage(data) {
  const { project, contributors = [] } = data;
  const departments = project.departments || [];
  // Same "Time by task" data the on-screen Project Analytics card uses —
  // top 8 by hours, so the shared image gives the full picture (task,
  // department, and people) instead of just department rings + contributors.
  const shareTasks = [...(data.taskBreakdown || [])].sort((a, b) => b.hours - a.hours).slice(0, 8);
  const shareUntagged = Number(data.untaggedHours) || 0;

  // "Who worked on this" is grouped BY DEPARTMENT (a header row per
  // department, its people listed underneath) so the shared/group-chat
  // report shows the same "inside each department, who used the time"
  // breakdown as the on-screen Department breakdown chart, not just a
  // flat contributor list.
  const byDeptForShare = {};
  contributors.forEach((c) => {
    const key = c.departmentId || 'unassigned';
    if (!byDeptForShare[key]) byDeptForShare[key] = { name: c.departmentName || 'No department set', people: [] };
    byDeptForShare[key].people.push(c);
  });
  const shareDeptGroups = Object.values(byDeptForShare)
    .map((d) => ({ ...d, total: Math.round(d.people.reduce((s, p) => s + (Number(p.hours) || 0), 0) * 100) / 100 }))
    .sort((a, b) => b.total - a.total);

  const W = 720;
  const RING_ROW_H = 210;
  const ringCols = Math.min(Math.max(departments.length, 1), 3);
  const ringRows = Math.max(1, Math.ceil(departments.length / ringCols));
  const HEADER_H = 90 + ringRows * RING_ROW_H;
  const ROW_H = 56;
  const DEPT_GROUP_HEADER_H = 34;
  const TASK_ROW_H = 44;
  const taskSectionH = shareTasks.length
    ? (54 + shareTasks.length * TASK_ROW_H + (shareUntagged > 0 ? 22 : 0))
    : (shareUntagged > 0 ? 90 : 0);
  const peopleSectionH = contributors.length
    ? (shareDeptGroups.length * DEPT_GROUP_HEADER_H + contributors.length * ROW_H)
    : ROW_H;
  const H = HEADER_H + peopleSectionH + taskSectionH + 90;

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

  if (!departments.length) {
    ctx.fillStyle = '#a8a6a2';
    ctx.font = '13px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('No department hours logged or allocated yet.', 40, 130);
  } else {
    const colW = W / ringCols;
    departments.forEach((d, i) => {
      const col = i % ringCols;
      const row = Math.floor(i / ringCols);
      const cx = colW * col + colW / 2;
      const cy = 90 + row * RING_ROW_H + 78;
      drawShareRing(ctx, cx, cy, d.usedHours, d.allocatedHours, d.name);
    });
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.beginPath();
  ctx.moveTo(40, HEADER_H - 14);
  ctx.lineTo(W - 40, HEADER_H - 14);
  ctx.stroke();

  ctx.fillStyle = '#f5f4f0';
  ctx.font = '700 14px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText('Who worked on this', 40, HEADER_H + 8);

  const allocatedByDept = {};
  departments.forEach((d) => { allocatedByDept[d.id] = Number(d.allocatedHours) || 0; });

  let y = HEADER_H + 40;
  if (!contributors.length) {
    ctx.fillStyle = '#a8a6a2';
    ctx.font = '13px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('No one has logged hours on this project yet.', 40, y);
  } else {
    // Grouped BY DEPARTMENT — a bold header row (name + total) then that
    // department's people underneath, each person's bar scaled against
    // their OWN department's busiest contributor so it reads as "who used
    // the time inside this department" rather than competing on an
    // absolute scale against people in entirely different departments.
    for (const group of shareDeptGroups) {
      const sortedPeople = [...group.people].sort((a, b) => b.hours - a.hours);
      const maxInDept = Math.max(...sortedPeople.map((p) => p.hours), 1);
      const allocated = allocatedByDept[sortedPeople[0]?.departmentId] || 0;

      ctx.font = '800 13.5px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillStyle = '#f5f4f0';
      ctx.fillText(group.name, 40, y);
      ctx.textAlign = 'right';
      ctx.font = '700 12.5px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillStyle = '#a8a6a2';
      ctx.fillText(`${group.total}h`, W - 40, y);
      ctx.textAlign = 'left';
      y += DEPT_GROUP_HEADER_H;

      sortedPeople.forEach((p, i) => {
        const barX = 56, barW = W - 96, barY = y + 12, barH = 8;
        const color = PA_PALETTE[i % PA_PALETTE.length];

        ctx.font = '650 13.5px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
        ctx.fillStyle = '#f5f4f0';
        ctx.fillText(p.name, barX, y);

        ctx.textAlign = 'right';
        ctx.font = '800 13px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
        ctx.fillStyle = '#f5f4f0';
        ctx.fillText(`${p.hours}h`, W - 40, y);
        ctx.textAlign = 'left';

        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
        ctx.fill();

        const pct = allocated > 0 ? Math.min(p.hours / allocated, 1) : (p.hours / maxInDept);
        const fillW = Math.max(barH, barW * pct);
        ctx.fillStyle = color;
        roundRectPath(ctx, barX, barY, fillW, barH, barH / 2);
        ctx.fill();

        y += ROW_H;
      });
    }
  }

  // ---- Time by task — same top-8-by-hours data as the on-screen chart ----
  if (shareTasks.length || shareUntagged > 0) {
    const taskY = y + 20;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(40, taskY - 14);
    ctx.lineTo(W - 40, taskY - 14);
    ctx.stroke();

    ctx.fillStyle = '#f5f4f0';
    ctx.font = '700 14px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.fillText('Time by task', 40, taskY + 8);

    let ty = taskY + 40;
    if (!shareTasks.length) {
      ctx.fillStyle = '#a8a6a2';
      ctx.font = '13px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillText(`${shareUntagged}h logged, not tagged with a specific task yet.`, 40, ty);
    } else {
      const maxTaskHours = Math.max(...shareTasks.map((t) => t.hours), 0.01);
      shareTasks.forEach((t, i) => {
        const barX = 40, barW = W - 80, barY = ty + 12, barH = 8;
        const color = PA_PALETTE[i % PA_PALETTE.length];

        ctx.font = '700 13.5px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
        ctx.fillStyle = '#f5f4f0';
        ctx.fillText(t.label, barX, ty);

        ctx.textAlign = 'right';
        ctx.font = '800 13px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
        ctx.fillStyle = '#f5f4f0';
        ctx.fillText(`${t.hours}h`, W - 40, ty);
        ctx.textAlign = 'left';

        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
        ctx.fill();

        const fillW = Math.max(barH, barW * (t.hours / maxTaskHours));
        ctx.fillStyle = color;
        roundRectPath(ctx, barX, barY, fillW, barH, barH / 2);
        ctx.fill();

        ty += TASK_ROW_H;
      });
      if (shareUntagged > 0) {
        ctx.fillStyle = '#a8a6a2';
        ctx.font = '11.5px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
        ctx.fillText(`+ ${shareUntagged}h logged with free-typed notes, not matching a specific task`, 40, ty + 4);
      }
    }
  }

  ctx.fillStyle = '#6b6965';
  ctx.font = '11px -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  ctx.fillText(new Date().toLocaleString(), 40, H - 30);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// SPAM FIX: this button used to post instantly every single tap, with no
// memory of the last time it was used — that's what was flooding group
// chats with the same project-status image back to back. Now it checks
// project_share_log for the last share to this SAME project+group; inside
// the last hour, it requires an explicit confirm before posting again.
const SHARE_COOLDOWN_MS = 60 * 60 * 1000;

async function minutesSinceLastShare(jobId, chatId) {
  const { data } = await sb
    .from('project_share_log')
    .select('shared_at')
    .eq('job_id', jobId)
    .eq('chat_id', chatId)
    .order('shared_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.shared_at) return null;
  return Math.round((Date.now() - new Date(data.shared_at).getTime()) / 60000);
}

if ($('shareProjectBtn')) {
  $('shareProjectBtn').addEventListener('click', async () => {
    const chatId = $('shareProjectGroupSelect').value;
    if (!chatId) { showToast('Pick a group to share to.'); return; }
    if (!currentProjectReport) { showToast('Still loading project data — try again in a second.'); return; }

    const { project } = currentProjectReport;

    try {
      const minsAgo = await minutesSinceLastShare(project.jobId, chatId);
      if (minsAgo !== null && minsAgo * 60000 < SHARE_COOLDOWN_MS) {
        const label = minsAgo < 1 ? 'less than a minute ago' : `${minsAgo} minute${minsAgo === 1 ? '' : 's'} ago`;
        if (!confirm(`This project was already shared to this group ${label}. Share it again anyway?`)) return;
      }
    } catch { /* if the check itself fails, fall through and allow sharing rather than block the feature */ }

    const btn = $('shareProjectBtn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing image…';

    try {
      const blob = await buildProjectShareImage(currentProjectReport);
      if (!blob) throw new Error('Could not generate the image.');

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

      // Best-effort log — a failure here shouldn't undo an already-posted
      // share, it just means the next tap won't know to throttle itself.
      sb.from('project_share_log').insert({ job_id: project.jobId, chat_id: chatId, shared_by: currentUser.id }).then(() => {}, () => {});

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
let chatMessagesCache = []; // last loaded rows for the open thread, kept so edit/cancel can re-render without a fresh fetch
let editingMessageId = null; // message currently showing its inline edit box, if any
let onlineUserIds = new Set();  // who's currently online, via Supabase Realtime Presence
// presenceChannel itself is declared up near currentUser/currentProfile now — see the comment there.
let globalMessagesChannel = null; // app-wide watch for the new-message banner (separate from the per-thread one below)

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

// ---------- App-wide new-message banner (WhatsApp-style) ----------
// Fires for a new message in ANY chat this person belongs to, not just the
// one currently open — a small banner slides down from the top so a new
// message is noticed even while looking at a completely different part of
// the app. This works alongside (not instead of) the real OS-level push
// notifications set up in Settings — this one only needs the app open in a
// tab/window right now (no permission prompt, nothing while backgrounded);
// the OS push already covers the closed/locked-phone case.
function startGlobalMessageWatch() {
  if (globalMessagesChannel || !currentUser) return;
  globalMessagesChannel = sb
    .channel('global-messages')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      handleIncomingMessageForBanner(payload.new);
    })
    .subscribe();
}
function stopGlobalMessageWatch() {
  if (globalMessagesChannel) { sb.removeChannel(globalMessagesChannel); globalMessagesChannel = null; }
}
async function handleIncomingMessageForBanner(msg) {
  if (!msg || !currentUser || msg.sender_id === currentUser.id) return;
  // If the tab/window isn't actually in front of someone, skip the in-app
  // banner — the real push notification (Settings → Enable notifications)
  // is what's meant to reach them while backgrounded or locked.
  if (document.visibilityState !== 'visible') return;
  const chatOverlayOpen = $('chatOverlayBackdrop')?.classList.contains('show');
  if (chatOverlayOpen && activeChatId === msg.chat_id) return; // already visible live in the open thread

  if (!teamProfiles.length) await loadTeamProfiles();
  let chat = chatListCache.find((c) => c.id === msg.chat_id);
  if (!chat) { await refreshChatList(); chat = chatListCache.find((c) => c.id === msg.chat_id); }

  const sender = teamProfiles.find((p) => p.id === msg.sender_id);
  const senderName = sender ? (sender.full_name || sender.email) : 'Someone';
  const isGroup = chat?.type === 'group';
  const preview = msg.content ? msg.content : (msg.attachment_name ? `📎 ${msg.attachment_name}` : 'Sent an attachment');

  showNewMessageBanner({
    title: isGroup ? (chat?.name || 'Group') : senderName,
    subtitle: isGroup ? `${senderName}: ${preview}` : preview,
    chatId: msg.chat_id,
  });
  playLaunchSound();
  if (chatOverlayOpen) refreshChatList();
}
function showNewMessageBanner({ title, subtitle, chatId }) {
  const el = $('newMsgBanner');
  if (!el) return;
  el.querySelector('.new-msg-banner-title').textContent = title;
  el.querySelector('.new-msg-banner-subtitle').textContent = subtitle;
  el.dataset.chatId = chatId;
  el.classList.add('show');
  clearTimeout(showNewMessageBanner._t);
  showNewMessageBanner._t = setTimeout(() => el.classList.remove('show'), 5000);
}
if ($('newMsgBanner')) {
  $('newMsgBanner').addEventListener('click', () => {
    const chatId = $('newMsgBanner').dataset.chatId;
    $('newMsgBanner').classList.remove('show');
    if (!chatId) return;
    openChatOverlay();
    openChat(chatId);
  });
}

// ---------- Online presence — who's currently in the app ----------
function startPresence() {
  if (presenceChannel || !currentUser) return;
  presenceChannel = sb.channel('presence:online', { config: { presence: { key: currentUser.id } } });
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      onlineUserIds = new Set(Object.keys(presenceChannel.presenceState()));
      renderChatList();
      updateThreadPresence();
      refreshOnlineDots();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await presenceChannel.track({ online_at: new Date().toISOString() });
    });
}
function stopPresence() {
  if (presenceChannel) { sb.removeChannel(presenceChannel); presenceChannel = null; }
  onlineUserIds = new Set();
}

// ---------- Last seen — a real timestamp for "who was here recently", not
// just "online right now" (Presence above only knows about this instant).
// Best-effort: writes to the person's own profile row only, on a timer
// while the app is open, so anyone offline still shows a useful "Last seen
// 10 minutes ago" instead of nothing.
let lastSeenTimerId = null;
async function pingLastSeen() {
  if (!currentUser) return;
  try { await sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', currentUser.id); } catch { /* best-effort, ignore */ }
}
function startLastSeenHeartbeat() {
  if (lastSeenTimerId || !currentUser) return;
  pingLastSeen();
  lastSeenTimerId = setInterval(pingLastSeen, 60000);
}
function stopLastSeenHeartbeat() {
  if (lastSeenTimerId) { clearInterval(lastSeenTimerId); lastSeenTimerId = null; }
}
function lastSeenLabel(iso) {
  if (!iso) return 'Last seen a while ago';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'Last seen just now';
  if (mins === 1) return 'Last seen 1 minute ago';
  if (mins < 60) return `Last seen ${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs === 1 ? 'Last seen 1 hour ago' : `Last seen ${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'Last seen 1 day ago' : `Last seen ${days} days ago`;
}

// Live-updates every "is this person online" dot/label currently on screen
// (Team list, Department member list, etc.) straight from onlineUserIds —
// no re-fetch needed, so it can run on every presence sync tick.
function refreshOnlineDots() {
  document.querySelectorAll('[data-presence-user]').forEach((dot) => {
    dot.classList.toggle('online', onlineUserIds.has(dot.dataset.presenceUser));
  });
  document.querySelectorAll('[data-last-seen-for]').forEach((el) => {
    const isOnline = onlineUserIds.has(el.dataset.lastSeenFor);
    el.textContent = isOnline ? 'Online now' : lastSeenLabel(el.dataset.lastSeen);
    el.classList.toggle('online', isOnline);
  });
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
  chatMessagesCache = rows;
  const wrap = $('chatMessages');
  const isGroup = activeChatMeta?.type === 'group';
  const scrolledToBottomAlready = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
  const parts = await Promise.all(rows.map(async (m) => {
    const mine = m.sender_id === currentUser.id;

    // Own message currently being edited — an inline textarea + Save/Cancel
    // instead of the normal bubble, so editing happens right in place
    // rather than a separate popup.
    if (mine && m.id === editingMessageId) {
      return `
        <div class="chat-bubble-row mine" data-msg-id="${m.id}">
          <div class="chat-bubble chat-bubble-editing">
            <textarea class="chat-edit-textarea" data-edit-input="${m.id}">${escapeHtml(m.content || '')}</textarea>
            <div class="chat-edit-actions">
              <button type="button" class="ghost" data-cancel-edit="${m.id}">Cancel</button>
              <button type="button" class="primary" data-save-edit="${m.id}" style="margin-top:0;">Save</button>
            </div>
          </div>
        </div>
      `;
    }

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
    // Only text content is editable (nothing to "edit" on an attachment by
    // itself), and only by whoever sent it.
    const editBtn = (mine && m.content)
      ? `<button type="button" class="chat-edit-btn" data-edit-msg="${m.id}" title="Edit message">✏️</button>`
      : '';
    const editedTag = m.edited_at ? '<span class="chat-edited-tag">edited</span> ' : '';
    return `
      <div class="chat-bubble-row ${mine ? 'mine' : ''}" data-msg-id="${m.id}">
        <div class="chat-bubble">
          ${senderName}
          ${m.content ? escapeHtml(m.content) : ''}
          ${mediaHtml}
          <div class="chat-bubble-time">${editedTag}${time}${editBtn}</div>
        </div>
      </div>
    `;
  }));
  wrap.innerHTML = parts.join('');
  wrap.querySelectorAll('[data-edit-msg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingMessageId = btn.dataset.editMsg;
      renderMessages(chatMessagesCache);
    });
  });
  wrap.querySelectorAll('[data-cancel-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingMessageId = null;
      renderMessages(chatMessagesCache);
    });
  });
  wrap.querySelectorAll('[data-save-edit]').forEach((btn) => {
    btn.addEventListener('click', () => saveMessageEdit(btn.dataset.saveEdit));
  });
  const textarea = editingMessageId && wrap.querySelector(`[data-edit-input="${editingMessageId}"]`);
  if (textarea) { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
  // Keep the view pinned to the bottom for new messages arriving while
  // already caught up, but don't yank someone back down if they've
  // scrolled up to read older messages (e.g. right as they open an edit box).
  if (scrolledToBottomAlready || editingMessageId) wrap.scrollTop = wrap.scrollHeight;
}

async function saveMessageEdit(msgId) {
  const textarea = document.querySelector(`[data-edit-input="${msgId}"]`);
  const newText = (textarea?.value || '').trim();
  if (!newText) { showToast("Message can't be empty."); return; }
  const { error } = await sb.from('messages').update({ content: newText, edited_at: new Date().toISOString() }).eq('id', msgId);
  if (error) { showToast(`Couldn't save edit: ${error.message}`); return; }
  editingMessageId = null;
  await loadMessages(activeChatId);
  refreshChatList();
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
  // Any member of a group can manage it (rename/add/remove/delete) — being
  // able to open the chat at all already proves membership, since chat
  // membership is what RLS uses to decide who can even read it. Admins can
  // also manage any group, including ones they haven't joined, because the
  // "admins see every chat" RLS/read-path below surfaces those groups too.
  const canManageGroup = activeChatMeta?.type === 'group';
  if ($('manageGroupBtn')) $('manageGroupBtn').style.display = canManageGroup ? 'flex' : 'none';
  editingMessageId = null; // don't carry an open edit box over from a different chat
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

// ---------- Manage group (admin only — rename, add/remove members, delete) ----------
$('manageGroupBtn')?.addEventListener('click', async () => {
  if (!activeChatId || activeChatMeta?.type !== 'group') return;
  if (!teamProfiles.length) await loadTeamProfiles();
  $('manageGroupNameInput').value = activeChatMeta.name || '';
  const currentMemberIds = new Set((activeChatMeta.memberProfiles || []).map((p) => p.id));
  // Everyone on the team, not just current members, so the admin can also
  // add someone new — current members start ticked, everyone else doesn't.
  const allPeople = [currentUser, ...teamProfiles].filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);
  $('manageGroupMemberList').innerHTML = allPeople.length
    ? allPeople.map((p) => `
        <label class="person-pick-row">
          <input type="checkbox" value="${p.id}" ${currentMemberIds.has(p.id) ? 'checked' : ''} />
          <span>${escapeHtml(p.full_name || p.email)}${p.id === currentUser.id ? ' (you)' : ''}</span>
        </label>
      `).join('')
    : '<div class="empty">No teammates yet.</div>';
  $('manageGroupOverlay').classList.add('show');
});
$('manageGroupCancelBtn')?.addEventListener('click', () => $('manageGroupOverlay').classList.remove('show'));

$('manageGroupSaveBtn')?.addEventListener('click', async () => {
  if (!activeChatId) return;
  const name = $('manageGroupNameInput').value.trim();
  if (!name) { showToast('Give the group a name.'); return; }
  const selectedIds = Array.from($('manageGroupMemberList').querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
  if (!selectedIds.length) { showToast('A group needs at least one member.'); return; }

  const { error: renameErr } = await sb.from('chats').update({ name }).eq('id', activeChatId);
  if (renameErr) { showToast(`Couldn't rename group: ${renameErr.message}`); return; }

  const currentMemberIds = new Set((activeChatMeta.memberProfiles || []).map((p) => p.id));
  const selectedSet = new Set(selectedIds);
  const toAdd = selectedIds.filter((id) => !currentMemberIds.has(id));
  const toRemove = [...currentMemberIds].filter((id) => !selectedSet.has(id));

  if (toAdd.length) {
    const { error: addErr } = await sb.from('chat_members').insert(toAdd.map((id) => ({ chat_id: activeChatId, user_id: id })));
    if (addErr) { showToast(`Couldn't add members: ${addErr.message}`); return; }
  }
  if (toRemove.length) {
    const { error: removeErr } = await sb.from('chat_members').delete().eq('chat_id', activeChatId).in('user_id', toRemove);
    if (removeErr) { showToast(`Couldn't remove members: ${removeErr.message}`); return; }
  }

  showToast('Group updated.');
  $('manageGroupOverlay').classList.remove('show');
  await refreshChatList();
  await openChat(activeChatId);
});

$('manageGroupDeleteBtn')?.addEventListener('click', async () => {
  if (!activeChatId) return;
  const name = activeChatMeta?.name || 'this group';
  if (!confirm(`Delete "${name}" for everyone? Every message in it is deleted too, permanently. This cannot be undone.`)) return;
  const deletingChatId = activeChatId;
  const { error } = await sb.from('chats').delete().eq('id', deletingChatId);
  if (error) { showToast(`Couldn't delete group: ${error.message}`); return; }
  showToast('Group deleted.');
  $('manageGroupOverlay').classList.remove('show');
  activeChatId = null;
  activeChatMeta = null;
  $('chatShell').classList.remove('show-thread');
  $('chatThreadWrap').style.display = 'none';
  $('chatEmpty').style.display = 'flex';
  if (messagesChannel) { sb.removeChannel(messagesChannel); messagesChannel = null; }
  clearInterval(openChatTimer);
  await refreshChatList();
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

  // The list is built here inside `wrap` like before, but the moment it
  // opens it gets moved out to <body> (see openList below) — every one of
  // these dropdowns lives inside a modal whose rounded-corner panel uses
  // `overflow: hidden`, which was clipping/garbling the bottom of longer
  // lists (Roles, Departments, etc.) instead of cleanly showing or
  // scrolling to them. Moving the actual open list to <body> and
  // positioning it with fixed, on-screen coordinates escapes that clipping
  // entirely, from any modal, at any scroll position.
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
    window.removeEventListener('scroll', positionList, true);
    window.removeEventListener('resize', positionList);
  }
  function onOutside(e) {
    if (!wrap.contains(e.target) && !list.contains(e.target)) closeList();
  }
  // Positions the (now body-level) list against the button's current, real
  // on-screen location — flipping upward instead of down whenever there
  // isn't enough room below, measured against the true viewport instead of
  // a possibly-clipping modal ancestor.
  function positionList() {
    const btnRect = btn.getBoundingClientRect();
    const listHeight = list.offsetHeight;
    const spaceBelow = window.innerHeight - btnRect.bottom;
    const spaceAbove = btnRect.top;
    const openUp = listHeight > spaceBelow - 12 && spaceAbove > spaceBelow;
    list.style.left = btnRect.left + 'px';
    list.style.width = btnRect.width + 'px';
    if (openUp) {
      list.style.top = 'auto';
      list.style.bottom = (window.innerHeight - btnRect.top + 4) + 'px';
    } else {
      list.style.bottom = 'auto';
      list.style.top = (btnRect.bottom + 4) + 'px';
    }
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
    document.body.appendChild(list);
    list.classList.add('glass-portal');
    list.style.display = 'block';
    positionList();
    document.addEventListener('mousedown', onOutside, true);
    // Keep it glued to the button if the modal/page scrolls or the window
    // resizes while it's open, instead of drifting away from what it's
    // anchored to.
    window.addEventListener('scroll', positionList, true);
    window.addEventListener('resize', positionList);
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

// =====================================================================
// SPECIAL REQUEST — a late/forgot/issue timesheet entry submitted after
// the fact. Submitting here only inserts a 'pending' row into
// special_requests via the submit-special-request Edge Function — no
// real timesheet entry, job_hours_ledger row, or Sheet sync happens yet.
// A department head (departments.head_id) or any admin then approves or
// rejects it (anytime, no deadline) via approve-special-request, which is
// what actually creates the real entry — tagged specialRequest: true so
// it gets the light-blue Sheet row highlight — and syncs it. Rejecting
// just flips the status; nothing is ever created for a rejected request.
// =====================================================================

let srMode = '';
const srDescSelected = new Set();
let srJobIdConfirmed = false;
let srLocationOptions = [];

document.querySelectorAll('.sr-mode-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    srMode = chip.dataset.srMode;
    document.querySelectorAll('.sr-mode-chip').forEach((c) => c.classList.toggle('selected', c === chip));
  });
});

async function ensureSrLocationOptions() {
  srLocationOptions = await fetchLocationAllowances();
}

function renderSrLocationResults(query) {
  const box = $('srLocationResults');
  if (!box) return;
  const q = (query || '').trim().toLowerCase();
  const matches = q ? srLocationOptions.filter((r) => r.name.toLowerCase().includes(q)) : srLocationOptions;
  box.innerHTML = matches.length
    ? matches.slice(0, 30).map((r) => `<div class="job-search-item" data-location-name="${escapeHtml(r.name)}"><div class="jid">📍 ${escapeHtml(r.name)}</div></div>`).join('')
    : '<div class="job-search-empty">No matching location on file — you can still type your own.</div>';
  box.style.display = 'block';
  box.querySelectorAll('[data-location-name]').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('srLocation').value = item.dataset.locationName;
      box.style.display = 'none';
    });
  });
}
if ($('srLocation')) {
  $('srLocation').addEventListener('focus', () => renderSrLocationResults($('srLocation').value));
  $('srLocation').addEventListener('input', () => renderSrLocationResults($('srLocation').value));
  $('srLocation').addEventListener('blur', () => {
    setTimeout(() => { if ($('srLocationResults')) $('srLocationResults').style.display = 'none'; }, 150);
  });
}

function renderSrJobSearchResults(matches) {
  const box = $('srJobIdResults');
  if (!box) return;
  box.innerHTML = matches.length
    ? matches.slice(0, 50).map((r) => `
        <div class="job-search-item" data-job-id="${escapeHtml(r.job_id)}">
          <div class="jid">${escapeHtml(r.job_id)}</div>
          <div class="jdesc">${escapeHtml(r.name || '')}${r.client ? ' · ' + escapeHtml(r.client) : ''}</div>
        </div>
      `).join('')
    : '<div class="job-search-empty">No matching job found — pick one from the list.</div>';
  box.style.display = 'block';
  box.querySelectorAll('.job-search-item[data-job-id]').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('srJobId').value = item.dataset.jobId;
      srJobIdConfirmed = true;
      box.style.display = 'none';
    });
  });
}
if ($('srJobId')) {
  $('srJobId').addEventListener('input', () => {
    srJobIdConfirmed = false;
    const q = $('srJobId').value.trim().toLowerCase();
    if (!q) { $('srJobIdResults').style.display = 'none'; return; }
    renderSrJobSearchResults(jobSearchOptions.filter((r) => jobMatchesQuery(r, q)));
  });
  $('srJobId').addEventListener('focus', () => { if ($('srJobId').value.trim()) $('srJobId').dispatchEvent(new Event('input')); });
  $('srJobId').addEventListener('blur', () => {
    setTimeout(() => { if ($('srJobIdResults')) $('srJobIdResults').style.display = 'none'; }, 150);
    const match = jobSearchOptions.find((r) => String(r.job_id).toLowerCase() === $('srJobId').value.trim().toLowerCase());
    if (match) { srJobIdConfirmed = true; $('srJobId').value = match.job_id; }
  });
}

function resetSpecialRequestForm() {
  if ($('srDate')) $('srDate').value = new Date().toISOString().slice(0, 10);
  if ($('srStartTime')) $('srStartTime').value = '';
  if ($('srEndTime')) $('srEndTime').value = '';
  if ($('srLocation')) $('srLocation').value = '';
  if ($('srJobId')) $('srJobId').value = '';
  srJobIdConfirmed = false;
  srMode = '';
  document.querySelectorAll('.sr-mode-chip').forEach((c) => c.classList.remove('selected'));
  srDescSelected.clear();
  if ($('srDescription')) $('srDescription').value = '';
  if ($('srReason')) $('srReason').value = '';
}

async function renderSpecialRequestForm() {
  resetSpecialRequestForm();
  await ensureSrLocationOptions();
  await renderChipPicker('srDescChips', 'general', srDescSelected);
}

if ($('srSubmitBtn')) {
  $('srSubmitBtn').addEventListener('click', async () => {
    const entryDate = $('srDate').value;
    const startTime = $('srStartTime').value;
    const endTime = $('srEndTime').value;
    const location = $('srLocation').value.trim();
    const jobId = $('srJobId').value.trim();
    const description = combineDescription(srDescSelected, $('srDescription').value);
    const reason = $('srReason').value.trim();

    if (!entryDate || !startTime || !endTime) { showToast('Fill in the date, clock-in and clock-out time.'); return; }
    if (!jobId || !srJobIdConfirmed) { showToast('Pick the Job ID from the list below the field.'); return; }
    if (!srMode) { showToast('Pick a mode of work.'); return; }
    if (!reason) { showToast("Explain why this is being submitted late — it's required."); return; }
    if (!confirm(`Submit a special request for ${entryDate}, ${startTime}–${endTime} on ${jobId}?\n\nThis goes to your department head (or an admin) for approval before it becomes a real entry.`)) return;

    $('srSubmitBtn').disabled = true;
    try {
      const { data: { session } } = await getSessionSafe();
      if (!session) { showToast('Please sign in again.'); return; }
      const { data, error } = await withTimeout(
        sb.functions.invoke('submit-special-request', {
          body: { entryDate, startTime, endTime, location, jobId, mode: srMode, description, reason },
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        20000,
        'Submit special request'
      );
      if (error || data?.error) throw new Error(data?.error || await readFunctionsError(error));
      showToast('Special request submitted — waiting for approval.');
      renderSpecialRequestForm();
      renderMySpecialRequests();
    } catch (err) {
      showToast(`Couldn't submit: ${err.message || err}`);
    } finally {
      $('srSubmitBtn').disabled = false;
    }
  });
}

const SR_STATUS_LABEL = { pending: 'pending approval', approved: 'approved & synced', rejected: 'rejected' };
const SR_STATUS_CLASS = { pending: 'pending', approved: 'synced', rejected: 'error' };

async function renderMySpecialRequests() {
  const wrap = $('mySpecialRequestsList');
  if (!wrap || !currentUser) return;
  wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await sb.from('special_requests').select('*').eq('person_id', currentUser.id).order('created_at', { ascending: false }).limit(30);
  if (error) { wrap.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  if (!data.length) { wrap.innerHTML = '<div class="empty">No special requests yet.</div>'; return; }
  wrap.innerHTML = data.map((r) => `
    <div class="entry">
      <span class="type-icon">🕐</span>
      <div class="entry-body">
        <div class="entry-meta">${escapeHtml(r.job_id || '—')} · ${escapeHtml(r.entry_date)} · ${escapeHtml(r.start_time)}–${escapeHtml(r.end_time)}</div>
        <div class="entry-desc">${escapeHtml(r.reason || '')}</div>
      </div>
      <div class="entry-status-stack">
        <span class="sr-tag">Special</span>
        <span class="chip ${SR_STATUS_CLASS[r.status] || ''}">${SR_STATUS_LABEL[r.status] || r.status}</span>
      </div>
    </div>
  `).join('');
}

let srHeadDepartmentIds = [];
async function renderSpecialRequestApprovals() {
  const card = $('srApprovalsCard');
  const wrap = $('srApprovalsList');
  if (!card || !wrap || !currentUser) return;

  const isAdmin = currentProfile?.role === 'admin';
  if (!isAdmin) {
    const { data } = await sb.from('departments').select('id').eq('head_id', currentUser.id);
    srHeadDepartmentIds = (data || []).map((d) => d.id);
  }
  if (!isAdmin && !srHeadDepartmentIds.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { data: rows, error } = await sb.from('special_requests').select('*').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) { wrap.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  if (!rows || !rows.length) { wrap.innerHTML = '<div class="empty">Nothing pending.</div>'; return; }

  const personIds = [...new Set(rows.map((r) => r.person_id))];
  const { data: people } = await sb.from('profiles').select('id, full_name, email').in('id', personIds);
  const nameById = {};
  (people || []).forEach((p) => { nameById[p.id] = p.full_name || p.email; });

  wrap.innerHTML = rows.map((r) => `
    <div class="entry" style="align-items:flex-start;">
      <span class="type-icon">🕐</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(nameById[r.person_id] || 'Someone')}</div>
        <div class="entry-meta">${escapeHtml(r.job_id || '—')} · ${escapeHtml(MODE_LABEL[r.mode] || r.mode || '')}</div>
        <div class="entry-meta">📅 ${escapeHtml(r.entry_date)} · 🕐 ${escapeHtml(r.start_time)}–${escapeHtml(r.end_time)}</div>
        ${r.location ? `<div class="entry-meta">📍 ${escapeHtml(r.location)}</div>` : ''}
        ${r.description ? `<div class="entry-meta">What they worked on: ${escapeHtml(r.description)}</div>` : ''}
        <div class="entry-meta" style="margin-top:4px;"><strong>Reason for late entry:</strong> ${escapeHtml(r.reason || '')}</div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button type="button" class="primary" data-sr-approve="${r.id}" style="flex:1; margin-top:0;">✓ Approve</button>
          <button type="button" class="secondary" data-sr-reject="${r.id}" style="flex:1;">✕ Reject</button>
        </div>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-sr-approve]').forEach((btn) => {
    btn.addEventListener('click', () => reviewSpecialRequest(btn.dataset.srApprove, 'approve'));
  });
  wrap.querySelectorAll('[data-sr-reject]').forEach((btn) => {
    btn.addEventListener('click', () => reviewSpecialRequest(btn.dataset.srReject, 'reject'));
  });
}

async function reviewSpecialRequest(requestId, action) {
  if (action === 'reject' && !confirm('Reject this special request? No entry will be created.')) return;
  try {
    const { data: { session } } = await getSessionSafe();
    if (!session) { showToast('Please sign in again.'); return; }
    const { data, error } = await withTimeout(
      sb.functions.invoke('approve-special-request', {
        body: { requestId, action },
        headers: { Authorization: `Bearer ${session.access_token}` },
      }),
      20000,
      'Review special request'
    );
    if (error || data?.error) throw new Error(data?.error || await readFunctionsError(error));
    showToast(action === 'approve' ? 'Approved — synced.' : 'Rejected.');
    renderSpecialRequestApprovals();
    renderMySpecialRequests();
  } catch (err) {
    showToast(`Couldn't ${action}: ${err.message || err}`);
  }
}

// =====================================================================
// LEAVE / VACATION REQUEST — a separate, date-RANGE request type sharing
// only the Special Request panel's UI (via the top mode toggle below) and
// its exact RLS/approval permission shape. No synced timesheet entry or
// job_hours_ledger row is ever created here, so — unlike special requests
// — approval is a plain status update straight against leave_requests,
// no Edge Function involved. The whole point is the year-timeline chart
// at the bottom: a quick visual of who's away, what kind of leave, and
// when they're back, so nobody gets a project understaffed by surprise.
// =====================================================================

const LEAVE_TYPE_LABEL = {
  holiday: '🏖️ Holiday', emergency: '🚨 Emergency Leave', exhibition: '🎪 Exhibition',
  sick: '🤒 Sick Leave', maternity: '🤰 Maternity Leave', other: '✨ Other',
};
const LEAVE_TYPE_COLOR = {
  holiday: '#4dabff', emergency: '#ff5470', exhibition: '#b98bff',
  sick: '#ffb84d', maternity: '#f2d94d', other: '#39ffb0',
};
const LEAVE_STATUS_LABEL = { pending: 'pending approval', approved: 'approved', rejected: 'rejected' };
const LEAVE_STATUS_CLASS = { pending: 'pending', approved: 'synced', rejected: 'error' };

document.querySelectorAll('.sr-top-mode-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.sr-top-mode-chip').forEach((c) => c.classList.toggle('selected', c === chip));
    const mode = chip.dataset.srTopMode;
    if ($('srLateEntrySection')) $('srLateEntrySection').style.display = mode === 'lateEntry' ? '' : 'none';
    if ($('srLeaveSection')) $('srLeaveSection').style.display = mode === 'leave' ? '' : 'none';
    if ($('srDocumentSection')) $('srDocumentSection').style.display = mode === 'document' ? '' : 'none';
  });
});

let selectedLeaveType = '';
document.querySelectorAll('.leave-type-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    selectedLeaveType = chip.dataset.leaveType;
    document.querySelectorAll('.leave-type-chip').forEach((c) => c.classList.toggle('selected', c === chip));
  });
});

function resetLeaveRequestForm() {
  if ($('leaveStartDate')) $('leaveStartDate').value = '';
  if ($('leaveEndDate')) $('leaveEndDate').value = '';
  if ($('leaveRequestReason')) $('leaveRequestReason').value = '';
  selectedLeaveType = '';
  document.querySelectorAll('.leave-type-chip').forEach((c) => c.classList.remove('selected'));
}

if ($('leaveSubmitBtn')) {
  $('leaveSubmitBtn').addEventListener('click', async () => {
    const startDate = $('leaveStartDate').value;
    const endDate = $('leaveEndDate').value;
    const reason = $('leaveRequestReason').value.trim();

    if (!selectedLeaveType) { showToast('Pick a leave type.'); return; }
    if (!startDate || !endDate) { showToast('Pick a start date and a return date.'); return; }
    if (endDate < startDate) { showToast('Return date must be on or after the start date.'); return; }
    if (!confirm(`Request ${LEAVE_TYPE_LABEL[selectedLeaveType] || 'leave'} from ${startDate} to ${endDate}?\n\nThis goes to your department head (or an admin) for approval.`)) return;

    $('leaveSubmitBtn').disabled = true;
    try {
      const { error } = await sb.from('leave_requests').insert({
        person_id: currentUser.id,
        department_id: currentProfile?.department_id || null,
        leave_type: selectedLeaveType,
        start_date: startDate,
        end_date: endDate,
        reason: reason || null,
      });
      if (error) throw error;
      showToast('Leave request submitted — waiting for approval.');
      resetLeaveRequestForm();
      renderMyLeaveRequests();
    } catch (err) {
      showToast(`Couldn't submit: ${err.message || err}`);
    } finally {
      $('leaveSubmitBtn').disabled = false;
    }
  });
}

async function renderMyLeaveRequests() {
  const wrap = $('myLeaveRequestsList');
  if (!wrap || !currentUser) return;
  wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await sb.from('leave_requests').select('*').eq('person_id', currentUser.id).order('start_date', { ascending: false }).limit(30);
  if (error) { wrap.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  if (!data.length) { wrap.innerHTML = '<div class="empty">No leave requests yet.</div>'; return; }
  wrap.innerHTML = data.map((r) => `
    <div class="entry">
      <span class="type-icon">${(LEAVE_TYPE_LABEL[r.leave_type] || '🌴').split(' ')[0]}</span>
      <div class="entry-body">
        <div class="entry-meta">${escapeHtml(LEAVE_TYPE_LABEL[r.leave_type] || r.leave_type)}</div>
        <div class="entry-desc">${escapeHtml(r.start_date)} → ${escapeHtml(r.end_date)}</div>
        ${r.reason ? `<div class="entry-meta">${escapeHtml(r.reason)}</div>` : ''}
      </div>
      <div class="entry-status-stack">
        <span class="chip ${LEAVE_STATUS_CLASS[r.status] || ''}">${LEAVE_STATUS_LABEL[r.status] || r.status}</span>
      </div>
    </div>
  `).join('');
}

let leaveManagerIsAdmin = false;
let leaveManagerDepartmentIds = [];
async function ensureLeaveManagerContext() {
  leaveManagerIsAdmin = currentProfile?.role === 'admin';
  if (!leaveManagerIsAdmin) {
    const { data } = await sb.from('departments').select('id').eq('head_id', currentUser.id);
    leaveManagerDepartmentIds = (data || []).map((d) => d.id);
  }
  return leaveManagerIsAdmin || leaveManagerDepartmentIds.length > 0;
}

async function renderLeaveApprovals() {
  const card = $('leaveApprovalsCard');
  const wrap = $('leaveApprovalsList');
  if (!card || !wrap || !currentUser) return;

  const canManage = await ensureLeaveManagerContext();
  if (!canManage) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { data: rows, error } = await sb.from('leave_requests').select('*').eq('status', 'pending').order('start_date', { ascending: true });
  if (error) { wrap.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  if (!rows || !rows.length) { wrap.innerHTML = '<div class="empty">Nothing pending.</div>'; return; }

  const personIds = [...new Set(rows.map((r) => r.person_id))];
  const { data: people } = await sb.from('profiles').select('id, full_name, email').in('id', personIds);
  const nameById = {};
  (people || []).forEach((p) => { nameById[p.id] = p.full_name || p.email; });

  wrap.innerHTML = rows.map((r) => `
    <div class="entry" style="align-items:flex-start;">
      <span class="type-icon">${(LEAVE_TYPE_LABEL[r.leave_type] || '🌴').split(' ')[0]}</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(nameById[r.person_id] || 'Someone')}</div>
        <div class="entry-meta">${escapeHtml(LEAVE_TYPE_LABEL[r.leave_type] || r.leave_type)}</div>
        <div class="entry-meta">📅 ${escapeHtml(r.start_date)} → ${escapeHtml(r.end_date)}</div>
        ${r.reason ? `<div class="entry-meta">${escapeHtml(r.reason)}</div>` : ''}
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button type="button" class="primary" data-leave-approve="${r.id}" style="flex:1; margin-top:0;">✓ Approve</button>
          <button type="button" class="secondary" data-leave-reject="${r.id}" style="flex:1;">✕ Reject</button>
        </div>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-leave-approve]').forEach((btn) => {
    btn.addEventListener('click', () => reviewLeaveRequest(btn.dataset.leaveApprove, 'approve'));
  });
  wrap.querySelectorAll('[data-leave-reject]').forEach((btn) => {
    btn.addEventListener('click', () => reviewLeaveRequest(btn.dataset.leaveReject, 'reject'));
  });
}

async function reviewLeaveRequest(requestId, action) {
  if (action === 'reject' && !confirm('Reject this leave request?')) return;
  try {
    const { error } = await sb.from('leave_requests').update({
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: currentUser.id,
      reviewed_at: new Date().toISOString(),
    }).eq('id', requestId);
    if (error) throw error;
    showToast(action === 'approve' ? 'Approved.' : 'Rejected.');
    renderLeaveApprovals();
    renderMyLeaveRequests();
    renderLeaveCalendar();
  } catch (err) {
    showToast(`Couldn't ${action}: ${err.message || err}`);
  }
}

// ---------- Year-timeline leave calendar (Gantt-style) ----------
let leaveCalendarChart = null;
let leaveCalendarYearPopulated = false;

function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function dayOfYearFor(dateStr, year) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const start = Date.UTC(year, 0, 1);
  const diff = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
  return diff;
}
function monthLabelForDay(day, year) {
  const d = new Date(Date.UTC(year, 0, 1));
  d.setUTCDate(d.getUTCDate() + Math.round(day));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Draws each person's name directly on (or right next to) their colour
// bar, rather than relying only on the cramped y-axis label margin — the
// name and the bar it belongs to are meant to read as one unit at a
// glance. Registered once, and only acts on a chart that explicitly opts
// in via options.plugins.leaveNameLabelPlugin.enabled, so it never touches
// the other Chart.js charts elsewhere in the app.
let leaveNameLabelPluginRegistered = false;
function ensureLeaveNameLabelPlugin() {
  if (leaveNameLabelPluginRegistered || typeof Chart === 'undefined') return;
  Chart.register({
    id: 'leaveNameLabelPlugin',
    afterDatasetsDraw(chart) {
      if (!chart.options?.plugins?.leaveNameLabelPlugin?.enabled) return;
      const meta = chart.getDatasetMeta(0);
      if (!meta) return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = '600 11px sans-serif';
      ctx.textBaseline = 'middle';
      meta.data.forEach((bar, i) => {
        const label = chart.data.labels[i];
        if (!label || !bar) return;
        const { x, y, base } = bar.getProps(['x', 'y', 'base'], true);
        const left = Math.min(x, base);
        const barWidth = Math.abs(x - base);
        const text = String(label);
        const textWidth = ctx.measureText(text).width;
        if (textWidth + 10 <= barWidth) {
          // Fits inside its own bar — dark text right on the colour.
          ctx.fillStyle = '#0a0a14';
          ctx.textAlign = 'left';
          ctx.fillText(text, left + 5, y);
        } else {
          // Too long for the bar — print just past its end instead, still
          // clearly paired with that bar rather than only on the axis.
          ctx.fillStyle = '#e8f4ff';
          ctx.textAlign = 'left';
          ctx.fillText(text, Math.max(x, base) + 5, y);
        }
      });
      ctx.restore();
    },
  });
  leaveNameLabelPluginRegistered = true;
}

function populateLeaveCalendarYearSelect() {
  const sel = $('leaveCalendarYear');
  if (!sel || leaveCalendarYearPopulated) return;
  const nowYear = new Date().getFullYear();
  sel.innerHTML = [nowYear - 1, nowYear, nowYear + 1].map((y) => `<option value="${y}" ${y === nowYear ? 'selected' : ''}>${y}</option>`).join('');
  sel.addEventListener('change', () => renderLeaveCalendar());
  leaveCalendarYearPopulated = true;
  if (typeof initGlassSelect === 'function') initGlassSelect(sel);
}

async function renderLeaveCalendar() {
  const card = $('leaveCalendarCard');
  const legendWrap = $('leaveCalendarLegendList');
  if (!card || !currentUser) return;

  const canManage = await ensureLeaveManagerContext();
  if (!canManage) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  populateLeaveCalendarYearSelect();
  if (legendWrap) {
    legendWrap.innerHTML = Object.entries(LEAVE_TYPE_LABEL).map(([key, label]) => `
      <div style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cfe8ff;">
        <span style="width:12px; height:12px; border-radius:3px; background:${LEAVE_TYPE_COLOR[key]}; display:inline-block;"></span>${escapeHtml(label)}
      </div>
    `).join('');
  }

  const year = parseInt($('leaveCalendarYear')?.value, 10) || new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const { data: rows, error } = await sb.from('leave_requests').select('*').eq('status', 'approved')
    .lte('start_date', yearEnd).gte('end_date', yearStart).order('start_date', { ascending: true });

  const chartEl = $('leaveCalendarChart');
  if (!chartEl || typeof Chart === 'undefined') return;
  if (leaveCalendarChart) { leaveCalendarChart.destroy(); leaveCalendarChart = null; }
  if (error || !rows || !rows.length) return;

  const personIds = [...new Set(rows.map((r) => r.person_id))];
  const { data: people } = await sb.from('profiles').select('id, full_name, email').in('id', personIds);
  const nameById = {};
  (people || []).forEach((p) => { nameById[p.id] = p.full_name || p.email; });

  const sorted = [...rows].sort((a, b) => (nameById[a.person_id] || '').localeCompare(nameById[b.person_id] || '') || a.start_date.localeCompare(b.start_date));
  const yearLen = isLeapYear(year) ? 366 : 365;

  const labels = sorted.map((r) => nameById[r.person_id] || 'Someone');
  const data = sorted.map((r) => [
    Math.max(0, dayOfYearFor(r.start_date, year)),
    Math.min(yearLen, dayOfYearFor(r.end_date, year) + 1),
  ]);
  const colors = sorted.map((r) => LEAVE_TYPE_COLOR[r.leave_type] || '#39ffb0');

  ensureLeaveNameLabelPlugin();

  leaveCalendarChart = new Chart(chartEl.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      layout: { padding: { right: 90 } },
      plugins: {
        legend: { display: false },
        leaveNameLabelPlugin: { enabled: true },
        title: { display: true, text: `Who's on leave — ${year}`, color: '#cfe8ff' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const r = sorted[ctx.dataIndex];
              return `${LEAVE_TYPE_LABEL[r.leave_type] || r.leave_type} · ${r.start_date} → ${r.end_date}`;
            },
          },
        },
      },
      scales: {
        x: {
          min: 0, max: yearLen,
          ticks: { color: '#cfe8ff', callback: (v) => monthLabelForDay(v, year) },
          grid: { color: 'rgba(255,255,255,0.08)' },
        },
        y: { ticks: { color: '#cfe8ff', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
}

// =====================================================================
// REQUEST A DOCUMENT — a third Special Request mode. Employee picks a
// document type (Salary Document, Visa, Work Permit, NOC, Character
// Certificate, etc. — managed by admin in Data Feed), explains where it's
// going, and submits. Admin-only queue (no department-head routing here);
// admin uploads the actual file once it's ready, which flips the request
// to 'ready' and fires a push notification to the requester. Rejecting
// just flips the status — nothing else changes.
// =====================================================================

const DOC_STATUS_LABEL = { pending: 'queued', ready: 'ready to download', rejected: 'rejected' };
const DOC_STATUS_CLASS = { pending: 'pending', ready: 'synced', rejected: 'error' };

let selectedDocTypeId = '';
async function renderDocumentRequestForm() {
  const grid = $('docTypeGrid');
  if (!grid) return;
  selectedDocTypeId = '';
  if ($('docRequestPurpose')) $('docRequestPurpose').value = '';
  const types = (await fetchDocumentTypes()).filter((t) => t.active);
  grid.innerHTML = types.length
    ? types.map((t) => `<div class="doc-type-chip" data-doctype-id="${t.id}"><span class="emoji">${t.icon}</span>${escapeHtml(t.name)}</div>`).join('')
    : '<div class="empty">No document types set up yet — ask an admin to add some in Data Feed.</div>';
  grid.querySelectorAll('.doc-type-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      selectedDocTypeId = chip.dataset.doctypeId;
      grid.querySelectorAll('.doc-type-chip').forEach((c) => c.classList.toggle('selected', c === chip));
    });
  });
}

if ($('docRequestSubmitBtn')) {
  $('docRequestSubmitBtn').addEventListener('click', async () => {
    const purpose = $('docRequestPurpose').value.trim();
    if (!selectedDocTypeId) { showToast('Pick a document type.'); return; }
    if (!purpose) { showToast("Tell us where you're submitting this document — it's required."); return; }
    if (!confirm('Submit this document request? It goes straight to admin.')) return;

    $('docRequestSubmitBtn').disabled = true;
    try {
      const { error } = await sb.from('document_requests').insert({
        person_id: currentUser.id,
        document_type_id: selectedDocTypeId,
        purpose,
      });
      if (error) throw error;
      showToast('Document request submitted — waiting on admin.');
      renderDocumentRequestForm();
      renderMyDocumentRequests();
    } catch (err) {
      showToast(`Couldn't submit: ${err.message || err}`);
    } finally {
      $('docRequestSubmitBtn').disabled = false;
    }
  });
}

async function renderMyDocumentRequests() {
  const wrap = $('myDocumentRequestsList');
  if (!wrap || !currentUser) return;
  wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await sb.from('document_requests').select('*, document_types(name, icon)').eq('person_id', currentUser.id).order('created_at', { ascending: false }).limit(30);
  if (error) { wrap.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  if (!data.length) { wrap.innerHTML = '<div class="empty">No document requests yet.</div>'; return; }
  wrap.innerHTML = data.map((r) => `
    <div class="entry">
      <span class="type-icon">${r.document_types?.icon || '📄'}</span>
      <div class="entry-body">
        <div class="entry-meta">${escapeHtml(r.document_types?.name || 'Document')}</div>
        <div class="entry-desc">${escapeHtml(r.purpose)}</div>
      </div>
      <div class="entry-status-stack">
        <span class="chip ${DOC_STATUS_CLASS[r.status] || ''}">${DOC_STATUS_LABEL[r.status] || r.status}</span>
        ${r.status === 'ready' ? `<button type="button" class="secondary" data-doc-download="${r.id}" style="margin-top:6px;">⬇ Download</button>` : ''}
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-doc-download]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.docDownload;
      const row = data.find((r) => r.id === id);
      if (!row?.file_path) { showToast('No file on this request yet.'); return; }
      btn.disabled = true;
      try {
        const { data: signed, error } = await sb.storage.from('document-requests').createSignedUrl(row.file_path, 600);
        if (error || !signed?.signedUrl) throw error || new Error('Could not create a download link');
        window.open(signed.signedUrl, '_blank');
      } catch (err) {
        showToast(`Couldn't download: ${err.message || err}`);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

let docManagerIsAdmin = false;
const pendingDocUploads = new Map(); // requestId -> File, chosen but not yet uploaded

async function renderDocumentRequestApprovals() {
  const card = $('docRequestApprovalsCard');
  const wrap = $('docRequestApprovalsList');
  if (!card || !wrap || !currentUser) return;

  docManagerIsAdmin = currentProfile?.role === 'admin';
  if (!docManagerIsAdmin) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  wrap.innerHTML = '<div class="empty">Loading…</div>';
  const { data: rows, error } = await sb.from('document_requests').select('*, document_types(name, icon)').eq('status', 'pending').order('created_at', { ascending: true });
  if (error) { wrap.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  if (!rows || !rows.length) { wrap.innerHTML = '<div class="empty">Nothing pending.</div>'; return; }

  const personIds = [...new Set(rows.map((r) => r.person_id))];
  const { data: people } = await sb.from('profiles').select('id, full_name, email').in('id', personIds);
  const nameById = {};
  (people || []).forEach((p) => { nameById[p.id] = p.full_name || p.email; });

  wrap.innerHTML = rows.map((r) => `
    <div class="entry" style="align-items:flex-start;">
      <span class="type-icon">${r.document_types?.icon || '📄'}</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(nameById[r.person_id] || 'Someone')}</div>
        <div class="entry-meta">${escapeHtml(r.document_types?.name || 'Document')}</div>
        <div class="entry-meta">📝 ${escapeHtml(r.purpose)}</div>
        <div class="location-row" style="margin-top:8px;">
          <input type="file" data-doc-file="${r.id}" style="flex:1 1 160px;" />
        </div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button type="button" class="primary" data-doc-upload="${r.id}" style="flex:1; margin-top:0;">⬆ Upload &amp; mark ready</button>
          <button type="button" class="secondary" data-doc-reject="${r.id}" style="flex:1;">✕ Reject</button>
        </div>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-doc-file]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.docFile;
      if (input.files && input.files[0]) pendingDocUploads.set(id, input.files[0]);
      else pendingDocUploads.delete(id);
    });
  });
  wrap.querySelectorAll('[data-doc-upload]').forEach((btn) => {
    btn.addEventListener('click', () => uploadDocumentForRequest(btn.dataset.docUpload));
  });
  wrap.querySelectorAll('[data-doc-reject]').forEach((btn) => {
    btn.addEventListener('click', () => reviewDocumentRequest(btn.dataset.docReject, 'reject'));
  });
}

async function uploadDocumentForRequest(requestId) {
  const file = pendingDocUploads.get(requestId);
  if (!file) { showToast('Choose a file first.'); return; }
  try {
    const safeName = file.name.replace(/[^a-z0-9_.-]/gi, '_');
    const path = `${requestId}/${Date.now()}_${safeName}`;
    const { error: upErr } = await sb.storage.from('document-requests').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (upErr) throw upErr;

    const { error } = await sb.from('document_requests').update({
      status: 'ready',
      file_path: path,
      file_name: file.name,
      uploaded_by: currentUser.id,
      uploaded_at: new Date().toISOString(),
    }).eq('id', requestId);
    if (error) throw error;

    // Best-effort — a push failure shouldn't undo an already-uploaded file.
    const { data: { session } } = await getSessionSafe();
    sb.functions.invoke('send-push', {
      body: { kind: 'document', requestId },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    }).catch(() => {});

    showToast('Uploaded — requester notified.');
    pendingDocUploads.delete(requestId);
    renderDocumentRequestApprovals();
  } catch (err) {
    showToast(`Couldn't upload: ${err.message || err}`);
  }
}

async function reviewDocumentRequest(requestId, action) {
  if (action === 'reject' && !confirm('Reject this document request?')) return;
  try {
    const { error } = await sb.from('document_requests').update({ status: 'rejected' }).eq('id', requestId);
    if (error) throw error;
    showToast('Rejected.');
    renderDocumentRequestApprovals();
  } catch (err) {
    showToast(`Couldn't reject: ${err.message || err}`);
  }
}

// =====================================================================
// FIELD ACTIVITIES — marketing/field people log client visits against a
// day-long "mission" (Mission Start each morning, Mission Stop at day's
// end). Each visit picks a client from the existing Clients list, states
// a goal, captures GPS when heading there, then gets a brief + GPS again
// once the meeting is done. Admin gets a per-person analytics view (tiles
// + line graph) to see how effective each person is at bringing in
// business, since the Project Tank depends on this team finding work.
// In-app only for now — no Google Sheet sync.
// =====================================================================

let currentFieldMission = null; // the signed-in user's active mission row, or null
let fieldMissionTimerIntervalId = null;
let fieldLocationIntervalId = null;
const FIELD_LOCATION_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes while a mission is active

async function fetchActiveFieldMission() {
  if (!currentUser) return null;
  const { data, error } = await sb.from('field_missions')
    .select('*')
    .eq('person_id', currentUser.id)
    .eq('status', 'active')
    .order('start_at', { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return null;
  return data[0];
}

function fieldMissionTimerTick() {
  if (!currentFieldMission || !$('fieldMissionTimer')) return;
  const secs = Math.max(0, Math.floor((Date.now() - new Date(currentFieldMission.start_at).getTime()) / 1000));
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  $('fieldMissionTimer').textContent = `${h}:${m}:${s}`;
}

function stopFieldMissionTimer() {
  if (fieldMissionTimerIntervalId) { clearInterval(fieldMissionTimerIntervalId); fieldMissionTimerIntervalId = null; }
}

function startFieldMissionTimer() {
  stopFieldMissionTimer();
  fieldMissionTimerTick();
  fieldMissionTimerIntervalId = setInterval(fieldMissionTimerTick, 1000);
}

// Same idea as updateMyDriverLocation()/startDriverLocationLoopIfNeeded(),
// but scoped to "mission currently active" rather than "has Driver role",
// and read-access is admin-or-self only (see field_locations RLS) rather
// than visible to everyone the way driver_locations is.
async function updateMyFieldLocation() {
  if (!currentFieldMission || !currentUser) return;
  const r = await fetchAndFillLocation({ silent: true, fillField: false });
  if (!r.ok) return;
  await sb.from('field_locations').upsert({
    person_id: currentUser.id,
    lat: r.lat,
    lng: r.lng,
    address: r.address,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'person_id' });
}

function startFieldLocationLoopIfNeeded() {
  if (fieldLocationIntervalId || !currentFieldMission || !navigator.geolocation) return;
  updateMyFieldLocation();
  fieldLocationIntervalId = setInterval(updateMyFieldLocation, FIELD_LOCATION_INTERVAL_MS);
}

function stopFieldLocationLoop() {
  if (fieldLocationIntervalId) { clearInterval(fieldLocationIntervalId); fieldLocationIntervalId = null; }
}

async function renderFieldMissionCard() {
  const statusText = $('fieldMissionStatusText');
  const toggleBtn = $('fieldMissionToggleBtn');
  const timerEl = $('fieldMissionTimer');
  const visitFormCard = $('fieldVisitFormCard');
  const todayCard = $('fieldTodayCard');
  if (!statusText || !toggleBtn) return;

  currentFieldMission = await fetchActiveFieldMission();

  if (currentFieldMission) {
    const startTime = new Date(currentFieldMission.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    statusText.textContent = `Mission started at ${startTime} — good luck out there.`;
    toggleBtn.textContent = '🛑 Mission Stop';
    if (timerEl) timerEl.style.display = 'block';
    startFieldMissionTimer();
    if (visitFormCard) visitFormCard.style.display = '';
    if (todayCard) todayCard.style.display = '';
    startFieldLocationLoopIfNeeded();
  } else {
    statusText.textContent = 'Not started today.';
    toggleBtn.textContent = '🚀 Start Mission';
    if (timerEl) timerEl.style.display = 'none';
    stopFieldMissionTimer();
    if (visitFormCard) visitFormCard.style.display = 'none';
    if (todayCard) todayCard.style.display = 'none';
    stopFieldLocationLoop();
  }
}

if ($('fieldMissionToggleBtn')) {
  $('fieldMissionToggleBtn').addEventListener('click', async () => {
    const btn = $('fieldMissionToggleBtn');
    btn.disabled = true;
    try {
      if (!currentFieldMission) {
        const r = await fetchAndFillLocation({ silent: true, fillField: false });
        const { error } = await sb.from('field_missions').insert({
          person_id: currentUser.id,
          mission_date: new Date().toISOString().slice(0, 10),
          start_lat: r.ok ? r.lat : null,
          start_lng: r.ok ? r.lng : null,
          start_address: r.ok ? r.address : null,
        });
        if (error) throw error;
        showToast('Mission started — have a good day out there!');
      } else {
        const { data: openVisits } = await sb.from('field_visits')
          .select('id').eq('mission_id', currentFieldMission.id).eq('status', 'traveling');
        if (openVisits && openVisits.length) {
          showToast('Finish your current visit (add a brief) before stopping the mission.');
          return;
        }
        if (!confirm('Stop your mission for today?')) return;
        const r = await fetchAndFillLocation({ silent: true, fillField: false });
        const { error } = await sb.from('field_missions').update({
          end_at: new Date().toISOString(),
          end_lat: r.ok ? r.lat : null,
          end_lng: r.ok ? r.lng : null,
          end_address: r.ok ? r.address : null,
          status: 'completed',
        }).eq('id', currentFieldMission.id);
        if (error) throw error;
        showToast('Mission stopped — nice work today.');
      }
      await renderFieldMissionCard();
      await renderFieldTodayVisits();
    } catch (err) {
      showToast(`Couldn't update mission: ${err.message || err}`);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Log a visit (nested inside an active mission) ----------

async function populateFieldVisitClientSelect() {
  const sel = $('fieldVisitClientSelect');
  if (!sel) return;
  let rows = clientsCache;
  if (!rows || !rows.length) {
    const res = await fetchClients();
    rows = res.rows;
    clientsCache = rows;
  }
  sel.innerHTML = '<option value="">Choose a client…</option>' + rows.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

if ($('fieldVisitClientSelect')) {
  $('fieldVisitClientSelect').addEventListener('change', () => {
    const infoEl = $('fieldVisitClientLocationInfo');
    if (!infoEl) return;
    const client = clientsCache.find((c) => c.id === $('fieldVisitClientSelect').value);
    if (!client) { infoEl.style.display = 'none'; return; }
    infoEl.style.display = 'block';
    infoEl.innerHTML = (client.lat && client.lng)
      ? `📍 ${escapeHtml(client.address || '')} · <a href="${liveMapUrl(client.lat, client.lng)}" target="_blank" rel="noopener">View on map</a>`
      : 'No saved location for this client yet — search one in Clients or Company Finder.';
  });
}

if ($('fieldVisitStartBtn')) {
  $('fieldVisitStartBtn').addEventListener('click', async () => {
    if (!currentFieldMission) { showToast('Start your mission first.'); return; }
    const clientId = $('fieldVisitClientSelect').value;
    const goal = $('fieldVisitGoal').value.trim();
    if (!clientId) { showToast('Pick a client.'); return; }
    if (!goal) { showToast('What is the goal of this visit?'); return; }
    const btn = $('fieldVisitStartBtn');
    const locationInput = $('fieldVisitLocationSearch');
    btn.disabled = true;
    btn.textContent = '📍 Locating…';
    try {
      // A searched-and-picked address takes priority over GPS (useful when
      // heading somewhere GPS can't pin down yet, or a specific address is
      // known); otherwise fall back to silently capturing the device's
      // current location, same as everywhere else in the app.
      let lat = null, lng = null, address = null;
      if (locationInput?.dataset.lat && locationInput?.dataset.lon) {
        lat = parseFloat(locationInput.dataset.lat);
        lng = parseFloat(locationInput.dataset.lon);
        address = locationInput.value.trim() || null;
      } else {
        const r = await fetchAndFillLocation({ silent: true, fillField: false });
        if (r.ok) { lat = r.lat; lng = r.lng; address = r.address; }
      }
      const { error } = await sb.from('field_visits').insert({
        mission_id: currentFieldMission.id,
        person_id: currentUser.id,
        client_id: clientId,
        goal,
        start_lat: lat,
        start_lng: lng,
        start_address: address,
      });
      if (error) throw error;
      showToast("On your way — don't forget to add a brief once you're done.");
      $('fieldVisitClientSelect').value = '';
      $('fieldVisitGoal').value = '';
      if (locationInput) { locationInput.value = ''; locationInput.dataset.lat = ''; locationInput.dataset.lon = ''; }
      renderFieldTodayVisits();
    } catch (err) {
      showToast(`Couldn't log visit: ${err.message || err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "📍 I'm heading there";
    }
  });
}

async function finishFieldVisit(visitId) {
  const brief = prompt('Quick brief about this meeting (what happened, next steps, etc.):');
  if (brief === null) return;
  if (!brief.trim()) { showToast('A brief is needed to close out the visit.'); return; }
  try {
    const r = await fetchAndFillLocation({ silent: true, fillField: false });
    const { error } = await sb.from('field_visits').update({
      visit_end_at: new Date().toISOString(),
      end_lat: r.ok ? r.lat : null,
      end_lng: r.ok ? r.lng : null,
      end_address: r.ok ? r.address : null,
      brief: brief.trim(),
      status: 'completed',
    }).eq('id', visitId);
    if (error) throw error;
    showToast('Visit closed out.');
    renderFieldTodayVisits();
  } catch (err) {
    showToast(`Couldn't finish visit: ${err.message || err}`);
  }
}

async function renderFieldTodayVisits() {
  const statsEl = $('fieldTodayStats');
  const listEl = $('fieldTodayVisitsList');
  if (!listEl || !currentUser) return;
  listEl.innerHTML = '<div class="empty">Loading…</div>';
  const todayStr = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb.from('field_visits')
    .select('*, clients(name)')
    .eq('person_id', currentUser.id)
    .gte('visit_start_at', `${todayStr}T00:00:00`)
    .order('visit_start_at', { ascending: false });
  if (error) { listEl.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }
  const rows = data || [];
  if (statsEl) {
    const completed = rows.filter((r) => r.status === 'completed').length;
    statsEl.innerHTML = `<span>👥 ${rows.length} visit${rows.length === 1 ? '' : 's'} today</span><span>✅ ${completed} completed</span>`;
  }
  if (!rows.length) { listEl.innerHTML = '<div class="empty">No visits logged yet today.</div>'; return; }
  listEl.innerHTML = rows.map((r) => `
    <div class="entry" style="align-items:flex-start;">
      <span class="type-icon">${r.status === 'completed' ? '✅' : '📍'}</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(r.clients?.name || 'Client')}</div>
        <div class="entry-meta">${escapeHtml(r.goal)}</div>
        ${r.brief ? `<div class="entry-meta">📝 ${escapeHtml(r.brief)}</div>` : ''}
        <div class="entry-meta">${new Date(r.visit_start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${r.visit_end_at ? ' → ' + new Date(r.visit_end_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ' (in progress)'}</div>
        ${r.status === 'traveling' ? `<button type="button" class="secondary" data-field-finish-visit="${r.id}" style="margin-top:8px;">Finished — add brief</button>` : ''}
      </div>
    </div>
  `).join('');
  listEl.querySelectorAll('[data-field-finish-visit]').forEach((btn) => {
    btn.addEventListener('click', () => finishFieldVisit(btn.dataset.fieldFinishVisit));
  });
}

// ---------- Admin analytics: pick a person + period, see tiles + line graph ----------

let fieldAdminSelectedPersonId = '';
let fieldAdminSelectedPeriodDays = 30;
let fieldAdminLineChart = null;

async function populateFieldAdminPersonSelect() {
  const sel = $('fieldAdminPersonSelect');
  if (!sel) return;
  const { data, error } = await sb.from('profiles').select('id, full_name, email').order('full_name', { ascending: true });
  if (error || !data) return;
  sel.innerHTML = '<option value="">Choose a person…</option>' + data.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name || p.email)}</option>`).join('');
  if (fieldAdminSelectedPersonId) sel.value = fieldAdminSelectedPersonId;
}

if ($('fieldAdminPersonSelect')) {
  $('fieldAdminPersonSelect').addEventListener('change', () => {
    fieldAdminSelectedPersonId = $('fieldAdminPersonSelect').value;
    renderFieldAdminAnalytics();
  });
}

document.querySelectorAll('.field-period-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.field-period-btn').forEach((b) => b.classList.toggle('active', b === btn));
    fieldAdminSelectedPeriodDays = Number(btn.dataset.fieldPeriod) || 30;
    renderFieldAdminAnalytics();
  });
});

async function renderFieldAdminAnalytics() {
  const summaryEl = $('fieldAdminSummary');
  const tileGridEl = $('fieldAdminTileGrid');
  const chartWrapEl = $('fieldAdminLineChartWrap');
  if (!summaryEl) return;
  if (!fieldAdminSelectedPersonId) {
    summaryEl.innerHTML = '<div class="empty">Pick a person to see their activity.</div>';
    if (tileGridEl) tileGridEl.innerHTML = '';
    if (chartWrapEl) chartWrapEl.style.display = 'none';
    return;
  }
  summaryEl.innerHTML = '<div class="empty">Loading…</div>';
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - fieldAdminSelectedPeriodDays);

  const [{ data: missions, error: mErr }, { data: visits, error: vErr }] = await Promise.all([
    sb.from('field_missions').select('*').eq('person_id', fieldAdminSelectedPersonId).gte('start_at', cutoff.toISOString()).order('start_at', { ascending: true }),
    sb.from('field_visits').select('*, clients(name)').eq('person_id', fieldAdminSelectedPersonId).gte('visit_start_at', cutoff.toISOString()).order('visit_start_at', { ascending: true }),
  ]);
  if (mErr || vErr) { summaryEl.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml((mErr || vErr).message)}</div>`; return; }

  const missionRows = missions || [];
  const visitRows = visits || [];
  const totalHours = missionRows.reduce((sum, m) => {
    const end = m.end_at ? new Date(m.end_at).getTime() : Date.now();
    return sum + Math.max(0, end - new Date(m.start_at).getTime()) / 3600000;
  }, 0);
  const completedVisits = visitRows.filter((v) => v.status === 'completed').length;
  const uniqueClients = new Set(visitRows.map((v) => v.client_id)).size;
  const missionDays = new Set(missionRows.map((m) => m.mission_date)).size;

  summaryEl.innerHTML = `
    <div class="profit-stat-grid">
      <div class="profit-stat-card"><div class="hint">🗓️ Days in field</div><div class="profit-stat-value" style="color:#4dabff;">${missionDays}</div></div>
      <div class="profit-stat-card"><div class="hint">👥 Customers met</div><div class="profit-stat-value" style="color:#39ffb0;">${completedVisits}</div></div>
      <div class="profit-stat-card"><div class="hint">🧭 Total visits</div><div class="profit-stat-value" style="color:#ffb84d;">${visitRows.length}</div></div>
      <div class="profit-stat-card"><div class="hint">🏢 Unique clients</div><div class="profit-stat-value" style="color:#b98bff;">${uniqueClients}</div></div>
      <div class="profit-stat-card"><div class="hint">⏱️ Hours in field</div><div class="profit-stat-value" style="color:#f2d94d;">${totalHours.toFixed(1)}h</div></div>
    </div>
  `;

  // Bucket by day for short periods, by month for long ones — used for
  // both the tile grid and the line graph below it.
  const byMonth = fieldAdminSelectedPeriodDays > 90;
  const bucketKey = (dateStr) => (byMonth ? dateStr.slice(0, 7) : dateStr.slice(0, 10));
  const bucketLabel = (key) => (byMonth
    ? new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
    : new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));

  const bucket = new Map();
  const ensureBucket = (key) => {
    if (!bucket.has(key)) bucket.set(key, { visits: 0, customers: 0, hours: 0 });
    return bucket.get(key);
  };
  missionRows.forEach((m) => {
    const b = ensureBucket(bucketKey(m.mission_date));
    const end = m.end_at ? new Date(m.end_at).getTime() : Date.now();
    b.hours += Math.max(0, end - new Date(m.start_at).getTime()) / 3600000;
  });
  visitRows.forEach((v) => {
    const b = ensureBucket(bucketKey(v.visit_start_at.slice(0, 10)));
    b.visits += 1;
    if (v.status === 'completed') b.customers += 1;
  });

  const sortedKeys = [...bucket.keys()].sort();

  if (tileGridEl) {
    tileGridEl.innerHTML = sortedKeys.length ? sortedKeys.map((k) => {
      const b = bucket.get(k);
      return `
        <div class="profit-dept-card">
          <div class="hint">${escapeHtml(bucketLabel(k))}</div>
          <div style="font-size:13px; margin-top:4px;">🧭 ${b.visits} visits · 👥 ${b.customers} met</div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">⏱️ ${b.hours.toFixed(1)}h</div>
        </div>
      `;
    }).join('') : '<div class="empty">No activity in this period.</div>';
  }

  if (chartWrapEl) {
    if (fieldAdminLineChart) { fieldAdminLineChart.destroy(); fieldAdminLineChart = null; }
    if (sortedKeys.length && typeof Chart !== 'undefined') {
      chartWrapEl.style.display = 'block';
      const chartEl = $('fieldAdminLineChart');
      fieldAdminLineChart = new Chart(chartEl.getContext('2d'), {
        type: 'line',
        data: {
          labels: sortedKeys.map(bucketLabel),
          datasets: [
            { label: 'Visits', data: sortedKeys.map((k) => bucket.get(k).visits), borderColor: '#4dabff', backgroundColor: 'rgba(77,171,255,0.15)', fill: true, tension: 0.35 },
            { label: 'Customers met', data: sortedKeys.map((k) => bucket.get(k).customers), borderColor: '#39ffb0', backgroundColor: 'rgba(57,255,176,0.15)', fill: true, tension: 0.35 },
          ],
        },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: '#cfe8ff', boxWidth: 10, font: { size: 10 } } } },
          scales: {
            x: { ticks: { color: '#cfe8ff', maxRotation: sortedKeys.length > 12 ? 60 : 0 }, grid: { color: 'rgba(255,255,255,0.06)' } },
            y: { ticks: { color: '#cfe8ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
          },
        },
      });
    } else {
      chartWrapEl.style.display = 'none';
    }
  }
}

// ---------- Live map: who's currently on an active mission right now ----------

let fieldLiveMapInstance = null;

async function renderFieldLiveMap() {
  const listEl = $('fieldLiveMapList');
  const mapWrap = $('fieldLiveMapArea');
  if (!listEl) return;
  listEl.innerHTML = '<div class="empty">Loading…</div>';

  const { data: activeMissions, error: mErr } = await sb.from('field_missions').select('person_id').eq('status', 'active');
  if (mErr) { listEl.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(mErr.message)}</div>`; return; }
  const activePersonIds = [...new Set((activeMissions || []).map((m) => m.person_id))];
  if (!activePersonIds.length) {
    listEl.innerHTML = '<div class="empty">No one is on an active mission right now.</div>';
    if (mapWrap) mapWrap.style.display = 'none';
    return;
  }

  const { data, error } = await sb.from('field_locations')
    .select('person_id, lat, lng, address, updated_at, profiles(full_name, email)')
    .in('person_id', activePersonIds);
  if (error) { listEl.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(error.message)}</div>`; return; }

  const rows = data || [];
  listEl.innerHTML = rows.length ? rows.map((r) => `
    <div class="entry">
      <span class="type-icon">📍</span>
      <div class="entry-body">
        <div class="entry-desc">${escapeHtml(r.profiles?.full_name || r.profiles?.email || 'Field person')}</div>
        <div class="entry-meta">${escapeHtml(r.address || '')} · ${escapeHtml(minutesAgoLabel(r.updated_at))}</div>
      </div>
    </div>
  `).join('') : '<div class="empty">On a mission, but no location captured yet.</div>';

  if (mapWrap && typeof L !== 'undefined' && rows.filter((r) => r.lat && r.lng).length) {
    mapWrap.style.display = 'block';
    if (!fieldLiveMapInstance) {
      fieldLiveMapInstance = L.map(mapWrap);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles © Esri',
      }).addTo(fieldLiveMapInstance);
      fieldLiveMapInstance._markerLayer = L.layerGroup().addTo(fieldLiveMapInstance);
    }
    fieldLiveMapInstance._markerLayer.clearLayers();
    const points = rows.filter((r) => r.lat && r.lng);
    points.forEach((r) => {
      const name = r.profiles?.full_name || r.profiles?.email || 'Field person';
      const marker = L.marker([r.lat, r.lng]).addTo(fieldLiveMapInstance._markerLayer);
      marker.bindTooltip(
        `<div class="live-driver-tag"><b>${escapeHtml(name)}</b></div>`,
        { permanent: true, direction: 'top', offset: [0, -30], className: 'live-driver-tooltip' }
      );
      marker.bindPopup(`<div class="live-driver-tag"><b>${escapeHtml(name)}</b><br>${escapeHtml(r.address || '')}</div>`);
    });
    if (points.length) {
      const bounds = L.latLngBounds(points.map((r) => [r.lat, r.lng]));
      setTimeout(() => {
        fieldLiveMapInstance.invalidateSize();
        fieldLiveMapInstance.fitBounds(bounds.pad(0.2), { maxZoom: 15 });
      }, 50);
    }
  } else if (mapWrap) {
    mapWrap.style.display = 'none';
  }
}

// ---------- Panel entry point (wired into openPanel('fieldActivities')) ----------

async function renderFieldActivitiesPanel() {
  const isAdmin = currentProfile?.role === 'admin';
  if ($('fieldAdminCard')) $('fieldAdminCard').style.display = isAdmin ? 'block' : 'none';
  if ($('fieldLiveMapCard')) $('fieldLiveMapCard').style.display = isAdmin ? 'block' : 'none';

  await renderFieldMissionCard();
  await populateFieldVisitClientSelect();
  await renderFieldTodayVisits();
  wireAddressSearch('fieldVisitLocationSearch', 'fieldVisitLocationSearchResults');

  if (isAdmin) {
    await populateFieldAdminPersonSelect();
    const defaultBtn = document.querySelector(`.field-period-btn[data-field-period="${fieldAdminSelectedPeriodDays}"]`);
    document.querySelectorAll('.field-period-btn').forEach((b) => b.classList.toggle('active', b === defaultBtn));
    renderFieldAdminAnalytics();
    renderFieldLiveMap();
  }
}

// =====================================================================
// COMPANY SEARCH — powers Company Finder (search real companies worldwide
// by industry + location) and address search for Clients. Uses OpenStreet-
// Map's free Nominatim search (the same free, no-key service already used
// elsewhere in this app for reverse-geocoding clock-in/out locations) —
// no API key, no billing account, $0, and searches run entirely inside
// this app rather than opening Chrome/Google Maps.
// TRADE-OFF: OSM's listings are community-submitted, not a paid business
// directory — well-known/larger companies and named landmarks usually
// show up, but a specific small or specialized business may not be listed
// at all, and phone/website details generally aren't available through
// this free endpoint (those fields are simply left blank when missing).
// If richer, more complete coverage is ever needed, this is the one place
// that would need to change — swap the fetch below for a paid provider
// (e.g. Google Places) and keep returning the same { ok, places, error }
// shape so nothing else in Company Finder or Clients has to change.
// =====================================================================

async function companyTextSearch(query, { maxResults = 12 } = {}) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=${maxResults}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, places: [], error: `Search failed (${res.status})` };
    const data = await res.json();
    const places = (data || [])
      .filter((r) => r.lat && r.lon)
      .map((r) => ({
        id: `osm-${r.osm_type}-${r.osm_id}`,
        displayName: { text: (r.display_name || 'Unnamed').split(',')[0].trim() },
        formattedAddress: r.display_name || '',
        location: { latitude: parseFloat(r.lat), longitude: parseFloat(r.lon) },
        internationalPhoneNumber: null,
        websiteUri: null,
      }));
    return { ok: true, places, error: null };
  } catch (err) {
    return { ok: false, places: [], error: err.message || String(err) };
  }
}

// =====================================================================
// COMPANY FINDER — search real companies worldwide by industry + location
// (marine, oil & gas, manufacturers, shipping, ship builders, integration,
// cloud, or a custom keyword), see them on a map, and save any of them
// straight into Clients with one tap — ready for a Field Activities visit.
// =====================================================================

const COMPANY_FINDER_INDUSTRIES = [
  { label: 'Marine Industries', emoji: '🚢' },
  { label: 'Oil & Gas', emoji: '🛢️' },
  { label: 'Manufacturers', emoji: '🏭' },
  { label: 'Shipping Companies', emoji: '📦' },
  { label: 'Ship Builders', emoji: '⚓' },
  { label: 'Integration Companies', emoji: '🔧' },
  { label: 'Cloud Companies', emoji: '☁️' },
];

let companyFinderSelectedIndustry = '';
let companyFinderResults = [];
let companyFinderMapInstance = null;

function renderCompanyFinderIndustryChips() {
  const wrap = $('companyFinderIndustryGrid');
  if (!wrap || wrap.dataset.built) return; // build once — the grid itself never changes
  wrap.dataset.built = '1';
  wrap.innerHTML = COMPANY_FINDER_INDUSTRIES.map((i) => `
    <div class="doc-type-chip" data-industry-label="${escapeHtml(i.label)}"><span class="emoji">${i.emoji}</span>${escapeHtml(i.label)}</div>
  `).join('');
  wrap.querySelectorAll('[data-industry-label]').forEach((chip) => {
    chip.addEventListener('click', () => {
      wrap.querySelectorAll('[data-industry-label]').forEach((c) => c.classList.toggle('selected', c === chip));
      companyFinderSelectedIndustry = chip.dataset.industryLabel;
      if ($('companyFinderKeyword')) $('companyFinderKeyword').value = '';
    });
  });
}

if ($('companyFinderSearchBtn')) {
  $('companyFinderSearchBtn').addEventListener('click', async () => {
    const location = $('companyFinderLocation').value.trim() || 'Dubai, UAE';
    const keyword = $('companyFinderKeyword').value.trim();
    const industry = keyword || companyFinderSelectedIndustry;
    if (!industry) { showToast('Pick an industry, or type your own keyword.'); return; }
    const btn = $('companyFinderSearchBtn');
    const resultsEl = $('companyFinderResults');
    btn.disabled = true;
    btn.textContent = '🔍 Searching…';
    resultsEl.innerHTML = '<div class="empty">Searching…</div>';
    const { ok, places, error } = await companyTextSearch(`${industry} companies in ${location}`);
    btn.disabled = false;
    btn.textContent = '🔍 Search';
    if (!ok) { resultsEl.innerHTML = `<div class="empty">${escapeHtml(error)}</div>`; return; }
    companyFinderResults = places;
    renderCompanyFinderResults();
  });
}

async function renderCompanyFinderResults() {
  const resultsEl = $('companyFinderResults');
  const mapWrap = $('companyFinderMapArea');
  if (!resultsEl) return;
  if (!companyFinderResults.length) {
    resultsEl.innerHTML = '<div class="empty">No companies found — try a different industry or location.</div>';
    if (mapWrap) mapWrap.style.display = 'none';
    return;
  }

  const placeIds = companyFinderResults.map((p) => p.id).filter(Boolean);
  const { data: existing } = await sb.from('clients').select('place_id').in('place_id', placeIds);
  const existingSet = new Set((existing || []).map((r) => r.place_id));

  resultsEl.innerHTML = companyFinderResults.map((p, idx) => {
    const already = existingSet.has(p.id);
    return `
      <div class="entry" style="align-items:flex-start;">
        <span class="type-icon">🏢</span>
        <div class="entry-body">
          <div class="entry-desc">${escapeHtml(p.displayName?.text || 'Unnamed company')}</div>
          <div class="entry-meta">${escapeHtml(p.formattedAddress || '')}</div>
          ${p.internationalPhoneNumber ? `<div class="entry-meta">📞 ${escapeHtml(p.internationalPhoneNumber)}</div>` : ''}
          <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
            ${p.websiteUri ? `<a class="secondary" style="text-decoration:none; text-align:center; padding:8px 12px; border-radius:10px;" href="${escapeHtml(p.websiteUri)}" target="_blank" rel="noopener">🌐 Website</a>` : ''}
            <button type="button" class="primary" style="margin-top:0;" data-add-company="${idx}" ${already ? 'disabled' : ''}>${already ? '✅ Already a client' : '➕ Add as Client'}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  resultsEl.querySelectorAll('[data-add-company]').forEach((btn) => {
    btn.addEventListener('click', () => addCompanyAsClient(Number(btn.dataset.addCompany), btn));
  });

  renderCompanyFinderMap();
}

async function addCompanyAsClient(idx, btn) {
  const p = companyFinderResults[idx];
  if (!p) return;
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const { error } = await sb.from('clients').insert({
      name: p.displayName?.text || 'Unnamed company',
      address: p.formattedAddress || null,
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      phone: p.internationalPhoneNumber || null,
      website: p.websiteUri || null,
      industry: companyFinderSelectedIndustry || null,
      source: 'openstreetmap',
      place_id: p.id,
      created_by: currentUser.id,
    });
    if (error) throw error;
    btn.textContent = '✅ Added';
    showToast(`${p.displayName?.text || 'Company'} added to Clients.`);
    clientsCache = []; // stale — force a refresh next time it's needed
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '➕ Add as Client';
    showToast(`Couldn't add: ${err.message || err}`);
  }
}

async function renderCompanyFinderMap() {
  const mapWrap = $('companyFinderMapArea');
  if (!mapWrap) return;
  const points = companyFinderResults.filter((p) => p.location?.latitude && p.location?.longitude);
  if (!points.length || typeof L === 'undefined') { mapWrap.style.display = 'none'; return; }
  mapWrap.style.display = 'block';
  if (!companyFinderMapInstance) {
    companyFinderMapInstance = L.map(mapWrap);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles © Esri',
    }).addTo(companyFinderMapInstance);
    companyFinderMapInstance._markerLayer = L.layerGroup().addTo(companyFinderMapInstance);
  }
  companyFinderMapInstance._markerLayer.clearLayers();
  points.forEach((p) => {
    const marker = L.marker([p.location.latitude, p.location.longitude]).addTo(companyFinderMapInstance._markerLayer);
    marker.bindPopup(`<div class="live-driver-tag"><b>${escapeHtml(p.displayName?.text || '')}</b><br>${escapeHtml(p.formattedAddress || '')}</div>`);
  });
  const bounds = L.latLngBounds(points.map((p) => [p.location.latitude, p.location.longitude]));
  setTimeout(() => {
    companyFinderMapInstance.invalidateSize();
    companyFinderMapInstance.fitBounds(bounds.pad(0.2), { maxZoom: 15 });
  }, 50);
}

async function renderQueue() {
  const list = $('entryList');
  const entries = await getAllEntries();

  // Special requests never go through the local-first IndexedDB queue
  // above — they're submitted straight to Supabase via submit-special-
  // request and only ever become a real entry once approved — so they're
  // fetched separately here just for display, merged in alongside the
  // normal queue. The light-blue "Special" tag stays on the row before
  // AND after approval; only the status chip next to it changes.
  let srRows = [];
  if (currentUser) {
    const { data } = await sb.from('special_requests').select('*').eq('person_id', currentUser.id).order('created_at', { ascending: false }).limit(50);
    srRows = data || [];
  }

  if (!entries.length && !srRows.length) { list.innerHTML = '<div class="empty">No entries yet.</div>'; return; }

  const regularHtml = entries.map(en => {
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

  const srHtml = srRows.map((r) => `
    <div class="entry" title="Special request — see it in Special Request for full details">
      <span class="type-icon">${MODE_ICON[r.mode] || '🕐'}</span>
      <div class="entry-body">
        <div class="entry-meta">${escapeHtml(MODE_LABEL[r.mode] || r.mode || '')} · ${escapeHtml(r.job_id || '—')} · ${escapeHtml(r.entry_date)}</div>
        <div class="entry-desc">${escapeHtml(r.description || r.reason || '')}</div>
      </div>
      <div class="entry-status-stack">
        <span class="sr-tag">Special</span>
        <span class="chip ${SR_STATUS_CLASS[r.status] || ''}">${SR_STATUS_LABEL[r.status] || r.status}</span>
      </div>
    </div>
  `).join('');

  list.innerHTML = regularHtml + srHtml;
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

// HUD confirm sound — plays alongside the AEON orb ripple effect below, and
// when the Renewal Manager HUD person panel opens.
const hudConfirmAudio = new Audio('./hud-confirm.wav');
hudConfirmAudio.volume = 0.6;
function playHudConfirmSound() {
  try { hudConfirmAudio.currentTime = 0; hudConfirmAudio.play().catch(() => {}); } catch { /* audio not available — silently skip */ }
}

// ---------- AEON orb tap — water-ripple wave effect ----------
// A canvas overlay across the whole screen, created on first use. Tapping
// the AEON orb to open the chat sends a real radial wave (with distance and
// time decay, not a simple CSS pulse) out from the orb's exact on-screen
// position toward the far corner. The canvas only animates while a ripple
// is actually in flight, so it costs nothing the rest of the time, and it
// never intercepts clicks (pointer-events: none).
let hudRippleCanvas = null, hudRippleCtx = null, hudRipplePoints = [], hudRipples = [], hudRippleRunning = false;
function ensureHudRippleCanvas() {
  if (hudRippleCanvas) return;
  hudRippleCanvas = document.createElement('canvas');
  hudRippleCanvas.style.cssText = 'position:fixed; inset:0; width:100vw; height:100vh; pointer-events:none; z-index:9999;';
  document.body.appendChild(hudRippleCanvas);
  hudRippleCtx = hudRippleCanvas.getContext('2d');
  const resizeRippleCanvas = () => {
    hudRippleCanvas.width = window.innerWidth;
    hudRippleCanvas.height = window.innerHeight;
    const SPACING = 26;
    hudRipplePoints = [];
    for (let y = SPACING / 2; y < hudRippleCanvas.height; y += SPACING) {
      for (let x = SPACING / 2; x < hudRippleCanvas.width; x += SPACING) {
        hudRipplePoints.push({ x, y });
      }
    }
  };
  window.addEventListener('resize', resizeRippleCanvas);
  resizeRippleCanvas();
}
function hudRippleFrame(now) {
  const SPEED = 480, WAVELEN = 60, WAVEWIDTH = 120;
  const diag = Math.hypot(hudRippleCanvas.width, hudRippleCanvas.height);
  hudRipples = hudRipples.filter((r) => (now - r.start) / 1000 * SPEED - WAVEWIDTH < diag + 60);
  hudRippleCtx.clearRect(0, 0, hudRippleCanvas.width, hudRippleCanvas.height);
  if (!hudRipples.length) { hudRippleRunning = false; return; }
  for (const p of hudRipplePoints) {
    let disp = 0;
    for (const r of hudRipples) {
      const age = (now - r.start) / 1000;
      const radius = age * SPEED;
      const dist = Math.hypot(p.x - r.x, p.y - r.y);
      const diff = dist - radius;
      if (Math.abs(diff) < WAVEWIDTH) {
        const envelope = Math.cos((diff / WAVEWIDTH) * Math.PI / 2);
        const distDecay = Math.exp(-dist / 900);
        const timeDecay = Math.exp(-age / 2.4);
        const phase = (diff / WAVELEN) * Math.PI * 2;
        disp += Math.sin(phase) * envelope * distDecay * timeDecay;
      }
    }
    const bright = Math.max(0, disp) * 0.9;
    if (bright > 0.05) {
      const size = 1 + Math.max(0, disp) * 2.4;
      hudRippleCtx.beginPath();
      hudRippleCtx.fillStyle = `rgba(120,230,210,${Math.min(0.85, bright)})`;
      hudRippleCtx.arc(p.x, p.y + disp * 7, Math.max(0.6, size), 0, Math.PI * 2);
      hudRippleCtx.fill();
    }
  }
  requestAnimationFrame(hudRippleFrame);
}
function triggerAeonRipple(originEl) {
  if (!originEl) return;
  ensureHudRippleCanvas();
  const r = originEl.getBoundingClientRect();
  hudRipples.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, start: performance.now() });
  if (!hudRippleRunning) { hudRippleRunning = true; requestAnimationFrame(hudRippleFrame); }
}
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
// Nothing about this conversation is kept once you close it — closing wipes
// both the in-memory context sent to the AI (aiHistory) and the on-screen
// bubbles, so reopening AEON Ai always starts a brand new conversation.
const AI_GREETING_HTML = '<div class="ai-msg assistant">How can I help you? I can support you with things like your timesheets, leave, daily progress updates, and reports — or ask me about anything else you need, like what did I work on 23/07/2026 or summarize my last report.</div>';
function resetAiChat() {
  aiHistory = [];
  const wrap = $('aiMessages');
  if (wrap) wrap.innerHTML = AI_GREETING_HTML;
}
function closeAiChat() {
  aiOpen = false;
  $('aiMesh').classList.remove('show');
  $('aiChatPanel').classList.remove('show');
  if (currentUser) $('aiOrbLabel').style.display = 'block';
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  $('aiOrb').classList.remove('speaking');
  resetAiChat();
}

$('aiOrb').addEventListener('click', () => {
  if (!aiOpen) { triggerAeonRipple($('aiOrb')); playHudConfirmSound(); }
  aiOpen ? closeAiChat() : openAiChat();
});
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

// Glass popup under the update icon spelling out what changed, instead of
// leaving people to guess from a plain dot. Shows on its own once a new
// build finishes downloading, and STAYS UP — long enough to actually read —
// closing only when someone taps the ✕, taps somewhere OUTSIDE the popup
// itself, or the longer timeout below runs out. (Previously it dismissed on
// literally the next tap anywhere on the page, which meant it often
// vanished before anyone had a chance to read it.)
function showUpdatePopup() {
  const popup = $('updatePopup');
  if (!popup) return;
  $('updatePopupVersion').textContent = pendingUpdateVersion ? `Update ready — ${pendingUpdateVersion}` : 'Update ready';
  $('updatePopupNotes').textContent = pendingUpdateNotes || 'Tap the refresh icon above to apply it.';
  popup.classList.add('show');
  clearTimeout(showUpdatePopup._t);
  showUpdatePopup._t = setTimeout(hideUpdatePopup, 25000);
  // Only dismiss on a tap OUTSIDE the popup (and outside the update icon
  // itself, since tapping that is how you apply the update) — tapping
  // inside the popup to read it no longer closes it.
  document.addEventListener('pointerdown', dismissUpdatePopupIfOutside, { once: true });
}
function dismissUpdatePopupIfOutside(e) {
  const popup = $('updatePopup');
  const btn = $('updateStatusBtn');
  if (popup && (popup.contains(e.target) || (btn && btn.contains(e.target)))) {
    // Tap landed inside the popup or on the update icon — keep it open and
    // keep listening for the next tap instead.
    document.addEventListener('pointerdown', dismissUpdatePopupIfOutside, { once: true });
    return;
  }
  hideUpdatePopup();
}
function hideUpdatePopup() {
  const popup = $('updatePopup');
  if (popup) popup.classList.remove('show');
  clearTimeout(showUpdatePopup._t);
}
$('updatePopupClose')?.addEventListener('click', hideUpdatePopup);

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
    showUpdatePopup();
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

// =====================================================================
// HEALTH & LEARNING — curated, minimal content: a handful of short tips
// plus links out to real, trusted, free resources for each topic. Nothing
// here is stored in Supabase or fetched live — it's small enough to just
// ship as data, and it's meant as a pointer to good outside resources, not
// a replacement for them.
// =====================================================================

const HEALTH_CATEGORIES = [
  {
    key: 'exercise', icon: '🏃', label: 'Exercise',
    tips: [
      { icon: '🚶', text: '150 min a week of movement — a few 10-minute walks a day adds up.' },
      { icon: '💪', text: 'Simple strength work, twice a week — bodyweight is fine.' },
      { icon: '🤸', text: 'A few minutes of stretching after any physical shift.' },
      { icon: '🪜', text: 'Stairs over elevators, walking over standing still.' },
    ],
    links: [
      { label: 'WHO — physical activity', url: 'https://www.who.int/news-room/fact-sheets/detail/physical-activity' },
      { label: 'NHS — exercise guide', url: 'https://www.nhs.uk/live-well/exercise/' },
    ],
  },
  {
    key: 'food', icon: '🥗', label: 'Better Food',
    tips: [
      { icon: '🥦', text: 'Half the plate as vegetables and fruit, most meals.' },
      { icon: '💧', text: 'Water over sugary drinks — it adds up fast over a year.' },
      { icon: '🌾', text: 'Whole grains over refined ones, where you can.' },
      { icon: '🍟', text: 'Go easy on fried and heavily processed food.' },
    ],
    links: [
      { label: 'WHO — healthy diet', url: 'https://www.who.int/news-room/fact-sheets/detail/healthy-diet' },
      { label: 'Harvard — Healthy Eating Plate', url: 'https://www.hsph.harvard.edu/nutritionsource/healthy-eating-plate/' },
    ],
  },
  {
    key: 'sleep', icon: '🌙', label: 'Sleep & Habits',
    tips: [
      { icon: '😴', text: '7 to 9 hours, at a consistent time — that matters as much as the total.' },
      { icon: '📵', text: 'Screens off 30 minutes before bed, if you can manage it.' },
      { icon: '☕', text: 'Caffeine cut-off by mid-afternoon, especially before a night shift.' },
      { icon: '🔁', text: 'Small daily habits beat occasional big efforts.' },
    ],
    links: [
      { label: 'Sleep Foundation — sleep hygiene', url: 'https://www.sleepfoundation.org/sleep-hygiene' },
      { label: 'CDC — about sleep', url: 'https://www.cdc.gov/sleep/about/index.html' },
    ],
  },
  {
    key: 'balance', icon: '⚖️', label: 'Lifestyle Balance',
    tips: [
      { icon: '⏸️', text: 'Real breaks during work — 5 minutes away resets focus.' },
      { icon: '🎯', text: 'Weekly time for something unrelated to work.' },
      { icon: '🚭', text: 'Go easy on alcohol, and avoid tobacco.' },
      { icon: '🗣️', text: 'Stress that lasts weeks, not days, is worth talking about.' },
    ],
    links: [
      { label: 'WHO — mental health', url: 'https://www.who.int/health-topics/mental-health' },
      { label: 'Mayo Clinic — managing stress', url: 'https://www.mayoclinic.org/healthy-lifestyle/stress-management/basics/stress-basics' },
    ],
  },
  {
    key: 'hydration', icon: '💧', label: 'Hydration',
    tips: [
      { icon: '🚰', text: "Drink through the day — don't wait until you feel thirsty." },
      { icon: '🟡', text: 'Dark urine is an early sign you need more water.' },
      { icon: '🔥', text: 'Heat or physical work means you need noticeably more than usual.' },
      { icon: '🥤', text: 'Water first — sports drinks only matter for long, hard, sweaty work.' },
    ],
    links: [
      { label: 'CDC — water & healthier drinks', url: 'https://www.cdc.gov/healthy-weight-growth/foods-drinks/water-and-healthier-drinks.html' },
      { label: 'Mayo Clinic — water basics', url: 'https://www.mayoclinic.org/healthy-lifestyle/nutrition-and-healthy-eating/in-depth/water/art-20044256' },
    ],
  },
  {
    key: 'heat', icon: '🌡️', label: 'Heat & Sun Safety',
    tips: [
      { icon: '⚠️', text: 'Dizziness, nausea, or stopping sweating in heat — treat as an emergency.' },
      { icon: '👕', text: 'Light, loose, breathable clothing when working outdoors.' },
      { icon: '🌳', text: 'Shade breaks during the hottest part of the day, whenever possible.' },
      { icon: '🧢', text: 'A hat and sunscreen matter as much as water on a hot site.' },
    ],
    links: [
      { label: 'OSHA — heat exposure', url: 'https://www.osha.gov/heat-exposure' },
      { label: 'WHO — heat and health', url: 'https://www.who.int/news-room/fact-sheets/detail/climate-change-heat-and-health' },
    ],
  },
  {
    key: 'posture', icon: '🧍', label: 'Back & Posture',
    tips: [
      { icon: '🏋️', text: 'Lift with your legs, not your back — keep the load close to your body.' },
      { icon: '🌀', text: 'Avoid twisting your spine while carrying or lifting something heavy.' },
      { icon: '🪑', text: 'Stretch or change position if you sit or stand still for long stretches.' },
      { icon: '💻', text: 'Screens roughly at eye level — looking down all day adds up on the neck.' },
    ],
    links: [
      { label: 'NHS — back pain', url: 'https://www.nhs.uk/conditions/back-pain/' },
      { label: 'OSHA — ergonomics', url: 'https://www.osha.gov/ergonomics' },
    ],
  },
  {
    key: 'hearing', icon: '👂', label: 'Hearing Protection',
    tips: [
      { icon: '🎧', text: 'Ear protection around loud machinery — every time, not just sometimes.' },
      { icon: '📉', text: 'Loud noise over years causes hearing loss you cannot get back.' },
      { icon: '🤫', text: 'Give your ears quiet recovery time after a loud shift.' },
      { icon: '🩺', text: 'A periodic hearing check catches damage before you notice it yourself.' },
    ],
    links: [
      { label: 'OSHA — noise', url: 'https://www.osha.gov/noise' },
      { label: 'CDC — preventing hearing loss', url: 'https://www.cdc.gov/hearing-loss-children/php/prevention/index.html' },
    ],
  },
  {
    key: 'eyesafety', icon: '👁️', label: 'Eye Safety',
    tips: [
      { icon: '🥽', text: 'Proper eye protection for welding, grinding, or cutting — always.' },
      { icon: '🚫', text: 'Never look directly at a welding arc, even briefly, even with sunglasses.' },
      { icon: '🚿', text: 'Rinse immediately if a chemical or debris gets in the eye, then seek help.' },
      { icon: '🔍', text: 'Regular eye checkups catch strain or damage early.' },
    ],
    links: [
      { label: 'OSHA — eye & face protection', url: 'https://www.osha.gov/eye-face-protection' },
      { label: 'American Academy of Ophthalmology', url: 'https://www.aao.org/eye-health' },
    ],
  },
  {
    key: 'firstaid', icon: '🩹', label: 'First Aid Basics',
    tips: [
      { icon: '📍', text: 'Know where the nearest first aid kit and AED actually are.' },
      { icon: '❤️', text: 'Basic CPR is a skill worth learning once, properly, from a real course.' },
      { icon: '🩸', text: 'Clean and treat small cuts and burns right away, don\'t wait.' },
      { icon: '📞', text: 'Know your workplace\'s emergency contact and reporting process in advance.' },
    ],
    links: [
      { label: 'Red Cross — first aid', url: 'https://www.redcross.org/take-a-class/first-aid' },
      { label: 'St John Ambulance — first aid advice', url: 'https://www.sja.org.uk/get-advice/first-aid-advice/' },
    ],
  },
  {
    key: 'findcare', icon: '🩺', label: 'Health Info',
    tips: [
      { icon: 'ℹ️', text: 'General information only — see a licensed doctor for an actual concern.' },
      { icon: '🚨', text: 'Anything urgent — call your local emergency number directly.' },
      { icon: '☎️', text: 'Worth knowing your local free health helpline, before you need it.' },
    ],
    links: [
      { label: 'World Health Organization', url: 'https://www.who.int/' },
      { label: 'Mayo Clinic — conditions A-Z', url: 'https://www.mayoclinic.org/diseases-conditions' },
      { label: 'MedlinePlus (free, US NLM)', url: 'https://medlineplus.gov/' },
    ],
  },
];

const LEARNING_CATEGORIES = [
  {
    key: 'ai', icon: '🤖', label: 'AI & Machine Learning',
    tips: [
      { icon: '🎓', text: 'Elements of AI — free, beginner-friendly, certificate included.' },
      { icon: '📈', text: "Google's ML Crash Course — free and practical." },
      { icon: '🧩', text: 'Kaggle Learn — short, free, hands-on micro-courses.' },
    ],
    links: [
      { label: 'Elements of AI (free)', url: 'https://www.elementsofai.com/' },
      { label: 'Google ML Crash Course', url: 'https://developers.google.com/machine-learning/crash-course' },
      { label: 'Kaggle Learn', url: 'https://www.kaggle.com/learn' },
    ],
  },
  {
    key: 'cyber', icon: '🔐', label: 'Cyber Security',
    tips: [
      { icon: '🛡️', text: 'Cisco — "Intro to Cybersecurity", free with a certificate.' },
      { icon: '🕵️', text: 'TryHackMe — a free tier of hands-on guided labs.' },
      { icon: '🎥', text: 'Coursera is usually free to audit — pay only for the certificate.' },
    ],
    links: [
      { label: 'Cisco — Intro to Cybersecurity', url: 'https://www.netacad.com/courses/cybersecurity' },
      { label: 'TryHackMe', url: 'https://tryhackme.com/' },
      { label: 'ISC2 Certified in Cybersecurity', url: 'https://www.isc2.org/certifications/cc' },
    ],
  },
  {
    key: 'coding', icon: '🐍', label: 'Python & Coding',
    tips: [
      { icon: '🆓', text: 'freeCodeCamp — free end to end, certificates included.' },
      { icon: '📘', text: "Python's own official tutorial — free, for complete beginners." },
      { icon: '🏛️', text: "Harvard's CS50 — free to take, verified certificate costs extra." },
    ],
    video: { label: 'freeCodeCamp on YouTube', url: 'https://www.youtube.com/@freecodecamp' },
    links: [
      { label: 'freeCodeCamp', url: 'https://www.freecodecamp.org/' },
      { label: 'Python official tutorial', url: 'https://docs.python.org/3/tutorial/' },
      { label: 'Harvard CS50', url: 'https://cs50.harvard.edu/x/' },
    ],
  },
  {
    key: 'plc', icon: '⚙️', label: 'PLC & Industrial Automation',
    tips: [
      { icon: '🎬', text: 'RealPars — a large free video library, basics to real projects.' },
      { icon: '🏭', text: 'Siemens SITRAIN — some free intro courses alongside paid ones.' },
      { icon: '📝', text: 'Instrumentation Tools — free write-ups on PLC/control basics.' },
    ],
    video: { label: 'RealPars on YouTube', url: 'https://www.youtube.com/@RealPars' },
    links: [
      { label: 'RealPars (free videos)', url: 'https://realpars.com/' },
      { label: 'SITRAIN by Siemens', url: 'https://www.sitrain-learning.siemens.com/' },
      { label: 'Instrumentation Tools', url: 'https://instrumentationtools.com/' },
    ],
  },
  {
    key: 'hmi', icon: '🖥️', label: 'HMI Design',
    tips: [
      { icon: '🎬', text: 'RealPars — HMI design principles, in the same free library.' },
      { icon: '🏭', text: 'Rockwell Automation — free intro tutorials on its HMI/SCADA tools.' },
      { icon: '📰', text: 'ISA — free articles on HMI best practice.' },
    ],
    video: { label: 'RealPars on YouTube', url: 'https://www.youtube.com/@RealPars' },
    links: [
      { label: 'RealPars — HMI', url: 'https://realpars.com/hmi/' },
      { label: 'Rockwell Automation', url: 'https://www.rockwellautomation.com/' },
      { label: 'ISA — resources', url: 'https://www.isa.org/' },
    ],
  },
  {
    key: 'design', icon: '📐', label: 'Industrial & Engineering Design',
    tips: [
      { icon: '🖱️', text: 'Autodesk — free Fusion 360 and AutoCAD access for learners.' },
      { icon: '🧱', text: 'GrabCAD — a free community library of real CAD models.' },
      { icon: '🎥', text: 'Coursera — many engineering design courses free to audit.' },
    ],
    links: [
      { label: 'Autodesk (free for learners)', url: 'https://www.autodesk.com/education/edu-software/overview' },
      { label: 'GrabCAD', url: 'https://grabcad.com/' },
      { label: 'Coursera', url: 'https://www.coursera.org/' },
    ],
  },
  {
    key: 'safety', icon: '🦺', label: 'Workplace Safety',
    tips: [
      { icon: '🎓', text: 'Alison.com — genuinely free certificate courses on safety topics.' },
      { icon: '📋', text: 'OSHA — free training materials and guidance (US).' },
      { icon: '📖', text: "UK HSE — extensive free guidance, useful as general reference anywhere." },
    ],
    links: [
      { label: 'Alison — Health & Safety', url: 'https://alison.com/courses/health-and-safety' },
      { label: 'OSHA — training resources', url: 'https://www.osha.gov/training' },
      { label: 'UK HSE — guidance', url: 'https://www.hse.gov.uk/' },
    ],
  },
  {
    key: 'cloud', icon: '☁️', label: 'Cloud Computing',
    tips: [
      { icon: '🟠', text: 'AWS Skill Builder — genuinely free digital training, no cost to start.' },
      { icon: '🔵', text: 'Microsoft Learn — free Azure learning paths with progress tracking.' },
      { icon: '🟢', text: 'Google Cloud Skills Boost — free hands-on labs to try.' },
    ],
    links: [
      { label: 'AWS Skill Builder', url: 'https://skillbuilder.aws/' },
      { label: 'Microsoft Learn — Azure', url: 'https://learn.microsoft.com/en-us/training/azure/' },
      { label: 'Google Cloud Skills Boost', url: 'https://www.cloudskillsboost.google/' },
    ],
  },
  {
    key: 'networking', icon: '🌐', label: 'Networking & IT',
    tips: [
      { icon: '🖧', text: 'Cisco Networking Academy — free "Networking Basics" course.' },
      { icon: '🎬', text: 'Professor Messer — free, well-known CompTIA Network+ video series.' },
      { icon: '🧪', text: 'Free Packet Tracer tool lets you practice real network setups.' },
    ],
    video: { label: 'Professor Messer on YouTube', url: 'https://www.youtube.com/@professormesser' },
    links: [
      { label: 'Cisco — Networking Basics', url: 'https://www.netacad.com/courses/networking-basics' },
      { label: 'Professor Messer', url: 'https://www.professormesser.com/' },
    ],
  },
  {
    key: 'projectmgmt', icon: '📋', label: 'Project Management',
    tips: [
      { icon: '🎥', text: "Google's Project Management course is free to audit on Coursera." },
      { icon: '🏛️', text: 'PMI shares free articles and resources even before you\'re a member.' },
      { icon: '📝', text: 'Free planning templates are widely available and a great place to start.' },
    ],
    links: [
      { label: 'Coursera — Google Project Management', url: 'https://www.coursera.org/professional-certificates/google-project-management' },
      { label: 'PMI — resources', url: 'https://www.pmi.org/' },
    ],
  },
  {
    key: 'excel', icon: '📊', label: 'Excel & Data Skills',
    tips: [
      { icon: '📗', text: "Microsoft's own free Excel training covers everything from basics up." },
      { icon: '📄', text: 'Google offers free training for Sheets and the rest of Workspace.' },
      { icon: '📈', text: 'freeCodeCamp has free courses on data analysis too, not just coding.' },
    ],
    links: [
      { label: 'Microsoft — Excel training', url: 'https://support.microsoft.com/en-us/excel' },
      { label: 'Google Workspace Learning Center', url: 'https://support.google.com/a/users/answer/9282958' },
    ],
  },
  {
    key: 'communication', icon: '🗣️', label: 'Communication & English',
    tips: [
      { icon: '📻', text: 'BBC Learning English is completely free, for every level.' },
      { icon: '🦉', text: 'Duolingo is free for daily practice in short bursts.' },
      { icon: '✍️', text: 'Clear written communication is its own skill worth practicing.' },
    ],
    links: [
      { label: 'BBC Learning English', url: 'https://www.bbc.co.uk/learningenglish' },
      { label: 'Duolingo', url: 'https://www.duolingo.com/' },
    ],
  },
  {
    key: 'welding', icon: '⚓', label: 'Welding & Marine Trades',
    tips: [
      { icon: '🏛️', text: 'American Welding Society shares free resources and guidance.' },
      { icon: '🎬', text: 'Well-known welding YouTube channels cover real technique, free.' },
      { icon: '⚓', text: 'IMCA publishes free guidance for marine and offshore work.' },
    ],
    links: [
      { label: 'American Welding Society', url: 'https://www.aws.org/' },
      { label: 'IMCA — marine contractors', url: 'https://www.imca-int.com/' },
    ],
  },
];

// Renders a tile grid + tap-to-expand detail card, shared by Health and
// Learning — tapping a tile again (or another tile) swaps the detail
// underneath rather than opening yet another overlay layer. Each tip gets
// its own little icon badge rather than a plain bulleted line, so this
// reads as a set of designed cards rather than a wall of text.
function renderCategoryTileGrid(panelKey, categories) {
  const grid = $(panelKey === 'health' ? 'healthTileGrid' : 'learningTileGrid');
  const detailArea = $(panelKey === 'health' ? 'healthDetailArea' : 'learningDetailArea');
  if (!grid || !detailArea) return;

  function renderDetail(cat) {
    detailArea.innerHTML = `
      <div class="category-detail">
        <div class="category-detail-title">
          <span class="category-detail-emoji">${cat.icon}</span>
          ${escapeHtml(cat.label)}
        </div>
        <div class="category-detail-tips">
          ${cat.tips.map((t) => `
            <div class="category-tip-row">
              <span class="category-tip-icon">${t.icon}</span>
              <span class="category-tip-text">${escapeHtml(t.text)}</span>
            </div>
          `).join('')}
        </div>
        <div class="category-detail-links">
          ${cat.video ? `<a class="category-link-chip category-video-chip" href="${escapeHtml(cat.video.url)}" target="_blank" rel="noopener">▶ ${escapeHtml(cat.video.label)}</a>` : ''}
          ${cat.links.map((l) => `<a class="category-link-chip" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">🔗 ${escapeHtml(l.label)}</a>`).join('')}
        </div>
      </div>
    `;
  }

  grid.innerHTML = categories.map((cat, i) => `
    <button type="button" class="category-tile tile-tint-${(i % 7) + 1}" data-cat="${cat.key}">
      <span class="category-tile-icon">${cat.icon}</span>
      <span class="category-tile-label">${escapeHtml(cat.label)}</span>
    </button>
  `).join('');
  detailArea.innerHTML = '';

  grid.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const alreadyActive = btn.classList.contains('active');
      grid.querySelectorAll('.category-tile').forEach((t) => t.classList.remove('active'));
      if (alreadyActive) { detailArea.innerHTML = ''; return; }
      btn.classList.add('active');
      renderDetail(categories.find((c) => c.key === btn.dataset.cat));
    });
  });
}
function renderHealthPanel() { renderCategoryTileGrid('health', HEALTH_CATEGORIES); }
function renderLearningPanel() { renderCategoryTileGrid('learning', LEARNING_CATEGORIES); }

// =====================================================================
// WEATHER — a small badge pinned top-left of the header (icon + current
// outdoor temp), tap for a full forecast. Location comes from the device's
// own GPS (same permission prompt already used for clock-in location);
// the data itself is Open-Meteo — free, no API key, no signup needed.
// =====================================================================

let weatherData = null; // { current: {...}, daily: [...], place: 'City, Country' }
const WEATHER_CACHE_KEY = 'ctorq-weather-cache-v1';
const WEATHER_CACHE_MS = 20 * 60 * 1000; // 20 minutes — weather doesn't change fast enough to need more

// WMO weather codes (used by Open-Meteo) → a simple icon + plain-language label.
function weatherCodeInfo(code) {
  const map = {
    0: ['☀️', 'Clear sky'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
    45: ['🌫️', 'Foggy'], 48: ['🌫️', 'Foggy'],
    51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Heavy drizzle'],
    61: ['🌧️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
    66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
    71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
    80: ['🌦️', 'Light showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Heavy showers'],
    85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Heavy snow showers'],
    95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm + hail'], 99: ['⛈️', 'Severe thunderstorm'],
  };
  return map[code] || ['🌡️', 'Weather'];
}
function weatherDayLabel(dateStr, i) {
  if (i === 0) return 'Today';
  if (i === 1) return 'Tomorrow';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
}
function uvIndexLabel(uv) {
  if (uv == null) return '';
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}
// US AQI scale (what Open-Meteo's `us_aqi` field already reports in).
function aqiLabel(aqi) {
  if (aqi == null) return '';
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy (sensitive)';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}
function windDirLabel(deg) {
  if (deg == null) return '';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}
function weatherClockTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function daylightLength(sunriseIso, sunsetIso) {
  if (!sunriseIso || !sunsetIso) return '';
  const mins = Math.round((new Date(sunsetIso) - new Date(sunriseIso)) / 60000);
  return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

async function loadWeather() {
  if (!('geolocation' in navigator)) return;
  try {
    const cachedRaw = localStorage.getItem(WEATHER_CACHE_KEY);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      if (Date.now() - cached.savedAt < WEATHER_CACHE_MS) {
        weatherData = cached.data;
        updateWeatherBadge();
        return;
      }
    }
  } catch { /* ignore a corrupt/old cache entry */ }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        // `current` covers the always-available basics; UV index and
        // visibility are hourly-only fields on Open-Meteo, so those are
        // pulled from the hourly array at the index matching this hour.
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,pressure_msl,is_day` +
          `&hourly=uv_index,visibility` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max` +
          `&timezone=auto&temperature_unit=celsius&wind_speed_unit=kmh`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('weather fetch failed');
        const json = await res.json();

        const hourKey = String(json.current?.time || '').slice(0, 13); // "YYYY-MM-DDTHH"
        let hourIdx = (json.hourly?.time || []).findIndex((t) => t.slice(0, 13) === hourKey);
        if (hourIdx === -1) hourIdx = 0;

        let place = '';
        try {
          const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=10`);
          const geo = await geoRes.json();
          const a = geo.address || {};
          place = [a.city || a.town || a.village || a.county, a.country].filter(Boolean).join(', ');
        } catch { /* place name is a nice-to-have, not essential */ }

        // Air quality is a separate free Open-Meteo API — best-effort, never
        // blocks the rest of the weather data if it fails or is slow.
        let aqi = null;
        try {
          const aqRes = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}&current=us_aqi`);
          const aqJson = await aqRes.json();
          aqi = aqJson.current?.us_aqi ?? null;
        } catch { /* air quality is a bonus stat, not essential */ }

        weatherData = {
          current: json.current,
          uvIndex: json.hourly?.uv_index?.[hourIdx] ?? null,
          visibility: json.hourly?.visibility?.[hourIdx] ?? null, // meters
          aqi,
          sunrise: json.daily?.sunrise?.[0] || null,
          sunset: json.daily?.sunset?.[0] || null,
          daily: (json.daily?.time || []).map((date, i) => ({
            date,
            code: json.daily.weather_code[i],
            hi: Math.round(json.daily.temperature_2m_max[i]),
            lo: Math.round(json.daily.temperature_2m_min[i]),
          })),
          place,
        };
        try {
          localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data: weatherData }));
        } catch { /* storage full or unavailable — not essential */ }
        updateWeatherBadge();
      } catch { /* network hiccup — just leave the badge hidden this session */ }
    },
    () => { /* permission denied or unavailable — badge simply stays hidden, never blocks anything */ },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 15 * 60 * 1000 }
  );
}
function updateWeatherBadge() {
  if (!weatherData?.current) return;
  const [icon] = weatherCodeInfo(weatherData.current.weather_code);
  if ($('weatherBadgeIcon')) $('weatherBadgeIcon').textContent = icon;
  if ($('weatherBadgeTemp')) $('weatherBadgeTemp').textContent = `${Math.round(weatherData.current.temperature_2m)}°`;
  if ($('weatherBadge')) $('weatherBadge').style.display = 'flex';
  if ($('weatherOverlay')?.classList.contains('show')) renderWeatherDetail();
}
function renderWeatherDetail() {
  const area = $('weatherDetailArea');
  if (!area) return;
  if (!weatherData?.current) {
    area.innerHTML = '<div class="empty">Still getting your local weather — make sure location access is allowed for this app.</div>';
    return;
  }
  const c = weatherData.current;
  const [icon, label] = weatherCodeInfo(c.weather_code);
  const today = weatherData.daily[0];
  const visibilityKm = weatherData.visibility != null ? (weatherData.visibility / 1000).toFixed(1) : null;
  const windDeg = c.wind_direction_10m;

  area.innerHTML = `
    <div class="weather-hero">
      <div class="weather-hero-icon">${icon}</div>
      <div class="weather-hero-temp">${Math.round(c.temperature_2m)}°C</div>
      <div class="weather-hero-desc">${escapeHtml(label)}${today ? ` · H:${today.hi}° L:${today.lo}°` : ''}</div>
      ${weatherData.place ? `<div class="weather-hero-place">📍 ${escapeHtml(weatherData.place)}</div>` : ''}
    </div>

    <div class="weather-bento-grid">
      <div class="weather-bento-card">
        <div class="weather-stat-label">Feels like</div>
        <div class="weather-bento-value">${Math.round(c.apparent_temperature)}°</div>
      </div>
      <div class="weather-bento-card">
        <div class="weather-stat-label">UV Index</div>
        <div class="weather-bento-value">${weatherData.uvIndex != null ? Math.round(weatherData.uvIndex) : '—'}</div>
        <div class="weather-bento-sub">${escapeHtml(uvIndexLabel(weatherData.uvIndex))}</div>
      </div>
      <div class="weather-bento-card">
        <div class="weather-stat-label">Air Quality</div>
        <div class="weather-bento-value">${weatherData.aqi != null ? Math.round(weatherData.aqi) : '—'}</div>
        <div class="weather-bento-sub">${escapeHtml(aqiLabel(weatherData.aqi))}</div>
      </div>
      <div class="weather-bento-card">
        <div class="weather-stat-label">Visibility</div>
        <div class="weather-bento-value">${visibilityKm != null ? `${visibilityKm} km` : '—'}</div>
      </div>
      <div class="weather-bento-card weather-wind-card">
        <div class="weather-stat-label">Wind</div>
        <div class="weather-bento-value">${Math.round(c.wind_speed_10m)} <span class="weather-bento-unit">km/h</span></div>
        <div class="weather-bento-sub">
          ${windDeg != null ? `<span class="weather-compass" style="transform:rotate(${windDeg}deg);">↑</span> ${windDirLabel(windDeg)}` : ''}
        </div>
      </div>
      <div class="weather-bento-card">
        <div class="weather-stat-label">Humidity</div>
        <div class="weather-bento-value">${Math.round(c.relative_humidity_2m)}%</div>
      </div>
      <div class="weather-bento-card">
        <div class="weather-stat-label">Pressure</div>
        <div class="weather-bento-value">${c.pressure_msl != null ? Math.round(c.pressure_msl) : '—'} <span class="weather-bento-unit">hPa</span></div>
      </div>
      <div class="weather-bento-card">
        <div class="weather-stat-label">Sunrise &amp; Sunset</div>
        <div class="weather-bento-value weather-bento-value-sm">🌅 ${escapeHtml(weatherClockTime(weatherData.sunrise))} &nbsp; 🌇 ${escapeHtml(weatherClockTime(weatherData.sunset))}</div>
        <div class="weather-bento-sub">${escapeHtml(daylightLength(weatherData.sunrise, weatherData.sunset))} daylight</div>
      </div>
    </div>

    <div class="card glass">
      ${weatherData.daily.map((d, i) => {
        const [dIcon, dLabel] = weatherCodeInfo(d.code);
        return `
          <div class="weather-forecast-row">
            <span class="weather-forecast-day">${weatherDayLabel(d.date, i)} · ${escapeHtml(dLabel)}</span>
            <span class="weather-forecast-icon">${dIcon}</span>
            <span class="weather-forecast-range">${d.hi}° <span class="lo">${d.lo}°</span></span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}
if ($('weatherBadge')) $('weatherBadge').addEventListener('click', () => openPanel('weather'));

// Give every plain <select> already in the page the glass-styled dropdown
// treatment. Selects created dynamically later (Team roster role/department
// pickers, Job Allocation driver pickers) are wired individually right
// after they're rendered — see initGlassSelect() calls near those renders.
initAllGlassSelects();
