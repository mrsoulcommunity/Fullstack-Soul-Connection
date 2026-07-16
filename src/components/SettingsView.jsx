import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { formatBytes } from '../utils/format.js';

const INTERVAL_OPTIONS = [
  { value: 0, label: 'خاموش' },
  { value: 6 * 3600000, label: 'هر ۶ ساعت' },
  { value: 12 * 3600000, label: 'هر ۱۲ ساعت' },
  { value: 24 * 3600000, label: 'هر ۲۴ ساعت' },
];

const LOG_LEVELS = [
  { value: 'warning', label: 'هشدار (پیش‌فرض)' },
  { value: 'info', label: 'اطلاعات' },
  { value: 'debug', label: 'دیباگ' },
];

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      <button
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        type="button"
      >
        <span className="knob" />
      </button>
    </label>
  );
}

function updaterStatusHint(updaterStatus) {
  switch (updaterStatus?.status) {
    case 'checking': return 'در حال بررسی…';
    case 'available': return `نسخه‌ی جدید ${updaterStatus.version} موجود است`;
    case 'not-available': return 'شما از آخرین نسخه استفاده می‌کنید';
    case 'downloading': return `در حال دانلود… ${Math.round(updaterStatus.percent || 0)}٪`;
    case 'downloaded': return `نسخه‌ی ${updaterStatus.version} آماده‌ی نصب است`;
    case 'error': return `خطا در بررسی به‌روزرسانی: ${updaterStatus.message}`;
    default: return null;
  }
}

function Section({ title, children }) {
  return (
    <div className="settings-section">
      <h4 className="settings-section-title">{title}</h4>
      {children}
    </div>
  );
}

// Mirrors its own draft while typing, but always re-syncs to the real,
// backend-confirmed value once a commit attempt settles -- whether it
// succeeded or was rejected (e.g. SOCKS/HTTP port collision) -- so the field
// never keeps showing a value that was never actually applied.
function PortField({ label, value, onCommit, disabled }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');

  useEffect(() => { setDraft(String(value)); }, [value]);

  async function commit() {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setError('بین ۱۰۲۴ تا ۶۵۵۳۵');
      setDraft(String(value));
      return;
    }
    setError('');
    if (n === value) return;
    try {
      await onCommit(n);
    } catch (err) {
      setDraft(String(value));
      setError(err.message || 'ذخیره نشد');
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {error && <span className="setting-hint error">{error}</span>}
      </div>
      <input
        className="setting-select port-input mono"
        type="number"
        min={1024}
        max={65535}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </div>
  );
}

