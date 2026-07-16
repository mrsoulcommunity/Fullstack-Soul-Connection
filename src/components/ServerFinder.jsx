import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } from 'react';
import Icon from './Icon.jsx';
import { formatBytes, formatSpeed } from '../utils/format.js';
import { countryOf } from '../utils/geo.js';
import { PRIORITIES, priorityByKey, healthScore, extractMetrics, scoreTone, qualityEstimates, recommend } from '../utils/score.js';
import * as engine from '../finder/testEngine.js';
import TestDashboard from './TestDashboard.jsx';

const RECENT_KEY = 'soul.finder.recent.v1';

const MODES = [
  { key: 'ping', icon: 'signal', title: 'پینگ شبکه', desc: 'ICMP و TCP — سریع، فقط تاخیر شبکه' },
  { key: 'real', icon: 'radar', title: 'پینگ واقعی', desc: 'اتصال واقعی با کانفیگ و سنجش تاخیر از داخل تونل' },
  { key: 'speed', icon: 'gauge', title: 'تست سرعت', desc: 'بنچمارک دانلود و آپلود از داخل تونل' },
];

const SORTS = [
  ['score', 'بهترین امتیاز'],
  ['ping', 'کمترین پینگ'],
  ['real', 'کمترین پینگ واقعی'],
  ['down', 'بیشترین سرعت دانلود'],
  ['loss', 'کمترین از‌دست‌رفت'],
  ['stability', 'پایدارترین'],
  ['boot', 'سریع‌ترین برقراری'],
  ['fav', 'موردعلاقه‌ها'],
  ['recent', 'اخیرا استفاده‌شده'],
  ['country', 'کشور'],
  ['name', 'نام'],
];

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}
function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* ignore */ }
}

const fmtMs = (v) => (v == null ? '—' : `${v}ms`);
const fmtPct = (v) => (v == null ? '—' : `${v}٪`);
const mbps = (bps) => (bps == null ? '—' : `${((bps * 8) / 1e6).toFixed(1)} Mb`);

function msTone(v) {
  if (v == null) return 'na';
  if (v < 0) return 'bad';
  if (v < 150) return 'good';
  if (v < 400) return 'mid';
  return 'bad';
}

function fmtEta(ms) {
  if (ms == null) return null;
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `~${s} ثانیه`;
  return `~${Math.ceil(s / 60)} دقیقه`;
}

/* ---------- small SVG widgets ---------- */

function ScoreRing({ score }) {
  const tone = scoreTone(score);
  const C = 2 * Math.PI * 13;
  const off = score == null ? C : C * (1 - score / 100);
  return (
    <div className={`score-ring tone-${tone}`} title="امتیاز سلامت (۰ تا ۱۰۰)">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle className="ring-bg" cx="16" cy="16" r="13" />
        <circle className="ring-val" cx="16" cy="16" r="13" strokeDasharray={C} strokeDashoffset={off} />
      </svg>
      <span className="mono">{score == null ? '–' : score}</span>
    </div>
  );
}

