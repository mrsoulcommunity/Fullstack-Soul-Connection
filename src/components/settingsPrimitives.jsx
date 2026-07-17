import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

// Shared building blocks for the Settings screens (SettingsView.jsx,
// NetworkSettings.jsx) -- kept in one file so the two sibling views don't
// need to import from each other.

export function Section({ title, icon, description, children }) {
  return (
    <section className="settings-card">
      <header className="settings-card-head">
        <span className="settings-card-icon"><Icon name={icon} size={16} /></span>
        <div className="settings-card-heading">
          <h4 className="settings-section-title">{title}</h4>
          {description && <p className="settings-card-desc">{description}</p>}
        </div>
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

export function Toggle({ checked, onChange, label, hint }) {
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

// Mirrors its own draft while typing, but always re-syncs to the real,
// backend-confirmed value once a commit attempt settles -- whether it
// succeeded or was rejected (e.g. SOCKS/HTTP port collision) -- so the field
// never keeps showing a value that was never actually applied.
export function PortField({ label, value, onCommit, disabled }) {
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

export function BypassField({ value, onCommit }) {
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

// Renderer-side mirror of the same validation electron/main.cjs applies --
// fails fast in the UI instead of round-tripping to the main process first.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
export function isValidHost(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const m = v.match(IPV4_RE);
  if (m) return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
  return HOSTNAME_RE.test(v);
}

// Generic single-line text field with the same draft/commit/error shape as
// PortField, reused for Host and Username inputs.
export function TextField({ label, value, onCommit, disabled, placeholder, hint, validate }) {
  const [draft, setDraft] = useState(value || '');
  const [error, setError] = useState('');

  useEffect(() => { setDraft(value || ''); }, [value]);

  async function commit() {
    const v = draft.trim();
    if (validate) {
      const msg = validate(v);
      if (msg) {
        setError(msg);
        setDraft(value || '');
        return;
      }
    }
    setError('');
    if (v === (value || '')) return;
    try {
      await onCommit(v);
    } catch (err) {
      setDraft(value || '');
      setError(err.message || 'ذخیره نشد');
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {error ? <span className="setting-hint error">{error}</span> : hint ? <span className="setting-hint">{hint}</span> : null}
      </div>
      <input
        className="setting-select mono"
        type="text"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </div>
  );
}

// Same shape as TextField, plus a show/hide toggle. Optional field -- an
// empty value is always valid (no username/password required).
export function PasswordField({ label, value, onCommit, disabled, hint }) {
  const [draft, setDraft] = useState(value || '');
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);

  useEffect(() => { setDraft(value || ''); }, [value]);

  async function commit() {
    setError('');
    if (draft === (value || '')) return;
    try {
      await onCommit(draft);
    } catch (err) {
      setDraft(value || '');
      setError(err.message || 'ذخیره نشد');
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {error ? <span className="setting-hint error">{error}</span> : hint ? <span className="setting-hint">{hint}</span> : null}
      </div>
      <div className="password-field-wrap">
        <input
          className="setting-select mono"
          type={visible ? 'text' : 'password'}
          value={draft}
          disabled={disabled}
          placeholder="—"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
        <button
          type="button"
          className="password-toggle"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          title={visible ? 'پنهان کردن' : 'نمایش'}
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} size={13} />
        </button>
      </div>
    </div>
  );
}
