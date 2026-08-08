'use strict';
// Owns everything about "is Windows routing through our tunnel right now".
//
// THE BUG THIS REPLACES
// ---------------------
// System proxy used to be tracked as a single stored boolean that the app set
// whenever it *believed* it had changed something. The actual state lives in
// the Windows registry, and nothing ever compared the two. Any divergence --
// a failed registry write swallowed by a `catch {}`, the drop handler clearing
// the flag without telling the renderer, the user changing it in Internet
// Options, another VPN client, a crash -- became permanent and invisible.
//
// THE MODEL
// ---------
// Two separate facts, never conflated:
//
//   desired  persisted user intent: "route my system through the tunnel".
//            Survives disconnect and restart. Only the user changes it.
//   actual   what the registry says right now. Re-read, never assumed.
//
// `reconcile()` is the ONLY thing that writes the registry. It compares
// (desired AND a tunnel to point at) against `actual` and converges them, then
// publishes the result. Everything else -- connect, disconnect, drops, failover
// switches, the IPC toggle, settings edits, the drift timer -- just calls
// reconcile() with a reason and lets it work out what that implies.
//
// Because intent is separate from application, a disconnect no longer silently
// destroys the user's choice: the proxy is withdrawn from Windows (leaving it
// pointed at a dead port would kill their internet) while `desired` stays true,
// so the next connect puts it straight back.

const systemProxy = require('./systemProxy.cjs');

const DRIFT_POLL_MS = 6000;

class SystemProxyController {
  /**
   * @param {object} deps
   * @param {object} deps.store            JsonStore, for persisted intent + saved config
   * @param {function} deps.getSettings    () => settings (host/port/bypass)
   * @param {function} deps.getTunnel      () => { connected, host, port } | null
   * @param {function} deps.onChange       (status) => void, called on every status change
   * @param {function} [deps.notify]       (title, body) => void, user-visible warnings
   */
  constructor({ store, getSettings, getTunnel, onChange, notify = () => {} }) {
    this.store = store;
    this.getSettings = getSettings;
    this.getTunnel = getTunnel;
    this.onChange = onChange;
    this.notify = notify;

    this.actual = null;        // last read() result
    this.lastError = null;     // why the last converge attempt failed, if it did
    this.checkedAt = null;
    this.busy = false;
    this.queued = null;        // coalesces reconciles requested while one is running
    this.settled = Promise.resolve(); // resolves when all scheduled work has drained
    this.timer = null;
    this._lastPublished = null;
  }

  // ---- intent ----

  get desired() {
    return !!this.store.get('systemProxyDesired', false);
  }

  set desired(v) {
    this.store.set('systemProxyDesired', !!v);
  }

  // ---- status published to the renderer ----
  //
  // `active` is derived from the registry, never from intent, so the UI cannot
  // show "on" unless Windows genuinely is. `pending` marks the honest middle
  // state: the user wants it but there is no tunnel to point at yet.
  status() {
    const a = this.actual;
    const tunnel = this.getTunnel();
    const active = !!(a && a.enabled && this.isOurs(a));
    return {
      desired: this.desired,
      active,
      pending: this.desired && !active,
      host: a ? a.host : null,
      port: a ? a.port : null,
      server: a ? a.server : '',
      pac: a ? a.pac : null,
      // A proxy that is on but isn't ours: someone else's config, which we
      // report and leave strictly alone.
      foreign: !!(a && a.enabled && !this.isOurs(a)),
      readable: a ? a.readable !== false : true,
      tunnelUp: !!(tunnel && tunnel.connected),
      lastError: this.lastError,
      checkedAt: this.checkedAt,
    };
  }

  // Is the currently-configured proxy one of ours? Loopback plus a port we
  // either use right now or are configured to use. Anything else belongs to
  // the user or another tool and is never touched.
  isOurs(state) {
    if (!state || !state.port || !systemProxy.isLoopback(state.host)) return false;
    const s = this.getSettings();
    const tunnel = this.getTunnel();
    const ports = new Set([s.socksPort, s.httpPort]);
    if (tunnel && tunnel.port) ports.add(tunnel.port);
    for (const p of this.store.get('systemProxyKnownPorts', [])) ports.add(p);
    return ports.has(state.port);
  }

  _rememberPort(port) {
    // Ports drift when one is busy at connect time (findFreePort bumps them).
    // Remembering the ones we have actually written lets a later cleanup still
    // recognise its own leftovers -- including after a restart.
    const known = new Set(this.store.get('systemProxyKnownPorts', []));
    if (known.has(port)) return;
    known.add(port);
    this.store.set('systemProxyKnownPorts', [...known].slice(-8));
  }

  // Publishes only when something a consumer could act on has actually moved.
  // `checkedAt` is deliberately excluded from the comparison: it changes on
  // every drift tick, and including it meant a steady state still pushed an IPC
  // message and rebuilt the tray menu every few seconds forever.
  _publish() {
    const next = this.status();
    const { checkedAt, ...meaningful } = next;
    const key = JSON.stringify(meaningful);
    if (key === this._lastPublished) return;
    this._lastPublished = key;
    this.onChange(next);
  }

  // ---- the single converge path ----

