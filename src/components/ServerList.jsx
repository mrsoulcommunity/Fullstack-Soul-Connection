import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import ContextMenu from './ContextMenu.jsx';
import { RenameModal, EditProfileModal, EditSubscriptionModal, SubscriptionDetailsModal, ConfirmModal } from './ManageModals.jsx';
import QrModal from './QrModal.jsx';
import SubTestModal from './SubTestModal.jsx';
import * as engine from '../finder/testEngine.js';
import { formatBytes, relativeTime, subUsageInfo } from '../utils/format.js';
import { isMeasuring, pingMs, pingTone, pingTitle, toneForMs } from '../utils/ping.js';

function groupStats(items, pings) {
  const totalBytes = items.reduce((sum, p) => sum + (p.totalBytes || 0), 0);
  const measured = items.map((p) => pingMs(pings[p.id])).filter((v) => v != null && v >= 0);
  const bestPing = measured.length ? Math.min(...measured) : undefined;
  return { totalBytes, bestPing };
}

// The measured value, or the reason there isn't one. Deliberately terse: this
// pill sits in a 296px sidebar next to a name that needs the room, and the full
// breakdown (median / min / max / jitter / loss / method) lives in the tooltip.
function PingPill({ entry, onClick }) {
  const measuring = isMeasuring(entry);
  const ms = pingMs(entry);
  const failed = !!entry && entry.status === 'fail';

  return (
    <button
      className={`ping ${pingTone(entry)} ${measuring ? 'measuring' : ''} ${entry?.method === 'tunnel' ? 'via-tunnel' : ''}`}
      onClick={onClick}
      title={pingTitle(entry)}
      aria-busy={measuring || undefined}
    >
      {measuring && <span className="ping-dots" aria-hidden="true"><i /><i /><i /></span>}
      {ms != null ? (
        // Keyed on the measurement time so a fresh reading remounts and
        // replays its entrance -- the row visibly confirms it just updated.
        <span key={entry.at || 'v'} className="ping-num">
          {ms}
          <span className="ping-unit">ms</span>
        </span>
      ) : !measuring && (
        <span className="ping-num">{failed ? '؟' : '—'}</span>
      )}
    </button>
  );
}

