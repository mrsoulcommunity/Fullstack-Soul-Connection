'use strict';
// The "Soul Connection servers" pool: a curated server list the app manages
// itself, kept deliberately separate from the user's own profiles.
//
// It is not a subscription. The user never adds, edits, renames, favourites or
// deletes these -- so mixing them into store's `profiles` would mean guarding
// every mutation path against them. They live under their own store key
// instead, and only findProfile() in main.cjs unions the two.
//
// Picking a server is a two-stage funnel, because the two things worth
// measuring cost wildly different amounts:
//
//   Stage 1  TCP handshake to every server, wide fan-out. Cheap (one socket,
//            no xray), so it can afford to touch all of them. Answers "is this
//            host alive and how far away is it" -- and nothing else.
//   Stage 2  A real tunnel through the few best survivors: boot xray, send
//            actual requests through it, measure what the user would feel.
//            Expensive (a process + ports each), so it runs on a handful.
//
// Reversing that -- real-tunnelling everything -- would take minutes on a
// 30-server list. Doing only stage 1 would happily pick a server that answers
// TCP on :443 but whose tunnel is dead or throttled, which is the common
// failure mode for a public pool.
const { fetchText } = require('./fetchText.cjs');
const { parseMany } = require('./parsers.cjs');
const { tcpPingStats, realPing } = require('./serverTest.cjs');

const SOUL_SUB_URL =
  'https://raw.githubusercontent.com/mrsoulcommunity/SoulConnection/refs/heads/main/soul%20server.txt';

// Tuning. These are the numbers that decide "fast" vs "thorough"; they are
// gathered here rather than sprinkled through the code so the trade-off is
// adjustable in one place.
const LIST_TTL_MS = 30 * 60 * 1000;   // re-fetch the list at most twice an hour
// Measured against the real list from a censored network: the raw.github
// fetch took ~12s. Anything near that as a timeout turns a slow-but-working
// network into a hard failure, so leave real headroom -- the TTL cache and
// the warm-up at startup are what keep this off the connect path anyway.
const FETCH_TIMEOUT_MS = 25000;
const PROBE_CONCURRENCY = 16;         // stage 1 sockets in flight
const PROBE_SAMPLES = 2;
const PROBE_TIMEOUT_MS = 1500;
const PROBE_GAP_MS = 60;
const FINALIST_COUNT = 4;             // how many get a real tunnel
// Equal to FINALIST_COUNT so a batch is one round rather than two: measured
// against the real list, halving the rounds took selection from ~15s to ~8s.
// Safe for ranking fidelity because realPing sends small HTTP probes, not bulk
// transfer -- four of them don't contend for bandwidth the way a speed test
// would, so the numbers stay comparable between candidates.
const TUNNEL_CONCURRENCY = 4;         // xray processes in flight
const TUNNEL_SAMPLES = 3;
// How long a previous winner stays eligible for the verify-only fast path.
// Short enough that the pool's ranking still reflects current conditions,
// long enough to cover a reconnect after a drop or a quick toggle.
const WINNER_REUSE_MS = 10 * 60 * 1000;
const VERIFY_SAMPLES = 1;
const VERIFY_BUDGET_MS = 8000;

class AbortedError extends Error {
  constructor() {
    super('انتخاب سرور لغو شد');
    this.code = 'ABORTED';
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new AbortedError();
}

// Bounded-concurrency map. Workers pull from a shared cursor rather than
// pre-slicing into chunks, so one slow server can't idle a lane while others
// are still queued.
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// Lower is better. Latency dominates, but a server that drops packets or
// jitters badly is worse to actually use than its average suggests -- and a
// slow tunnel boot is time the user spends staring at a spinner on every
// single connect, so it earns a small say too.
function scoreCandidate(r) {
  return r.avg + (r.jitter || 0) * 0.5 + (r.loss || 0) * 30 + (r.bootMs || 0) * 0.15;
}

// The real list carries several entries per host (the CDN block alone repeats
// one address three times). Ranked purely by latency they cluster together and
// fill the finalist batch with what is effectively the same server -- so if it
// happens to be down, the expensive stage-2 round is wasted on three copies of
// the same failure. Reordering so each host's best entry comes first spreads
// the first batch over distinct hosts without dropping anything: the extra
// entries simply fall to the back as later fallbacks.
function diversifyByHost(ranked) {
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const item of ranked) {
    const host = item.profile.address;
    if (seen.has(host)) rest.push(item);
    else { seen.add(host); first.push(item); }
  }
  return first.concat(rest);
}

