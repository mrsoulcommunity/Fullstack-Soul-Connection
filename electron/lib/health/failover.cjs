'use strict';
// Automatic failover: the decision layer.
//
// It consumes HealthMonitor's rolling view of the live tunnel and answers one
// question -- "should we move, and where to?" -- while being extremely
// reluctant to say yes. Everything in here exists to avoid the failure mode
// that makes automatic switching worse than none at all: a client that
// oscillates between two servers, tearing the connection down every thirty
// seconds because one of them was 4ms better for a moment.
//
// Four independent brakes:
//   1. consecutive checks   one bad sample is a hiccup, not a degraded link.
//   2. a real margin        the alternative must be clearly better, in points
//                           on the same 0–100 quality scale, not merely ahead.
//   3. cooldown             after a switch, nothing is reconsidered for a while.
//   4. a return ban         the server we just left is off the table for the
//                           length of the cooldown, so A→B→A is impossible.
//
// Executing the switch is not this module's job: it emits an intent and the
// caller (main.cjs) performs the reconnect and reports back. That keeps every
// connection state transition in exactly one place.
const { EventEmitter } = require('events');

// badChecks     consecutive degraded health snapshots before acting
// margin        how many quality points better the alternative must be
// cooldownMs    quiet period after a switch, and how long a left server is banned
// probeMs       how often the live tunnel is measured
// loss/latency/jitter: the thresholds that make a snapshot "degraded"
// maxPerHour    hard ceiling; past it, the app stops switching and says so
const FAILOVER_MODES = {
  conservative: {
    key: 'conservative', label: 'محافظه‌کار',
    badChecks: 5, margin: 25, cooldownMs: 10 * 60 * 1000, probeMs: 12000,
    loss: 18, latency: 900, jitter: 260, scoreFloor: 25, maxPerHour: 2,
  },
  balanced: {
    key: 'balanced', label: 'متعادل',
    badChecks: 3, margin: 15, cooldownMs: 5 * 60 * 1000, probeMs: 8000,
    loss: 12, latency: 700, jitter: 190, scoreFloor: 35, maxPerHour: 4,
  },
  fast: {
    key: 'fast', label: 'سریع',
    badChecks: 2, margin: 8, cooldownMs: 2 * 60 * 1000, probeMs: 5000,
    loss: 8, latency: 500, jitter: 140, scoreFloor: 45, maxPerHour: 6,
  },
};

const DEFAULT_MODE = 'balanced';

function modeConfig(key) {
  return FAILOVER_MODES[key] || FAILOVER_MODES[DEFAULT_MODE];
}

// Reason codes are stable identifiers; the Persian text is what the UI shows.
const REASONS = {
  lost: 'قطع شدن ارتباط با سرور',
  loss: 'پکت‌لاس بالا',
  latency: 'پینگ بیش از حد بالا',
  jitter: 'جیتر بالا',
  quality: 'افت کیفیت کلی اتصال',
};

// A dead tunnel scores nothing, so "better by N points" would be trivially
// satisfied by anything -- this is the absolute floor a replacement must clear
// before it is worth interrupting the user for.
const MIN_REPLACEMENT_SCORE = 30;

function judge(health, cfg) {
  if (!health) return null;
  // The most recent probe got no answer at all. On its own that is nothing --
  // the caller only acts after `badChecks` consecutive degraded snapshots.
  if (health.consecutiveFails > 0) return 'lost';
  if (health.loss != null && health.loss >= cfg.loss) return 'loss';
  if (health.latency != null && health.latency >= cfg.latency) return 'latency';
  if (health.jitter != null && health.jitter >= cfg.jitter) return 'jitter';
  if (health.score != null && health.total >= 3 && health.score < cfg.scoreFloor) return 'quality';
  return null;
}

class FailoverController extends EventEmitter {
  // getConfig() -> { enabled, mode }
  // getCurrentId() -> id of the live profile, or null
  constructor({ monitor, getConfig, getCurrentId }) {
    super();
    this.monitor = monitor;
    this.getConfig = getConfig;
    this.getCurrentId = getCurrentId;
    this.badStreak = 0;
    this.lastReason = null;
    this.cooldownUntil = 0;
    this.banned = new Map(); // profileId -> banned-until timestamp
    this.switchTimes = [];
    this.switching = false;
    this.lastEvent = null;
    this._onActive = (health) => this._evaluate(health);
    monitor.on('active', this._onActive);
  }

  detach() {
    this.monitor.off('active', this._onActive);
  }

  reset() {
    this.badStreak = 0;
    this.lastReason = null;
    this.switching = false;
  }

  // Called when a session ends for any reason, so a new session starts from a
  // clean slate but keeps the anti-flapping history (bans, rate limit).
  resetSession() {
    this.reset();
  }

  mode() {
    return modeConfig(this.getConfig()?.mode);
  }

