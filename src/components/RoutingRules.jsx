import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { Section, Toggle } from './settingsPrimitives.jsx';

// "قوانین مسیریابی" -- the Routing Rules screen: pick the overall mode, then
// decide per application and per destination.
//
// Deliberately presentational: what a rule *means* (normalization, matching,
// priority) lives in the main process (electron/lib/routing/rules.cjs), so this
// file can't drift from the engine that actually routes the traffic.

const MODES = [
  {
    key: 'proxy',
    title: 'همه از پروکسی',
    hint: 'تمام ترافیک از تونل عبور می‌کند',
    icon: 'shield',
  },
  {
    key: 'direct',
    title: 'همه مستقیم',
    hint: 'هیچ ترافیکی از تونل عبور نمی‌کند',
    icon: 'globe',
  },
  {
    key: 'smart',
    title: 'بر اساس قوانین',
    hint: 'هر برنامه و هر دامنه، مسیر خودش را دارد',
    icon: 'filter',
  },
];

const ROUTE_LABEL = { proxy: 'پروکسی', direct: 'مستقیم' };

// One-click starting points, so the first rule doesn't require knowing an
// executable name off the top of your head.
const PRESETS = [
  { appName: 'Chrome', exe: 'chrome.exe', route: 'proxy' },
  { appName: 'Firefox', exe: 'firefox.exe', route: 'proxy' },
  { appName: 'Edge', exe: 'msedge.exe', route: 'proxy' },
  { appName: 'Telegram', exe: 'telegram.exe', route: 'proxy' },
  { appName: 'Discord', exe: 'discord.exe', route: 'proxy' },
  { appName: 'Steam', exe: 'steam.exe', route: 'direct' },
  { appName: 'Epic Games', exe: 'epicgameslauncher.exe', route: 'direct' },
  { appName: 'سایت‌های ایرانی', domain: '*.ir', route: 'direct' },
];

function RouteChip({ route }) {
  return (
    <span className={`route-chip ${route}`}>
      <Icon name={route === 'proxy' ? 'shield' : 'globe'} size={11} />
      {ROUTE_LABEL[route]}
    </span>
  );
}

// The three-state control that is the whole point of the app list: proxy,
// direct, or no rule at all (fall back to the default). One click each way --
// nothing to confirm, nothing to save.
function RoutePicker({ value, onPick, busy }) {
  return (
    <div className="route-picker" role="group">
      <button
        className={`route-pick ${value === 'proxy' ? 'on proxy' : ''}`}
        onClick={() => onPick('proxy')}
        disabled={busy}
        title="این برنامه از پروکسی عبور کند"
      >
        پروکسی
      </button>
      <button
        className={`route-pick ${value === 'direct' ? 'on direct' : ''}`}
        onClick={() => onPick('direct')}
        disabled={busy}
        title="این برنامه مستقیم و بدون پروکسی وصل شود"
      >
        مستقیم
      </button>
      <button
        className={`route-pick ${!value ? 'on none' : ''}`}
        onClick={() => onPick(null)}
        disabled={busy || !value}
        title="بدون قانون؛ از حالت پیش‌فرض پیروی کن"
      >
        —
      </button>
    </div>
  );
}

function RuleModal({ initial, onClose, onSave }) {
  const [appName, setAppName] = useState(initial?.appName || '');
  const [exe, setExe] = useState(initial?.exe || '');
  const [domain, setDomain] = useState(initial?.domain || '');
  const [route, setRoute] = useState(initial?.route || 'proxy');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError('');
    setSaving(true);
    try {
      await onSave({ id: initial?.id, appName, exe, domain, route, enabled: initial ? initial.enabled : true });
      onClose();
    } catch (err) {
      setError(err.message || 'ذخیره نشد');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{initial ? 'ویرایش قانون' : 'قانون جدید'}</h3>
        <p className="hint">
          حداقل یکی از «فایل اجرایی» یا «دامنه» را پر کن. اگر هر دو را پر کنی، قانون فقط برای همان
          برنامه و همان مقصد اعمال می‌شود و بر قوانین کلی‌تر اولویت دارد.
        </p>

        <div className="field">
          <label className="field-label">نام برنامه (اختیاری)</label>
          <input value={appName} placeholder="کروم" onChange={(e) => setAppName(e.target.value)} autoFocus />
        </div>

        <div className="field">
          <label className="field-label">فایل اجرایی</label>
          <input className="mono" value={exe} placeholder="chrome.exe" onChange={(e) => setExe(e.target.value)} />
          <span className="field-hint">مسیر کامل هم قابل قبول است؛ فقط نام فایل نگه داشته می‌شود.</span>
        </div>

        <div className="field">
          <label className="field-label">دامنه یا مقصد</label>
          <input className="mono" value={domain} placeholder="example.com یا ‎*.example.com" onChange={(e) => setDomain(e.target.value)} />
          <span className="field-hint">خالی یعنی «همه‌ی مقصدها». برای همه‌ی زیردامنه‌ها از ‎*.example.com استفاده کن.</span>
        </div>

        <div className="field">
          <label className="field-label">مسیر اتصال</label>
          <div className="tabs">
            <button className={`tab ${route === 'proxy' ? 'active' : ''}`} onClick={() => setRoute('proxy')}>
              پروکسی
            </button>
            <button className={`tab ${route === 'direct' ? 'active' : ''}`} onClick={() => setRoute('direct')}>
              مستقیم
            </button>
          </div>
        </div>

        {error && <div className="error-msg">{error}</div>}

        <div className="row">
          <button className="btn" onClick={onClose}>انصراف</button>
          <button className="btn primary" onClick={submit} disabled={saving || (!exe.trim() && !domain.trim())}>
            {saving ? 'در حال ذخیره…' : 'ذخیره'}
          </button>
        </div>
      </div>
    </div>
  );
}

