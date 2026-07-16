import React, { useEffect, useState, useCallback, useRef } from 'react';
import ServerList from './components/ServerList.jsx';
import AddModal from './components/AddModal.jsx';
import ConnectHero from './components/ConnectHero.jsx';
import SettingsView from './components/SettingsView.jsx';
import Icon from './components/Icon.jsx';

const PING_CONCURRENCY = 12;

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
  const [bestServerBusy, setBestServerBusy] = useState(false);
  const [updatingSubs, setUpdatingSubs] = useState(false);

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

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  async function handleToggleConnect() {
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
  }

  async function handleSelect(id) {
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
  }

  async function handleDelete(id) {
    const updated = await window.soul.deleteProfile(id);
    setProfiles(updated);
    if (activeProfileId === id) setActiveProfileId(null);
  }

  async function handlePing(id) {
    setPings((p) => ({ ...p, [id]: 'measuring' }));
    try {
      const { ms } = await window.soul.pingTest(id);
      setPings((p) => ({ ...p, [id]: ms }));
      return ms;
    } catch {
      setPings((p) => ({ ...p, [id]: -1 }));
      return -1;
    }
  }

  async function handlePingAll(ids) {
    await mapWithConcurrency(ids, PING_CONCURRENCY, (id) => handlePing(id));
  }

  async function handleBestServer() {
    if (!profiles.length || bestServerBusy) return;
    setBestServerBusy(true);
    try {
      const results = await mapWithConcurrency(profiles, PING_CONCURRENCY, async (p) => ({ id: p.id, ms: await handlePing(p.id) }));
      const reachable = results.filter((r) => r.ms > 0);
      if (!reachable.length) {
        showToast('هیچ سروری در دسترس نیست');
        return;
      }
      reachable.sort((a, b) => a.ms - b.ms);
      const best = reachable[0];
      setActiveProfileId(best.id);
      showToast('بهترین سرور انتخاب شد، در حال اتصال…');
      setBusy(true);
      try {
        await window.soul.connect(best.id);
      } catch (err) {
        showToast(err.message || 'خطا در اتصال');
      } finally {
        setBusy(false);
      }
    } finally {
      setBestServerBusy(false);
    }
  }

  async function handleAddLink(link) {
    const profile = await window.soul.addLink(link);
    setProfiles((p) => [...p, profile]);
    setShowAdd(false);
    showToast('کانفیگ اضافه شد');
  }

  async function handleAddSubscription(url) {
    const { profiles: added } = await window.soul.addSubscription(url);
    await refresh();
    setShowAdd(false);
    showToast(`${added.length} کانفیگ از ساب‌اسکریپشن اضافه شد`);
  }

  async function handleRefreshSubscription(id) {
    try {
      const { profiles: added } = await window.soul.refreshSubscription(id);
      await refresh();
      showToast(`${added.length} کانفیگ به‌روزرسانی شد`);
    } catch (err) {
      showToast(err.message || 'خطا در به‌روزرسانی');
    }
  }

  async function handleUpdateAllSubscriptions() {
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
  }

  async function handleDeleteSubscription(id) {
    const updated = await window.soul.deleteSubscription(id);
    setProfiles(updated);
    await refresh();
  }

  async function handleSetMode(mode) {
    if (mode === connectionMode || connectionState !== 'disconnected') return;
    try {
      await window.soul.setMode(mode);
      setConnectionMode(mode);
    } catch (err) {
      showToast(err.message || 'خطا در تغییر حالت');
    }
  }

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

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  return (
    <div className="app-shell">
      <div className="titlebar">
        <div className="mark" />
        <div className="name">
          Soul Connection
          <small>کلاینت V2Ray / Xray</small>
        </div>
      </div>

      <ConnectHero
        connectionState={connectionState}
        connectionMode={connectionMode}
        activeProfile={activeProfile}
        connectedAt={connectedAt}
        latencyMs={latencyMs}
        traffic={traffic}
        onToggle={handleToggleConnect}
        onSetMode={handleSetMode}
      />

      {tab === 'servers' ? (
        <div className="body">
          <div className="section-head">
            <h2>کانفیگ‌ها</h2>
            <div className="head-actions">
              <button
                className="icon-btn"
                onClick={handleBestServer}
                disabled={bestServerBusy || !profiles.length}
                title="بهترین سرور"
              >
                <Icon name="bolt" size={15} />
              </button>
              <button className="icon-btn" onClick={() => setShowAdd(true)} title="افزودن">
                <Icon name="plus" size={16} />
              </button>
            </div>
          </div>
          <ServerList
            profiles={profiles}
            subscriptions={subscriptions}
            activeProfileId={activeProfileId}
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
          />
        </div>
      ) : (
        <div className="body">
          <div className="section-head">
            <h2>تنظیمات</h2>
          </div>
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

      <div className="tabbar no-drag">
        <button className={`tabbar-btn ${tab === 'servers' ? 'active' : ''}`} onClick={() => setTab('servers')}>
          <Icon name="signal" size={17} />
          سرورها
        </button>
        <button className={`tabbar-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          <Icon name="settings" size={17} />
          تنظیمات
        </button>
      </div>

      {showAdd && (
        <AddModal
          onClose={() => setShowAdd(false)}
          onAddLink={handleAddLink}
          onAddSubscription={handleAddSubscription}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
