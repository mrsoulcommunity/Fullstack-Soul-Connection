import React from 'react';

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

export default function ServerList({ profiles, activeProfileId, pings, onSelect, onDelete, onPing }) {
  if (!profiles.length) {
    return (
      <div className="empty">
        هنوز کانفیگی اضافه نکردی.<br />
        با دکمه‌ی ＋ یک لینک vmess/vless/trojan/ss یا یک ساب‌اسکریپشن اضافه کن.
      </div>
    );
  }

  return (
    <div className="list">
      {profiles.map((p) => {
        const ms = pings[p.id];
        return (
          <div key={p.id} className={`server-card ${p.id === activeProfileId ? 'active' : ''}`}>
            <span className="proto-tag">{p.protocol}</span>
            <div className="info" onClick={() => onSelect(p.id)}>
              <div className="name">{p.name || p.address}</div>
              <div className="addr mono">{p.address}:{p.port}</div>
            </div>
            <button className={`ping ${pingClass(ms)}`} onClick={() => onPing(p.id)}>
              {pingLabel(ms)}
            </button>
            <button className="del" onClick={() => onDelete(p.id)} title="حذف">✕</button>
          </div>
        );
      })}
    </div>
  );
}
