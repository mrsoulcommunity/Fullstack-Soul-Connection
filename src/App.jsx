import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import ServerList from './components/ServerList.jsx';
import AddModal from './components/AddModal.jsx';
import ConnectHero from './components/ConnectHero.jsx';
import StatusBar from './components/StatusBar.jsx';
import SettingsView from './components/SettingsView.jsx';
import ServerFinder from './components/ServerFinder.jsx';
import Icon from './components/Icon.jsx';

const PING_CONCURRENCY = 12;

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
  const [pings, setPings] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState('servers');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [updatingSubs, setUpdatingSubs] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);

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
        if (/^(vmess|vless|trojan|ss):\/\//i.test(text)) {
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
    const offState = window.soul.onStateChanged(({ connectionState, activeProfileId, connectedAt }) => {
      setConnectionState(connectionState);
      setActiveProfileId(activeProfileId);
      setConnectedAt(connectedAt);
      if (connectionState !== 'connected') {
        setLatencyMs(null);
        setTraffic(null);
        refresh(); // picks up the just-persisted lifetime usage total
      }
    });
    const offLatency = window.soul.onLatencyUpdate(({ ms }) => setLatencyMs(ms));
    const offTraffic = window.soul.onTrafficUpdate((data) => setTraffic(data));
    const offProfiles = window.soul.onProfilesChanged(() => refresh());
    const offOpenSettings = window.soul.onOpenSettings(() => setTab('settings'));
    const offUpdater = window.soul.onUpdaterStatus(setUpdaterStatus);
    return () => { offState(); offLatency(); offTraffic(); offProfiles(); offOpenSettings(); offUpdater(); };
  }, [refresh]);

  // Stabilized with useCallback: these flow into React.memo'd children
  // (ServerCard via ServerList, ConnectHero, StatusBar) that sit in the
  // hottest paths (ping-all, 1s traffic ticks) -- a fresh function reference
  // every App render would defeat memoization and re-render the whole tree.
  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  }, []);

  const handleToggleConnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (connectionState === 'connected' || connectionState === 'connecting') {
        await window.soul.disconnect();
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
  }, [busy, connectionState, activeProfileId, showToast]);

  const handleSelect = useCallback(async (id) => {
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
  }, [connectionState, showToast]);

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
    const profile = await window.soul.addLink(link);
    setProfiles((p) => [...p, profile]);
    setShowAdd(false);
    showToast('کانفیگ اضافه شد');
  }, [showToast]);

  const handleAddSubscription = useCallback(async (url) => {
    const { profiles: added } = await window.soul.addSubscription(url);
    await refresh();
    setShowAdd(false);
    showToast(`${added.length} کانفیگ از ساب‌اسکریپشن اضافه شد`);
  }, [refresh, showToast]);

  const handleRefreshSubscription = useCallback(async (id) => {
    try {
      const { profiles: added } = await window.soul.refreshSubscription(id);
      await refresh();
      showToast(`${added.length} کانفیگ به‌روزرسانی شد`);
    } catch (err) {
      showToast(err.message || 'خطا در به‌روزرسانی');
    }
  }, [refresh, showToast]);

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

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId),
    [profiles, activeProfileId]
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

          <ServerList
            profiles={profiles}
            subscriptions={subscriptions}
            activeProfileId={activeProfileId}
            connectionState={connectionState}
            pings={pings}
            updatingSubs={updatingSubs}
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
          />

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
            <span className="main-title">{tab === 'settings' ? 'تنظیمات' : 'کنترل اتصال'}</span>
            <button
              className="icon-btn ghost"
              onClick={() => setTab(tab === 'settings' ? 'servers' : 'settings')}
              title={tab === 'settings' ? 'بازگشت به کنترل اتصال' : 'تنظیمات'}
            >
              <Icon name={tab === 'settings' ? 'close' : 'settings'} size={16} />
            </button>
          </header>

          {tab === 'servers' ? (
            <ConnectHero
              connectionState={connectionState}
              connectionMode={connectionMode}
              activeProfile={activeProfile}
              onToggle={handleToggleConnect}
              onSetMode={handleSetMode}
            />
          ) : (
            <div className="settings-pane">
              {settings && (
                <SettingsView
                  settings={settings}
                  connectionState={connectionState}
                  profiles={profiles}
                  appInfo={appInfo}
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
                />
              )}
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
        />
      )}
    </div>
  );
}
