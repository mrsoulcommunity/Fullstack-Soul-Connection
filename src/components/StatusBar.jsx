import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { formatBytes, formatSpeed } from '../utils/format.js';

const SHORT_STATUS = {
  disconnected: 'قطع',
  connecting: 'در حال اتصال…',
  connected: 'متصل',
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

function StatusBar({ connectionState, activeProfile, connectedAt, latencyMs, selectedPing, traffic, notice }) {
  const connected = connectionState === 'connected';
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!connected || !connectedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connected, connectedAt]);

  const duration = connected && connectedAt ? formatDuration(now - connectedAt) : null;

  // Live tunnel latency once connected; the last manual ping of the
  // selected server otherwise, so the rail is never empty for no reason.
  const ping = connected
    ? latencyMs
    : (typeof selectedPing === 'number' && selectedPing > 0 ? selectedPing : null);
  const pingText = connected && latencyMs == null
    ? '…'
    : ping == null ? '—' : ping < 0 ? 'بدون پاسخ' : `${ping}ms`;

  return (
    <footer className="status-rail">
      <div className="rail-seg">
        <span className="rail-label">وضعیت</span>
        <span className="rail-value">
          <span className={`status-dot ${connectionState}`} />
          {SHORT_STATUS[connectionState]}
        </span>
      </div>

      <div className="rail-seg grow">
        <span className="rail-label">سرور</span>
        <span className="rail-value" title={activeProfile ? `${activeProfile.address}:${activeProfile.port}` : undefined}>
          {activeProfile ? (activeProfile.name || activeProfile.address) : '—'}
        </span>
      </div>

      <div className="rail-seg">
        <span className="rail-label">پینگ</span>
        <span className={`rail-value mono tone-${latencyTone(ping)}`}>{pingText}</span>
      </div>

      <div className="rail-seg">
        <span className="rail-label">سرعت</span>
        <span className="rail-value mono">
          {connected && traffic ? (
            <>
              <span className="speed-down">
                <Icon name="arrowDown" size={11} />
                {formatSpeed(traffic.downlinkSpeed)}
              </span>
              <span className="speed-up">
                <Icon name="arrowUp" size={11} />
                {formatSpeed(traffic.uplinkSpeed)}
              </span>
            </>
          ) : '—'}
        </span>
      </div>

      <div className="rail-seg optional">
        <span className="rail-label">مصرف نشست</span>
        <span className="rail-value mono">
          {connected && traffic ? formatBytes(traffic.sessionTotal) : '—'}
        </span>
      </div>

      <div className="rail-seg">
        <span className="rail-label">مدت اتصال</span>
        <span className="rail-value mono">{duration ?? '—'}</span>
      </div>

      {notice && (
        <div className={`rail-notice ${notice.type === 'error' ? 'error' : ''}`} role="status">
          <Icon name="info" size={14} />
          {notice.msg}
        </div>
      )}
    </footer>
  );
}

// `selectedPing`/`activeProfile` are usually unchanged on any given ping-all
// tick (only the pinged profile's value moves), so memoizing skips a re-render
// of this whole footer for every other tick.
export default React.memo(StatusBar);
