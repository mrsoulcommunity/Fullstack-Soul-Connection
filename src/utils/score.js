// Health scoring + recommendation profiles for the Server Finder.
// Every metric is normalized to 0–100, then blended with the weights of the
// user's selected priority. Only metrics that were actually measured take
// part — the weight mass of missing metrics is redistributed.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Log-scale normalizers: the difference between 40ms and 200ms matters far
// more than between 800ms and 1000ms.
function normLog(value, best, worst) {
  if (value == null || !(value >= 0)) return null;
  if (value <= best) return 100;
  if (value >= worst) return 0;
  return Math.round(100 * (1 - Math.log(value / best) / Math.log(worst / best)));
}

// Increasing variant for throughput: 0 at/below `worst`, 100 at/above `best`.
function normLogUp(value, worst, best) {
  if (value == null || !(value > 0)) return null;
  if (value <= worst) return 0;
  if (value >= best) return 100;
  return Math.round(100 * (Math.log(value / worst) / Math.log(best / worst)));
}

// Speeds are bytes/second everywhere in this app.
export const normalizers = {
  latency: (ms) => normLog(ms, 40, 1200),
  jitter: (ms) => normLog(ms, 5, 300),
  first: (ms) => normLog(ms, 250, 8000),
  boot: (ms) => normLog(ms, 600, 8000),
  loss: (pct) => (pct == null ? null : Math.round(clamp(100 - pct * 2.5, 0, 100))),
  down: (bps) => normLogUp(bps, 62_500, 12_500_000), // 0.5 → 100 Mbit/s
  up: (bps) => normLogUp(bps, 31_250, 6_250_000), // 0.25 → 50 Mbit/s
  stability: (pct) => (pct == null ? null : Math.round(clamp(pct, 0, 100))),
};

export const PRIORITIES = [
  { key: 'balanced', label: 'متعادل', icon: 'sliders', weights: { latency: 0.25, down: 0.25, stability: 0.15, loss: 0.15, jitter: 0.1, up: 0.1 } },
  { key: 'latency', label: 'کمترین تاخیر', icon: 'bolt', weights: { latency: 0.6, jitter: 0.25, loss: 0.15 } },
  { key: 'speed', label: 'بیشترین سرعت', icon: 'gauge', weights: { down: 0.55, up: 0.2, latency: 0.15, stability: 0.1 } },
  { key: 'gaming', label: 'گیمینگ', icon: 'target', weights: { latency: 0.35, jitter: 0.3, loss: 0.25, stability: 0.1 } },
  { key: 'streaming', label: 'استریم', icon: 'play', weights: { down: 0.45, stability: 0.25, latency: 0.15, loss: 0.15 } },
  { key: 'browsing', label: 'وب‌گردی', icon: 'globe', weights: { latency: 0.35, first: 0.3, down: 0.2, loss: 0.15 } },
  { key: 'stable', label: 'پایداری', icon: 'shield', weights: { stability: 0.35, loss: 0.3, jitter: 0.2, latency: 0.15 } },
];

export function priorityByKey(key) {
  return PRIORITIES.find((p) => p.key === key) || PRIORITIES[0];
}

// Collapses the three test modes into one metric set. Real-tunnel numbers win
// over raw network numbers when both exist.
export function extractMetrics(r) {
  if (!r) return {};
  const ping = r.ping || null;
  const real = r.real || null;
  const speed = r.speed || null;
  const worstLoss = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
  return {
    latency: real?.avg ?? speed?.rttAvg ?? ping?.avg ?? null,
    jitter: real?.jitter ?? speed?.rttJitter ?? ping?.jitter ?? null,
    loss: worstLoss(real?.loss, ping?.loss),
    first: real?.firstMs ?? null,
    boot: real?.bootMs ?? speed?.bootMs ?? null,
    down: speed?.downBps ?? null,
    up: speed?.upBps ?? null,
    stability: speed?.stability ?? null,
  };
}

export function healthScore(result, priorityKey = 'balanced') {
  const metrics = extractMetrics(result);
  const { weights } = priorityByKey(priorityKey);
  let sum = 0;
  let weightUsed = 0;
  for (const [metric, weight] of Object.entries(weights)) {
    const norm = normalizers[metric](metrics[metric]);
    if (norm == null) continue;
    sum += norm * weight;
    weightUsed += weight;
  }
  if (weightUsed < 0.3) return null; // too little data to claim a score
  return Math.round(sum / weightUsed);
}

export function scoreTone(score) {
  if (score == null) return 'na';
  if (score >= 75) return 'good';
  if (score >= 45) return 'mid';
  return 'bad';
}

const mbps = (bps) => (bps == null ? null : (bps * 8) / 1e6);

// Human quality estimates shown on speed-tested cards.
export function qualityEstimates(result) {
  const m = extractMetrics(result);
  const down = mbps(m.down);
  const out = [];
  if (down != null) {
    const label = down >= 25 ? '4K' : down >= 8 ? 'Full HD' : down >= 3 ? 'HD' : down >= 1 ? 'SD' : 'ضعیف';
    out.push({ key: 'streaming', title: 'استریم', label, tone: down >= 8 ? 'good' : down >= 1 ? 'mid' : 'bad' });
  }
  if (m.latency != null) {
    const great = m.latency < 90 && (m.jitter ?? 0) < 25 && (m.loss ?? 0) < 2;
    const good = m.latency < 170 && (m.jitter ?? 0) < 50 && (m.loss ?? 0) < 5;
    const okay = m.latency < 280;
    const label = great ? 'عالی' : good ? 'خوب' : okay ? 'قابل قبول' : 'ضعیف';
    out.push({ key: 'gaming', title: 'گیمینگ', label, tone: great || good ? 'good' : okay ? 'mid' : 'bad' });
  }
  if (m.latency != null || down != null) {
    const fast = (m.first == null || m.first < 900) && (m.latency ?? 999) < 200 && (down == null || down > 2);
    const okay = (m.latency ?? 999) < 400;
    const label = fast ? 'روان' : okay ? 'معمولی' : 'کند';
    out.push({ key: 'browsing', title: 'وب‌گردی', label, tone: fast ? 'good' : okay ? 'mid' : 'bad' });
  }
  return out;
}

// Picks the winner for the recommendation banner. Requires an actual score
// and penalizes servers whose tests failed outright.
export function recommend(profiles, results, priorityKey) {
  let best = null;
  for (const p of profiles) {
    const r = results[p.id];
    if (!r || r.status !== 'ok') continue;
    const score = healthScore(r, priorityKey);
    if (score == null) continue;
    if (!best || score > best.score) best = { profile: p, score };
  }
  return best;
}
