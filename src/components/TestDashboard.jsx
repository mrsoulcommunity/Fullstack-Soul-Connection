import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { formatSpeed } from '../utils/format.js';
import { healthScore, priorityByKey, recommend } from '../utils/score.js';
import { countryOf } from '../utils/geo.js';
import * as engine from '../finder/testEngine.js';

const MODE_TITLES = { ping: 'پینگ شبکه', real: 'پینگ واقعی تونل', speed: 'بنچمارک سرعت' };

const PHASE_STEPS = {
  real: [
    { key: 'boot', label: 'تونل' },
    { key: 'reach', label: 'دسترسی' },
    { key: 'handshake', label: 'TLS' },
    { key: 'probe', label: 'سنجش' },
  ],
  speed: [
    { key: 'boot', label: 'تونل' },
    { key: 'warmup', label: 'گرم‌کردن' },
    { key: 'download', label: 'دانلود' },
    { key: 'upload', label: 'آپلود' },
  ],
};

/* Smoothly tweens a numeric value with rAF — isolated so per-frame renders
   stay inside this leaf component. */
function AnimatedNumber({ value, format = (v) => Math.round(v), duration = 500 }) {
  const [display, setDisplay] = useState(value ?? 0);
  const anim = useRef({ raf: 0 });
  const shownRef = useRef(value ?? 0);

  useEffect(() => {
    const target = value ?? 0;
    const from = shownRef.current;
    if (from === target) return undefined;
    const start = performance.now();
    cancelAnimationFrame(anim.current.raf);
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const v = from + (target - from) * ease(t);
      shownRef.current = v;
      setDisplay(v);
      if (t < 1) anim.current.raf = requestAnimationFrame(step);
    };
    anim.current.raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(anim.current.raf);
  }, [value, duration]);

  return <>{format(display)}</>;
}