function Sparkline({ values, tone = 'good', width = 200, height = 36 }) {
  if (!values || values.length < 2) return null;
  const ok = values.map((v) => (v > 0 ? v : null));
  const max = Math.max(...ok.filter((v) => v != null), 1);
  const step = width / (values.length - 1);
  const pts = ok.map((v, i) => (v == null ? null : `${(i * step).toFixed(1)},${(height - 3 - (v / max) * (height - 8)).toFixed(1)}`));
  const path = pts.filter(Boolean).join(' ');
  return (
    <svg className={`sparkline tone-${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={path} />
      {ok.map((v, i) => (v == null
        ? <circle key={i} className="miss" cx={i * step} cy={height - 6} r="2.5" />
        : null))}
    </svg>
  );
}

// Live area chart + needle gauge for the speed benchmark.
function SpeedDash({ active }) {
  const samples = active.samples.filter((s) => s.dir === active.dir);
  const maxBps = Math.max(...samples.map((s) => s.bps), 1e6);
  const W = 320; const H = 64;
  let area = '';
  if (samples.length > 1) {
    const step = W / (samples.length - 1);
    const pts = samples.map((s, i) => `${(i * step).toFixed(1)},${(H - 2 - (s.bps / maxBps) * (H - 10)).toFixed(1)}`);
    area = `0,${H} ${pts.join(' ')} ${W},${H}`;
  }
  // Needle position: log scale 0.5 → 200 Mbit/s across 180°.
  const mbit = (active.bps * 8) / 1e6;
  const frac = Math.max(0, Math.min(1, Math.log(Math.max(mbit, 0.5) / 0.5) / Math.log(200 / 0.5)));
  const angle = -90 + frac * 180;
  return (
    <div className="speed-dash">
      <div className="speed-gauge" aria-hidden="true">
        <svg viewBox="0 0 100 58">
          <path className="g-track" d="M8 52a42 42 0 0 1 84 0" />
          <path className="g-fill" d="M8 52a42 42 0 0 1 84 0" strokeDasharray={`${frac * 132} 200`} />
          <g transform={`rotate(${angle} 50 52)`}>
            <line className="g-needle" x1="50" y1="52" x2="50" y2="16" />
          </g>
          <circle className="g-hub" cx="50" cy="52" r="3.5" />
        </svg>
        <div className="g-read mono">{formatSpeed(active.bps)}</div>
        <div className="g-dir">{active.dir === 'down' ? '↓ دانلود' : '↑ آپلود'}</div>
      </div>
      <svg className={`speed-area ${active.dir}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {area && <polygon points={area} />}
      </svg>
    </div>
  );
}

/* ---------- result card ---------- */

function ResultCard({ profile, sub, result, selected, expanded, recommended, isActive, testing, priority, engineIdle, onSelect, onExpand, onConnect, onFavorite, onRetest, onContext }) {
  const geo = countryOf(profile);
  const m = extractMetrics(result);
  const score = healthScore(result, priority);
  const quality = result?.speed ? qualityEstimates(result) : null;
  const failed = result?.status === 'fail';

  return (
    <div
      className={`fcard ${selected ? 'sel' : ''} ${expanded ? 'open' : ''} ${isActive ? 'active' : ''} ${failed ? 'failed' : ''}`}
      onClick={() => { onSelect(); onExpand(); }}
      onContextMenu={onContext}
    >
      <div className="fcard-row">
        <button
          className={`fav-btn ${profile.favorite ? 'on' : ''}`}
          title={profile.favorite ? 'حذف از موردعلاقه‌ها' : 'افزودن به موردعلاقه‌ها'}
          onClick={(e) => { e.stopPropagation(); onFavorite(); }}
        >
          <Icon name="star" size={14} />
        </button>
        <span className="flag" title={geo?.label}>{geo?.flag || '🌐'}</span>
        <div className="fcard-info">
          <div className="fcard-name">
            {profile.name || profile.address}
            {recommended && <span className="badge-rec"><Icon name="check" size={10} />پیشنهاد</span>}
            {isActive && <span className="badge-live">متصل</span>}
          </div>
          <div className="fcard-meta">
            {geo && <span>{geo.label}</span>}
            <span>{sub ? sub.name : 'دستی'}</span>
            <span className="mono proto">{profile.protocol}</span>
          </div>
        </div>

        {testing ? (
          <div className="fcard-testing">
            <span className="spin" aria-hidden="true" />
            <span>{result?.phase ? PHASE_SHORT[result.phase] || 'در حال تست…' : 'در حال تست…'}</span>
          </div>
        ) : failed ? (
          <div className="fcard-fail" title={result.error}>ناموفق</div>
        ) : (
          <div className="fcard-metrics mono">
            <span className={`fm tone-${msTone(m.latency)}`} title="تاخیر">{fmtMs(m.latency)}</span>
            {m.down != null && <span className="fm tone-good" title="دانلود">↓{mbps(m.down)}</span>}
            {m.up != null && <span className="fm tone-idle" title="آپلود">↑{mbps(m.up)}</span>}
            {m.loss != null && m.loss > 0 && <span className="fm tone-bad" title="از‌دست‌رفت">{m.loss}٪</span>}
          </div>
        )}

        <ScoreRing score={score} />

        <button
          className="fcard-connect"
          onClick={(e) => { e.stopPropagation(); onConnect(); }}
          disabled={isActive}
        >
          {isActive ? 'متصل' : 'اتصال'}
        </button>
      </div>

      {expanded && (
        <div className="fcard-detail" onClick={(e) => e.stopPropagation()}>
          <div className="detail-grid mono">
            <Metric label="پینگ شبکه" value={fmtMs(result?.ping?.avg)} tone={msTone(result?.ping?.avg)} />
            <Metric label="پینگ واقعی" value={fmtMs(result?.real?.avg)} tone={msTone(result?.real?.avg)} />
            <Metric label="کمینه / بیشینه" value={m.latency != null ? `${(result?.real?.min ?? result?.ping?.min) ?? '–'} / ${(result?.real?.max ?? result?.ping?.max) ?? '–'}` : '—'} />
            <Metric label="جیتر" value={fmtMs(m.jitter)} />
            <Metric label="از‌دست‌رفت" value={fmtPct(m.loss)} tone={m.loss > 5 ? 'bad' : m.loss > 0 ? 'mid' : 'na'} />
            <Metric label="برقراری تونل" value={fmtMs(m.boot)} />
            <Metric label="دست‌دادن TLS" value={fmtMs(result?.real?.handshakeMs)} />
            <Metric label="دانلود" value={m.down != null ? formatSpeed(m.down) : '—'} tone={m.down ? 'good' : 'na'} />
            <Metric label="آپلود" value={m.up != null ? formatSpeed(m.up) : '—'} />
            <Metric label="پایداری" value={fmtPct(m.stability)} tone={m.stability >= 75 ? 'good' : m.stability != null ? 'mid' : 'na'} />
            <Metric label="حجم مصرفی" value={profile.totalBytes ? formatBytes(profile.totalBytes) : '—'} />
            <Metric label="آدرس" value={`${profile.address}:${profile.port}`} ltr />
          </div>

          {(result?.real?.samples?.length > 1 || result?.ping?.samples?.length > 1) && (
            <div className="detail-spark">
              <span className="detail-spark-label">نمونه‌های تاخیر</span>
              <Sparkline values={result?.real?.samples || result?.ping?.samples} tone={msTone(m.latency)} />
            </div>
          )}

          {quality && quality.length > 0 && (
            <div className="quality-row">
              {quality.map((q) => (
                <span key={q.key} className={`q-badge tone-${q.tone}`}>{q.title}: {q.label}</span>
              ))}
            </div>
          )}

          <div className="detail-actions">
            {MODES.map((mode) => (
              <button
                key={mode.key}
                className="btn mini"
                disabled={!engineIdle}
                onClick={() => onRetest(mode.key)}
              >
                <Icon name={mode.icon} size={12} />
                {mode.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const PHASE_SHORT = {
  boot: 'راه‌اندازی تونل…',
  reach: 'بررسی دسترسی…',
  handshake: 'دست‌دادن TLS…',
  probe: 'سنجش تاخیر…',
  warmup: 'گرم‌کردن تونل…',
  download: 'سنجش دانلود…',
  upload: 'سنجش آپلود…',
};

function Metric({ label, value, tone = 'na', ltr }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value tone-${tone} ${ltr ? 'mono' : ''}`}>{value}</span>
    </div>
  );
}

/* ---------- main finder ---------- */

export default function ServerFinder({ profiles, subscriptions, activeProfileId, connectionState, onClose, onConnect, onToggleFavorite }) {
  const t = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [recent, setRecent] = useState(loadRecent);
  const [chips, setChips] = useState({ fav: false, tested: false, protocols: [] });
  const [advOpen, setAdvOpen] = useState(false);
  const [adv, setAdv] = useState({ sub: '', country: '', network: '', security: '' });
  const [sortBy, setSortBy] = useState('score');
  const [mode, setMode] = useState('real');
  const [priority, setPriority] = useState('balanced');
  const [selIdx, setSelIdx] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [logOpen, setLogOpen] = useState(false);
  // Reopening the finder mid-batch lands straight on the live dashboard.
  const [view, setView] = useState(() => (engine.getSnapshot().status !== 'idle' ? 'dash' : 'list'));
  const [ctxMenu, setCtxMenu] = useState(null); // {x, y, profile}
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const logRef = useRef(null);

  const subsById = useMemo(() => Object.fromEntries(subscriptions.map((s) => [s.id, s])), [subscriptions]);
  const running = t.status === 'running' || t.status === 'paused' || t.status === 'stopping';

  useEffect(() => {
    engine.setProfileNames(Object.fromEntries(profiles.map((p) => [p.id, p.name || p.address])));
  }, [profiles]);

  // The distinct values that exist in the data drive the filter UI.
  const facets = useMemo(() => {
    const protocols = new Map();
    const countries = new Map();
    const networks = new Set();
    const securities = new Set();
    for (const p of profiles) {
      protocols.set(p.protocol, (protocols.get(p.protocol) || 0) + 1);
      const geo = countryOf(p);
      if (geo) countries.set(geo.iso, geo);
      if (p.network) networks.add(p.network);
      if (p.security) securities.add(p.security);
    }
    return {
      protocols: [...protocols.entries()].sort((a, b) => b[1] - a[1]),
      countries: [...countries.values()].sort((a, b) => a.label.localeCompare(b.label, 'fa')),
      networks: [...networks],
      securities: [...securities],
    };
  }, [profiles]);

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = profiles.filter((p) => {
      if (chips.fav && !p.favorite) return false;
      if (chips.tested && t.results[p.id]?.status !== 'ok') return false;
      if (chips.protocols.length && !chips.protocols.includes(p.protocol)) return false;
      if (adv.sub && p.subId !== adv.sub) return false;
      if (adv.network && p.network !== adv.network) return false;
      if (adv.security && p.security !== adv.security) return false;
      const geo = countryOf(p);
      if (adv.country && geo?.iso !== adv.country) return false;
      if (tokens.length) {
        const sub = subsById[p.subId];
        const hay = [p.name, p.address, p.protocol, p.network, p.security, sub?.name, geo?.label, geo?.iso]
          .filter(Boolean).join(' ').toLowerCase();
        if (!tokens.every((tk) => hay.includes(tk))) return false;
      }
      return true;
    });

    const val = (p) => {
      const r = t.results[p.id];
      const m = extractMetrics(r);
      switch (sortBy) {
        case 'score': { const s = healthScore(r, priority); return s == null ? 1e9 : -s; }
        case 'ping': return r?.ping?.avg ?? m.latency ?? 1e9;
        case 'real': return r?.real?.avg ?? 1e9;
        case 'down': return m.down == null ? 1e9 : -m.down;
        case 'loss': return m.loss ?? 1e9;
        case 'stability': return m.stability == null ? 1e9 : -m.stability;
        case 'boot': return m.boot ?? 1e9;
        case 'fav': return p.favorite ? 0 : 1;
        case 'recent': return p.lastUsedAt ? -p.lastUsedAt : 1e15;
        default: return 0;
      }
    };
    if (sortBy === 'name') list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fa'));
    else if (sortBy === 'country') list = [...list].sort((a, b) => (countryOf(a)?.label || '～').localeCompare(countryOf(b)?.label || '～', 'fa'));
    else list = [...list].sort((a, b) => val(a) - val(b));
    return list;
  }, [profiles, query, chips, adv, sortBy, priority, t.results, subsById]);

  useEffect(() => { setSelIdx((i) => Math.min(i, Math.max(filtered.length - 1, 0))); }, [filtered.length]);

  const commitRecent = useCallback((q) => {
    const v = q.trim();
    if (!v) return;
    setRecent((r) => {
      const next = [v, ...r.filter((x) => x !== v)].slice(0, 8);
      saveRecent(next);
      return next;
    });
  }, []);

  const startBatch = () => {
    if (!filtered.length || running) return;
    commitRecent(query);
    engine.startBatch(filtered.map((p) => p.id), mode);
    setView('dash');
  };

  const recommendation = useMemo(() => {
    if (running) return null;
    return recommend(filtered, t.results, priority);
  }, [filtered, t.results, priority, running]);

  const testedCount = useMemo(
    () => filtered.filter((p) => t.results[p.id]?.status === 'ok').length,
    [filtered, t.results]
  );

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e) => {
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (ctxMenu) {
        if (e.key === 'Escape') setCtxMenu(null);
        return;
      }
      if (view === 'dash') {
        // The dashboard is its own workspace: Esc returns to the list,
        // Space toggles pause while a batch is running.
        if (e.key === 'Escape') setView('list');
        else if (e.key === ' ' && !inField) {
          e.preventDefault();
          const st = engine.getSnapshot().status;
          if (st === 'running') engine.pause();
          else if (st === 'paused') engine.resume();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (inField && query) { setQuery(''); return; }
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelIdx((i) => {
          const next = Math.max(0, Math.min(filtered.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
          const el = listRef.current?.children[next];
          el?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'Enter' && !inField) {
        const p = filtered[selIdx];
        if (p) { commitRecent(query); onConnect(p.id); }
      } else if (e.key === 'Enter' && inField && e.target === searchRef.current) {
        commitRecent(query);
        searchRef.current.blur();
      } else if ((e.key === 'f' || e.key === 'F') && !inField) {
        const p = filtered[selIdx];
        if (p) onToggleFavorite(p);
      } else if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, selIdx, query, onClose, onConnect, onToggleFavorite, commitRecent, view, ctxMenu]);

  // Live log autoscroll.
  useEffect(() => {
    if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [t.logs.length, logOpen]);

  const eta = engine.etaMs();
  const progress = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const activeChips = chips.fav || chips.tested || chips.protocols.length > 0;
  const activeAdv = adv.sub || adv.country || adv.network || adv.security;

  if (view === 'dash') {
    return (
      <div className="finder-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="finder dash-mode" role="dialog" aria-label="داشبورد تست سرورها">
          <TestDashboard
            t={t}
            profiles={profiles}
            priority={priority}
            activeProfileId={activeProfileId}
            connectionState={connectionState}
            onBack={() => setView('list')}
            onConnect={(id) => { onConnect(id); }}
            onRetest={() => {
              if (t.batchIds.length && t.status === 'idle') {
                engine.startBatch(t.batchIds, t.lastBatch?.mode || mode);
              }
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="finder-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finder" role="dialog" aria-label="سرور یاب هوشمند">

        {/* ---- search head ---- */}
        <div className="finder-head">
          <div className="finder-search">
            <Icon name="search" size={17} className="fs-icon" />
            <input
              ref={searchRef}
              autoFocus
              value={query}
              placeholder="جست‌وجوی نام، کشور، شهر، پروتکل، ساب‌اسکریپشن…"
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
            />
            {query && (
              <button className="fs-clear" onClick={() => setQuery('')} title="پاک کردن">
                <Icon name="close" size={13} />
              </button>
            )}
            <kbd className="fs-kbd">Esc</kbd>
          </div>
          <button className="icon-btn ghost finder-close" onClick={onClose} title="بستن (Esc)">
            <Icon name="close" size={16} />
          </button>
        </div>

        {searchFocused && !query && recent.length > 0 && (
          <div className="recent-row">
            <Icon name="history" size={12} />
            {recent.map((r) => (
              <button key={r} className="recent-chip" onMouseDown={() => setQuery(r)}>{r}</button>
            ))}
            <button className="recent-clear" onMouseDown={() => { setRecent([]); saveRecent([]); }}>پاک کردن</button>
          </div>
        )}

        {/* ---- quick filters ---- */}
        <div className="chip-row">
          <button className={`chip ${!activeChips ? 'on' : ''}`} onClick={() => setChips({ fav: false, tested: false, protocols: [] })}>
            همه <span className="chip-n mono">{profiles.length}</span>
          </button>
          <button className={`chip ${chips.fav ? 'on' : ''}`} onClick={() => setChips((c) => ({ ...c, fav: !c.fav }))}>
            <Icon name="star" size={12} /> موردعلاقه
          </button>
          <button className={`chip ${chips.tested ? 'on' : ''}`} onClick={() => setChips((c) => ({ ...c, tested: !c.tested }))}>
            <Icon name="check" size={12} /> تست‌شده
          </button>
          {facets.protocols.slice(0, 4).map(([proto, n]) => (
            <button
              key={proto}
              className={`chip mono ${chips.protocols.includes(proto) ? 'on' : ''}`}
              onClick={() => setChips((c) => ({
                ...c,
                protocols: c.protocols.includes(proto) ? c.protocols.filter((x) => x !== proto) : [...c.protocols, proto],
              }))}
            >
              {proto} <span className="chip-n mono">{n}</span>
            </button>
          ))}
          <button className={`chip adv-toggle ${advOpen || activeAdv ? 'on' : ''}`} onClick={() => setAdvOpen((v) => !v)}>
            <Icon name="filter" size={12} /> فیلتر پیشرفته
            <Icon name="chevron" size={11} className={advOpen ? 'flip' : ''} />
          </button>
        </div>

        {/* ---- advanced filters ---- */}
        {advOpen && (
          <div className="adv-panel">
            <label>
              <span>ساب‌اسکریپشن</span>
              <select className="finder-select" value={adv.sub} onChange={(e) => setAdv((a) => ({ ...a, sub: e.target.value }))}>
                <option value="">همه</option>
                {subscriptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label>
              <span>کشور</span>
              <select className="finder-select" value={adv.country} onChange={(e) => setAdv((a) => ({ ...a, country: e.target.value }))}>
                <option value="">همه</option>
                {facets.countries.map((c) => <option key={c.iso} value={c.iso}>{c.flag} {c.label}</option>)}
              </select>
            </label>
            {facets.networks.length > 1 && (
              <label>
                <span>شبکه</span>
                <select className="finder-select" value={adv.network} onChange={(e) => setAdv((a) => ({ ...a, network: e.target.value }))}>
                  <option value="">همه</option>
                  {facets.networks.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
            {facets.securities.length > 1 && (
              <label>
                <span>امنیت</span>
                <select className="finder-select" value={adv.security} onChange={(e) => setAdv((a) => ({ ...a, security: e.target.value }))}>
                  <option value="">همه</option>
                  {facets.securities.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            )}
            <label>
              <span>مرتب‌سازی</span>
              <select className="finder-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            {activeAdv ? (
              <button className="btn mini adv-reset" onClick={() => setAdv({ sub: '', country: '', network: '', security: '' })}>حذف فیلترها</button>
            ) : null}
          </div>
        )}

        {/* ---- test controls ---- */}
        <div className="test-bar">
          <div className="mode-cards" role="radiogroup" aria-label="روش تست">
            {MODES.map((m) => (
              <button
                key={m.key}
                role="radio"
                aria-checked={mode === m.key}
                className={`mode-card ${mode === m.key ? 'on' : ''}`}
                disabled={running}
                onClick={() => setMode(m.key)}
                title={m.desc}
              >
                <Icon name={m.icon} size={15} />
                <span>{m.title}</span>
              </button>
            ))}
          </div>

          <select
            className="finder-select priority-select"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            title="اولویت پیشنهاد و امتیازدهی"
          >
            {PRIORITIES.map((p) => <option key={p.key} value={p.key}>اولویت: {p.label}</option>)}
          </select>

          {!running ? (
            <button className="btn primary test-start" onClick={startBatch} disabled={!filtered.length}>
              <Icon name="play" size={13} />
              تست {filtered.length} سرور
            </button>
          ) : (
            <div className="test-run-controls">
              {t.status === 'paused' ? (
                <button className="icon-btn" onClick={engine.resume} title="ادامه"><Icon name="play" size={14} /></button>
              ) : (
                <button className="icon-btn" onClick={engine.pause} title="توقف موقت"><Icon name="pause" size={14} /></button>
              )}
              <button className="icon-btn" onClick={engine.cancelAll} title="لغو"><Icon name="stop" size={13} /></button>
            </div>
          )}
        </div>

        {/* ---- batch progress ---- */}
        {running && (
          <div className="progress-strip">
            <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
            <span className="progress-text mono">{t.done}/{t.total}</span>
            {t.status === 'paused' ? <span className="progress-eta">متوقف</span>
              : eta != null && <span className="progress-eta">{fmtEta(eta)} مانده</span>}
            <button className="log-toggle dash-jump" onClick={() => setView('dash')}>
              <Icon name="gauge" size={11} /> داشبورد زنده
            </button>
            <button className="log-toggle" onClick={() => setLogOpen((v) => !v)}>
              گزارش زنده <Icon name="chevron" size={10} className={logOpen ? 'flip' : ''} />
            </button>
          </div>
        )}

        {/* ---- live speed dashboard ---- */}
        {t.activeSpeed && <SpeedDash active={t.activeSpeed} />}

        {/* ---- recommendation ---- */}
        {recommendation && !running && testedCount > 0 && (
          <div className="rec-banner">
            <div className="rec-icon"><Icon name={priorityByKey(priority).icon} size={16} /></div>
            <div className="rec-text">
              <span className="rec-title">
                پیشنهاد برای «{priorityByKey(priority).label}»: {recommendation.profile.name || recommendation.profile.address}
              </span>
              <span className="rec-sub">امتیاز سلامت {recommendation.score} از ۱۰۰ · بر پایه‌ی {testedCount} سرور تست‌شده</span>
            </div>
            <button
              className="btn primary mini"
              disabled={recommendation.profile.id === activeProfileId && connectionState === 'connected'}
              onClick={() => onConnect(recommendation.profile.id)}
            >
              اتصال
            </button>
          </div>
        )}

        {/* ---- results ---- */}
        <div className="finder-body" ref={listRef}>
          {profiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-glyph"><Icon name="signal" size={30} strokeWidth={2.25} /></div>
              <h3>هنوز کانفیگی نداری</h3>
              <p>اول از پنل اصلی یک کانفیگ یا ساب‌اسکریپشن اضافه کن.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-glyph"><Icon name="search" size={28} strokeWidth={2.25} /></div>
              <h3>چیزی پیدا نشد</h3>
              <p>عبارت دیگری امتحان کن یا فیلترها را کم کن.</p>
              <button
                className="btn empty-cta"
                onClick={() => { setQuery(''); setChips({ fav: false, tested: false, protocols: [] }); setAdv({ sub: '', country: '', network: '', security: '' }); }}
              >
                پاک کردن همه‌ی فیلترها
              </button>
            </div>
          ) : (
            filtered.map((p, i) => {
              const r = t.results[p.id];
              return (
                <ResultCard
                  key={p.id}
                  profile={p}
                  sub={subsById[p.subId]}
                  result={r}
                  selected={i === selIdx}
                  expanded={expandedId === p.id}
                  recommended={recommendation?.profile.id === p.id}
                  isActive={p.id === activeProfileId && connectionState === 'connected'}
                  testing={r?.status === 'testing' || r?.status === 'queued'}
                  priority={priority}
                  engineIdle={t.status === 'idle'}
                  onSelect={() => setSelIdx(i)}
                  onExpand={() => setExpandedId((id) => (id === p.id ? null : p.id))}
                  onConnect={() => { commitRecent(query); onConnect(p.id); }}
                  onFavorite={() => onToggleFavorite(p)}
                  onRetest={(mk) => engine.testOne(p.id, mk)}
                  onContext={(e) => {
                    e.preventDefault();
                    setSelIdx(i);
                    setCtxMenu({
                      x: Math.min(e.clientX, window.innerWidth - 200),
                      y: Math.min(e.clientY, window.innerHeight - 230),
                      profile: p,
                    });
                  }}
                />
              );
            })
          )}
        </div>

        {/* ---- live log ---- */}
        {logOpen && (
          <div className="live-log mono" ref={logRef}>
            {t.logs.slice(-60).map((l, i) => (
              <div key={i} className={`log-line tone-${l.tone}`}>
                <span className="log-t">{new Date(l.t).toLocaleTimeString('fa-IR')}</span>
                {l.msg}
              </div>
            ))}
          </div>
        )}

        {/* ---- context menu ---- */}
        {ctxMenu && (
          <div className="ctx-backdrop" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
            <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
              <div className="ctx-title">{ctxMenu.profile.name || ctxMenu.profile.address}</div>
              <button className="ctx-item" onClick={() => { onConnect(ctxMenu.profile.id); setCtxMenu(null); }}>
                <Icon name="power" size={13} /> اتصال
              </button>
              <button className="ctx-item" onClick={() => { onToggleFavorite(ctxMenu.profile); setCtxMenu(null); }}>
                <Icon name="star" size={13} /> {ctxMenu.profile.favorite ? 'حذف از موردعلاقه‌ها' : 'افزودن به موردعلاقه‌ها'}
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  navigator.clipboard?.writeText(`${ctxMenu.profile.address}:${ctxMenu.profile.port}`).catch(() => {});
                  setCtxMenu(null);
                }}
              >
                <Icon name="folder" size={13} /> کپی آدرس
              </button>
              <div className="ctx-sep" />
              {MODES.map((mo) => (
                <button
                  key={mo.key}
                  className="ctx-item"
                  disabled={running}
                  onClick={() => { engine.testOne(ctxMenu.profile.id, mo.key); setCtxMenu(null); setView('dash'); }}
                >
                  <Icon name={mo.icon} size={13} /> {mo.title}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ---- footer hints ---- */}
        <div className="finder-foot">
          <span><kbd>↑↓</kbd> حرکت</span>
          <span><kbd>Enter</kbd> اتصال</span>
          <span><kbd>F</kbd> موردعلاقه</span>
          <span><kbd>/</kbd> جست‌وجو</span>
          {testedCount > 0 && !running && (
            <button className="foot-clear" onClick={engine.clearResults}>پاک کردن نتایج</button>
          )}
        </div>
      </div>
    </div>
  );
}
