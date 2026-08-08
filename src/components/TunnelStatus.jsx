import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { isoToFlag, countryNameFa } from '../utils/geo.js';

// ---- Tunnel Status ----
//
// The one thing a VPN client has to be able to prove: that traffic is leaving
// somewhere else now. Everything shown here is measured from OUTSIDE, through
// the live tunnel (main asks an internet echo service via xray's own inbound),
// so the address is the one the user is genuinely browsing with -- not the
// server address from the config, not anything read out of a panel or an
// inbound/outbound definition.
//
// Two modes, because this panel serves two different moments:
//
//   compact   a single quiet strip: state, address, quality. What you want
//             99% of the time, and it gives the connect hero back its room.
//   expanded  the full readout -- location, ISP, latency, system proxy,
//             provenance -- for when the user is actually investigating.
//
// The choice is persisted with the rest of the UI session, and the two modes
// share one container so the arrow animates a real height change rather than
// swapping one box for another.
//
// Owns its own IPC subscription rather than taking state from App: nothing else
// in the tree needs it, and App's state is already re-rendered every traffic
// tick.

// Its own key, deliberately not part of the "Restore Previous Session" blob:
// this is a direct UI affordance the user operates with a visible control, and
// it would be baffling for it to reset because an unrelated setting is off.
const EXPANDED_KEY = 'soul.tunnelPanel.expanded';