  _rateLimited(cfg) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.switchTimes = this.switchTimes.filter((t) => t > cutoff);
    return this.switchTimes.length >= cfg.maxPerHour;
  }

  _excluded() {
    const now = Date.now();
    const out = new Set();
    const current = this.getCurrentId();
    if (current) out.add(current);
    for (const [id, until] of this.banned) {
      if (until > now) out.add(id);
      else this.banned.delete(id);
    }
    return out;
  }

  _evaluate(health) {
    const cfg = this.mode();
    const conf = this.getConfig() || {};
    if (!conf.enabled || this.switching) return;

    const reason = judge(health, cfg);
    if (!reason) {
      this.badStreak = 0;
      this.lastReason = null;
      return;
    }
    this.badStreak++;
    this.lastReason = reason;
    this.emit('degrading', { reason, reasonText: REASONS[reason], streak: this.badStreak, need: cfg.badChecks, health });
    if (this.badStreak < cfg.badChecks) return;
    if (Date.now() < this.cooldownUntil) return;

    if (this._rateLimited(cfg)) {
      this.emit('blocked', { reason: 'rate-limit', text: 'تعویض خودکار سرور موقتاً متوقف شد (تعداد تعویض‌ها در یک ساعت اخیر زیاد بوده است)' });
      this.cooldownUntil = Date.now() + cfg.cooldownMs;
      this.badStreak = 0;
      return;
    }

    const candidate = this.monitor.best(this._excluded());
    if (!candidate || candidate.score == null) {
      this.emit('blocked', { reason: 'no-candidate', text: 'کیفیت اتصال افت کرده، اما سرور جایگزین سالمی پیدا نشد' });
      // Don't retry on the very next sample: with no alternative, hammering
      // this path just spams the UI. Wait out a short cooldown first.
      this.cooldownUntil = Date.now() + Math.min(cfg.cooldownMs, 60000);
      this.badStreak = 0;
      return;
    }

    const currentScore = reason === 'lost' ? 0 : (health.score ?? 0);
    const gain = candidate.score - currentScore;
    const dead = reason === 'lost';
    // A live-but-degraded link only gets replaced by something clearly better.
    // A dead one is replaced by anything that clears the floor -- "no internet"
    // has no margin to protect.
    const worthIt = dead
      ? candidate.score >= MIN_REPLACEMENT_SCORE
      : gain >= cfg.margin && candidate.score >= MIN_REPLACEMENT_SCORE;

    if (!worthIt) {
      this.emit('blocked', {
        reason: 'not-better',
        text: 'سرور جایگزین به‌اندازه‌ی کافی بهتر نیست، پس روی سرور فعلی می‌مانیم',
        candidate: candidate.profile?.name, gain: Math.round(gain),
      });
      this.cooldownUntil = Date.now() + Math.min(cfg.cooldownMs, 90000);
      this.badStreak = 0;
      return;
    }

    this.switching = true;
    this.emit('switch', {
      reason,
      reasonText: REASONS[reason],
      candidate: candidate.profile,
      candidateScore: candidate.score,
      currentScore,
      measured: candidate.measured,
      health,
    });
  }

  // Reported back by the caller once the reconnect has actually happened (or
  // failed). This is what starts the cooldown -- not the decision itself, so a
  // failed attempt doesn't buy the old server a free quiet period.
  noteSwitchResult({ ok, fromProfile, toProfile, reason, message }) {
    const cfg = this.mode();
    this.switching = false;
    this.badStreak = 0;
    if (ok) {
      this.switchTimes.push(Date.now());
      this.cooldownUntil = Date.now() + cfg.cooldownMs;
      if (fromProfile?.id) this.banned.set(fromProfile.id, Date.now() + cfg.cooldownMs);
    } else {
      // Failed attempt: back off briefly so we don't loop on a bad candidate,
      // and keep the candidate out of the running for that time.
      this.cooldownUntil = Date.now() + 60000;
      if (toProfile?.id) this.banned.set(toProfile.id, Date.now() + 5 * 60 * 1000);
    }
    this.lastEvent = {
      at: Date.now(),
      ok: !!ok,
      reason,
      reasonText: REASONS[reason] || reason || null,
      from: fromProfile ? { id: fromProfile.id, name: fromProfile.name } : null,
      to: toProfile ? { id: toProfile.id, name: toProfile.name } : null,
      message: message || null,
    };
    this.emit('result', this.lastEvent);
    return this.lastEvent;
  }

  snapshot() {
    const cfg = this.mode();
    return {
      mode: cfg.key,
      badStreak: this.badStreak,
      need: cfg.badChecks,
      reason: this.lastReason,
      reasonText: this.lastReason ? REASONS[this.lastReason] : null,
      cooldownUntil: this.cooldownUntil,
      lastEvent: this.lastEvent,
      switchesLastHour: this.switchTimes.filter((t) => t > Date.now() - 3600000).length,
    };
  }
}

module.exports = { FailoverController, FAILOVER_MODES, DEFAULT_MODE, REASONS, modeConfig };
