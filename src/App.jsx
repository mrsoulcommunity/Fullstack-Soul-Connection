import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import ServerList from './components/ServerList.jsx';
import AddModal from './components/AddModal.jsx';
import ConnectHero from './components/ConnectHero.jsx';
import StatusBar from './components/StatusBar.jsx';
import SettingsView from './components/SettingsView.jsx';
import ServerFinder from './components/ServerFinder.jsx';
import SoulPoolEntry from './components/SoulPoolEntry.jsx';
import RoutingRules from './components/RoutingRules.jsx';
import { FailoverStatus } from './components/FailoverSettings.jsx';
import Icon from './components/Icon.jsx';
import { loadSession, saveSession, clearSession } from './utils/sessionState.js';

const PING_CONCURRENCY = 12;

// Update card, pinned to the bottom of the sidebar just above "افزودن کانفیگ".
// The About section in Settings exposes the same actions, but a release has to
// reach someone who never opens Settings -- so it surfaces here, in the corner
// the eye already returns to, until acted on or dismissed.
//
// One click does the whole thing: download, then install and relaunch. Once
// that click lands the card becomes a progress readout and stops being
// clickable, so there's no way to fire a second install mid-flight.
function UpdateCard({ status, version, percent, onUpdate, onDismiss }) {
  const downloading = status === 'downloading';
  const installing = status === 'installing' || status === 'downloaded';
  const failed = status === 'error';
  const busy = downloading || installing;
  const pct = Math.min(100, Math.max(0, Math.round(percent || 0)));

  const hint = installing
    ? 'در حال نصب… برنامه بسته و دوباره باز می‌شود'
    : downloading
      ? `در حال دانلود… ${pct}٪`
      : failed
        ? 'دانلود ناموفق بود — برای تلاش دوباره کلیک کنید'
        : 'برای به‌روزرسانی خودکار کلیک کنید';

  return (
    <div className={`update-card ${busy ? 'busy' : ''} ${failed ? 'failed' : ''}`}>
      <button
        type="button"
        className="update-card-main"
        onClick={busy ? undefined : onUpdate}
        disabled={busy}
        title={busy ? hint : `به‌روزرسانی به نسخه‌ی ${version}`}
      >
        <span className="update-card-glyph">
          <Icon name={installing ? 'refresh' : failed ? 'refresh' : 'arrowDown'} size={15} />
        </span>
        <span className="update-card-text">
          <span className="update-card-title">
            {busy ? `نسخه‌ی ${version}` : `نسخه‌ی ${version} موجود است`}
          </span>
          <span className="update-card-hint">{hint}</span>
        </span>
      </button>

      {downloading && (
        <div className="update-card-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="update-card-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      {!busy && (
        <button className="update-card-dismiss" onClick={onDismiss} title="بعداً یادآوری کن">
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

// Custom chrome for the frameless window. Standard Windows layout: app
// icon/name at the top-left, minimize/maximize/close at the top-right in
// that order (close outermost) -- `.titlebar` forces `direction: ltr` in CSS
// so this physical layout holds regardless of the app's own RTL content.
function TitleBar({ maximized, onMinimize, onToggleMaximize, onClose }) {
  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <img src="./icon.png" alt="" />
        <span>Soul Connection</span>
      </div>
      <div className="titlebar-drag" onDoubleClick={onToggleMaximize} />
      <div className="titlebar-controls">
        <button className="tb-btn" onClick={onMinimize} title="کوچک‌کردن">
          <Icon name="winMinimize" size={13} />
        </button>
        <button className="tb-btn" onClick={onToggleMaximize} title={maximized ? 'بازگردانی' : 'بیشینه‌سازی'}>
          <Icon name={maximized ? 'winRestore' : 'winMaximize'} size={12} />
        </button>
        <button className="tb-btn close" onClick={onClose} title="بستن">
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [connectionMode, setConnectionMode] = useState('proxy');
  const [connectionState, setConnectionState] = useState('disconnected');
  const [connectedAt, setConnectedAt] = useState(null);
  const [latencyMs, setLatencyMs] = useState(null);
  const [traffic, setTraffic] = useState(null);
  const [settings, setSettings] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [updaterStatus, setUpdaterStatus] = useState(null);
  // Version carried across the whole download flow: only 'available' and
  // 'downloaded' events carry it, 'downloading' progress events don't.
  // Soul Connection pool: `soulMode` is the selection, `soulProgress` is the
  // live sweep readout (null whenever nothing is running).
  const [soulMode, setSoulMode] = useState(false);
  const [soulCount, setSoulCount] = useState(0);
  const [soulProgress, setSoulProgress] = useState(null);
  const [activeSoulProfile, setActiveSoulProfile] = useState(null);
  const [soulRefreshing, setSoulRefreshing] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [pings, setPings] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  // Seeded eagerly (before `settings` loads) from whatever was last saved --
  // if "Restore Previous Session" turns out to be off, the effect below
  // wipes the stored session so the NEXT launch starts clean. A one-time
  // restore before that check resolves is a harmless, self-correcting edge
  // case, not worth delaying the sidebar's first render to avoid.
  const sessionRef = useRef(loadSession() || {});
  const [tab, setTab] = useState(() => sessionRef.current.tab || 'servers');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [updatingSubs, setUpdatingSubs] = useState(false);
  const [refreshingSubIds, setRefreshingSubIds] = useState(() => new Set());
  const [finderOpen, setFinderOpen] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [systemProxyEnabled, setSystemProxyEnabled] = useState(false);
  const [killSwitchBlocking, setKillSwitchBlocking] = useState(false);
  // Smart Routing / health / failover. `routingNeedsReconnect` is sticky until
  // the next connect: a domain-rule change only reaches xray when the tunnel is
  // rebuilt, and the user has to be told rather than left wondering why the
  // rule they just wrote isn't doing anything yet.
  const [routing, setRouting] = useState(null);
  const [routingNeedsReconnect, setRoutingNeedsReconnect] = useState(false);
  const [health, setHealth] = useState(null);
  const [failover, setFailover] = useState(null);
  const [failoverEvent, setFailoverEvent] = useState(null);

  useEffect(() => {
    window.soul.windowIsMaximized?.().then(setWindowMaximized).catch(() => {});
    const off = window.soul.onWindowState?.(({ maximized }) => setWindowMaximized(maximized));
    return () => off && off();
  }, []);

  const refresh = useCallback(async () => {
    const data = await window.soul.listProfiles();
    setProfiles(data.profiles);
    setSubscriptions(data.subscriptions);
    setActiveProfileId(data.activeProfileId);
    setConnectionMode(data.connectionMode);
    setConnectionState(data.connectionState);
    setConnectedAt(data.connectedAt);
    setSettings(data.settings);
    setSystemProxyEnabled(data.systemProxyEnabled);
    setKillSwitchBlocking(!!data.killSwitchBlocking);
    setSoulMode(!!data.soulModeEnabled);
    setSoulCount(data.soulCount || 0);
    setActiveSoulProfile(data.activeSoulProfile || null);
    if (data.routing) setRouting(data.routing);
    if (data.health) setHealth(data.health);
    if (data.failover) setFailover(data.failover);
  }, []);

  // Warm the pool list in the background on first paint so the sidebar can
  // show a real server count, and so the first connect skips the fetch.
  useEffect(() => {
    let cancelled = false;
    window.soul.soulList?.()
      .then((r) => { if (!cancelled && r) setSoulCount(r.count); })
      .catch(() => { /* offline; the count just stays at 0 until connect */ });
    return () => { cancelled = true; };
  }, []);

  // Ctrl+K (or Ctrl+F) opens the server finder from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f')) {
        e.preventDefault();
        setFinderOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Global Ctrl+V: smart-detect clipboard content (config link vs subscription
  // URL) and add it, unless the user is pasting into a real field/modal.
  const showAddRef = useRef(showAdd);
  useEffect(() => { showAddRef.current = showAdd; }, [showAdd]);

  useEffect(() => {
    const onKey = async (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
      if (inField) return;
      if (showAddRef.current || finderOpen) return;
      if (document.body.dataset.modalOpen === 'true') return;

      e.preventDefault();
      let text;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        showToast('دسترسی به کلیپ‌بورد ممکن نشد', 'error');
        return;
      }
      text = (text || '').trim();
      if (!text) return;

      try {
        // Look for a config prefix ANYWHERE in the paste, not just at the
        // very start -- a multi-config paste can have a leading blank line,
        // a label, or other text before the first real link.
        if (/(vmess|vless|trojan|ss):\/\//i.test(text)) {
          await handleAddLink(text);
        } else if (/^https?:\/\//i.test(text)) {
          await handleAddSubscription(text);
        } else {
          showToast('محتوای کلیپ‌بورد یک کانفیگ یا لینک سابسکریپشن معتبر نیست', 'error');
        }
      } catch (err) {
        showToast(err.message || 'خطا در افزودن از کلیپ‌بورد', 'error');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finderOpen]);

  useEffect(() => {
    refresh();
    window.soul.getAppInfo().then(setAppInfo).catch(() => {});
    const offState = window.soul.onStateChanged(({ connectionState, activeProfileId, connectedAt, systemProxyEnabled, killSwitchBlocking, soulModeEnabled, activeSoulProfile }) => {
      setConnectionState(connectionState);
      setActiveProfileId(activeProfileId);
      setConnectedAt(connectedAt);
      setSystemProxyEnabled(systemProxyEnabled);
      setKillSwitchBlocking(!!killSwitchBlocking);
      setSoulMode(!!soulModeEnabled);
      setActiveSoulProfile(activeSoulProfile || null);
      if (connectionState === 'connected') {
        // A fresh tunnel was built from the current rules, so whatever was
        // pending has now been applied.
        setRoutingNeedsReconnect(false);
      } else {
        setLatencyMs(null);
        setTraffic(null);
        setHealth(null);
        refresh(); // picks up the just-persisted lifetime usage total
      }
    });
    const offSoul = window.soul.onSoulProgress?.((p) => {
      setSoulProgress(p);
      // 'done' leaves the winning server on screen; a cancel (error with no
      // message) just clears the row back to its idle state.
      if (p.phase === 'error' && !p.message) setSoulProgress(null);
    });
    const offRouting = window.soul.onRoutingChanged?.((state) => {
      setRouting(state);
      if (state.needsReconnect) setRoutingNeedsReconnect(true);
    });
    const offHealth = window.soul.onHealthUpdate?.((patch) => {
      setHealth((prev) => ({ ...prev, ...patch }));
    });
    const offFailover = window.soul.onFailoverEvent?.((e) => {
      // 'degrading' is the engine counting bad checks -- useful telemetry, but
      // not something to interrupt the user with until it actually acts.
      if (e.phase === 'degrading') return;
      if (e.phase === 'blocked') return;
      setFailoverEvent(e);
      if (e.phase === 'done' || e.phase === 'failed') {
        window.soul.getHealth?.().then((h) => h && setFailover(h.failover)).catch(() => {});
      }
    });
    const offLatency = window.soul.onLatencyUpdate(({ ms }) => setLatencyMs(ms));
    const offTraffic = window.soul.onTrafficUpdate((data) => setTraffic(data));
    const offProfiles = window.soul.onProfilesChanged(() => refresh());
    const offOpenSettings = window.soul.onOpenSettings(() => setTab('settings'));
    const offUpdater = window.soul.onUpdaterStatus((s) => {
      setUpdaterStatus(s);
      if (s.status === 'available' || s.status === 'downloaded') {
        setPendingUpdate(s.version);
        // A check that turns up a release re-opens the card even if an
        // earlier one was dismissed -- the user asked for this answer.
        setUpdateDismissed(false);
      } else if (s.status === 'not-available') {
        // The release this card was offering is gone (pulled, or already
        // installed) -- drop it rather than leave a dead offer on screen.
        setPendingUpdate(null);
      }
    });
    return () => {
      offState(); offLatency(); offTraffic(); offProfiles(); offOpenSettings(); offUpdater();
      if (offSoul) offSoul();
      if (offRouting) offRouting();
      if (offHealth) offHealth();
      if (offFailover) offFailover();
    };
  }, [refresh]);

  // A completed switch has told its story after a while; a failed one stays
  // until dismissed, because it means the user is probably still offline.
  useEffect(() => {
    if (failoverEvent?.phase !== 'done') return;
    const t = setTimeout(() => setFailoverEvent(null), 20000);
    return () => clearTimeout(t);
  }, [failoverEvent]);

  // "Restore Previous Session": persist the active tab whenever it changes,
  // but only while the setting is on -- and wipe any stored session the
  // moment it's turned off, so a disabled toggle actually stays disabled.
  useEffect(() => {
    if (!settings) return;
    if (!settings.restorePreviousSession) {
      clearSession();
      return;
    }
    saveSession({ ...sessionRef.current, tab });
  }, [tab, settings]);

  // Debounced report from ServerList of query/sortBy/collapsed -- merged
  // into the same stored session object as `tab`.
  const handleSessionChange = useCallback((partial) => {
    sessionRef.current = { ...sessionRef.current, ...partial };
    if (settings?.restorePreviousSession) saveSession({ ...sessionRef.current, tab });
  }, [tab, settings]);

  // Stabilized with useCallback: these flow into React.memo'd children
  // (ServerCard via ServerList, ConnectHero, StatusBar) that sit in the
  // hottest paths (ping-all, 1s traffic ticks) -- a fresh function reference
  // every App render would defeat memoization and re-render the whole tree.
  // The dismiss timer is tracked so a second toast restarts the countdown --
  // otherwise the previous toast's timer fires mid-life and clears the new one
  // early (very visible in flows that toast twice in a row, like add + connect).
  const toastTimer = useRef(null);
  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, 2600);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const handleToggleConnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (connectionState === 'connected' || connectionState === 'connecting') {
        await window.soul.disconnect();
      } else if (soulMode) {
        // The pool picks the server; this is the whole point of the mode.
        setSoulProgress({ phase: 'fetching' });
        await window.soul.soulConnectBest();
      } else if (settings?.autoSelectBestServer && profiles.length > 1) {
        // "Let it choose" is exactly what the toggle asks for. Clicking a
        // specific server in the sidebar still connects to that one.
        const r = await window.soul.connectBest();
        if (r?.profile) showToast(`بهترین سرور انتخاب شد: ${r.profile.name}`);
      } else {
        if (!activeProfileId) {
          showToast('اول یک کانفیگ را انتخاب کن');
          setBusy(false);
          return;
        }
        await window.soul.connect(activeProfileId);
      }
    } catch (err) {
      showToast(err.message || 'خطا در اتصال');
    } finally {
      setBusy(false);
    }
  }, [busy, connectionState, activeProfileId, soulMode, settings, profiles.length, showToast]);

  // ---- Smart Routing ----
  //
  // Every mutation answers with the whole routing state, so the UI never has to
  // guess what the main process did with the rule it just sent (normalization
  // rewrites exe paths and domain forms) -- it just renders what came back.
  const applyRouting = useCallback((state) => {
    if (!state) return;
    setRouting(state);
    if (state.needsReconnect) setRoutingNeedsReconnect(true);
  }, []);

  const handleSetRoutingMode = useCallback(async (mode) => {
    try {
      applyRouting(await window.soul.routingSetMode(mode));
    } catch (err) {
      showToast(err.message || 'خطا در تغییر حالت مسیریابی', 'error');
    }
  }, [applyRouting, showToast]);

  const handleSetLanDirect = useCallback(async (enabled) => {
    try {
      applyRouting(await window.soul.routingSetLanDirect(enabled));
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره', 'error');
    }
  }, [applyRouting, showToast]);

  // Rethrows: the rule modal keeps itself open and shows the validation error
  // inline instead of closing over a change that never happened.
  const handleSaveRule = useCallback(async (rule) => {
    try {
      applyRouting(await window.soul.routingSaveRule(rule));
    } catch (err) {
      showToast(err.message || 'قانون ذخیره نشد', 'error');
      throw err;
    }
  }, [applyRouting, showToast]);

  const handleDeleteRule = useCallback(async (id) => {
    try {
      applyRouting(await window.soul.routingDeleteRule(id));
    } catch (err) {
      showToast(err.message || 'حذف نشد', 'error');
    }
  }, [applyRouting, showToast]);

  const handleToggleRule = useCallback(async (id, enabled) => {
    try {
      applyRouting(await window.soul.routingToggleRule(id, enabled));
    } catch (err) {
      showToast(err.message || 'خطا', 'error');
    }
  }, [applyRouting, showToast]);

  const handleAddDomains = useCallback(async (payload) => {
    try {
      applyRouting(await window.soul.routingAddDomains(payload));
      showToast('دامنه‌ها اضافه شدند');
    } catch (err) {
      showToast(err.message || 'افزوده نشد', 'error');
      throw err;
    }
  }, [applyRouting, showToast]);

  const handleReconnect = useCallback(async () => {
    if (busy || !activeProfileId) return;
    setBusy(true);
    try {
      await window.soul.connect(activeProfileId);
      setRoutingNeedsReconnect(false);
    } catch (err) {
      showToast(err.message || 'خطا در اتصال مجدد', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, activeProfileId, showToast]);

  // Selecting the pool row. Toggling it off falls back to manual selection;
  // doing either mid-sweep cancels the sweep rather than queueing behind it.
  const handleSoulSelect = useCallback(async () => {
    try {
      if (connectionState === 'connecting') {
        await window.soul.soulCancel();
        setSoulProgress(null);
        return;
      }
      const next = !soulMode;
      await window.soul.soulSetEnabled(next);
      setSoulMode(next);
      if (!next) setSoulProgress(null);
    } catch (err) {
      showToast(err.message || 'خطا', 'error');
    }
  }, [soulMode, connectionState, showToast]);

  const handleSoulRefresh = useCallback(async () => {
    setSoulRefreshing(true);
    try {
      const r = await window.soul.soulList(true);
      setSoulCount(r.count);
      showToast(`${r.count} سرور سول کانکشن به‌روزرسانی شد`);
    } catch (err) {
      showToast(err.message || 'خطا در دریافت فهرست', 'error');
    } finally {
      setSoulRefreshing(false);
    }
  }, [showToast]);

  const handleSelect = useCallback(async (id) => {
    // Picking a server by hand leaves pool mode. Main does the same on its
    // side when connecting, but this keeps the sidebar honest while idle.
    if (soulMode) {
      setSoulMode(false);
      setSoulProgress(null);
      window.soul.soulSetEnabled(false).catch(() => {});
    }
    if (connectionState === 'connected' || connectionState === 'connecting') {
      setBusy(true);
      try {
        await window.soul.connect(id);
      } catch (err) {
        showToast(err.message || 'خطا در اتصال');
      } finally {
        setBusy(false);
      }
    } else {
      setActiveProfileId(id);
    }
  }, [connectionState, soulMode, showToast]);

  const handleDelete = useCallback(async (id) => {
    const updated = await window.soul.deleteProfile(id);
    setProfiles(updated);
    setActiveProfileId((cur) => (cur === id ? null : cur));
  }, []);

  const handleRenameProfile = useCallback(async (id, name) => {
    const updated = await window.soul.renameProfile(id, name);
    setProfiles(updated);
  }, []);

  const handleEditProfile = useCallback(async (id, link) => {
    const updated = await window.soul.updateProfile(id, link);
    setProfiles(updated);
    showToast('کانفیگ به‌روزرسانی شد');
  }, [showToast]);

  const handlePing = useCallback(async (id) => {
    setPings((p) => ({ ...p, [id]: 'measuring' }));
    try {
      const { ms } = await window.soul.pingTest(id);
      setPings((p) => ({ ...p, [id]: ms }));
      return ms;
    } catch {
      setPings((p) => ({ ...p, [id]: -1 }));
      return -1;
    }
  }, []);

  const handlePingAll = useCallback(async (ids) => {
    await mapWithConcurrency(ids, PING_CONCURRENCY, (id) => handlePing(id));
  }, [handlePing]);

  // Connect regardless of current state (used by the finder's result cards).
  const handleConnectTo = useCallback(async (id) => {
    if (busy) return;
    setBusy(true);
    try {
      await window.soul.connect(id);
    } catch (err) {
      showToast(err.message || 'خطا در اتصال');
    } finally {
      setBusy(false);
    }
  }, [busy, showToast]);

  const handleDisconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await window.soul.disconnect();
    } catch (err) {
      showToast(err.message || 'خطا در قطع اتصال');
    } finally {
      setBusy(false);
    }
  }, [busy, showToast]);

  const handleToggleFavorite = useCallback(async (profile) => {
    try {
      const updated = await window.soul.setFavorite(profile.id, !profile.favorite);
      setProfiles(updated);
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره');
    }
  }, [showToast]);

  const handleAddLink = useCallback(async (link) => {
    const { profiles: added, duplicates } = await window.soul.addLink(link);
    await refresh();
    setShowAdd(false);
    const dupNote = duplicates > 0 ? ` (${duplicates} مورد تکراری نادیده گرفته شد)` : '';
    showToast(added.length > 1 ? `${added.length} کانفیگ اضافه شد${dupNote}` : `کانفیگ اضافه شد${dupNote}`);
  }, [refresh, showToast]);

  const handleAddSubscription = useCallback(async (url) => {
    const { profiles: added } = await window.soul.addSubscription(url);
    await refresh();
    setShowAdd(false);
    showToast(`${added.length} کانفیگ از ساب‌اسکریپشن اضافه شد`);
  }, [refresh, showToast]);

  const handleAddCustom = useCallback(async (fields) => {
    await window.soul.addCustomConfig(fields);
    await refresh();
    setShowAdd(false);
    showToast('کانفیگ اضافه شد');
  }, [refresh, showToast]);

  const handleRefreshSubscription = useCallback(async (id) => {
    if (refreshingSubIds.has(id)) return; // already refreshing -- ignore repeat clicks
    setRefreshingSubIds((prev) => new Set(prev).add(id));
    try {
      const { profiles: added } = await window.soul.refreshSubscription(id);
      await refresh();
      showToast(`${added.length} کانفیگ به‌روزرسانی شد`);
    } catch (err) {
      showToast(err.message || 'خطا در به‌روزرسانی');
    } finally {
      setRefreshingSubIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [refresh, showToast, refreshingSubIds]);

  const handleUpdateAllSubscriptions = useCallback(async () => {
    if (updatingSubs) return;
    setUpdatingSubs(true);
    try {
      await window.soul.refreshAllSubscriptions();
      await refresh();
      showToast('همه‌ی ساب‌اسکریپشن‌ها به‌روزرسانی شدند');
    } catch (err) {
      showToast(err.message || 'خطا در به‌روزرسانی');
    } finally {
      setUpdatingSubs(false);
    }
  }, [updatingSubs, refresh, showToast]);

  const handleDeleteSubscription = useCallback(async (id) => {
    const updated = await window.soul.deleteSubscription(id);
    setProfiles(updated);
    await refresh();
  }, [refresh]);

  const handleUpdateSubscription = useCallback(async (id, patch) => {
    const updated = await window.soul.updateSubscription(id, patch);
    setSubscriptions(updated);
    showToast('ساب‌اسکریپشن به‌روزرسانی شد');
  }, [showToast]);

  const handleSetMode = useCallback(async (mode) => {
    if (mode === connectionMode || connectionState !== 'disconnected') return;
    try {
      await window.soul.setMode(mode);
      setConnectionMode(mode);
    } catch (err) {
      showToast(err.message || 'خطا در تغییر حالت');
    }
  }, [connectionMode, connectionState, showToast]);

  async function handleUpdateSettings(patch) {
    try {
      const updated = await window.soul.updateSettings(patch);
      setSettings(updated);
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره تنظیمات');
    }
  }

  // Same as handleUpdateSettings but rethrows on failure so callers that need
  // to react locally (e.g. reverting an optimistic input) can await it.
  async function handleUpdateSettingsChecked(patch) {
    try {
      const updated = await window.soul.updateSettings(patch);
      setSettings(updated);
      return updated;
    } catch (err) {
      showToast(err.message || 'خطا در ذخیره تنظیمات');
      throw err;
    }
  }

  async function handleExportBackup() {
    try {
      const res = await window.soul.exportBackup();
      if (!res.canceled) showToast('پشتیبان‌گیری با موفقیت انجام شد');
    } catch (err) {
      showToast(err.message || 'خطا در پشتیبان‌گیری');
    }
  }

  async function handleImportBackup() {
    try {
      const res = await window.soul.importBackup();
      if (!res.canceled) {
        await refresh();
        showToast(`${res.profiles} کانفیگ بازیابی شد`);
      }
    } catch (err) {
      showToast(err.message || 'خطا در بازیابی');
    }
  }

  async function handleResetUsage(id) {
    const updated = await window.soul.resetUsage(id);
    setProfiles(updated);
  }

  async function handleResetAllUsage() {
    const updated = await window.soul.resetAllUsage();
    setProfiles(updated);
  }

  const handleSystemProxyEnable = useCallback(async () => {
    try {
      await window.soul.systemProxyEnable();
      setSystemProxyEnabled(true);
      showToast('پروکسی سیستم فعال شد');
    } catch (err) {
      showToast(err.message || 'خطا در فعال‌سازی پروکسی سیستم', 'error');
    }
  }, [showToast]);

  const handleSystemProxyDisable = useCallback(async () => {
    try {
      await window.soul.systemProxyDisable();
      setSystemProxyEnabled(false);
      showToast('پروکسی سیستم بازنشانی شد');
    } catch (err) {
      showToast(err.message || 'خطا در بازنشانی پروکسی سیستم', 'error');
    }
  }, [showToast]);

  const handleOpenProxyFolder = useCallback(() => window.soul.openProxyFolder(), []);

  const handleEmergencyDisableKillSwitch = useCallback(async () => {
    try {
      const updated = await window.soul.updateSettings({ killSwitchEnabled: false });
      setSettings(updated);
      setKillSwitchBlocking(false);
      showToast('Kill Switch غیرفعال شد و اینترنت آزاد شد');
    } catch (err) {
      showToast(err.message || 'خطا در غیرفعال‌سازی Kill Switch', 'error');
    }
  }, [showToast]);

  const handleResetNetworkDefaults = useCallback(async () => {
    try {
      const updated = await window.soul.resetNetworkDefaults();
      setSettings(updated);
      showToast('تنظیمات شبکه بازنشانی شد');
    } catch (err) {
      showToast(err.message || 'خطا در بازنشانی تنظیمات شبکه', 'error');
    }
  }, [showToast]);

  // A pool server isn't in `profiles`, so fall back to the copy main ships
  // with the state payload -- otherwise the hero would claim no server is
  // selected while the tunnel is up on a pool server.
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId)
      || (activeSoulProfile && activeSoulProfile.id === activeProfileId ? activeSoulProfile : undefined),
    [profiles, activeProfileId, activeSoulProfile]
  );

  return (
    <div className={`app-shell ${windowMaximized ? 'maximized' : ''}`}>
      <TitleBar
        maximized={windowMaximized}
        onMinimize={() => window.soul.windowMinimize()}
        onToggleMaximize={() => window.soul.windowToggleMaximize()}
        onClose={() => window.soul.windowClose()}
      />
      <div className="workspace">
        <aside className="sidebar">
          <header className="sidebar-head">
            <img className="mark" src="./icon.png" alt="" />
            <div className="brand">
              <span className="brand-name">Soul Connection</span>
              <span className="brand-sub">
                {profiles.length ? `${profiles.length} کانفیگ` : 'کلاینت V2Ray / Xray'}
              </span>
            </div>
          </header>

          <SoulPoolEntry
            enabled={soulMode}
            count={soulCount}
            connectionState={connectionState}
            progress={soulProgress}
            activeSoulProfile={activeSoulProfile}
            busy={busy && connectionState !== 'connecting'}
            refreshing={soulRefreshing}
            onSelect={handleSoulSelect}
            onRefresh={handleSoulRefresh}
          />

          <ServerList
            profiles={profiles}
            subscriptions={subscriptions}
            activeProfileId={activeProfileId}
            connectionState={connectionState}
            pings={pings}
            updatingSubs={updatingSubs}
            refreshingSubIds={refreshingSubIds}
            onSelect={handleSelect}
            onDelete={handleDelete}
            onPing={handlePing}
            onPingAll={handlePingAll}
            onAdd={() => setShowAdd(true)}
            onRefreshSubscription={handleRefreshSubscription}
            onUpdateAllSubscriptions={handleUpdateAllSubscriptions}
            onDeleteSubscription={handleDeleteSubscription}
            onConnectTo={handleConnectTo}
            onDisconnect={handleDisconnect}
            onRenameProfile={handleRenameProfile}
            onEditProfile={handleEditProfile}
            onUpdateSubscription={handleUpdateSubscription}
            onToast={showToast}
            initialQuery={sessionRef.current.query}
            initialSortBy={sessionRef.current.sortBy}
            initialCollapsed={sessionRef.current.collapsed}
            onSessionChange={handleSessionChange}
          />

          {pendingUpdate && !updateDismissed && (
            <UpdateCard
              status={updaterStatus?.status}
              version={pendingUpdate}
              percent={updaterStatus?.percent}
              onUpdate={() => window.soul.downloadAndInstall()}
              onDismiss={() => setUpdateDismissed(true)}
            />
          )}

          {profiles.length > 0 && (
            <footer className="sidebar-foot">
              <button className="btn primary add-btn" onClick={() => setShowAdd(true)}>
                <Icon name="plus" size={15} />
                افزودن کانفیگ
              </button>
              <button
                className="icon-btn tall"
                onClick={() => setFinderOpen(true)}
                title="سرور یاب هوشمند (Ctrl+K)"
              >
                <Icon name="radar" size={15} />
              </button>
            </footer>
          )}
        </aside>

        <main className="main">
          <header className="main-head">
            <span className="main-title">
              {tab === 'settings' ? 'تنظیمات' : tab === 'routing' ? 'قوانین مسیریابی' : 'کنترل اتصال'}
            </span>
            <div className="main-head-actions">
              <button
                className={`icon-btn ghost ${tab === 'routing' ? 'active' : ''}`}
                onClick={() => setTab(tab === 'routing' ? 'servers' : 'routing')}
                title={tab === 'routing' ? 'بازگشت به کنترل اتصال' : 'قوانین مسیریابی'}
              >
                <Icon name={tab === 'routing' ? 'close' : 'filter'} size={16} />
              </button>
              <button
                className={`icon-btn ghost ${tab === 'settings' ? 'active' : ''}`}
                onClick={() => setTab(tab === 'settings' ? 'servers' : 'settings')}
                title={tab === 'settings' ? 'بازگشت به کنترل اتصال' : 'تنظیمات'}
              >
                <Icon name={tab === 'settings' ? 'close' : 'settings'} size={16} />
              </button>
            </div>
          </header>

          {tab === 'servers' ? (
            <ConnectHero
              connectionState={connectionState}
              connectionMode={connectionMode}
              activeProfile={activeProfile}
              onToggle={handleToggleConnect}
              onSetMode={handleSetMode}
            />
          ) : tab === 'routing' ? (
            <div className="settings-pane">
              <RoutingRules
                routing={routing}
                connectionState={connectionState}
                needsReconnect={routingNeedsReconnect}
                onSetMode={handleSetRoutingMode}
                onSetLanDirect={handleSetLanDirect}
                onSaveRule={handleSaveRule}
                onDeleteRule={handleDeleteRule}
                onToggleRule={handleToggleRule}
                onAddDomains={handleAddDomains}
                onReconnect={handleReconnect}
              />
            </div>
          ) : (
            <div className="settings-pane">
              {settings && (
                <SettingsView
                  settings={settings}
                  connectionState={connectionState}
                  profiles={profiles}
                  appInfo={appInfo}
                  systemProxyEnabled={systemProxyEnabled}
                  updaterStatus={updaterStatus}
                  onCheckForUpdates={() => window.soul.checkForUpdates()}
                  onDownloadUpdate={() => window.soul.downloadUpdate()}
                  onInstallUpdate={() => window.soul.installUpdate()}
                  onUpdate={handleUpdateSettings}
                  onUpdateChecked={handleUpdateSettingsChecked}
                  onOpenLogsFolder={() => window.soul.openLogsFolder()}
                  onExportBackup={handleExportBackup}
                  onImportBackup={handleImportBackup}
                  onResetUsage={handleResetUsage}
                  onResetAllUsage={handleResetAllUsage}
                  onSystemProxyEnable={handleSystemProxyEnable}
                  onSystemProxyDisable={handleSystemProxyDisable}
                  onOpenProxyFolder={handleOpenProxyFolder}
                  onResetNetworkDefaults={handleResetNetworkDefaults}
                  killSwitchBlocking={killSwitchBlocking}
                  health={health}
                  failover={failover}
                />
              )}
            </div>
          )}

          {failoverEvent && (
            <FailoverStatus event={failoverEvent} onDismiss={() => setFailoverEvent(null)} />
          )}

          {killSwitchBlocking && (
            <div className="killswitch-banner" role="alert">
              <Icon name="shield" size={16} />
              <span className="killswitch-banner-text">
                Kill Switch فعال است — تمام ترافیک اینترنت مسدود شده تا وقتی دوباره وصل شوی.
              </span>
              <button className="btn danger killswitch-banner-btn" onClick={handleEmergencyDisableKillSwitch}>
                غیرفعال‌سازی اضطراری
              </button>
            </div>
          )}

          <StatusBar
            connectionState={connectionState}
            activeProfile={activeProfile}
            connectedAt={connectedAt}
            latencyMs={latencyMs}
            selectedPing={activeProfileId ? pings[activeProfileId] : undefined}
            traffic={traffic}
            notice={toast}
          />
        </main>
      </div>

      {finderOpen && (
        <ServerFinder
          profiles={profiles}
          subscriptions={subscriptions}
          activeProfileId={activeProfileId}
          connectionState={connectionState}
          onClose={() => setFinderOpen(false)}
          onConnect={handleConnectTo}
          onToggleFavorite={handleToggleFavorite}
        />
      )}

      {showAdd && (
        <AddModal
          onClose={() => setShowAdd(false)}
          onAddLink={handleAddLink}
          onAddSubscription={handleAddSubscription}
          onAddCustom={handleAddCustom}
        />
      )}
    </div>
  );
}
