import React from 'react';

const LABELS = {
  disconnected: 'اتصال',
  connecting: 'در حال اتصال…',
  connected: 'قطع اتصال',
  disconnecting: 'در حال قطع…',
};

const STATUS_TEXT = {
  disconnected: 'متصل نیستی',
  connecting: 'در حال برقراری تونل…',
  connected: 'اتصال برقرار است',
  disconnecting: 'در حال قطع اتصال…',
};

export default function ConnectHero({ connectionState, connectionMode, activeProfile, onToggle, onSetMode }) {
  const busy = connectionState === 'connecting' || connectionState === 'disconnecting';
  const modeLocked = connectionState !== 'disconnected';

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