function loadExpanded() {
  try {
    return localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveExpanded(v) {
  try {
    localStorage.setItem(EXPANDED_KEY, v ? '1' : '0');
  } catch { /* private mode -- the preference just won't survive a restart */ }
}

const PHASE_LABEL = {
  probing: 'در حال شناسایی…',
  refreshing: 'در حال بررسی…',
  ok: 'تونل فعال',
  error: 'تأیید نشد',
};

function ago(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'هم‌اکنون';
  if (s < 60) return `${s} ثانیه پیش`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} دقیقه پیش` : `${Math.round(m / 60)} ساعت پیش`;
}

function locationOf(status) {
  const flag = isoToFlag(status.countryCode);
  const country = countryNameFa(status.countryCode) || status.country || status.countryCode;
  if (!country && !status.city) return null;
  return { flag, text: [status.city, country].filter(Boolean).join('، ') };
}

// Connection quality, from the only number that reflects the whole path:
// round-trip latency measured through the tunnel itself.
function qualityOf(ms) {
  if (typeof ms !== 'number') return { tone: 'na', label: '—', bars: 0 };
  if (ms < 0) return { tone: 'bad', label: 'بدون پاسخ', bars: 0 };
  if (ms < 80) return { tone: 'great', label: 'عالی', bars: 4 };
  if (ms < 160) return { tone: 'good', label: 'خوب', bars: 3 };
  if (ms < 320) return { tone: 'mid', label: 'متوسط', bars: 2 };
  return { tone: 'bad', label: 'ضعیف', bars: 1 };
}

function QualityBars({ bars, tone }) {
  return (
    <span className={`tq-bars tone-${tone}`} aria-hidden="true">
      {[1, 2, 3, 4].map((i) => <i key={i} className={i <= bars ? 'on' : ''} />)}
    </span>
  );
}

// A labelled cell. Labels stay put, values are free to be long (an ISP name can
// run on) and simply ellipsize.
function Field({ label, children, wide, mono, title, onClick, className = '' }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <div className={`tunnel-field ${wide ? 'wide' : ''} ${className}`}>
      <span className="tunnel-field-label">{label}</span>
      <Tag
        className={`tunnel-field-value ${mono ? 'mono' : ''} ${onClick ? 'copyable' : ''}`}
        title={title}
        onClick={onClick}
        type={onClick ? 'button' : undefined}
      >
        {children}
      </Tag>
    </div>
  );
}

export default function TunnelStatus({ connectionState, latencyMs, activeProfile, systemProxy, onToast }) {
  const [status, setStatus] = useState({ phase: 'idle' });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Defaults to compact: the panel should earn its space, not claim it.
  const [expanded, setExpanded] = useState(loadExpanded);

  useEffect(() => {
    let alive = true;
    window.soul.tunnelGet?.().then((s) => { if (alive && s) setStatus(s); }).catch(() => {});
    const off = window.soul.onTunnelStatus?.((s) => setStatus(s));
    return () => { alive = false; if (off) off(); };
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => {
      saveExpanded(!v);
      return !v;
    });
  }, []);

  // Drives the "checked N seconds ago" readout. Only ticks while a tunnel is
  // up, something has been measured, and the panel is actually showing it.
  const connected = connectionState === 'connected';
  useEffect(() => {
    if (!connected || !status.checkedAt || !expanded) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [connected, status.checkedAt, expanded]);

  const handleRefresh = useCallback(async (e) => {
    e?.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const s = await window.soul.tunnelRefresh?.();
      if (s) setStatus(s);
    } catch (err) {
      onToast?.(err.message || 'بررسی IP ناموفق بود', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, onToast]);

  const copyIp = useCallback((e) => {
    e?.stopPropagation();
    if (!status.ip) return;
    navigator.clipboard?.writeText(status.ip)
      .then(() => onToast?.('IP عمومی کپی شد'))
      .catch(() => onToast?.('کپی ناموفق بود', 'error'));
  }, [status.ip, onToast]);

  if (connectionState === 'disconnected' || connectionState === 'disconnecting') return null;

  const connecting = connectionState === 'connecting';
  const phase = connecting ? 'probing' : status.phase;
  const working = phase === 'probing' || phase === 'refreshing' || busy;
  const hasIp = !!status.ip && phase !== 'idle';
  const location = hasIp ? locationOf(status) : null;
  const quality = qualityOf(latencyMs);
  // Only claim the address changed when there is a genuine before-and-after:
  // the baseline is sampled while disconnected, so it may legitimately be
  // unknown (first run, offline at launch) -- in which case we say nothing.
  const changed = hasIp && status.baselineIp ? status.baselineIp !== status.ip : null;
  const sp = systemProxy || {};

  const stateLabel = connecting ? 'در حال برقراری تونل…' : PHASE_LABEL[phase] || '—';

  return (
    <section className={`tunnel-panel ${phase} ${expanded ? 'expanded' : 'compact'}`}>
      {/* The header IS the compact bar. In compact mode it carries the whole
          summary; expanded, it becomes the title row and the detail unfolds
          beneath it. One element, one height transition, no swap. */}
      <header className="tunnel-head">
        <span className="tunnel-title">
          <span className={`tunnel-pulse ${working ? 'working' : phase}`} aria-hidden="true" />
          <span className="tunnel-title-text">وضعیت تونل</span>
        </span>

        {expanded ? (
          <>
            <span className={`tunnel-chip ${phase}`}>{stateLabel}</span>
            {changed === true && (
              <span className="tunnel-chip verdict ok" title={`IP واقعی شما (${status.baselineIp}) دیگر دیده نمی‌شود`}>
                <Icon name="shield" size={11} />
                IP شما تغییر کرد
              </span>
            )}
            {changed === false && (
              <span className="tunnel-chip verdict warn" title="آدرس خروجی تونل با IP واقعی این دستگاه یکی است — ترافیک احتمالاً از تونل عبور نمی‌کند">
                <Icon name="info" size={11} />
                IP تغییر نکرده
              </span>
            )}
          </>
        ) : (
          // Compact summary: state, address, quality. Nothing else earns a place
          // on a single line.
          <div className="tunnel-summary">
            <span className={`tunnel-chip ${phase} slim`}>{stateLabel}</span>
            {hasIp ? (
              <button className="tunnel-summary-ip mono" onClick={copyIp} title="برای کپی کلیک کن" type="button">
                {location?.flag && <span className="tunnel-flag">{location.flag}</span>}
                <span className="tunnel-ip">{status.ip}</span>
              </button>
            ) : (
              <span className="tunnel-skeleton inline" aria-label="در حال دریافت" />
            )}
            <span className={`tunnel-summary-q tone-${quality.tone}`} title={`تأخیر تونل${typeof latencyMs === 'number' && latencyMs >= 0 ? `: ${latencyMs}ms` : ''}`}>
              <QualityBars bars={quality.bars} tone={quality.tone} />
              <span className="tq-label">{quality.label}</span>
            </span>
            {sp.active && (
              <span className="tunnel-summary-sp" title={`پروکسی سیستم فعال است — ویندوز از ${sp.host}:${sp.port} استفاده می‌کند`}>
                <Icon name="shield" size={11} />
                پروکسی سیستم
              </span>
            )}
          </div>
        )}

        <button
          className="tunnel-refresh"
          onClick={handleRefresh}
          disabled={working || !connected}
          title="بررسی دوباره"
        >
          {working ? <span className="icon-spinner" aria-hidden="true" /> : <Icon name="refresh" size={13} />}
        </button>

        <button
          className="tunnel-toggle"
          onClick={toggleExpanded}
          title={expanded ? 'جمع‌کردن' : 'نمایش جزئیات کامل'}
          aria-expanded={expanded}
          type="button"
        >
          <span className={`tunnel-chev ${expanded ? 'up' : ''}`}>
            <Icon name="chevron" size={13} />
          </span>
        </button>
      </header>

      {/* Kept mounted and collapsed by max-height so the transition is a real
          reveal in both directions; aria-hidden + inert keep the collapsed
          content out of the tab order and off screen readers. */}
      <div className="tunnel-body" aria-hidden={!expanded} inert={!expanded ? '' : undefined}>
        {phase === 'error' && !hasIp ? (
          <div className="tunnel-error">
            <Icon name="info" size={13} />
            <span>{status.message || 'آدرس خروجی تونل قابل تشخیص نبود'}</span>
          </div>
        ) : (
          <div className="tunnel-grid">
            <Field
              label="IP عمومی شما"
              wide
              mono
              title={hasIp ? 'برای کپی کلیک کن' : undefined}
              onClick={hasIp ? copyIp : undefined}
            >
              {hasIp ? (
                <>
                  <span className="tunnel-ip">{status.ip}</span>
                  <Icon name="copy" size={12} className="tunnel-copy-glyph" />
                </>
              ) : (
                <span className="tunnel-skeleton" aria-label="در حال دریافت" />
              )}
            </Field>

            <Field label="موقعیت خروجی">
              {location ? (
                <>
                  {location.flag && <span className="tunnel-flag">{location.flag}</span>}
                  <span className="tunnel-ellipsis">{location.text}</span>
                </>
              ) : hasIp ? '—' : <span className="tunnel-skeleton" />}
            </Field>

            <Field label="سرویس‌دهنده">
              {hasIp
                ? <span className="tunnel-ellipsis" title={status.isp || undefined}>{status.isp || '—'}</span>
                : <span className="tunnel-skeleton" />}
            </Field>

            <Field label="کیفیت اتصال" className="quality">
              <QualityBars bars={quality.bars} tone={quality.tone} />
              <span className={`tunnel-ellipsis tone-${quality.tone}`}>
                {quality.label}
                {typeof latencyMs === 'number' && latencyMs >= 0 && (
                  <span className="tq-ms mono"> · {latencyMs}ms</span>
                )}
              </span>
            </Field>

            {/* Verified against the Windows registry by the main process, so
                this agrees with Settings by construction rather than by two
                places happening to track the same flag. */}
            <Field label="پروکسی سیستم">
              <span className={`tunnel-ellipsis ${sp.active ? 'tone-good' : sp.pending ? 'tone-mid' : ''}`}>
                {sp.active
                  ? `فعال · ${sp.port}`
                  : sp.pending
                    ? 'در انتظار اعمال'
                    : sp.foreign
                      ? 'پروکسی دیگری فعال است'
                      : 'غیرفعال'}
              </span>
            </Field>

            <Field label="سرور" className="server">
              <span className="tunnel-ellipsis" title={activeProfile ? `${activeProfile.address}:${activeProfile.port}` : undefined}>
                {activeProfile ? (activeProfile.name || activeProfile.address) : '—'}
              </span>
            </Field>
          </div>
        )}

        <footer className="tunnel-foot">
          <span>
            {status.checkedAt ? `آخرین بررسی: ${ago(status.checkedAt, now)}` : 'در حال اولین بررسی…'}
            {status.source && ` · از ${status.source}`}
          </span>
          {status.matchesServer && activeProfile && (
            <span className="tunnel-note" title="این سرور مستقیم از آدرس خودش به اینترنت خارج می‌شود (بدون CDN یا واسط)">
              خروج مستقیم از خود سرور
            </span>
          )}
          {phase === 'error' && hasIp && (
            <span className="tunnel-note warn">آخرین بررسی ناموفق بود — مقدار بالا از بررسی قبلی است</span>
          )}
        </footer>
      </div>
    </section>
  );
}