class SoulPool {
  constructor({ store, xrayBin, workRoot }) {
    this.store = store;
    this.xrayBin = xrayBin;
    this.workRoot = workRoot;
  }

  list() {
    return this.store.get('soulProfiles', []);
  }

  find(id) {
    return this.list().find((p) => p.id === id);
  }

  // Re-fetching on every connect would put a GitHub round-trip in front of a
  // button the user expects to feel instant, and the list changes rarely.
  // `force` is what the manual refresh button uses.
  async refresh({ force = false } = {}) {
    const fetchedAt = this.store.get('soulProfilesFetchedAt', 0);
    const cached = this.list();
    if (!force && cached.length && Date.now() - fetchedAt < LIST_TTL_MS) return cached;

    let parsed;
    try {
      const { text } = await fetchText(SOUL_SUB_URL, FETCH_TIMEOUT_MS);
      parsed = parseMany(text);
    } catch (err) {
      // Offline, or GitHub unreachable. A stale list still connects; an empty
      // one doesn't -- so only surface the error when there's nothing to fall
      // back to.
      if (cached.length) return cached;
      throw new Error(`دریافت فهرست سرورهای سول کانکشن ناموفق بود: ${err.message}`);
    }
    if (!parsed.length) {
      if (cached.length) return cached;
      throw new Error('فهرست سرورهای سول کانکشن خالی است');
    }

    // parseMany mints fresh ids on every parse. Carrying the previous id over
    // for an unchanged link keeps `activeProfileId` pointing at a live server
    // across a refresh, exactly as subscription refresh does for user configs.
    const previousByLink = new Map(cached.map((p) => [p.link, p]));
    const next = parsed.map((fresh) => {
      const prev = previousByLink.get(fresh.link);
      return {
        ...fresh,
        id: prev ? prev.id : fresh.id,
        soul: true, // marks these as pool-owned everywhere downstream
      };
    });

    this.store.set('soulProfiles', next);
    this.store.set('soulProfilesFetchedAt', Date.now());
    return next;
  }

  // Stage 1: who is even alive, and how far away?
  async _probeAll(profiles, { signal, emit }) {
    let done = 0;
    const probes = await mapPool(profiles, PROBE_CONCURRENCY, async (p) => {
      throwIfAborted(signal);
      try {
        const r = await tcpPingStats(p.address, p.port, {
          count: PROBE_SAMPLES,
          timeoutMs: PROBE_TIMEOUT_MS,
          gapMs: PROBE_GAP_MS,
          signal,
        });
        // avg is null when every sample timed out.
        return r.avg == null ? null : { profile: p, avg: r.avg, loss: r.loss };
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        return null;
      } finally {
        done += 1;
        emit({ phase: 'probing', done, total: profiles.length });
      }
    });
    const ranked = probes
      .filter(Boolean)
      .sort((a, b) => (a.loss - b.loss) || (a.avg - b.avg));
    return diversifyByHost(ranked);
  }

  // Stage 2: what does traffic through it actually feel like?
  async _tunnelTest(finalists, { signal, emit, samples = TUNNEL_SAMPLES }) {
    let done = 0;
    const results = await mapPool(finalists, TUNNEL_CONCURRENCY, async ({ profile }) => {
      throwIfAborted(signal);
      try {
        const r = await realPing(profile, {
          xrayBin: this.xrayBin,
          workRoot: this.workRoot,
          signal,
          warmCount: samples,
        });
        return { profile, ...r, score: scoreCandidate(r) };
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        // A server that fails here is genuinely unusable (tunnel wouldn't
        // come up, or no traffic passed) -- drop it and let the next finalist
        // take its place.
        return null;
      } finally {
        done += 1;
        emit({ phase: 'testing', done, total: finalists.length });
      }
    });
    return results.filter(Boolean).sort((a, b) => a.score - b.score);
  }

  // Fast path for the common case: reconnecting soon after a successful
  // selection. A full sweep costs ~15-25s on a censored link (measured),
  // nearly all of it stage 2, and the answer rarely changes within minutes --
  // so re-verify the previous winner with one real tunnel test instead. It is
  // a genuine test, not a blind reuse: a server that has since died fails
  // here and the full sweep takes over.
  //
  // Runs CONCURRENTLY with stage 1 rather than before it. Measured the naive
  // way round: when the verify fails, its cost lands on top of the full sweep
  // and the worst case gets worse than having no fast path at all. Overlapping
  // it with the cheap TCP stage means a miss costs almost nothing -- stage 1
  // has already finished by then -- while a hit still skips stage 2 entirely.
  async _verifyLastWinner({ signal, emit }) {
    const last = this.store.get('soulLastWinner', null);
    if (!last || Date.now() - last.at > WINNER_REUSE_MS) return null;
    const profile = this.find(last.id);
    if (!profile) return null;

    // Fewer samples than a ranking test needs: this one only has to answer
    // "is it still healthy", not "is it better than these three others".
    const [checked] = await this._tunnelTest([{ profile }], {
      signal, emit: () => {}, samples: VERIFY_SAMPLES,
    });
    if (!checked) return null;
    return {
      profile: checked.profile,
      metrics: {
        avg: Math.round(checked.avg),
        jitter: Math.round(checked.jitter || 0),
        loss: checked.loss || 0,
        tested: 1,
        alive: 1,
        total: this.list().length,
        reused: true,
      },
    };
  }

