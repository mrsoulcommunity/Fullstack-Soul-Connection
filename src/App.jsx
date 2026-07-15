import React, { useEffect, useState, useCallback, useRef } from 'react';
import ServerList from './components/ServerList.jsx';
import AddModal from './components/AddModal.jsx';
import ConnectHero from './components/ConnectHero.jsx';
import SettingsModal from './components/SettingsModal.jsx';

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
  const [settings, setSettings] = useState(null);
  const [pings, setPings] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
    const offState = window.soul.onStateChanged(({ connectionState, activeProfileId, connectedAt }) => {
      setConnectionState(connectionState);
      setActiveProfileId(activeProfileId);
      setConnectedAt(connectedAt);
      if (connectionState !== 'connected') setLatencyMs(null);
    });
    const offLatency = window.soul.onLatencyUpdate(({ ms }) => setLatencyMs(ms));
    const offProfiles = window.soul.onProfilesChanged(() => refresh());
    const offOpenSettings = window.soul.onOpenSettings(() => setShowSettings(true));
    return () => { offState(); offLatency(); offProfiles(); offOpenSettings(); };
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

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  return (
    <div className="app-shell">
      <div className="titlebar">
        <div className="mark" />
        <div className="name">
          Soul Connection
          <small>کلاینت V2Ray / Xray</small>
        </div>
        <button className="icon-btn no-drag" onClick={() => setShowSettings(true)} title="تنظیمات">⚙</button>
      </div>

      <ConnectHero
        connectionState={connectionState}
        connectionMode={connectionMode}
        activeProfile={activeProfile}
        connectedAt={connectedAt}
        latencyMs={latencyMs}
        onToggle={handleToggleConnect}
        onSetMode={handleSetMode}
      />

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
              {bestServerBusy ? '…' : '⚡'}
            </button>
            <button className="icon-btn" onClick={() => setShowAdd(true)} title="افزودن">＋</button>
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
          onRefreshSubscription={handleRefreshSubscription}
          onUpdateAllSubscriptions={handleUpdateAllSubscriptions}
          onDeleteSubscription={handleDeleteSubscription}
        />
      </div>

      {showAdd && (
        <AddModal
          onClose={() => setShowAdd(false)}
          onAddLink={handleAddLink}
          onAddSubscription={handleAddSubscription}
        />
      )}

      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettings(false)}
          onUpdate={handleUpdateSettings}
          onOpenLogsFolder={() => window.soul.openLogsFolder()}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