function ProgressRing({ percent, active }) {
  const C = 2 * Math.PI * 42;
  return (
    <div className={`dash-ring ${active ? 'active' : ''}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="dr-track" cx="50" cy="50" r="42" />
        <circle
          className="dr-fill"
          cx="50" cy="50" r="42"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - percent / 100)}
        />
      </svg>
      <div className="dr-center">
        <span className="dr-num mono"><AnimatedNumber value={percent} />٪</span>
        <span className="dr-label">پیشرفت</span>
      </div>
    </div>
  );
}

/* One 3px cell per server — scales to hundreds without layout cost. */
function QueueStrip({ batchIds, results, total }) {
  return (
    <div className="queue-strip" title={`${total} سرور در این تست`}>
      {batchIds.map((id) => {
        const s = results[id]?.status || 'queued';
        return <span key={id} className={`qcell ${s}`} />;
      })}
    </div>
  );
}

function PulseChart({ pulse }) {
  const W = 400; const H = 88;
  const pts = pulse.slice(-80);
  if (pts.length < 2) {
    return (
      <div className="pulse-empty">
        <span className="skeleton-bar" />
        <span>در انتظار اولین نمونه‌ها…</span>
      </div>
    );
  }
  const ok = pts.filter((p) => p.ms > 0);
  const max = Math.max(...ok.map((p) => p.ms), 100);
  const step = W / Math.max(pts.length - 1, 1);
  const y = (ms) => H - 6 - (ms / max) * (H - 20);
  const line = pts.map((p, i) => (p.ms > 0 ? `${(i * step).toFixed(1)},${y(p.ms).toFixed(1)}` : null)).filter(Boolean).join(' ');
  const area = line ? `0,${H} ${line} ${W},${H}` : '';
  return (
    <div className="pulse-wrap">
      <svg className="pulse-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {area && <polygon className="pc-area" points={area} />}
        {line && <polyline className="pc-line" points={line} />}
        {pts.map((p, i) => (p.ms < 0
          ? <circle key={i} className="pc-miss" cx={i * step} cy={H - 10} r="2.5" />
          : null))}
      </svg>
      <div className="pulse-scale mono">
        <span>{max}ms</span>
        <span>0</span>
      </div>
    </div>
  );
}

function SpeedLive({ active }) {
  const samples = active.samples.filter((s) => s.dir === active.dir);
  const W = 400; const H = 88;
  const maxBps = Math.max(...samples.map((s) => s.bps), 1e6);
  let area = '';
  if (samples.length > 1) {
    const step = W / (samples.length - 1);
    const pts = samples.map((s, i) => `${(i * step).toFixed(1)},${(H - 4 - (s.bps / maxBps) * (H - 16)).toFixed(1)}`);
    area = `0,${H} ${pts.join(' ')} ${W},${H}`;
  }
  return (
    <div className="pulse-wrap">
      <svg className={`pulse-chart speed ${active.dir}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {area && <polygon className="pc-area" points={area} />}
      </svg>
      <div className="speed-live-read">
        <span className={`sl-dir ${active.dir}`}>{active.dir === 'down' ? '↓ دانلود' : '↑ آپلود'}</span>
        <span className="mono sl-bps"><AnimatedNumber value={active.bps} duration={260} format={(v) => formatSpeed(v)} /></span>
      </div>
    </div>
  );
}

function PhaseSteps({ mode, phase }) {
  const steps = PHASE_STEPS[mode];
  if (!steps) return null;
  const idx = steps.findIndex((s) => s.key === phase);
  return (
    <div className="phase-steps" aria-hidden="true">
      {steps.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 && <span className={`ps-line ${idx >= i ? 'on' : ''}`} />}
          <span className={`ps-dot ${idx > i ? 'done' : idx === i ? 'now' : ''}`} title={s.label}>
            {idx > i ? <Icon name="check" size={8} /> : null}
            <em>{s.label}</em>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function ActiveTests({ t, profileById, onSkip }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!t.currentIds.length) {
    return <div className="active-empty">{t.status === 'paused' ? 'متوقف — برای ادامه دکمه‌ی اجرا را بزن' : 'در انتظار صف…'}</div>;
  }
  return (
    <div className="active-list">
      {t.currentIds.map((id) => {
        const p = profileById[id];
        const r = t.results[id];
        const geo = countryOf(p);
        const elapsed = r?.startedAt ? Math.round((Date.now() - r.startedAt) / 1000) : 0;
        const last = r?.liveSamples?.length ? r.liveSamples[r.liveSamples.length - 1] : null;
        return (
          <div key={id} className="active-row">
            <span className="ar-pulse" aria-hidden="true" />
            <span className="ar-flag">{geo?.flag || '🌐'}</span>
            <div className="ar-info">
              <span className="ar-name">{p?.name || id}</span>
              <PhaseSteps mode={t.mode} phase={r?.phase} />
            </div>
            {last != null && last > 0 && <span className="ar-last mono">{last}ms</span>}
            <span className="ar-time mono">{elapsed}s</span>
            <button className="ar-skip" onClick={() => onSkip(id)} data-tip="رد کردن این سرور">
              <Icon name="chevron" size={13} className="skip-icon" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Leaderboard({ t, profiles, priority, onConnect, activeProfileId }) {
  const ranked = useMemo(() => {
    return profiles
      .map((p) => ({ p, r: t.results[p.id], score: healthScore(t.results[p.id], priority) }))
      .filter((x) => x.r?.status === 'ok' && x.score != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [profiles, t.results, priority]);

  if (!ranked.length) {
    return (
      <div className="lb-skeleton" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="lb-skel-row" style={{ animationDelay: `${i * 0.15}s` }}>
            <span className="skeleton-dot" /><span className="skeleton-bar w60" /><span className="skeleton-bar w20" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="lb-list">
      {ranked.map((x, i) => {
        const geo = countryOf(x.p);
        return (
          <div key={x.p.id} className={`lb-row ${i === 0 ? 'top' : ''}`}>
            <span className={`lb-rank mono ${i === 0 ? 'gold' : ''}`}>{i + 1}</span>
            <span className="lb-flag">{geo?.flag || '🌐'}</span>
            <span className="lb-name">{x.p.name || x.p.address}</span>
            <span className="lb-score mono"><AnimatedNumber value={x.score} /></span>
            <button
              className="lb-connect"
              disabled={x.p.id === activeProfileId}
              onClick={() => onConnect(x.p.id)}
            >
              {x.p.id === activeProfileId ? 'متصل' : 'اتصال'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Feed({ logs }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs.length]);
  return (
    <div className="feed" ref={ref}>
      {logs.slice(-40).map((l, i) => (
        <div key={`${l.t}-${i}`} className={`feed-line tone-${l.tone}`}>
          <span className="feed-dot" aria-hidden="true" />
          <span className="feed-msg">{l.msg}</span>
          <span className="feed-t mono">{new Date(l.t).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </div>
      ))}
    </div>
  );
}

function CompletionHero({ batch, best, onConnect, onRetest, onBack, activeProfileId, connectionState }) {
  const allFailed = batch.ok === 0 && !batch.cancelled;
  const tone = batch.cancelled ? 'cancel' : allFailed ? 'fail' : 'ok';
  const title = batch.cancelled ? 'تست لغو شد'
    : allFailed ? 'هیچ سروری پاسخ نداد'
    : batch.fail > 0 ? 'تست با موفقیت نسبی تمام شد' : 'تست کامل شد';
  return (
    <div className={`done-hero ${tone}`}>
      <div className="done-glyph" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <circle className="dg-ring" cx="32" cy="32" r="27" />
          {tone === 'ok' && <path className="dg-mark" d="M20 33.5l8.5 8.5L45 24" />}
          {tone === 'fail' && <path className="dg-mark" d="M23 23l18 18M41 23L23 41" />}
          {tone === 'cancel' && <path className="dg-mark" d="M22 32h20" />}
        </svg>
      </div>
      <h2 className="done-title">{title}</h2>
      <p className="done-sub">
        {batch.ok} موفق · {batch.fail} ناموفق{batch.skipped ? ` · ${batch.skipped} ردشده` : ''} · در {Math.round(batch.durationMs / 1000)} ثانیه
      </p>
      {best && (
        <div className="done-best">
          <span className="db-label">بهترین انتخاب</span>
          <span className="db-flag">{countryOf(best.profile)?.flag || '🌐'}</span>
          <span className="db-name">{best.profile.name || best.profile.address}</span>
          <span className="db-score mono">{best.score}</span>
        </div>
      )}
      <div className="done-actions">
        {best && (
          <button
            className="btn primary"
            disabled={best.profile.id === activeProfileId && connectionState === 'connected'}
            onClick={() => onConnect(best.profile.id)}
          >
            <Icon name="bolt" size={13} /> اتصال به بهترین
          </button>
        )}
        <button className="btn" onClick={onRetest}><Icon name="refresh" size={13} /> تست دوباره</button>
        <button className="btn" onClick={onBack}>مشاهده‌ی نتایج</button>
      </div>
    </div>
  );
}

export default function TestDashboard({ t, profiles, priority, activeProfileId, connectionState, onBack, onConnect, onRetest }) {
  const profileById = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p])), [profiles]);
  const batchProfiles = useMemo(
    () => t.batchIds.map((id) => profileById[id]).filter(Boolean),
    [t.batchIds, profileById]
  );

  // 1s ticker so ETA / elapsed stay live between engine events.
  const [, tick] = useState(0);
  useEffect(() => {
    if (t.status === 'idle') return undefined;
    const timer = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [t.status]);

  const running = t.status !== 'idle';
  const percent = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const eta = engine.etaMs();
  const remaining = Math.max(t.total - t.done, 0);

  const liveStats = useMemo(() => {
    let bestMs = null; let sumMs = 0; let nMs = 0; let bestDown = null;
    for (const id of t.batchIds) {
      const r = t.results[id];
      if (!r || r.status !== 'ok') continue;
      const ms = r.real?.avg ?? r.ping?.avg ?? r.speed?.rttAvg ?? null;
      if (ms != null) { sumMs += ms; nMs++; if (bestMs == null || ms < bestMs) bestMs = ms; }
      const d = r.speed?.downBps;
      if (d != null && (bestDown == null || d > bestDown)) bestDown = d;
    }
    return { bestMs, avgMs: nMs ? Math.round(sumMs / nMs) : null, bestDown };
  }, [t.results, t.batchIds]);

  const best = useMemo(
    () => (t.lastBatch && !running ? recommend(batchProfiles, t.results, priority) : null),
    [t.lastBatch, running, batchProfiles, t.results, priority]
  );

  const phaseLabel = t.status === 'paused' ? 'متوقف'
    : t.status === 'stopping' ? 'در حال لغو…'
    : running ? `${t.currentIds.length} تست هم‌زمان در جریان`
    : '';

  return (
    <div className="dash" role="region" aria-label="داشبورد تست سرورها">
      {/* ---- header ---- */}
      <header className="dash-head">
        <div className={`dash-beacon ${running ? (t.status === 'paused' ? 'paused' : 'live') : 'done'}`} aria-hidden="true">
          <span className="beacon-core" />
          <span className="beacon-wave" />
          <span className="beacon-wave w2" />
        </div>
        <div className="dash-title">
          <h2>{running ? `در حال ${MODE_TITLES[t.mode]}` : `نتیجه‌ی ${MODE_TITLES[t.lastBatch?.mode || t.mode]}`}</h2>
          <p>{running ? phaseLabel : t.lastBatch ? `اولویت: ${priorityByKey(priority).label}` : ''}</p>
        </div>
        <div className="dash-controls">
          {running && (
            <>
              {t.status === 'paused' ? (
                <button className="icon-btn" onClick={engine.resume} data-tip="ادامه (Space)"><Icon name="play" size={14} /></button>
              ) : (
                <button className="icon-btn" onClick={engine.pause} data-tip="توقف موقت (Space)"><Icon name="pause" size={14} /></button>
              )}
              <button className="icon-btn" onClick={engine.cancelAll} data-tip="لغو همه"><Icon name="stop" size={13} /></button>
            </>
          )}
          <button className="icon-btn ghost" onClick={onBack} data-tip="بازگشت به فهرست (Esc)">
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>

      <div className="dash-scroll">
        {!running && t.lastBatch ? (
          <CompletionHero
            batch={t.lastBatch}
            best={best}
            onConnect={onConnect}
            onRetest={onRetest}
            onBack={onBack}
            activeProfileId={activeProfileId}
            connectionState={connectionState}
          />
        ) : (
          <section className="dash-progress">
            <ProgressRing percent={percent} active={t.status === 'running'} />
            <div className="dash-stats">
              <div className="stat-tiles">
                <div className="stat-tile">
                  <span className="st-num mono"><AnimatedNumber value={t.done} /><em>/{t.total}</em></span>
                  <span className="st-label">تست‌شده</span>
                </div>
                <div className="stat-tile">
                  <span className="st-num mono tone-good"><AnimatedNumber value={t.done - t.failed - t.skipped} /></span>
                  <span className="st-label">موفق</span>
                </div>
                <div className="stat-tile">
                  <span className="st-num mono tone-bad"><AnimatedNumber value={t.failed} /></span>
                  <span className="st-label">ناموفق</span>
                </div>
                <div className="stat-tile">
                  <span className="st-num mono"><AnimatedNumber value={remaining} /></span>
                  <span className="st-label">در صف</span>
                </div>
                <div className="stat-tile">
                  <span className="st-num mono">{t.status === 'paused' ? '—' : eta != null ? `${Math.ceil(eta / 1000)}s` : '…'}</span>
                  <span className="st-label">زمان مانده</span>
                </div>
              </div>
              <QueueStrip batchIds={t.batchIds} results={t.results} total={t.total} />
            </div>
          </section>
        )}

        <div className="dash-grid">
          <section className="dash-card span2">
            <header className="dc-head">
              <h3>{t.activeSpeed ? 'پهنای باند زنده' : 'نبض تاخیر'}</h3>
              <div className="dc-side mono">
                {liveStats.bestMs != null && <span className="tone-good" data-tip="بهترین تاخیر">↓{liveStats.bestMs}ms</span>}
                {liveStats.avgMs != null && <span data-tip="میانگین تاخیر">Ø {liveStats.avgMs}ms</span>}
                {liveStats.bestDown != null && <span className="tone-good" data-tip="بهترین دانلود">{formatSpeed(liveStats.bestDown)}</span>}
              </div>
            </header>
            {t.activeSpeed ? <SpeedLive active={t.activeSpeed} /> : <PulseChart pulse={t.pulse} />}
          </section>

          <section className="dash-card">
            <header className="dc-head"><h3>تست‌های فعال</h3></header>
            <ActiveTests t={t} profileById={profileById} onSkip={engine.skipOne} />
          </section>

          <section className="dash-card">
            <header className="dc-head"><h3>برترین‌ها <em className="dc-hint">بر پایه‌ی {priorityByKey(priority).label}</em></h3></header>
            <Leaderboard t={t} profiles={batchProfiles} priority={priority} onConnect={onConnect} activeProfileId={activeProfileId} />
          </section>

          <section className="dash-card span2">
            <header className="dc-head"><h3>گزارش زنده</h3></header>
            <Feed logs={t.logs} />
          </section>
        </div>
      </div>
    </div>
  );
}