// The running-programs list, in Task Manager's own two-part shape: the windowed
// apps a user is actually thinking about first, background processes behind a
// disclosure. Choosing a route writes the rule immediately -- the list is the
// editor, not a form that feeds one.
function RunningApps({ appsState, onReload, routeOf, onPick, busyExe }) {
  const [query, setQuery] = useState('');
  const [showBackground, setShowBackground] = useState(false);
  const { apps, loading, error } = appsState;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) => a.name.toLowerCase().includes(q) || a.exe.includes(q));
  }, [apps, query]);

  const foreground = filtered.filter((a) => a.windowed);
  const background = filtered.filter((a) => !a.windowed);

  const row = (app) => (
    <div className="app-row" key={app.exe}>
      <span className="app-id">
        <span className="app-name">{app.name}</span>
        <span className="app-meta mono">
          {app.exe}
          {app.instances > 1 ? ` · ${app.instances} نمونه` : ''}
          {app.memoryMb ? ` · ${app.memoryMb} مگابایت` : ''}
        </span>
      </span>
      <RoutePicker value={routeOf(app.exe)} onPick={(r) => onPick(app, r)} busy={busyExe === app.exe} />
    </div>
  );

  return (
    <>
      <div className="app-list-head">
        <div className="app-search">
          <Icon name="search" size={13} />
          <input
            value={query}
            placeholder="جست‌وجوی برنامه…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="icon-btn" onClick={onReload} disabled={loading} title="تازه‌سازی فهرست">
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {loading && <div className="app-list-note">در حال خواندن فهرست برنامه‌های در حال اجرا…</div>}
      {error && !loading && (
        <div className="app-list-note error">
          {error} — می‌توانی با دکمه‌ی «قانون جدید» نام فایل اجرایی را دستی وارد کنی.
        </div>
      )}

      {!loading && !error && (
        <div className="app-list">
          {foreground.length > 0 && <div className="app-group-title">برنامه‌های باز</div>}
          {foreground.map(row)}
          {foreground.length === 0 && background.length === 0 && (
            <div className="app-list-note">برنامه‌ای پیدا نشد.</div>
          )}

          {background.length > 0 && (
            <>
              <button className="app-group-toggle" onClick={() => setShowBackground((v) => !v)}>
                <Icon name="chevron" size={13} className={showBackground ? 'flip' : ''} />
                فرایندهای پس‌زمینه ({background.length})
              </button>
              {showBackground && background.map(row)}
            </>
          )}
        </div>
      )}
    </>
  );
}

