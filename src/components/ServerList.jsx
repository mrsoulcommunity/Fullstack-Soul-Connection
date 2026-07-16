import React, { useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { formatBytes } from '../utils/format.js';

function pingClass(ms) {
  if (ms === undefined) return 'na';
  if (ms === 'measuring') return 'na';
  if (ms === -1) return 'bad';
  if (ms < 150) return 'good';
  if (ms < 400) return 'mid';
  return 'bad';
}

function pingLabel(ms) {
  if (ms === undefined) return 'پینگ';
  if (ms === 'measuring') return '…';
  if (ms === -1) return 'خطا';
  return `${ms}ms`;
}

function relativeTime(ts) {
  if (!ts) return 'هرگز';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'همین الان';
  if (min < 60) return `${min} دقیقه پیش`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ساعت پیش`;
  const day = Math.floor(hr / 24);
  return `${day} روز پیش`;
}

function ServerCard({ profile, active, ms, onSelect, onDelete, onPing }) {
  return (
    <div className={`server-card ${active ? 'active' : ''}`}>
      <span className="proto-tag">{profile.protocol}</span>
      <div className="info" onClick={() => onSelect(profile.id)}>
        <div className="name">{profile.name || profile.address}</div>
        <div className="addr mono">
          {profile.address}:{profile.port}
          {profile.totalBytes > 0 && <span className="usage-tag"> · {formatBytes(profile.totalBytes)}</span>}
        </div>
      </div>
      <button className={`ping ${pingClass(ms)}`} onClick={() => onPing(profile.id)}>
        {pingLabel(ms)}
      </button>
      <button className="del" onClick={() => onDelete(profile.id)} title="حذف">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

export default function ServerList({
  profiles, subscriptions, activeProfileId, pings, updatingSubs,
  onSelect, onDelete, onPing, onPingAll, onAdd,
  onRefreshSubscription, onUpdateAllSubscriptions, onDeleteSubscription,
}) {
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState('default');
  const [collapsed, setCollapsed] = useState({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = !q ? profiles : profiles.filter((p) =>
      (p.name || '').toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q)
    );
    if (sortBy === 'name') {
      list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortBy === 'ping') {
      list = [...list].sort((a, b) => {
        const ma = pings[a.id]; const mb = pings[b.id];
        const va = typeof ma === 'number' && ma > 0 ? ma : Infinity;
        const vb = typeof mb === 'number' && mb > 0 ? mb : Infinity;
        return va - vb;
      });
    }
    return list;
  }, [profiles, query, sortBy, pings]);

  const groups = useMemoGroups(filtered, subscriptions);

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
        <button className="icon-btn" title="پینگ همه" onClick={() => onPingAll(filtered.map((p) => p.id))}>
          <Icon name="refresh" size={15} />
        </button>
      </div>

      {subscriptions.length > 0 && (
        <button className="update-all-btn" onClick={onUpdateAllSubscriptions} disabled={updatingSubs}>
          {updatingSubs ? 'در حال به‌روزرسانی…' : 'به‌روزرسانی همه‌ی ساب‌اسکریپشن‌ها'}
        </button>
      )}

      <div className="list">
        {groups.map((group) => (
          <div key={group.key} className="server-group">
            {group.sub && (
              <div className="group-head">
                <button
                  className="group-toggle"
                  onClick={() => setCollapsed((c) => ({ ...c, [group.key]: !c[group.key] }))}
                >
                  <span className={`chev ${collapsed[group.key] ? 'closed' : ''}`}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <span className="group-name">{group.sub.name}</span>
                  <span className="group-meta mono">به‌روزرسانی: {relativeTime(group.sub.lastUpdated)}</span>
                </button>
                <button className="group-action" onClick={() => onRefreshSubscription(group.sub.id)} title="به‌روزرسانی">
                  <Icon name="refresh" size={13} />
                </button>
                <button className="group-action danger" onClick={() => onDeleteSubscription(group.sub.id)} title="حذف ساب‌اسکریپشن">
                  <Icon name="close" size={13} />
                </button>
              </div>
            )}
            {!collapsed[group.key] && group.items.map((p) => (
              <ServerCard
                key={p.id}
                profile={p}
                active={p.id === activeProfileId}
                ms={pings[p.id]}
                onSelect={onSelect}
                onDelete={onDelete}
                onPing={onPing}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function useMemoGroups(filtered, subscriptions) {
  return useMemo(() => {
    const bySub = new Map();
    const noGroup = [];
    for (const p of filtered) {
      if (p.subId) {
        if (!bySub.has(p.subId)) bySub.set(p.subId, []);
        bySub.get(p.subId).push(p);
      } else {
        noGroup.push(p);
      }
    }
    const groups = [];
    for (const sub of subscriptions) {
      const items = bySub.get(sub.id) || [];
      if (items.length) groups.push({ key: sub.id, sub, items });
    }
    if (noGroup.length) groups.push({ key: 'none', sub: null, items: noGroup });
    return groups;
  }, [filtered, subscriptions]);
}
