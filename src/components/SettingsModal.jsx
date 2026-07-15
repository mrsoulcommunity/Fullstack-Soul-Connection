import React from 'react';

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

export default function SettingsModal({ settings, onClose, onUpdate, onOpenLogsFolder }) {
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <h3>تنظیمات</h3>

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
          <button className="btn" onClick={onOpenLogsFolder}>باز کردن</button>
        </div>

        <div className="row">
          <button className="btn primary" onClick={onClose}>بستن</button>
        </div>
      </div>
    </div>
  );
}