// Memoized so a ping/traffic tick that changes one card's `ms` (or unrelated
// App state) doesn't re-render every other card in a list that can run into
// the hundreds. Relies on `onSelect`/`onDelete`/`onPing`/`onContextMenu` being
// referentially stable (useCallback'd) across unrelated re-renders.
const ServerCard = React.memo(function ServerCard({ profile, active, ping, onSelect, onRequestDelete, onPing, onContextMenu }) {
  return (
    <div className={`server-card ${active ? 'active' : ''}`} onContextMenu={(e) => onContextMenu(e, profile)}>
      <span className="proto-tag">{profile.protocol}</span>
      <div className="info" onClick={() => onSelect(profile.id)}>
        <div className="name">
          {profile.favorite && <Icon name="star" size={10} className="fav-mark" />}
          {profile.name || profile.address}
        </div>
        <div className="addr mono">
          {profile.address}:{profile.port}
          {profile.totalBytes > 0 && <span className="usage-tag"> · {formatBytes(profile.totalBytes)}</span>}
        </div>
      </div>
      <PingPill entry={ping} onClick={() => onPing(profile.id)} />
      <button className="del" onClick={() => onRequestDelete(profile)} title="حذف">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
});

export default function ServerList({
  profiles, subscriptions, activeProfileId, connectionState, pings, updatingSubs, refreshingSubIds,
  onSelect, onDelete, onPing, onPingAll, onAdd,
  onRefreshSubscription, onUpdateAllSubscriptions, onDeleteSubscription,
  onConnectTo, onDisconnect, onRenameProfile, onEditProfile, onUpdateSubscription, onToast,
  initialQuery, initialSortBy, initialCollapsed, onSessionChange,
}) {
  const [query, setQuery] = useState(initialQuery || '');
  const [sortBy, setSortBy] = useState(initialSortBy || 'default');
  const [collapsed, setCollapsed] = useState(initialCollapsed || {});
  const [ctxMenu, setCtxMenu] = useState(null);
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [testModal, setTestModal] = useState(null); // { sub, mode, autoConnectBest }
  const [pingingAll, setPingingAll] = useState(false);

  // "Restore Previous Session" -- reports query/sortBy/collapsed up (debounced)
  // whenever they change, so App.jsx can persist them; a no-op when the
  // feature is off (onSessionChange is undefined in that case).
  useEffect(() => {
    if (!onSessionChange) return undefined;
    const t = setTimeout(() => onSessionChange({ query, sortBy, collapsed }), 300);
    return () => clearTimeout(t);
  }, [query, sortBy, collapsed, onSessionChange]);

  // Signals the global Ctrl+V handler in App.jsx that a menu/modal owned by
  // this component is open, so it doesn't add clipboard content behind it.
  useEffect(() => {
    document.body.dataset.modalOpen = (modal || ctxMenu || confirmDelete || testModal) ? 'true' : 'false';
    return () => { document.body.dataset.modalOpen = 'false'; };
  }, [modal, ctxMenu, confirmDelete, testModal]);

  const requestDeleteProfile = useCallback((profile) => {
    setConfirmDelete({ type: 'profile', id: profile.id, label: profile.name || profile.address });
  }, []);

  const requestDeleteSubscription = useCallback((sub) => {
    setConfirmDelete({ type: 'subscription', id: sub.id, label: sub.name });
  }, []);

  // Both "Ping All Servers" and "Connect to Best Server" run a scoped batch
  // through the shared Server Finder engine — only one batch can run at a
  // time app-wide, so bail out with a toast instead of hijacking one that's
  // already in flight (e.g. started from the finder).
  const startSubTest = useCallback((sub, mode, autoConnectBest) => {
    if (engine.getSnapshot().status !== 'idle') {
      onToast?.('یک تست دیگر در حال اجراست — صبر کن تا تمام شود', 'error');
      return;
    }
    const subProfiles = profiles.filter((p) => p.subId === sub.id);
    if (!subProfiles.length) {
      onToast?.('این ساب‌اسکریپشن کانفیگی ندارد', 'error');
      return;
    }
    setTestModal({ sub, mode, autoConnectBest });
  }, [profiles, onToast]);

  // useCallback'd (with only truly-hot-changing deps) so this stays a stable
  // reference across ping/traffic-driven re-renders, letting ServerCard's
  // React.memo actually skip re-rendering unaffected cards.
  const copyText = useCallback((text, msg) => {
    navigator.clipboard?.writeText(text)
      .then(() => onToast?.(msg))
      .catch(() => onToast?.('کپی ناموفق بود', 'error'));
  }, [onToast]);

  const openProfileMenu = useCallback((e, profile) => {
    e.preventDefault();
    const isActiveConnected = profile.id === activeProfileId && (connectionState === 'connected' || connectionState === 'connecting');
    const items = [
      isActiveConnected
        ? { icon: 'stop', label: 'قطع اتصال', onClick: () => onDisconnect() }
        : { icon: 'power', label: 'اتصال', onClick: () => onConnectTo(profile.id) },
      { icon: 'gauge', label: 'نمایش پینگ', onClick: () => onPing(profile.id) },
      { icon: 'edit', label: 'ویرایش', sepBefore: true, onClick: () => setModal({ type: 'editProfile', profile }) },
      { icon: 'edit', label: 'تغییر نام', onClick: () => setModal({ type: 'renameProfile', profile }) },
      { icon: 'copy', label: 'کپی', onClick: () => copyText(profile.link, 'لینک کپی شد') },
      { icon: 'arrowUp', label: 'اشتراک‌گذاری / خروجی گرفتن', onClick: () => copyText(profile.link, 'لینک برای اشتراک‌گذاری کپی شد') },
      { icon: 'qrcode', label: 'اشتراک‌گذاری با QR', onClick: () => setModal({ type: 'qr', value: profile.link, title: profile.name || profile.address, subtitle: `${profile.address}:${profile.port}` }) },
      { icon: 'trash', label: 'حذف', danger: true, sepBefore: true, onClick: () => requestDeleteProfile(profile) },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, title: profile.name || profile.address, items });
  }, [activeProfileId, connectionState, onDisconnect, onConnectTo, onPing, requestDeleteProfile, copyText]);

  const openSubMenu = useCallback((e, sub) => {
    e.preventDefault();
    const items = [
      { icon: 'bolt', label: 'اتصال به بهترین سرور', onClick: () => startSubTest(sub, 'ping', true) },
      { icon: 'gauge', label: 'پینگ گرفتن از تمام سرورها', onClick: () => startSubTest(sub, 'ping', false) },
      { icon: 'refresh', label: 'به‌روزرسانی ساب‌اسکریپشن', sepBefore: true, onClick: () => onRefreshSubscription(sub.id) },
      { icon: 'edit', label: 'ویرایش', sepBefore: true, onClick: () => setModal({ type: 'editSub', sub }) },
      { icon: 'edit', label: 'تغییر نام', onClick: () => setModal({ type: 'renameSub', sub }) },
      { icon: 'copy', label: 'کپی لینک', onClick: () => copyText(sub.url, 'لینک ساب‌اسکریپشن کپی شد') },
      { icon: 'qrcode', label: 'اشتراک‌گذاری با QR', onClick: () => setModal({ type: 'qr', value: sub.url, title: sub.name, subtitle: `${sub.configCount ?? 0} کانفیگ` }) },
      { icon: 'info', label: 'مشاهده اطلاعات', onClick: () => setModal({ type: 'details', sub }) },
      { icon: 'trash', label: 'حذف', danger: true, sepBefore: true, onClick: () => requestDeleteSubscription(sub) },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, title: sub.name, items });
  }, [onRefreshSubscription, requestDeleteSubscription, copyText, startSubTest]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = !q ? profiles : profiles.filter((p) =>
      (p.name || '').toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q)
    );
    if (sortBy === 'name') {
      list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortBy === 'ping') {
      list = [...list].sort((a, b) => {
        // Unmeasured and unreachable both sink to the bottom rather than
        // pretending to be fast.
        const va = pingMs(pings[a.id]);
        const vb = pingMs(pings[b.id]);
        return (va == null ? Infinity : va) - (vb == null ? Infinity : vb);
      });
    }
    return list;
  }, [profiles, query, sortBy, pings]);

  const groups = useMemoGroups(filtered, subscriptions, pings);

  // A real ping takes several samples per server, so a sweep over a large list
  // is measurably long -- the toolbar button becomes the progress readout for
  // it instead of sitting there looking idle.
  const measuringCount = useMemo(
    () => filtered.reduce((n, p) => n + (isMeasuring(pings[p.id]) ? 1 : 0), 0),
    [filtered, pings]
  );

  const runPingAll = useCallback(async () => {
    if (pingingAll) return;
    setPingingAll(true);
    try {
      await onPingAll(filtered.map((p) => p.id));
    } finally {
      setPingingAll(false);
    }
  }, [pingingAll, onPingAll, filtered]);

  if (!profiles.length) {
    return (
      <div className="empty-state">
        <div className="empty-glyph">
          <Icon name="signal" size={30} strokeWidth={2.25} />
        </div>
        <h3>هنوز سروری وصل نکرده‌ای</h3>
        <p>یک لینک کانفیگ یا آدرس ساب‌اسکریپشن اضافه کن تا اولین اتصالت رو بزنی.</p>
        <button className="btn primary empty-cta" onClick={onAdd}>
          <Icon name="plus" size={15} />
          افزودن کانفیگ
        </button>
      </div>
    );
  }

  return (
    <div className="list-wrap">
      <div className="list-toolbar">
        <div className="search-box">
          <Icon name="search" size={14} className="search-icon" />
          <input
            className="search-input"
            placeholder="جست‌وجو…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className="sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="default">پیش‌فرض</option>
          <option value="ping">پینگ</option>
          <option value="name">نام</option>
        </select>
        <button
          className={`icon-btn ping-all ${pingingAll ? 'busy' : ''}`}
          title={pingingAll ? `در حال اندازه‌گیری پینگ واقعی… (${measuringCount} سرور باقی مانده)` : 'اندازه‌گیری پینگ واقعی همه‌ی سرورها'}
          onClick={runPingAll}
          disabled={pingingAll}
        >
          {pingingAll
            ? <span className="icon-spinner" aria-hidden="true" />
            : <Icon name="gauge" size={15} />}
        </button>
      </div>

      {subscriptions.length > 0 && (
        <button className="update-all-btn" onClick={onUpdateAllSubscriptions} disabled={updatingSubs}>
          {updatingSubs && <span className="icon-spinner" aria-hidden="true" />}
          {updatingSubs ? 'در حال به‌روزرسانی…' : 'به‌روزرسانی همه‌ی ساب‌اسکریپشن‌ها'}
        </button>
      )}

      <div className="list">
        {groups.map((group) => {
          const usageInfo = !group.local ? subUsageInfo(group.sub) : null;
          const critical = usageInfo && (usageInfo.expired || usageInfo.exhausted);
          return (
          <div key={group.key} className={`server-group ${group.local ? 'local-group' : ''}`}>
            {(group.sub || group.local) && (
              <div
                className={`group-head ${group.local ? 'local' : ''} ${critical ? 'critical' : ''}`}
                onContextMenu={!group.local ? (e) => openSubMenu(e, group.sub) : undefined}
              >
                <div className="group-head-row">
                  <button
                    className="group-toggle"
                    onClick={() => setCollapsed((c) => ({ ...c, [group.key]: !c[group.key] }))}
                  >
                    <span className={`chev ${collapsed[group.key] ? 'closed' : ''}`}>
                      <Icon name="chevron" size={12} />
                    </span>
                    {group.local && <Icon name="folder" size={12} className="local-icon" />}
                    <span className="group-name">{group.local ? 'لوکال' : group.sub.name}</span>
                    <span className="group-stats">
                      {group.stats.totalBytes > 0 && (
                        <span className="stat-chip size">{formatBytes(group.stats.totalBytes)}</span>
                      )}
                      <span
                        className={`stat-chip ping ${toneForMs(group.stats.bestPing ?? null)}`}
                        title={group.stats.bestPing !== undefined ? 'بهترین پینگ اندازه‌گیری‌شده در این گروه' : 'هنوز پینگی گرفته نشده'}
                      >
                        {group.stats.bestPing !== undefined ? `${group.stats.bestPing}ms` : '—'}
                      </span>
                    </span>
                    {!group.local && <span className="group-meta">{relativeTime(group.sub.lastUpdated)}</span>}
                  </button>
                  {!group.local && (
                    <>
                      <button
                        className="group-action"
                        onClick={() => onRefreshSubscription(group.sub.id)}
                        disabled={refreshingSubIds?.has(group.sub.id)}
                        title="به‌روزرسانی"
                      >
                        {refreshingSubIds?.has(group.sub.id)
                          ? <span className="icon-spinner" aria-hidden="true" />
                          : <Icon name="refresh" size={13} />}
                      </button>
                      <button className="group-action danger" onClick={() => requestDeleteSubscription(group.sub)} title="حذف ساب‌اسکریپشن">
                        <Icon name="close" size={13} />
                      </button>
                    </>
                  )}
                </div>
                {usageInfo && (
                  <div className="sub-usage">
                    <div className="usage-bar-track">
                      <div
                        className={`usage-bar-fill ${critical ? 'critical' : ''}`}
                        style={{ transform: `scaleX(${Math.max(usageInfo.total > 0 ? usageInfo.pct : 0, usageInfo.total > 0 ? 2 : 0) / 100})` }}
                      />
                    </div>
                    <div className="usage-row">
                      <span className="usage-text">
                        {usageInfo.total > 0
                          ? `${formatBytes(usageInfo.used)} / ${formatBytes(usageInfo.total)}`
                          : formatBytes(usageInfo.used)}
                      </span>
                      {usageInfo.daysLeft !== null && (
                        <span className={`usage-expiry ${usageInfo.expired ? 'critical' : ''}`}>
                          {usageInfo.expired ? 'منقضی شده' : `${usageInfo.daysLeft} روز تا انقضا`}
                        </span>
                      )}
                    </div>
                    {critical && (
                      <div className="usage-warn">
                        <Icon name="info" size={11} />
                        {usageInfo.expired ? 'این ساب‌اسکریپشن منقضی شده است' : 'حجم این ساب‌اسکریپشن به پایان رسیده است'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {!collapsed[group.key] && group.items.map((p) => (
              <ServerCard
                key={p.id}
                profile={p}
                active={p.id === activeProfileId}
                ping={pings[p.id]}
                onSelect={onSelect}
                onRequestDelete={requestDeleteProfile}
                onPing={onPing}
                onContextMenu={openProfileMenu}
              />
            ))}
          </div>
          );
        })}
      </div>

      {ctxMenu && <ContextMenu {...ctxMenu} onClose={() => setCtxMenu(null)} />}

      {modal?.type === 'renameProfile' && (
        <RenameModal
          title="تغییر نام کانفیگ"
          initialValue={modal.profile.name}
          onClose={() => setModal(null)}
          onSubmit={(name) => onRenameProfile(modal.profile.id, name)}
        />
      )}
      {modal?.type === 'editProfile' && (
        <EditProfileModal
          profile={modal.profile}
          onClose={() => setModal(null)}
          onSubmit={(link) => onEditProfile(modal.profile.id, link)}
        />
      )}
      {modal?.type === 'renameSub' && (
        <RenameModal
          title="تغییر نام ساب‌اسکریپشن"
          initialValue={modal.sub.name}
          onClose={() => setModal(null)}
          onSubmit={(name) => onUpdateSubscription(modal.sub.id, { name })}
        />
      )}
      {modal?.type === 'editSub' && (
        <EditSubscriptionModal
          sub={modal.sub}
          onClose={() => setModal(null)}
          onSubmit={(patch) => onUpdateSubscription(modal.sub.id, patch)}
        />
      )}
      {modal?.type === 'details' && (
        <SubscriptionDetailsModal sub={modal.sub} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'qr' && (
        <QrModal
          title={modal.title}
          subtitle={modal.subtitle}
          value={modal.value}
          onClose={() => setModal(null)}
          onToast={onToast}
        />
      )}

      {testModal && (
        <SubTestModal
          sub={testModal.sub}
          profiles={profiles}
          mode={testModal.mode}
          autoConnectBest={testModal.autoConnectBest}
          activeProfileId={activeProfileId}
          connectionState={connectionState}
          onConnect={onConnectTo}
          onClose={() => setTestModal(null)}
          onToast={onToast}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={confirmDelete.type === 'subscription' ? 'حذف ساب‌اسکریپشن' : 'حذف کانفیگ'}
          message={
            `آیا از حذف ${confirmDelete.label ? `"${confirmDelete.label}"` : 'این مورد'} مطمئن هستید؟ ` +
            'این عملیات غیرقابل بازگشت است.'
          }
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            if (confirmDelete.type === 'subscription') onDeleteSubscription(confirmDelete.id);
            else onDelete(confirmDelete.id);
          }}
        />
      )}
    </div>
  );
}

function useMemoGroups(filtered, subscriptions, pings) {
  return useMemo(() => {
    const bySub = new Map();
    const noGroup = [];
    // Groups are rendered by walking `subscriptions`, so a profile tagged with
    // a subId that no longer exists (restored backup, data file from an older
    // build) would land in a group that never renders -- invisible in the list
    // while still counted everywhere else. Treat those as local configs.
    const knownSubIds = new Set(subscriptions.map((s) => s.id));
    for (const p of filtered) {
      if (p.subId && knownSubIds.has(p.subId)) {
        if (!bySub.has(p.subId)) bySub.set(p.subId, []);
        bySub.get(p.subId).push(p);
      } else {
        noGroup.push(p);
      }
    }
    const groups = [];
    if (noGroup.length) groups.push({ key: 'none', sub: null, local: true, items: noGroup, stats: groupStats(noGroup, pings) });
    for (const sub of subscriptions) {
      const items = bySub.get(sub.id) || [];
      if (items.length) groups.push({ key: sub.id, sub, items, stats: groupStats(items, pings) });
    }
    return groups;
  }, [filtered, subscriptions, pings]);
}
