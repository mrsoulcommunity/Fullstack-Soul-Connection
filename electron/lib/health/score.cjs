'use strict';
// One scoring function for the whole app: 0–100, higher is better.
//
// "Pick the lowest ping" is the wrong answer often enough to be worth avoiding
// -- a 60ms server that drops 8% of packets is measurably worse to use than a
// 110ms one that drops none, and neither number alone says so. Latency, jitter,
// packet loss, throughput and stability each get a say, and only the metrics
// that were actually measured take part: the weight of anything missing is
// redistributed over the rest, so a cheap TCP-only probe and a full tunnel test
// both produce a meaningful number on the same scale (a TCP-only one is capped
// separately by the caller, since it measured far less).
//
// This mirrors src/utils/score.js on the renderer side. The two are kept
// separate on purpose -- that one serves the Server Finder's user-selectable
// priorities, this one is the single fixed definition of "connection quality"
// that automatic selection and failover both reason about.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Log scale: 40ms -> 200ms matters far more than 800ms -> 1000ms.
function normDown(value, best, worst) {
  if (value == null || !(value >= 0)) return null;
  if (value <= best) return 100;
  if (value >= worst) return 0;
  return 100 * (1 - Math.log(value / best) / Math.log(worst / best));
}

function normUp(value, worst, best) {
  if (value == null || !(value > 0)) return null;
  if (value <= worst) return 0;
  if (value >= best) return 100;
  return 100 * (Math.log(value / worst) / Math.log(best / worst));
}

const NORM = {
  latency: (ms) => normDown(ms, 40, 1200),
  jitter: (ms) => normDown(ms, 5, 300),
  loss: (pct) => (pct == null ? null : clamp(100 - pct * 4, 0, 100)),
  down: (bps) => normUp(bps, 62_500, 12_500_000), // 0.5 – 100 Mbit/s
  stability: (pct) => (pct == null ? null : clamp(pct, 0, 100)),
};

// Loss is weighted as heavily as latency: it is the metric users describe as
// "the connection is broken" while a ping graph still looks fine.
const WEIGHTS = { latency: 0.3, loss: 0.3, jitter: 0.15, down: 0.15, stability: 0.1 };

function qualityScore(metrics = {}) {
  let sum = 0;
  let used = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const norm = NORM[key](metrics[key]);
    if (norm == null) continue;
    sum += norm * weight;
    used += weight;
  }
  if (used < 0.25) return null; // not enough measured to claim anything
  return Math.round(sum / used);
}

// A server known only by a TCP handshake has not proven its tunnel works, so
// its score is held below anything a real tunnel test can produce. Without
// this, a reachable-but-dead server outranks a measured healthy one purely
// because a bare TCP connect looks fast.
const TCP_ONLY_CEILING = 65;

function tcpOnlyScore({ latency, loss }) {
  const s = qualityScore({ latency, loss });
  return s == null ? null : Math.min(TCP_ONLY_CEILING, s);
}

// Aggregates a window of latency samples (-1 meaning "no answer") into the
// metric shape everything else here consumes.
function summarize(samples) {
  const list = Array.isArray(samples) ? samples : [];
  if (!list.length) return { latency: null, jitter: null, loss: null, alive: 0, total: 0 };
  const ok = list.filter((v) => v > 0);
  const loss = Math.round(((list.length - ok.length) / list.length) * 100);
  if (!ok.length) return { latency: null, jitter: null, loss, alive: 0, total: list.length };
  const latency = Math.round(ok.reduce((a, b) => a + b, 0) / ok.length);
  let jitter = 0;
  if (ok.length > 1) {
    let acc = 0;
    for (let i = 1; i < ok.length; i++) acc += Math.abs(ok[i] - ok[i - 1]);
    jitter = Math.round(acc / (ok.length - 1));
  }
  return { latency, jitter, loss, alive: ok.length, total: list.length };
}

function scoreTone(score) {
  if (score == null) return 'na';
  if (score >= 70) return 'good';
  if (score >= 45) return 'mid';
  return 'bad';
}

module.exports = { qualityScore, tcpOnlyScore, summarize, scoreTone, NORM, WEIGHTS, TCP_ONLY_CEILING };