  _rememberWinner(profile) {
    this.store.set('soulLastWinner', { id: profile.id, at: Date.now() });
  }

  // Returns the winning profile, or throws. `emit` reports progress for the UI.
  async selectBest({ signal, emit = () => {} } = {}) {
    emit({ phase: 'fetching' });
    const profiles = await this.refresh();
    throwIfAborted(signal);
    if (!profiles.length) throw new Error('هیچ سروری در فهرست سول کانکشن نیست');

    // Both start now; the verify is the only one whose result can short-circuit.
    // It also gets a hard budget: an unhealthy server can sit in realPing's
    // 15s cold-probe timeout, and without a cap a miss would stall the sweep
    // for longer than the sweep itself takes. Its own controller (chained to
    // the caller's) tears the test tunnel down on expiry instead of leaving an
    // orphan xray running alongside stage 2.
    const verifyCtl = new AbortController();
    const onParentAbort = () => verifyCtl.abort();
    if (signal) signal.addEventListener('abort', onParentAbort);
    const verifyTimer = setTimeout(() => verifyCtl.abort(), VERIFY_BUDGET_MS);
    const verifying = this._verifyLastWinner({ signal: verifyCtl.signal, emit })
      .catch(() => null)
      .finally(() => {
        clearTimeout(verifyTimer);
        if (signal) signal.removeEventListener('abort', onParentAbort);
      });

    const probing = this._probeAll(profiles, { signal, emit });
    // Neither may reject unobserved while we await the other.
    const probingSettled = probing.catch((err) => err);

    const reused = await verifying;
    if (reused) {
      throwIfAborted(signal);
      this._rememberWinner(reused.profile);
      // Stage 1 is still in flight and its result is now moot; it holds only
      // TCP sockets that resolve on their own, so let it finish unobserved.
      probingSettled.catch(() => {});
      return reused;
    }

    const alive = await probing;
    throwIfAborted(signal);
    if (!alive.length) {
      throw new Error('هیچ‌کدام از سرورهای سول کانکشن پاسخ ندادند. اتصال اینترنت خود را بررسی کنید.');
    }

    // Walk the ranked survivors in batches: the top finalists usually settle
    // it, but if every one of them fails to tunnel we keep going rather than
    // give up while dozens of untried servers are still on the list.
    for (let offset = 0; offset < alive.length; offset += FINALIST_COUNT) {
      throwIfAborted(signal);
      const batch = alive.slice(offset, offset + FINALIST_COUNT);
      const ranked = await this._tunnelTest(batch, { signal, emit });
      if (ranked.length) {
        const winner = ranked[0];
        this._rememberWinner(winner.profile);
        return {
          profile: winner.profile,
          metrics: {
            avg: Math.round(winner.avg),
            jitter: Math.round(winner.jitter || 0),
            loss: winner.loss || 0,
            tested: offset + batch.length,
            alive: alive.length,
            total: profiles.length,
          },
        };
      }
    }

    // Last resort: connect to the best server that answered a real ping.
    //
    // Stage 2 is a *ranking* tool, and treating it as a gate means a single
    // bad moment -- a slow link, an antivirus stalling xray's boot, four
    // finalists that all happen to be busy -- ends with the user connected to
    // nothing at all, even though servers are demonstrably reachable. A live
    // connection through a merely-reachable server beats a refusal, and if it
    // turns out to be dead the drop handler re-selects anyway.
    const best = alive[0];
    this._rememberWinner(best.profile);
    return {
      profile: best.profile,
      metrics: {
        avg: Math.round(best.avg),
        jitter: 0,
        loss: best.loss || 0,
        tested: alive.length,
        alive: alive.length,
        total: profiles.length,
        // Tells the UI this one was picked on reachability alone, so it can
        // say so rather than implying a quality measurement it never made.
        pingOnly: true,
      },
    };
  }
}

module.exports = { SoulPool, SOUL_SUB_URL };
