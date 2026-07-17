// Module-level store that runs Server Finder test batches. It lives outside
// React so a batch keeps running when the finder overlay is closed
// ("background testing"), and components subscribe via useSyncExternalStore.

const CONCURRENCY = { ping: 8, real: 3, speed: 1 };
const RESULTS_KEY = 'soul.finder.results.v1';
const MAX_LOGS = 150;

const listeners = new Set();

const state = {
  status: 'idle', // idle | running | paused | stopping
  mode: 'ping',
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  startedAt: null,
  avgTestMs: null,
  currentIds: [],
  results: loadResults(), // profileId -> {status, error, testedAt, ping, real, speed, phase, liveSamples, startedAt}
  logs: [],
  activeSpeed: null, // {profileId, dir, bps, samples: [{t,bps,dir}]} while a speed test runs
  batchIds: [], // order of the current/last batch, drives the queue strip
  pulse: [], // rolling latency samples across the whole batch: {t, ms, profileId}
  lastBatch: null, // {mode, total, ok, fail, durationMs, cancelled, finishedAt}
};

let snapshot = null;
let queue = [];
let resumeWaiters = [];
const inFlight = new Map(); // token -> profileId
let offTestEvent = null;

function loadResults() {
  try {
    const raw = localStorage.getItem(RESULTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Only completed results are persisted; anything transient is dropped.
    const clean = {};
    for (const [id, r] of Object.entries(parsed)) {
      if (r && (r.ping || r.real || r.speed)) {
        clean[id] = { ...r, status: r.status === 'ok' ? 'ok' : r.status === 'fail' ? 'fail' : 'idle', phase: null, liveSamples: [] };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function persistResults() {
  try {
    const out = {};
    for (const [id, r] of Object.entries(state.results)) {
      if (r.ping || r.real || r.speed) {
        out[id] = { status: r.status, error: r.error, testedAt: r.testedAt, ping: r.ping, real: r.real, speed: r.speed };
      }
    }
    localStorage.setItem(RESULTS_KEY, JSON.stringify(out));
  } catch { /* quota/private mode — results just won't survive a restart */ }
}

function emit() {
  snapshot = null;
  for (const fn of listeners) fn();
}

// 'sample'/'speed' events can arrive every ~15-20ms per in-flight test (up to
// 8 concurrent), which would otherwise force a full ServerFinder re-render
// far more often than the screen can even show a new frame. Coalescing to
// one emit per animation frame caps re-renders at the display's refresh rate
// without dropping any visual update.
let emitScheduled = false;
function emitThrottled() {
  if (emitScheduled) return;
  emitScheduled = true;
  requestAnimationFrame(() => {
    emitScheduled = false;
    emit();
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshot() {
  if (!snapshot) snapshot = { ...state, results: { ...state.results }, logs: state.logs.slice() };
  return snapshot;
}

function log(msg, tone = 'info') {
  state.logs.push({ t: Date.now(), msg, tone });
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
}

function upsert(id, patch) {
  state.results[id] = { ...(state.results[id] || { status: 'idle' }), ...patch };
}

const PHASE_LABELS = {
  boot: 'راه‌اندازی تونل آزمایشی',
  reach: 'بررسی دسترسی به سرور',
  handshake: 'دست‌دادن TLS و برقراری پروتکل',
  probe: 'سنجش تاخیر واقعی',
  warmup: 'گرم‌کردن تونل',
  download: 'سنجش سرعت دانلود',
  upload: 'سنجش سرعت آپلود',
};

function ensureEventBridge() {
  if (offTestEvent || !window.soul?.onTestEvent) return;
  offTestEvent = window.soul.onTestEvent((ev) => {
    const profileId = inFlight.get(ev.token);
    if (!profileId) return;
    const r = state.results[profileId];
    if (!r) return;
    if (ev.type === 'phase') {
      r.phase = ev.phase;
      if (PHASE_LABELS[ev.phase]) log(`${nameOf(profileId)} — ${PHASE_LABELS[ev.phase]}…`, 'dim');
      if (ev.phase === 'download' || ev.phase === 'upload') {
        state.activeSpeed = { profileId, dir: ev.phase === 'upload' ? 'up' : 'down', bps: 0, samples: state.activeSpeed?.profileId === profileId ? state.activeSpeed.samples : [] };
      }
    } else if (ev.type === 'sample') {
      r.liveSamples = [...(r.liveSamples || []), ev.ms];
      state.pulse = [...state.pulse, { t: Date.now(), ms: ev.ms, profileId }].slice(-120);
      emitThrottled();
      return;
    } else if (ev.type === 'speed') {
      state.activeSpeed = {
        profileId,
        dir: ev.dir,
        bps: ev.bps,
        samples: [...(state.activeSpeed?.profileId === profileId ? state.activeSpeed.samples : []), { t: ev.elapsed, bps: ev.bps, dir: ev.dir }].slice(-160),
      };
      emitThrottled();
      return;
    }
    emit();
  });
}

let profileNames = {};
export function setProfileNames(map) {
  profileNames = map;
}
const nameOf = (id) => profileNames[id] || id;

function waitIfPaused() {
  if (state.status !== 'paused') return Promise.resolve();
  return new Promise((resolve) => resumeWaiters.push(resolve));
}

async function runOne(profileId, mode) {
  const token = `${mode}-${profileId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  inFlight.set(token, profileId);
  state.currentIds = [...inFlight.values()];
  upsert(profileId, { status: 'testing', phase: null, error: null, liveSamples: [], startedAt: Date.now() });
  log(`شروع تست ${nameOf(profileId)}`, 'dim');
  emit();

  const started = Date.now();
  try {
    let data;
    if (mode === 'ping') data = { ping: await window.soul.testPing(profileId, token) };
    else if (mode === 'real') data = { real: await window.soul.testReal(profileId, token) };
    else data = { speed: await window.soul.testSpeed(profileId, token) };

    upsert(profileId, { ...data, status: 'ok', testedAt: Date.now(), phase: null });
    state.done++;
    const headline = data.ping ? `${data.ping.avg}ms`
      : data.real ? `${data.real.avg}ms واقعی`
      : `${((data.speed.downBps * 8) / 1e6).toFixed(1)} Mbps`;
    log(`✓ ${nameOf(profileId)} — ${headline}`, 'good');
  } catch (err) {
    const cancelled = /cancelled|abort/i.test(err?.message || '');
    if (cancelled && state.status !== 'stopping') {
      // Cancelled while the batch keeps running = the user skipped this server.
      upsert(profileId, { status: 'skipped', error: null, phase: null });
      state.done++;
      state.skipped++;
      log(`⤼ ${nameOf(profileId)} — رد شد`, 'dim');
    } else {
      upsert(profileId, { status: cancelled ? 'idle' : 'fail', error: cancelled ? null : (err?.message || 'خطای ناشناخته'), phase: null });
      if (!cancelled) {
        state.done++;
        state.failed++;
        log(`✗ ${nameOf(profileId)} — ${err?.message || 'ناموفق'}`, 'bad');
      }
    }
  } finally {
    inFlight.delete(token);
    state.currentIds = [...inFlight.values()];
    if (state.activeSpeed?.profileId === profileId) state.activeSpeed = null;
    const dur = Date.now() - started;
    state.avgTestMs = state.avgTestMs == null ? dur : Math.round(state.avgTestMs * 0.7 + dur * 0.3);
    emit();
  }
}

async function worker(mode) {
  while (queue.length && state.status !== 'stopping') {
    await waitIfPaused();
    if (state.status === 'stopping') break;
    const profileId = queue.shift();
    if (!profileId) break;
    await runOne(profileId, mode);
  }
}

export async function startBatch(profileIds, mode) {
  if (state.status !== 'idle' || !profileIds.length) return;
  ensureEventBridge();
  state.status = 'running';
  state.mode = mode;
  state.total = profileIds.length;
  state.done = 0;
  state.failed = 0;
  state.skipped = 0;
  state.avgTestMs = null;
  state.startedAt = Date.now();
  state.batchIds = [...profileIds];
  state.pulse = [];
  state.lastBatch = null;
  queue = [...profileIds];
  for (const id of profileIds) upsert(id, { status: 'queued', error: null });
  log(`تست ${mode === 'ping' ? 'پینگ شبکه' : mode === 'real' ? 'پینگ واقعی' : 'سرعت'} برای ${profileIds.length} سرور شروع شد`, 'info');
  emit();

  const n = Math.min(CONCURRENCY[mode] || 1, profileIds.length);
  await Promise.all(Array.from({ length: n }, () => worker(mode)));

  // Anything still marked queued (cancelled mid-batch) goes back to idle.
  for (const id of profileIds) {
    if (state.results[id]?.status === 'queued') upsert(id, { status: 'idle' });
  }
  const wasStopped = state.status === 'stopping';
  state.status = 'idle';
  state.currentIds = [];
  state.activeSpeed = null;
  state.lastBatch = {
    mode,
    total: state.total,
    ok: state.done - state.failed - state.skipped,
    fail: state.failed,
    skipped: state.skipped,
    durationMs: Date.now() - state.startedAt,
    cancelled: wasStopped,
    finishedAt: Date.now(),
  };
  log(wasStopped ? 'تست لغو شد' : `تست تمام شد — ${state.lastBatch.ok} موفق، ${state.failed} ناموفق${state.skipped ? `، ${state.skipped} ردشده` : ''}`, wasStopped ? 'bad' : 'good');
  persistResults();
  emit();
}

// Skip only the given in-flight test; the batch keeps going.
export function skipOne(profileId) {
  for (const [token, pid] of inFlight) {
    if (pid === profileId) window.soul.testCancel?.(token);
  }
}

export function pause() {
  if (state.status !== 'running') return;
  state.status = 'paused';
  log('تست موقتا متوقف شد — تست‌های در جریان کامل می‌شوند', 'info');
  emit();
}

export function resume() {
  if (state.status !== 'paused') return;
  state.status = 'running';
  const waiters = resumeWaiters;
  resumeWaiters = [];
  waiters.forEach((fn) => fn());
  log('ادامه‌ی تست…', 'info');
  emit();
}

export function cancelAll() {
  if (state.status === 'idle') return;
  state.status = 'stopping';
  queue = [];
  for (const token of inFlight.keys()) window.soul.testCancel?.(token);
  const waiters = resumeWaiters;
  resumeWaiters = [];
  waiters.forEach((fn) => fn());
  emit();
}

export async function testOne(profileId, mode) {
  if (state.status !== 'idle') return;
  await startBatch([profileId], mode);
}

export function etaMs() {
  if (state.status === 'idle' || !state.avgTestMs) return null;
  const remaining = queue.length + inFlight.size;
  const conc = Math.min(CONCURRENCY[state.mode] || 1, Math.max(remaining, 1));
  return Math.round((remaining * state.avgTestMs) / conc);
}

export function clearResults() {
  for (const id of Object.keys(state.results)) {
    if (state.results[id].status === 'testing' || state.results[id].status === 'queued') continue;
    delete state.results[id];
  }
  try { localStorage.removeItem(RESULTS_KEY); } catch { /* ignore */ }
  log('نتایج پاک شد', 'info');
  emit();
}