function BypassField({ value, onCommit }) {
  const [draft, setDraft] = useState(value || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(value || ''); }, [value]);

  async function commit() {
    if (draft === (value || '')) return;
    setSaving(true);
    try {
      await onCommit(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="setting-row column">
      <div className="setting-text">
        <span className="setting-label">لیست bypass سفارشی</span>
        <span className="setting-hint">آدرس‌ها یا الگوهایی که باید همیشه مستقیم (بدون پروکسی) باز شوند؛ با ; یا خط جدید جدا کن. مثال: example.com;10.20.*</span>
      </div>
      <textarea
        className="mono bypass-textarea"
        value={draft}
        placeholder="example.com;*.internal.local"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        disabled={saving}
      />
    </div>
  );
}

export default function SettingsView({
  settings, connectionState, profiles, appInfo,
  updaterStatus, onCheckForUpdates, onDownloadUpdate, onInstallUpdate,
  onUpdate, onUpdateChecked, onOpenLogsFolder,
  onExportBackup, onImportBackup, onResetUsage, onResetAllUsage,
}) {
  const portsLocked = connectionState !== 'disconnected';
  const totalUsage = (profiles || []).reduce((sum, p) => sum + (p.totalBytes || 0), 0);

  return (
    <div className="settings-view">
      <Section title="اتصال">
        <Toggle
          label="اجرای خودکار با ویندوز"
          hint="Soul Connection هنگام ورود به ویندوز خودکار اجرا می‌شود"
          checked={settings.launchOnStartup}
          onChange={(v) => onUpdate({ launchOnStartup: v })}
        />
        <Toggle
          label="اتصال خودکار هنگام اجرا"
          hint="به آخرین سرور فعال، خودکار وصل شود"
          checked={settings.autoConnect}
          onChange={(v) => onUpdate({ autoConnect: v })}
        />
        <Toggle
          label="کوچک‌شدن به Tray"
          hint="با بستن پنجره، برنامه به‌جای خروج، مخفی می‌شود"
          checked={settings.minimizeToTray}
          onChange={(v) => onUpdate({ minimizeToTray: v })}
        />
        <Toggle
          label="اتصال مجدد خودکار"
          hint="در صورت قطعی ناخواسته‌ی تونل، خودکار تلاش برای وصل‌شدن دوباره"
          checked={settings.autoReconnect}
          onChange={(v) => onUpdate({ autoReconnect: v })}
        />
      </Section>

      <Section title="شبکه">
        <PortField
          label="پورت SOCKS"
          value={settings.socksPort}
          disabled={portsLocked}
          onCommit={(v) => onUpdateChecked({ socksPort: v })}
        />
        <PortField
          label="پورت HTTP"
          value={settings.httpPort}
          disabled={portsLocked}
          onCommit={(v) => onUpdateChecked({ httpPort: v })}
        />
        {portsLocked && (
          <p className="setting-hint" style={{ marginTop: -4, marginBottom: 10 }}>
            برای تغییر پورت‌ها، اول قطع اتصال کن. اگر پورت انتخابی اشغال باشد، برنامه خودش نزدیک‌ترین پورت آزاد را انتخاب می‌کند.
          </p>
        )}
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">به‌روزرسانی خودکار ساب‌اسکریپشن‌ها</span>
          </div>
          <select
            className="setting-select"
            value={settings.subAutoUpdateInterval}
            onChange={(e) => onUpdate({ subAutoUpdateInterval: Number(e.target.value) })}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <BypassField
          value={settings.customBypass}
          onCommit={(v) => onUpdate({ customBypass: v })}
        />
      </Section>

      <Section title="مصرف داده">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">مجموع مصرف همه‌ی سرورها</span>
            <span className="setting-hint mono">{formatBytes(totalUsage)}</span>
          </div>
          <button
            className="btn icon-inline-btn"
            onClick={onResetAllUsage}
            disabled={!totalUsage}
          >
            <Icon name="trash" size={14} />
            پاک کردن
          </button>
        </div>
        {(profiles || []).filter((p) => p.totalBytes > 0).map((p) => (
          <div className="setting-row" key={p.id}>
            <div className="setting-text">
              <span className="setting-label">{p.name || p.address}</span>
              <span className="setting-hint mono">{formatBytes(p.totalBytes)}</span>
            </div>
            <button className="icon-btn" title="ریست این سرور" onClick={() => onResetUsage(p.id)}>
              <Icon name="refresh" size={14} />
            </button>
          </div>
        ))}
      </Section>

      <Section title="پشتیبان‌گیری">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">خروجی گرفتن از کانفیگ‌ها</span>
            <span className="setting-hint">همه‌ی سرورها، ساب‌اسکریپشن‌ها و تنظیمات را در یک فایل JSON ذخیره کن</span>
          </div>
          <button className="btn icon-inline-btn" onClick={onExportBackup}>
            <Icon name="arrowDown" size={14} />
            خروجی
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">بازیابی از فایل پشتیبان</span>
            <span className="setting-hint error">کانفیگ‌های فعلی جایگزین می‌شوند</span>
          </div>
          <button className="btn icon-inline-btn" onClick={onImportBackup} disabled={portsLocked}>
            <Icon name="arrowUp" size={14} />
            بازیابی
          </button>
        </div>
      </Section>

      <Section title="پیشرفته">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">سطح لاگ Xray</span>
          </div>
          <select
            className="setting-select"
            value={settings.xrayLogLevel}
            onChange={(e) => onUpdate({ xrayLogLevel: e.target.value })}
          >
            {LOG_LEVELS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">پوشه‌ی لاگ‌ها و کانفیگ فعال</span>
          </div>
          <button className="btn icon-inline-btn" onClick={onOpenLogsFolder}>
            <Icon name="folder" size={14} />
            باز کردن
          </button>
        </div>
      </Section>

      <Section title="درباره">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">Soul Connection</span>
            <span className="setting-hint mono">نسخه {appInfo?.version || '—'}</span>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">به‌روزرسانی</span>
            {updaterStatusHint(updaterStatus) && (
              <span className="setting-hint">{updaterStatusHint(updaterStatus)}</span>
            )}
          </div>
          {updaterStatus?.status === 'available' ? (
            <button className="btn icon-inline-btn" onClick={onDownloadUpdate}>
              <Icon name="arrowDown" size={14} />
              دانلود
            </button>
          ) : updaterStatus?.status === 'downloaded' ? (
            <button className="btn icon-inline-btn" onClick={onInstallUpdate}>
              <Icon name="refresh" size={14} />
              نصب و راه‌اندازی مجدد
            </button>
          ) : (
            <button
              className="btn icon-inline-btn"
              onClick={onCheckForUpdates}
              disabled={updaterStatus?.status === 'checking' || updaterStatus?.status === 'downloading'}
            >
              <Icon name="refresh" size={14} />
              بررسی برای به‌روزرسانی
            </button>
          )}
        </div>
      </Section>
    </div>
  );
}
