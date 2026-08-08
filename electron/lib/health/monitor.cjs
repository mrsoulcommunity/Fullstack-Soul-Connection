'use strict';
// Connection health monitoring, in two independent halves:
//
//   active   how the *live* tunnel is behaving right now -- one small HTTP
//            request through the local proxy every few seconds, kept as a
//            rolling window so a single hiccup can't be mistaken for a
//            degraded link.
//   backup   how the alternatives are doing, so that at the moment the primary
//            fails the answer to "where do we go?" already exists instead of
//            costing the user a 15-second sweep.
//
// Both are pure measurement. Nothing here decides anything or touches the
// connection -- that is failover.cjs's job, and keeping the split means the
// thresholds can change without the probing changing, and vice versa.
//
// Everything runs on timers with a single in-flight guard per loop, and every
// probe is a socket or a child process, never CPU work: the UI thread is a
// different process entirely, and the main process is never blocked for longer
// than a JSON parse.
const { EventEmitter } = require('events');
const { qualityScore, tcpOnlyScore, summarize } = require('./score.cjs');

const ACTIVE_WINDOW = 12;      // samples kept for the rolling summary
const BACKUP_TCP_CONCURRENCY = 8;
const TCP_PROBE_SAMPLES = 2;
const TCP_PROBE_TIMEOUT_MS = 1500;
// A tunnel measurement older than this is treated as unknown rather than
// trusted -- network conditions move, and a stale "this one was great" is
// exactly how a failover lands somewhere worse than where it started.
const TUNNEL_FRESH_MS = 10 * 60 * 1000;
const TCP_FRESH_MS = 3 * 60 * 1000;

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out;
}

class HealthMonitor extends EventEmitter {
  // Every probe is injected rather than imported, so this module has no opinion
  // about xray, ports or profiles -- and can be exercised without either.
  //   probeActive()            -> Promise<number>  latency ms, or -1
  //   probeTcp(profile)        -> Promise<{ avg, loss }>
  //   probeTunnel(profile, {signal}) -> Promise<{ avg, jitter, loss, bootMs }>
  constructor({ probeActive, probeTcp, probeTunnel }) {
    super();
    this.probeActive = probeActive;
    this.probeTcp = probeTcp;
    this.probeTunnel = probeTunnel;

    this.samples = [];
    this.consecutiveFails = 0;
    this.activeTimer = null;
    this.activeInFlight = false;
    this.activeSince = 0;

    this.results = new Map(); // profileId -> { tcp, tunnel }
    this.tcpTimer = null;
    this.tunnelTimer = null;
    this.backupInFlight = false;
    this.backupAbort = null;
    this.getCandidates = () => [];
  }

  // ---- active side ----

  startActive({ intervalMs = 8000 } = {}) {
    this.stopActive();
    this.samples = [];
    this.consecutiveFails = 0;
    this.activeSince = Date.now();
    const tick = async () => {
      if (this.activeInFlight) return;
      this.activeInFlight = true;
      try {
        const ms = await this.probeActive();
        this._recordActive(ms);
      } catch {
        this._recordActive(-1);
      } finally {
        this.activeInFlight = false;
      }
    };
    // Deliberately no immediate probe: a tunnel measured in its first second
    // is measuring its own cold start, and that reads as "degraded".
    this.activeTimer = setInterval(tick, intervalMs);
  }

  stopActive() {
    if (this.activeTimer) { clearInterval(this.activeTimer); this.activeTimer = null; }
    this.samples = [];
    this.consecutiveFails = 0;
    this.activeSince = 0;
  }

  _recordActive(ms) {
    this.samples.push(ms);
    if (this.samples.length > ACTIVE_WINDOW) this.samples.shift();
    if (ms > 0) this.consecutiveFails = 0;
    else this.consecutiveFails++;
    this.emit('active', this.activeHealth());
  }

  activeHealth() {
    const s = summarize(this.samples);
    return {
      ...s,
      score: qualityScore({ latency: s.latency, jitter: s.jitter, loss: s.loss }),
      consecutiveFails: this.consecutiveFails,
      samples: this.samples.slice(-ACTIVE_WINDOW),
      uptimeMs: this.activeSince ? Date.now() - this.activeSince : 0,
    };
  }

  // ---- backup side ----

  // getCandidates() must return the profiles worth knowing about right now,
  // already excluding the live one.
  startBackup({ getCandidates, tcpIntervalMs = 30000, tunnelIntervalMs = 180000, tunnelTopN = 3 } = {}) {
    this.stopBackup();
    this.getCandidates = getCandidates || (() => []);
    this.backupAbort = new AbortController();
    this.tunnelTopN = tunnelTopN;

    const tcpTick = () => { this._sweepTcp().catch(() => {}); };
    const tunnelTick = () => { this._sweepTunnel().catch(() => {}); };
    // Staggered: the first TCP sweep gives the tunnel sweep something to rank
    // before it picks who to spend a real xray process on.
    this.tcpTimer = setInterval(tcpTick, tcpIntervalMs);
    this.tunnelTimer = setInterval(tunnelTick, tunnelIntervalMs);
    setTimeout(tcpTick, 3000);
    setTimeout(tunnelTick, 25000);
  }

