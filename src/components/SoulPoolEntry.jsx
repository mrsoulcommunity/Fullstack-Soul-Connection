import React from 'react';
import Icon from './Icon.jsx';

// The "Soul Connection servers" row, pinned above the user's own list.
//
// It is a *selection*, not a server: choosing it means "when I press connect,
// find me the best one". So it sits in the same visual family as a server row
// and takes the same active highlight, but it never shows a ping or a menu --
// there is no single host behind it to describe.
function progressText(progress, connectionState) {
  if (!progress) return null;
  switch (progress.phase) {
    case 'fetching':
      return 'در حال دریافت فهرست سرورها…';
    case 'probing':
      return `بررسی سرورها… ${progress.done} از ${progress.total}`;
    case 'testing':
      return `تست کیفیت اتصال… ${progress.done} از ${progress.total}`;
    case 'connecting':
      return `اتصال به ${progress.server}`;
    case 'done':
      if (connectionState !== 'connected') return null;
      // pingOnly means no tunnel test passed and this server was chosen on
      // reachability alone -- don't quote a latency we didn't measure through
      // the tunnel as though we had.
      return progress.pingOnly
        ? `${progress.server} — انتخاب بر پایه‌ی پینگ`
        : `${progress.server} — ${progress.avg}ms`;
    case 'error':
      return progress.message || null;
    default:
      return null;
  }
}

function SoulPoolEntry({
  enabled, count, connectionState, progress, activeSoulProfile, busy,
  onSelect, onRefresh, refreshing,
}) {
  const selecting = !!progress && ['fetching', 'probing', 'testing', 'connecting'].includes(progress.phase);
  const failed = progress?.phase === 'error' && progress.message;
  const live = enabled && connectionState === 'connected' && activeSoulProfile;

  const detail = progressText(progress, connectionState)
    || (live ? `${activeSoulProfile.name}` : null)
    || (count ? `${count} سرور — انتخاب خودکار بهترین` : 'انتخاب خودکار بهترین سرور');

  return (
    <div className={`soul-entry ${enabled ? 'active' : ''} ${selecting ? 'working' : ''} ${failed ? 'failed' : ''}`}>
      <button
        type="button"
        className="soul-entry-main"
        onClick={onSelect}
        disabled={busy}
        aria-pressed={enabled}
        title="اتصال خودکار به بهترین سرور سول کانکشن"
      >
        <span className="soul-entry-badge">
          <Icon name={selecting ? 'radar' : 'shield'} size={16} />
        </span>
        <span className="soul-entry-text">
          <span className="soul-entry-title">سرورهای سول کانکشن</span>
          <span className="soul-entry-sub">{detail}</span>
        </span>
        {live && <span className="soul-entry-live" aria-label="متصل" />}
      </button>

      <button
        className="soul-entry-refresh"
        onClick={onRefresh}
        disabled={refreshing || selecting}
        title="به‌روزرسانی فهرست سرورها"
      >
        <Icon name="refresh" size={13} className={refreshing ? 'spin' : ''} />
      </button>

      {selecting && progress.total > 0 && (
        <div className="soul-entry-progress">
          <div
            className="soul-entry-progress-fill"
            style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default React.memo(SoulPoolEntry);