export default function RoutingRules({
  routing, connectionState, onSetMode, onSetLanDirect,
  onSaveRule, onDeleteRule, onToggleRule, onAddDomains, onReconnect, needsReconnect,
}) {
  const [editing, setEditing] = useState(null); // rule object, or 'new'
  const [appsState, setAppsState] = useState({ apps: [], loading: false, error: null });
  const [busyExe, setBusyExe] = useState(null);
  const rules = routing?.rules || [];
  const mode = routing?.mode || 'proxy';

  const loadApps = useCallback(async (force) => {
    if (!window.soul.listApps) return;
    setAppsState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await window.soul.listApps(force);
      setAppsState({ apps: r.apps || [], loading: false, error: r.error || null });
    } catch (err) {
      setAppsState({ apps: [], loading: false, error: err.message || 'فهرست برنامه‌ها خوانده نشد' });
    }
  }, []);

  // Enumerating processes costs a couple of seconds, so it happens once when
  // the screen is genuinely useful -- not on app start, and not in the modes
  // where per-app rules do nothing.
  useEffect(() => {
    if (mode === 'smart') loadApps(false);
  }, [mode, loadApps]);

  // An app-wide rule is one with this executable and no destination; a rule that
  // also names a domain is a narrower exception and must not be mistaken for it.
  const appRuleOf = useCallback(
    (exe) => rules.find((r) => r.exe === exe && r.domainKind === 'any'),
    [rules]
  );
  const routeOf = useCallback(
    (exe) => {
      const rule = appRuleOf(exe);
      return rule && rule.enabled ? rule.route : null;
    },
    [appRuleOf]
  );

  const handlePick = useCallback(async (app, route) => {
    setBusyExe(app.exe);
    try {
      const existing = appRuleOf(app.exe);
      if (!route) {
        if (existing) await onDeleteRule(existing.id);
      } else {
        await onSaveRule({
          id: existing?.id,
          appName: app.name || existing?.appName,
          exe: app.exe,
          domain: '',
          route,
          enabled: true,
        });
      }
    } catch {
      /* the toast is raised by the caller; the list simply stays as it was */
    } finally {
      setBusyExe(null);
    }
  }, [appRuleOf, onDeleteRule, onSaveRule]);

  // Same order the matcher uses, so what the user reads top-to-bottom is the
  // order conflicts are actually resolved in.
  const sorted = useMemo(() => {
    const rank = (r) => {
      const hasExe = !!r.exe;
      const k = r.domainKind;
      if (hasExe && k === 'exact') return 100;
      if (hasExe && k === 'suffix') return 80;
      if (!hasExe && k === 'exact') return 60;
      if (!hasExe && k === 'suffix') return 40;
      return 20;
    };
    return rules
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(b.r) - rank(a.r) || a.i - b.i)
      .map(({ r }) => r);
  }, [rules]);

  const usedPresets = new Set(rules.map((r) => `${r.exe}|${r.domain}`));
  const availablePresets = PRESETS.filter((p) => !usedPresets.has(`${p.exe || ''}|${p.domain || ''}`));

  return (
    <div className="settings-view routing-view">
      <Section title="حالت مسیریابی" icon="sliders" description="ترافیک به‌طور پیش‌فرض از کجا برود">
        <div className="routing-modes">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={`routing-mode ${mode === m.key ? 'on' : ''}`}
              onClick={() => onSetMode(m.key)}
              title={m.title}
              aria-pressed={mode === m.key}
            >
              <Icon name={m.icon} size={16} />
              <span className="routing-mode-title">{m.title}</span>
              <span className="routing-mode-hint">{m.hint}</span>
            </button>
          ))}
        </div>
      </Section>

      {needsReconnect && connectionState === 'connected' && (
        <div className="routing-notice">
          <Icon name="refresh" size={14} />
          <span>برای اعمال کامل این تغییر روی اتصال فعلی، یک‌بار قطع و دوباره وصل شو.</span>
          <button className="btn mini" onClick={onReconnect}>اتصال مجدد</button>
        </div>
      )}

      {mode === 'smart' && (
        <>
          <Section
            title="برنامه‌ها"
            icon="power"
            description="برای هر برنامه انتخاب کن از پروکسی برود یا مستقیم"
          >
            <RunningApps
              appsState={appsState}
              onReload={() => loadApps(true)}
              routeOf={routeOf}
              onPick={handlePick}
              busyExe={busyExe}
            />
          </Section>

          <Section
            title="قوانین"
            icon="filter"
            description="قانون خاص‌تر همیشه اولویت دارد؛ نیازی به مرتب‌سازی دستی نیست"
          >
            <div className="rule-table">
              <div className="rule-row head">
                <span>برنامه</span>
                <span>مقصد</span>
                <span>مسیر</span>
                <span />
              </div>
              {sorted.length === 0 && (
                <div className="rule-empty">
                  هنوز قانونی نساخته‌ای. تا وقتی قانونی نباشد، همه‌چیز از پروکسی می‌رود
                  (به‌جز شبکه‌ی محلی).
                </div>
              )}
              {sorted.map((rule) => (
                <div className={`rule-row ${rule.enabled ? '' : 'off'}`} key={rule.id}>
                  <span className="rule-app">
                    <span className="rule-app-name">{rule.appName || '—'}</span>
                    {rule.exe && <span className="rule-exe mono">{rule.exe}</span>}
                  </span>
                  <span className="rule-dest mono">{rule.domain || 'همه'}</span>
                  <span><RouteChip route={rule.route} /></span>
                  <span className="rule-actions">
                    <button
                      className={`switch small ${rule.enabled ? 'on' : ''}`}
                      role="switch"
                      aria-checked={rule.enabled}
                      title={rule.enabled ? 'غیرفعال کردن' : 'فعال کردن'}
                      onClick={() => onToggleRule(rule.id, !rule.enabled)}
                    >
                      <span className="knob" />
                    </button>
                    <button className="icon-btn" title="ویرایش" onClick={() => setEditing(rule)}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button className="icon-btn danger" title="حذف" onClick={() => onDeleteRule(rule.id)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>

            <div className="rule-add-row">
              <button className="btn primary mini" onClick={() => setEditing('new')}>
                <Icon name="plus" size={13} />
                قانون جدید
              </button>
              {routing?.dispatcherNeeded && (
                <span className={`rule-dispatch-state ${routing.dispatcherActive ? 'on' : ''}`}>
                  <Icon name={routing.dispatcherActive ? 'check' : 'info'} size={12} />
                  {routing.dispatcherActive
                    ? 'قوانین برنامه‌ای فعال است'
                    : 'قوانین برنامه‌ای از اتصال بعدی اعمال می‌شوند'}
                </span>
              )}
            </div>
          </Section>

          {availablePresets.length > 0 && (
            <Section title="شروع سریع" icon="bolt" description="قوانین رایج، با یک کلیک">
              <div className="preset-row">
                {availablePresets.map((p) => (
                  <button
                    key={p.appName}
                    className="chip"
                    onClick={() => onSaveRule({ ...p, enabled: true })}
                  >
                    <Icon name="plus" size={11} />
                    {p.appName}
                    <span className={`preset-route ${p.route}`}>{ROUTE_LABEL[p.route]}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}

          <Section title="دامنه‌ها" icon="globe" description="سایت‌هایی که باید مستقیم یا از پروکسی باز شوند">
            <BulkDomains onAdd={onAddDomains} />
          </Section>

          <Section title="شبکه محلی" icon="wifi" description="اتصال‌های داخلی سیستم و شبکه">
            <Toggle
              label="شبکه محلی همیشه مستقیم"
              hint="localhost، ‎127.0.0.1، شبکه‌های خصوصی و آدرس‌های LAN هرگز از تونل عبور نمی‌کنند"
              checked={routing?.lanDirect !== false}
              onChange={onSetLanDirect}
            />
          </Section>
        </>
      )}

      {mode !== 'smart' && (
        <div className="routing-notice muted">
          <Icon name="info" size={14} />
          <span>
            برای تعیین مسیر هر برنامه یا دامنه، حالت «بر اساس قوانین» را انتخاب کن.
          </span>
        </div>
      )}

      {editing && (
        <RuleModal
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={onSaveRule}
        />
      )}
    </div>
  );
}

function BulkDomains({ onAdd }) {
  const [text, setText] = useState('');
  const [route, setRoute] = useState('direct');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    setBusy(true);
    try {
      await onAdd({ domains: text, route });
      setText('');
    } catch (err) {
      setError(err.message || 'افزوده نشد');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setting-row column">
      <div className="setting-text">
        <span className="setting-label">افزودن گروهی دامنه</span>
        <span className="setting-hint">
          چند دامنه را با کاما، سمی‌کالن یا خط جدید جدا کن. وایلدکارت هم پشتیبانی می‌شود: ‎*.example.com
        </span>
      </div>
      <textarea
        className="mono bypass-textarea"
        value={text}
        placeholder={'example.com\n*.digikala.ir\nyoutube.com'}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="error-msg">{error}</div>}
      <div className="bulk-domain-actions">
        <div className="tabs compact">
          <button className={`tab ${route === 'direct' ? 'active' : ''}`} onClick={() => setRoute('direct')}>مستقیم</button>
          <button className={`tab ${route === 'proxy' ? 'active' : ''}`} onClick={() => setRoute('proxy')}>پروکسی</button>
        </div>
        <button className="btn primary mini" onClick={submit} disabled={busy || !text.trim()}>
          <Icon name="plus" size={13} />
          {busy ? 'در حال افزودن…' : 'افزودن'}
        </button>
      </div>
    </div>
  );
}