  stopBackup() {
    if (this.tcpTimer) { clearInterval(this.tcpTimer); this.tcpTimer = null; }
    if (this.tunnelTimer) { clearInterval(this.tunnelTimer); this.tunnelTimer = null; }
    if (this.backupAbort) { this.backupAbort.abort(); this.backupAbort = null; }
    this.backupInFlight = false;
  }

  _entry(id) {
    let e = this.results.get(id);
    if (!e) { e = { tcp: null, tunnel: null }; this.results.set(id, e); }
    return e;
  }

  async _sweepTcp() {
    const candidates = this.getCandidates();
    if (!candidates.length) return;
    const signal = this.backupAbort?.signal;
    await mapPool(candidates, BACKUP_TCP_CONCURRENCY, async (p) => {
      if (signal?.aborted) return;
      try {
        const r = await this.probeTcp(p, { count: TCP_PROBE_SAMPLES, timeoutMs: TCP_PROBE_TIMEOUT_MS, signal });
        this._entry(p.id).tcp = { avg: r.avg, loss: r.loss ?? 0, at: Date.now() };
      } catch {
        this._entry(p.id).tcp = { avg: null, loss: 100, at: Date.now() };
      }
    });
    // Prune servers that are no longer candidates so the map can't grow with
    // every subscription refresh.
    const live = new Set(candidates.map((p) => p.id));
    for (const id of this.results.keys()) if (!live.has(id)) this.results.delete(id);
    this.emit('backup', this.backupSnapshot());
  }

  // The expensive half: a real tunnel, on a handful of servers, rarely. Serial
  // on purpose -- each one spawns an xray process, and the point is to keep a
  // warm answer ready in the background, not to race.
  async _sweepTunnel() {
    if (this.backupInFlight) return;
    const candidates = this.getCandidates();
    if (!candidates.length) return;
    this.backupInFlight = true;
    const signal = this.backupAbort?.signal;
    try {
      const ranked = candidates
        .map((p) => ({ p, s: this._tcpScore(p.id) }))
        .filter((x) => x.s != null)
        .sort((a, b) => b.s - a.s)
        .slice(0, this.tunnelTopN);
      for (const { p } of ranked) {
        if (signal?.aborted) return;
        try {
          const r = await this.probeTunnel(p, { signal });
          this._entry(p.id).tunnel = {
            avg: r.avg, jitter: r.jitter ?? 0, loss: r.loss ?? 0, bootMs: r.bootMs ?? null, at: Date.now(),
          };
        } catch {
          // Reachable over TCP but the tunnel didn't come up: that is exactly
          // the failure this sweep exists to discover before a failover picks it.
          this._entry(p.id).tunnel = { avg: null, jitter: null, loss: 100, bootMs: null, at: Date.now() };
        }
        this.emit('backup', this.backupSnapshot());
      }
    } finally {
      this.backupInFlight = false;
    }
  }

  _tcpScore(id) {
    const e = this.results.get(id);
    if (!e?.tcp || Date.now() - e.tcp.at > TCP_FRESH_MS) return null;
    return tcpOnlyScore({ latency: e.tcp.avg, loss: e.tcp.loss });
  }

  scoreFor(id) {
    const e = this.results.get(id);
    if (!e) return null;
    if (e.tunnel && Date.now() - e.tunnel.at < TUNNEL_FRESH_MS) {
      return {
        score: qualityScore({ latency: e.tunnel.avg, jitter: e.tunnel.jitter, loss: e.tunnel.loss }),
        measured: 'tunnel',
        at: e.tunnel.at,
      };
    }
    const tcp = this._tcpScore(id);
    return tcp == null ? null : { score: tcp, measured: 'tcp', at: e.tcp.at };
  }

  // Best known alternative. `exclude` is a Set of ids that must not be
  // returned (the live server, plus anything the failover engine is currently
  // cooling off).
  best(exclude = new Set()) {
    let winner = null;
    for (const p of this.getCandidates()) {
      if (exclude.has(p.id)) continue;
      const s = this.scoreFor(p.id);
      if (!s || s.score == null) continue;
      if (!winner || s.score > winner.score) winner = { profile: p, ...s };
    }
    return winner;
  }

  backupSnapshot() {
    const out = [];
    for (const p of this.getCandidates()) {
      const s = this.scoreFor(p.id);
      const e = this.results.get(p.id);
      out.push({
        id: p.id,
        name: p.name,
        score: s?.score ?? null,
        measured: s?.measured ?? null,
        latency: e?.tunnel?.avg ?? e?.tcp?.avg ?? null,
        loss: e?.tunnel?.loss ?? e?.tcp?.loss ?? null,
        at: s?.at ?? null,
      });
    }
    return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 8);
  }

  stop() {
    this.stopActive();
    this.stopBackup();
    this.results.clear();
  }
}

module.exports = { HealthMonitor, TUNNEL_FRESH_MS, TCP_FRESH_MS };
