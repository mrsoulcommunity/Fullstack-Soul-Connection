import React, { useState } from 'react';
import Icon from './Icon.jsx';
import { formatBytes, relativeTime, subUsageInfo } from '../utils/format.js';

function Detail({ label, value, tone = 'na', ltr }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value tone-${tone} ${ltr ? 'mono' : ''}`}>{value}</span>
    </div>
  );
}

export function RenameModal({ title, initialValue, onSubmit, onClose }) {
  const [value, setValue] = useState(initialValue || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!value.trim()) return;
    setError('');
    setLoading(true);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (err) {
      setError(err.message || 'خطا رخ داد');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{title}</h3>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          autoFocus
        />
        {error && <div className="error-msg">{error}</div>}
        <div className="row">
          <button className="btn" onClick={onClose}>انصراف</button>
          <button className="btn primary" onClick={handleSubmit} disabled={loading || !value.trim()}>
            {loading ? 'در حال ذخیره…' : 'ذخیره'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditProfileModal({ profile, onSubmit, onClose }) {
  const [value, setValue] = useState(profile.link || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!value.trim()) return;
    setError('');
    setLoading(true);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (err) {
      setError(err.message || 'خطا رخ داد');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>ویرایش کانفیگ</h3>
        <p className="hint">لینک کانفیگ را ویرایش کن و ذخیره کن.</p>
        <textarea className="mono" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        {error && <div className="error-msg">{error}</div>}
        <div className="row">
          <button className="btn" onClick={onClose}>انصراف</button>
          <button className="btn primary" onClick={handleSubmit} disabled={loading || !value.trim()}>
            {loading ? 'در حال ذخیره…' : 'ذخیره'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditSubscriptionModal({ sub, onSubmit, onClose }) {
  const [name, setName] = useState(sub.name || '');
  const [url, setUrl] = useState(sub.url || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!name.trim() || !url.trim()) return;
    setError('');
    setLoading(true);
    try {
      await onSubmit({ name: name.trim(), url: url.trim() });
      onClose();
    } catch (err) {
      setError(err.message || 'خطا رخ داد');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>ویرایش ساب‌اسکریپشن</h3>
        <div className="field">
          <label className="field-label">نام</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label className="field-label">آدرس</label>
          <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        {error && <div className="error-msg">{error}</div>}
        <div className="row">
          <button className="btn" onClick={onClose}>انصراف</button>
          <button className="btn primary" onClick={handleSubmit} disabled={loading || !name.trim() || !url.trim()}>
            {loading ? 'در حال ذخیره…' : 'ذخیره'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmModal({ title, message, confirmLabel = 'حذف همیشگی', cancelLabel = 'انصراف', onConfirm, onClose }) {
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal confirm-modal">
        <div className="confirm-icon">
          <Icon name="info" size={19} />
        </div>
        <h3>{title}</h3>
        <p className="hint">{message}</p>
        <div className="row">
          <button className="btn" onClick={onClose}>{cancelLabel}</button>
          <button className="btn danger" onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function SubscriptionDetailsModal({ sub, onClose }) {
  const usageInfo = subUsageInfo(sub);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>جزئیات ساب‌اسکریپشن</h3>
        <div className="sub-url-row">
          <span className="sub-url mono">{sub.url}</span>
          <button
            className="icon-btn"
            onClick={() => navigator.clipboard?.writeText(sub.url).catch(() => {})}
            title="کپی آدرس"
          >
            <Icon name="copy" size={13} />
          </button>
        </div>
        <div className="detail-grid compact">
          <Detail label="نام" value={sub.name || '—'} />
          <Detail label="تعداد کانفیگ" value={String(sub.configCount ?? 0)} />
          <Detail label="ایجاد شده" value={sub.createdAt ? new Date(sub.createdAt).toLocaleDateString('fa-IR') : '—'} />
          <Detail label="آخرین به‌روزرسانی" value={relativeTime(sub.lastUpdated)} />
          {usageInfo && (
            <>
              <Detail
                label="حجم مصرفی"
                value={usageInfo.total > 0 ? `${formatBytes(usageInfo.used)} / ${formatBytes(usageInfo.total)}` : formatBytes(usageInfo.used)}
                ltr
              />
              <Detail
                label="انقضا"
                value={usageInfo.daysLeft !== null ? (usageInfo.expired ? 'منقضی شده' : `${usageInfo.daysLeft} روز مانده`) : '—'}
                tone={usageInfo.expired ? 'bad' : 'na'}
              />
            </>
          )}
        </div>
        <div className="row">
          <button className="btn primary" onClick={onClose}>بستن</button>
        </div>
      </div>
    </div>
  );
}
