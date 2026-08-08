import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { Section, Toggle, TextField, PasswordField, PortField, BypassField, isValidHost } from './settingsPrimitives.jsx';
import { ConfirmModal } from './ManageModals.jsx';

const PROTO_DEFAULTS = {
  socks: { host: '127.0.0.1', port: 10808, username: '', password: '' },
  http: { host: '127.0.0.1', port: 10809, username: '', password: '' },
};

const PROTO_LABEL = { socks: 'SOCKS5', http: 'HTTP' };

const hostValidate = (v) => (isValidHost(v) ? null : 'آدرس IP یا دامنه معتبر نیست');

function TestResult({ state }) {
  if (!state || state.status === 'idle') return null;
  if (state.status === 'testing') {
    return <span className="net-test-result testing"><span className="spin" aria-hidden="true" /> در حال تست…</span>;
  }
  if (state.status === 'ok') {
    return <span className="net-test-result ok"><Icon name="check" size={12} /> متصل{state.ms != null ? ` — ${state.ms}ms` : ''}</span>;
  }
  return <span className="net-test-result fail"><Icon name="info" size={12} /> {state.message || 'ناموفق'}</span>;
}

function ProxyLogFeed({ logs }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs.length]);
  if (!logs.length) {
    return <div className="net-log-empty">هنوز رویدادی ثبت نشده — پس از اتصال به یک سرور، لاگ‌های زنده‌ی پروکسی اینجا نمایش داده می‌شوند.</div>;
  }
  return (
    <div className="feed net-log-feed" ref={ref}>
      {logs.slice(-80).map((l, i) => (
        <div key={`${l.t}-${i}`} className="feed-line">
          <span className="feed-dot" aria-hidden="true" />
          <span className="feed-msg mono">{l.text}</span>
          <span className="feed-t mono">{new Date(l.t).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </div>
      ))}
    </div>
  );
}

// The live system-proxy readout. Every line here comes from a fresh read of the
// Windows registry in the main process -- intent and reality are shown
// separately on purpose, because the whole class of bug this replaces was the
// UI reporting one while the machine was in the other.
function SystemProxyRow({ status, busy, onSetDesired, onSync }) {
  const s = status || {};
  const tone = s.active ? 'connected' : s.pending || s.lastError ? 'connecting' : '';

  let hint;
  if (s.lastError) {
    hint = s.lastError;
  } else if (s.active) {
    hint = `فعال — ویندوز از ${s.host}:${s.port} استفاده می‌کند`;
  } else if (s.foreign) {
    hint = `پروکسی دیگری روی سیستم فعال است (${s.server || '—'}) — دست نخورده باقی می‌ماند`;
  } else if (s.pending && !s.tunnelUp) {
    hint = 'در انتظار اتصال — به‌محض وصل‌شدن به سرور، خودکار اعمال می‌شود';
  } else if (s.pending) {
    hint = 'در حال اعمال…';
  } else {
    hint = 'غیرفعال — ترافیک ویندوز از تونل عبور نمی‌کند';
  }

  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label net-status-label">
          <span className={`status-dot ${tone}`} />
          پروکسی سیستم ویندوز
          {s.active && <span className="net-verified" title="این وضعیت از رجیستری ویندوز خوانده شده است"><Icon name="check" size={11} /> تأییدشده</span>}
        </span>
        <span className={`setting-hint ${s.lastError ? 'error' : ''}`}>{hint}</span>
        {s.pac && (
          <span className="setting-hint error">
            یک اسکریپت PAC روی ویندوز تنظیم شده و بر پروکسی دستی اولویت دارد
          </span>
        )}
      </div>
      <div className="net-btn-row">
        <button className="btn icon-inline-btn" onClick={onSync} disabled={busy} title="خواندن دوباره‌ی وضعیت واقعی از ویندوز">
          <Icon name="refresh" size={13} /> بررسی
        </button>
        {/* The switch is intent. It stays where the user put it even with no
            tunnel up -- the hint above explains what is actually happening. */}
        <button
          className={`switch ${s.desired ? 'on' : ''}`}
          onClick={() => onSetDesired(!s.desired)}
          disabled={busy}
          role="switch"
          aria-checked={!!s.desired}
          aria-label="پروکسی سیستم ویندوز"
          type="button"
        >
          <span className="knob" />
        </button>
      </div>
    </div>
  );
}