  /**
   * Bring Windows in line with intent, then publish. Safe to call from
   * anywhere, at any time, as often as you like.
   * @param {object} opts
   * @param {string} opts.reason      for logs -- 'connect', 'disconnect', 'toggle', 'drift', ...
   * @param {boolean} [opts.force]    re-apply even if the registry already looks right
   */
  reconcile({ reason = 'unknown', force = false } = {}) {
    // Only one converge at a time; a request that arrives mid-flight is
    // remembered and run once at the end rather than racing the registry.
    //
    // Latecomers still wait for the drain before being answered. Returning
    // status() immediately would hand them a snapshot from before the converge
    // they asked for -- and these values are what the IPC handlers send
    // straight to the renderer, which is exactly the class of "UI shows the
    // wrong thing" bug this whole class exists to remove.
    if (this.busy) {
      this.queued = { reason, force: force || (this.queued && this.queued.force) };
      return this.settled.then(() => this.status());
    }
    this.settled = this._drain({ reason, force });
    return this.settled.then(() => this.status());
  }

  async _drain({ reason, force }) {
    this.busy = true;
    try {
      await this._reconcileOnce({ reason, force });
    } finally {
      this.busy = false;
    }
    // No await between clearing `busy` and re-entering, so a caller can never
    // slip in and start a second converge alongside the queued one.
    if (this.queued) {
      const next = this.queued;
      this.queued = null;
      await this._drain(next);
      return;
    }
    this._syncTimer();
  }

  async _reconcileOnce({ reason, force }) {
    this.actual = await systemProxy.read();
    this.checkedAt = Date.now();

    if (!this.actual.readable) {
      this.lastError = 'خواندن تنظیمات پروکسی ویندوز ممکن نشد';
      this._publish();
      return;
    }

    const tunnel = this.getTunnel();
    const shouldApply = this.desired && !!(tunnel && tunnel.connected && tunnel.port);

    if (shouldApply) {
      await this._converge(tunnel, { force, reason });
    } else {
      await this._withdraw({ reason });
    }
    this._publish();
  }

  async _converge(tunnel, { force, reason }) {
    const settings = this.getSettings();
    const bypass = systemProxy.buildBypass(settings.customBypass);

    // Already correct, and the bypass list hasn't drifted either.
    if (!force && systemProxy.pointsAt(this.actual, tunnel.host, tunnel.port)
        && this.actual.bypass === bypass) {
      this.lastError = null;
      return;
    }

    // First time we take over a config that isn't ours, keep the user's own
    // settings so they can be put back on the way out. Ours (or nothing) is
    // not worth preserving.
    if (this.actual.enabled && !this.isOurs(this.actual) && !this.store.get('systemProxySaved', null)) {
      this.store.set('systemProxySaved', {
        enabled: this.actual.enabled,
        server: this.actual.server,
        bypass: this.actual.bypass,
        pac: this.actual.pac,
      });
    }

    try {
      this.actual = await systemProxy.apply(tunnel.host, tunnel.port, bypass);
      this._rememberPort(tunnel.port);
      this.lastError = null;
    } catch (err) {
      // The write failed or Windows didn't take it. Report it instead of
      // leaving the UI claiming a proxy that isn't there.
      this.lastError = err.message;
      this.actual = await systemProxy.read().catch(() => this.actual);
      if (reason !== 'drift') {
        this.notify('پروکسی سیستم اعمال نشد', err.message);
      }
    }
  }

  async _withdraw({ reason }) {
    // Nothing enabled, or enabled but not ours -> leave the machine alone.
    if (!this.actual.enabled || !this.isOurs(this.actual)) {
      this.lastError = null;
      // A foreign proxy means the user's own config is live again; any
      // snapshot we were holding is stale.
      if (this.actual.enabled) this.store.set('systemProxySaved', null);
      return;
    }

    const saved = this.store.get('systemProxySaved', null);
    try {
      this.actual = await systemProxy.clear({ restore: saved });
      this.store.set('systemProxySaved', null);
      this.lastError = null;
      if (reason === 'startup') {
        this.notify(
          'پروکسی سیستم پاک شد',
          'پروکسی سیستم روی پورت خاموش برنامه مانده بود و اینترنت را قطع می‌کرد. برطرف شد.'
        );
      }
    } catch (err) {
      this.lastError = err.message;
      this.actual = await systemProxy.read().catch(() => this.actual);
    }
  }

  // ---- drift detection ----
  //
  // Runs only while there is something to watch: either we want the proxy on,
  // or the registry still has one of ours enabled. One `reg query` per tick.
  _syncTimer() {
    const watch = this.desired || (this.actual && this.actual.enabled && this.isOurs(this.actual));
    if (watch && !this.timer) {
      this.timer = setInterval(() => {
        this.reconcile({ reason: 'drift' }).catch(() => {});
      }, DRIFT_POLL_MS);
      if (this.timer.unref) this.timer.unref();
    } else if (!watch && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ---- commands ----

  async setDesired(desired) {
    this.desired = desired;
    return this.reconcile({ reason: desired ? 'enable' : 'disable', force: desired });
  }

  /**
   * Last-ditch synchronous-ish teardown for quit/update paths: clear the proxy
   * if it is ours, without caring about intent or publishing anything. Leaving
   * Windows pointed at a port that is about to stop existing is the one failure
   * mode that takes the user's internet down with it.
   */
  async withdrawForShutdown() {
    try {
      const state = await systemProxy.read();
      if (!state.enabled || !this.isOurs(state)) return;
      await systemProxy.clear({ restore: this.store.get('systemProxySaved', null) });
      this.store.set('systemProxySaved', null);
    } catch { /* best effort -- we are on the way out */ }
  }
}

module.exports = { SystemProxyController, DRIFT_POLL_MS };
