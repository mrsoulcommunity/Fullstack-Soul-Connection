import React, { useEffect, useState } from 'react';

const STATUS_TEXT = {
  disconnected: 'متصل نیستی',
  connecting: 'در حال برقراری تونل…',
  connected: 'اتصال برقرار است',
  disconnecting: 'در حال قطع اتصال…',
};

const LABELS = {
  disconnected: 'اتصال',
  connecting: 'در حال اتصال…',
  connected: 'قطع اتصال',
  disconnecting: 'در حال قطع…',
};

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function latencyTone(ms) {
  if (ms == null) return 'na';
  if (ms < 0) return 'bad';
  if (ms < 150) return 'good';
  if (ms < 400) return 'mid';
  return 'bad';
}

export default function ConnectHero({ connectionState, connectionMode, activeProfile, connectedAt, latencyMs, onToggle, onSetMode }) {
  const busy = connectionState === 'connecting' || connectionState === 'disconnecting';
  const modeLocked = connectionState !== 'disconnected';
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (connectionState !== 'connected' || !connectedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectionState, connectedAt]);

  const duration = connectionState === 'connected' && connectedAt ? formatDuration(now - connectedAt) : null;

  return (
    <div className="hero">
      <div className={`ring-wrap ${connectionState}`}>
        <div className="ring-pulse" />
        <button
          className={`connect-btn ${connectionState}`}
          onClick={onToggle}
          disabled={busy}
        >
          <span className="icon" />
          <span className="label">{LABELS[connectionState]}</span>
        </button>
      </div>
      <div className="status-line">
        <span className={`status-dot ${connectionState}`} />
        <span>{STATUS_TEXT[connectionState]}</span>
        {activeProfile && connectionState !== 'disconnected' && (
          <span className="mono" style={{ color: 'var(--text-faint)' }}>· {activeProfile.name}</span>
        )}
      </div>
      {connectionState === 'connected' && (
        <div className="session-strip">
          <span className={`latency-badge ${latencyTone(latencyMs)}`}>
            {latencyMs == null ? 'در حال سنجش…' : latencyMs < 0 ? 'بدون پاسخ' : `${latencyMs}ms`}
          </span>
          {duration && <span className="duration-badge mono">{duration}</span>}
        </div>
      )}
      <div className="mode-switch">
        <button
          className={`mode-pill ${connectionMode === 'proxy' ? 'active' : ''}`}
          disabled={modeLocked}
          onClick={() => onSetMode('proxy')}
        >
          پروکسی سیستم
        </button>
        <button
          className={`mode-pill ${connectionMode === 'tun' ? 'active' : ''}`}
          disabled={modeLocked}
          onClick={() => onSetMode('tun')}
        >
          تانل کامل
        </button>
      </div>
    </div>
  );
}
