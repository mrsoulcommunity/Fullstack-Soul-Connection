import React, { useState } from 'react';

export default function AddModal({ onClose, onAddLink, onAddSubscription }) {
  const [tab, setTab] = useState('link');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!value.trim()) return;
    setError('');
    setLoading(true);
    try {
      if (tab === 'link') {
        await onAddLink(value.trim());
      } else {
        await onAddSubscription(value.trim());
      }
    } catch (err) {
      setError(err.message || 'خطا رخ داد');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>افزودن کانفیگ</h3>
        <p className="hint">لینک vmess://, vless://, trojan:// یا ss:// یا یک آدرس ساب‌اسکریپشن وارد کن.</p>

        <div className="tabs">
          <button className={`tab ${tab === 'link' ? 'active' : ''}`} onClick={() => setTab('link')}>
            لینک تکی
          </button>
          <button className={`tab ${tab === 'sub' ? 'active' : ''}`} onClick={() => setTab('sub')}>
            ساب‌اسکریپشن
          </button>
        </div>

        {tab === 'link' ? (
          <textarea
            className="mono"
            placeholder="vmess://..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        ) : (
          <input
            className="mono"
            placeholder="https://example.com/sub"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        )}

        {error && <div className="error-msg">{error}</div>}

        <div className="row">
          <button className="btn" onClick={onClose}>انصراف</button>
          <button className="btn primary" onClick={handleSubmit} disabled={loading || !value.trim()}>
            {loading ? 'در حال افزودن…' : 'افزودن'}
          </button>
        </div>
      </div>
    </div>
  );
}