export default function NetworkSettings({
  settings, connectionState, systemProxy, killSwitchBlocking,
  onUpdate, onUpdateChecked, onSystemProxySetDesired, onSystemProxySync, onOpenProxyFolder, onResetNetworkDefaults,
}) {
  const [proto, setProto] = useState('socks');
  const [testState, setTestState] = useState({ socks: { status: 'idle' }, http: { status: 'idle' } });
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState([]);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const portsLocked = connectionState !== 'disconnected';
  const localProxyRunning = connectionState === 'connected';

  useEffect(() => {
    let cancelled = false;
    window.soul.getRecentProxyLogs?.().then((initial) => { if (!cancelled) setLogs(initial || []); }).catch(() => {});
    const off = window.soul.onProxyLog?.((entry) => {
      setLogs((prev) => [...prev, entry].slice(-300));
    });
    return () => { cancelled = true; off && off(); };
  }, []);

  async function handleTest(p) {
    setTestState((s) => ({ ...s, [p]: { status: 'testing' } }));
    try {
      const res = await window.soul.testProxyConnection(p);
      setTestState((s) => ({ ...s, [p]: { status: res.ok ? 'ok' : 'fail', message: res.message, ms: res.ms } }));
    } catch (err) {
      setTestState((s) => ({ ...s, [p]: { status: 'fail', message: err.message } }));
    } finally {
      setTimeout(() => setTestState((s) => ({ ...s, [p]: { status: 'idle' } })), 3000);
    }
  }

  async function handleResetProto(p) {
    const d = PROTO_DEFAULTS[p];
    const prefix = p === 'socks' ? 'socks' : 'http';
    await onUpdateChecked({
      [`${prefix}Host`]: d.host,
      [`${prefix}Port`]: d.port,
      [`${prefix}Username`]: d.username,
      [`${prefix}Password`]: d.password,
    });
  }

  async function handleSetDesired(v) {
    setBusy(true);
    try { await onSystemProxySetDesired(v); } finally { setBusy(false); }
  }
  async function handleSync() {
    setBusy(true);
    try { await onSystemProxySync(); } finally { setBusy(false); }
  }

  const prefix = proto === 'socks' ? 'socks' : 'http';

  return (
    <>
      <Section
        title="Kill Switch"
        icon="shield"
        description="جلوگیری کامل از نشت ترافیک هنگام قطع‌شدن VPN"
      >
        <Toggle
          label="Kill Switch"
          hint={killSwitchBlocking
            ? 'فعال — در حال حاضر تمام ترافیک اینترنت مسدود است چون تونل وصل نیست'
            : 'با قطع‌شدن ناگهانی اتصال، تغییر کانفیگ یا هر نوع افت اتصال، تمام ترافیک اینترنت سیستم مسدود می‌شود تا هیچ داده‌ای بیرون از تونل ارسال نشود؛ فعال‌سازی نیاز به دسترسی مدیر (UAC) دارد.'}
          checked={!!settings.killSwitchEnabled}
          onChange={(v) => onUpdate({ killSwitchEnabled: v })}
        />
        {killSwitchBlocking && (
          <div className="setting-row">
            <div className="setting-text">
              <span className="setting-label killswitch-active-label">
                <span className="status-dot blocking" />
                در حال مسدودسازی ترافیک
              </span>
              <span className="setting-hint">برای بازگرداندن فوری اینترنت، Kill Switch را خاموش کن یا دوباره به یک سرور وصل شو.</span>
            </div>
          </div>
        )}
      </Section>

      <Section title="وضعیت شبکه" icon="signal" description="پروکسی محلی و پروکسی سیستم ویندوز">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label net-status-label">
              <span className={`status-dot ${localProxyRunning ? 'connected' : ''}`} />
              سرویس پروکسی محلی
            </span>
            <span className="setting-hint">{localProxyRunning ? 'در حال اجرا' : 'متوقف — برای اجرا به یک سرور وصل شو'}</span>
          </div>
        </div>
        <SystemProxyRow
          status={systemProxy}
          busy={busy}
          onSetDesired={handleSetDesired}
          onSync={handleSync}
        />
      </Section>

      <Section title="پروکسی محلی — تنظیم دستی" icon="wifi" description="آدرس، پورت و احراز هویت اختیاری برای SOCKS5 و HTTP">
        <div className="tabs net-proto-tabs">
          <button className={`tab ${proto === 'socks' ? 'active' : ''}`} onClick={() => setProto('socks')}>SOCKS5</button>
          <button className={`tab ${proto === 'http' ? 'active' : ''}`} onClick={() => setProto('http')}>HTTP</button>
        </div>

        <TextField
          label="آدرس Host/IP"
          value={settings[`${prefix}Host`]}
          disabled={portsLocked}
          placeholder="127.0.0.1"
          hint="می‌تواند IP یا دامنه باشد؛ 0.0.0.0 یعنی در شبکه‌ی محلی هم قابل‌دسترس باشد"
          validate={hostValidate}
          onCommit={(v) => onUpdateChecked({ [`${prefix}Host`]: v })}
        />
        <PortField
          label={`پورت ${PROTO_LABEL[proto]}`}
          value={settings[`${prefix}Port`]}
          disabled={portsLocked}
          onCommit={(v) => onUpdateChecked({ [`${prefix}Port`]: v })}
        />
        <TextField
          label="نام کاربری (اختیاری)"
          value={settings[`${prefix}Username`]}
          disabled={portsLocked}
          placeholder="—"
          onCommit={(v) => onUpdateChecked({ [`${prefix}Username`]: v })}
        />
        <PasswordField
          label="رمز عبور (اختیاری)"
          value={settings[`${prefix}Password`]}
          disabled={portsLocked}
          onCommit={(v) => onUpdateChecked({ [`${prefix}Password`]: v })}
        />
        {portsLocked && (
          <p className="setting-hint" style={{ marginTop: -4, marginBottom: 10 }}>
            برای تغییر این تنظیمات، اول قطع اتصال کن.
          </p>
        )}

        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">آزمایش اتصال</span>
            <TestResult state={testState[proto]} />
          </div>
          <div className="net-btn-row">
            <button className="btn icon-inline-btn" disabled={!localProxyRunning || testState[proto].status === 'testing'} onClick={() => handleTest(proto)}>
              <Icon name="target" size={13} /> تست اتصال
            </button>
            <button className="btn icon-inline-btn" onClick={() => handleResetProto(proto)} disabled={portsLocked}>
              <Icon name="refresh" size={13} /> بازنشانی این پروتکل
            </button>
          </div>
        </div>
      </Section>

      <Section title="مسیرهای Bypass" icon="filter" description="آدرس‌هایی که همیشه بدون پروکسی، مستقیم باز می‌شوند">
        <BypassField value={settings.customBypass} onCommit={(v) => onUpdate({ customBypass: v })} />
      </Section>

      <Section title="گزارش زنده‌ی پروکسی" icon="history" description="آخرین رویدادهای پروکسی محلی">
        <ProxyLogFeed logs={logs} />
      </Section>

      <Section title="پیشرفته" icon="sliders" description="پوشه‌ی فایل‌ها و بازنشانی کامل">
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">پوشه‌ی پروکسی</span>
            <span className="setting-hint">کانفیگ فعال و لاگ‌های خام Xray</span>
          </div>
          <button className="btn icon-inline-btn" onClick={onOpenProxyFolder}>
            <Icon name="folder" size={14} />
            باز کردن
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">بازنشانی همه‌ی تنظیمات شبکه</span>
            <span className="setting-hint error">Host/Port/احراز هویت هر دو پروتکل و لیست bypass به حالت پیش‌فرض برمی‌گردند</span>
          </div>
          <button className="btn icon-inline-btn" disabled={portsLocked} onClick={() => setConfirmResetAll(true)}>
            <Icon name="trash" size={14} />
            بازنشانی همه
          </button>
        </div>
      </Section>

      {confirmResetAll && (
        <ConfirmModal
          title="بازنشانی تنظیمات شبکه"
          message="همه‌ی تنظیمات دستی SOCKS5 و HTTP (آدرس، پورت، احراز هویت) و لیست bypass به حالت پیش‌فرض بازمی‌گردند. ادامه می‌دهی؟"
          confirmLabel="بازنشانی"
          onClose={() => setConfirmResetAll(false)}
          onConfirm={onResetNetworkDefaults}
        />
      )}
    </>
  );
}
