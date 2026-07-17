import React from 'react';
import Icon from './Icon.jsx';

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

function ConnectHero({ connectionState, connectionMode, activeProfile, onToggle, onSetMode }) {
  const busy = connectionState === 'connecting' || connectionState === 'disconnecting';
  const modeLocked = connectionState !== 'disconnected';

  return (
    <section className={`stage ${connectionState}`}>
      <div className="aurora aurora-idle" aria-hidden="true" />
      <div className="aurora aurora-live" aria-hidden="true" />

      <div className={`ring-wrap ${connectionState}`}>
        <div className="ring-halo" aria-hidden="true" />
        <svg className="ring-svg" viewBox="0 0 200 200" aria-hidden="true">
          <circle className="ring-track" cx="100" cy="100" r="88" />
          <circle className="ring-spin" cx="100" cy="100" r="88" />
          <circle className="ring-arc" cx="100" cy="100" r="88" />
        </svg>
        <button className="connect-btn" onClick={onToggle} disabled={busy}>
          <Icon name="power" size={32} strokeWidth={2.2} />
          <span className="label">{LABELS[connectionState]}</span>
        </button>
      </div>

      <div className="stage-status">
        <span className={`status-dot ${connectionState}`} />
        {STATUS_TEXT[connectionState]}
      </div>

      <div className="stage-server">
        {activeProfile ? (
          <>
            <span className="name">{activeProfile.name || activeProfile.address}</span>
            <span className="addr mono">{activeProfile.address}:{activeProfile.port}</span>
          </>
        ) : (
          'سروری انتخاب نشده — از فهرست کناری یکی را انتخاب کن'
        )}
      </div>

      <div className={`mode-switch ${connectionMode === 'tun' ? 'tun' : ''}`}>
        <span className="mode-thumb" aria-hidden="true" />
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
      <div className="mode-hint">
        {modeLocked ? 'برای تغییر حالت، اول اتصال را قطع کن' : ''}
      </div>
    </section>
  );
}

// Doesn't depend on `pings`/`traffic` -- memoized so App's 1s traffic-poll
// re-render and ping-all bursts don't repaint this whole animated hero.
export default React.memo(ConnectHero);
