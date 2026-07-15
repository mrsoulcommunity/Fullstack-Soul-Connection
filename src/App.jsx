import React, { useEffect, useState, useCallback } from 'react';
import ServerList from './components/ServerList.jsx';
import AddModal from './components/AddModal.jsx';
import ConnectHero from './components/ConnectHero.jsx';

export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [connectionMode, setConnectionMode] = useState('proxy');
  const [connectionState, setConnectionState] = useState('disconnected');
  const [pings, setPings] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const data = await window.soul.listProfiles();
    setProfiles(data.profiles);
    setSubscriptions(data.subscriptions);
    setActiveProfileId(data.activeProfileId);
    setConnectionMode(data.connectionMode);
    setConnectionState(data.connectionState);
  }, []);

  useEffect(() => {
    refresh();
    const off = window.soul.onStateChanged(({ connectionState, activeProfileId }) => {
      setConnectionState(connectionState);
      setActiveProfileId(activeProfileId);
    });
    return off;
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
    } catch {
      setPings((p) => ({ ...p, [id]: -1 }));
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

  async function handleSetMode(mode) {
    if (mode === connectionMode || connectionState !== 'disconnected') return;
    try {
      await window.soul.setMode(mode);
      setConnectionMode(mode);
    } catch (err) {
      showToast(err.message || 'خطا در تغییر حالت');
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
      </div>

      <ConnectHero
        connectionState={connectionState}
        connectionMode={connectionMode}
        activeProfile={activeProfile}
        onToggle={handleToggleConnect}
        onSetMode={handleSetMode}
      />

      <div className="body">
        <div className="section-head">
          <h2>کانفیگ‌ها</h2>
          <button className="icon-btn" onClick={() => setShowAdd(true)} title="افزودن">＋</button>
        </div>
        <ServerList
          profiles={profiles}
          subscriptions={subscriptions}
          activeProfileId={activeProfileId}
          pings={pings}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onPing={handlePing}
        />
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
