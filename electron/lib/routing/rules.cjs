'use strict';
// Smart Routing: the rule model and the matcher.
//
// Deliberately pure -- no I/O, no electron, no xray. Two very different
// consumers have to agree *exactly* on what a rule means:
//
//   * the dispatcher (routing/dispatcher.cjs), which asks "this connection is
//     from chrome.exe to example.com -- proxy or direct?" once per connection,
//     on the hot path;
//   * the xray config compiler (routing/xrayRouting.cjs), which has to express
//     the same rule set declaratively, ahead of time, in xray's own syntax.
//
// Keeping the semantics in one dependency-free file is what makes those two
// answer identically instead of drifting apart.

const ROUTES = new Set(['proxy', 'direct']);
const MODES = new Set(['proxy', 'direct', 'smart']);
const MAX_RULES = 200;

function newRuleId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Accepts anything a user might paste -- a bare name, a name with the wrong
// case, or a full path dragged in from Explorer -- and reduces it to the
// lowercase basename, which is the only form the process lookup can compare
// against. Returns '' when there's nothing usable.
function normalizeExe(value) {
  let v = String(value == null ? '' : value).trim().replace(/^"+|"+$/g, '');
  if (!v) return '';
  v = v.replace(/\\/g, '/');
  const base = v.slice(v.lastIndexOf('/') + 1).toLowerCase();
  if (!base) return '';
  // A name without an extension is almost certainly the friendly app name
  // ("Chrome") rather than the executable -- assume .exe so the common case
  // just works instead of silently never matching.
  return /\.[a-z0-9]{1,8}$/.test(base) ? base : `${base}.exe`;
}

// Domain forms the UI accepts:
//   ''  / '*' / 'all'   -> matches every destination (kind: 'any')
//   'example.com'       -> that exact host only          (kind: 'exact')
//   '*.example.com'     -> example.com and every subdomain (kind: 'suffix')
// The exact/suffix split is what makes "Chrome + example.com -> Direct" beat
// "*.com -> Proxy" without any manual ordering.
function normalizeDomain(value) {
  let v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v || v === '*' || v === 'all' || v === 'any') return { kind: 'any', value: '' };

  // Tolerate a pasted URL or a trailing path/port.
  v = v.replace(/^[a-z0-9+.-]+:\/\//, '').replace(/[/?#].*$/, '');
  v = v.replace(/^\[([^\]]+)\]$/, '$1'); // [::1]:443
  if (!v.startsWith('*.') && /^(.+):\d+$/.test(v) && (v.match(/:/g) || []).length === 1) {
    v = v.replace(/:\d+$/, '');
  }
  v = v.replace(/\.+$/, '');
  if (!v) return { kind: 'any', value: '' };

  if (v.startsWith('*.')) {
    const base = v.slice(2).replace(/^\.+/, '');
    return base ? { kind: 'suffix', value: base } : { kind: 'any', value: '' };
  }
  // A leading dot is the other common way people write "and subdomains".
  if (v.startsWith('.')) {
    const base = v.replace(/^\.+/, '');
    return base ? { kind: 'suffix', value: base } : { kind: 'any', value: '' };
  }
  return { kind: 'exact', value: v };
}

function normalizeRule(input, existing = null) {
  const src = input || {};
  const exe = normalizeExe(src.exe);
  const domain = normalizeDomain(src.domain);
  const route = ROUTES.has(src.route) ? src.route : 'proxy';
  const name = String(src.appName == null ? '' : src.appName).trim().slice(0, 60);

  // A rule that names neither an app nor a destination would match literally
  // everything and quietly become the default route -- that's what the mode
  // selector is for, so reject it here instead of letting it shadow the rules
  // the user actually wrote.
  if (!exe && domain.kind === 'any') {
    throw new Error('هر قانون باید حداقل یک برنامه یا یک دامنه داشته باشد');
  }

  return {
    id: existing?.id || src.id || newRuleId(),
    enabled: src.enabled === undefined ? (existing ? existing.enabled : true) : !!src.enabled,
    appName: name || (exe ? exe.replace(/\.exe$/, '') : domain.value),
    exe,
    domain: domain.kind === 'any' ? '' : (domain.kind === 'suffix' ? `*.${domain.value}` : domain.value),
    domainKind: domain.kind,
    domainValue: domain.value,
    route,
    createdAt: existing?.createdAt || src.createdAt || Date.now(),
  };
}

// Rules loaded from disk were written by an older (or a hand-edited) version,
// so everything derived -- domainKind, domainValue, the normalized exe -- gets
// recomputed rather than trusted.
function sanitizeRules(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, MAX_RULES)) {
    try {
      out.push(normalizeRule(raw, raw));
    } catch {
      /* a rule that can't be made sense of is dropped, not fatal */
    }
  }
  return out;
}

// ---- destination classification ----

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(host) {
  const m = String(host || '').match(IPV4_RE);
  return !!m && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

// localhost, loopback, RFC1918, link-local, CGNAT, IPv6 ULA/loopback, and the
// hostname shapes Windows networks actually use for machines on the LAN.
// Everything here is Direct by default: sending it through the tunnel is at
// best pointless and at worst breaks printers, NAS boxes and router pages.
function isLocalTarget(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;

  if (isIpv4(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  // Single-label names ("nas", "router") never resolve publicly.
  if (!h.includes('.')) return true;
  return /\.(local|lan|home|internal|intranet|corp|home\.arpa)$/.test(h);
}

// ---- matching ----

function domainMatches(rule, host) {
  if (rule.domainKind === 'any') return true;
  const h = String(host || '').trim().toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (rule.domainKind === 'exact') return h === rule.domainValue;
  return h === rule.domainValue || h.endsWith(`.${rule.domainValue}`);
}

function exeMatches(rule, exe) {
  if (!rule.exe) return true;
  return !!exe && exe === rule.exe;
}

// How *specific* a rule is, which is the entire conflict-resolution story:
// the highest score wins, so the user never has to hand-order anything.
//
//   app + exact domain  100   "Chrome, example.com"
//   app + wildcard       80   "Chrome, *.example.com"
//   exact domain         60   "example.com"
//   built-in LAN rule    50   (see LAN_SPECIFICITY below)
//   wildcard domain      40   "*.example.com"
//   app only             20   "Chrome"
//
// The label bonus breaks ties between overlapping wildcards so the deeper one
// wins: *.api.example.com beats *.example.com.
const LAN_SPECIFICITY = 50;

function specificity(rule) {
  const hasExe = !!rule.exe;
  const k = rule.domainKind;
  let base;
  if (hasExe && k === 'exact') base = 100;
  else if (hasExe && k === 'suffix') base = 80;
  else if (!hasExe && k === 'exact') base = 60;
  else if (!hasExe && k === 'suffix') base = 40;
  else base = 20;
  const labels = k === 'any' ? 0 : Math.min(9, rule.domainValue.split('.').length);
  return base + labels;
}

// The one function that answers "proxy or direct" for a single connection.
// `ctx.exe` may be null (destination-only decision, or the process couldn't be
// identified) and `ctx.host` may be an IP.
function matchRoute(ctx, rules, opts = {}) {
  const mode = MODES.has(opts.mode) ? opts.mode : 'proxy';
  const lanDirect = opts.lanDirect !== false;

  if (mode === 'proxy') return { route: 'proxy', source: 'mode', rule: null };
  if (mode === 'direct') return { route: 'direct', source: 'mode', rule: null };

  let best = null;
  let bestScore = -1;
  const list = Array.isArray(rules) ? rules : [];
  for (let i = 0; i < list.length; i++) {
    const rule = list[i];
    if (!rule || !rule.enabled) continue;
    if (!exeMatches(rule, ctx.exe)) continue;
    if (!domainMatches(rule, ctx.host)) continue;
    const score = specificity(rule);
    // Strictly greater: on a tie the earlier rule keeps the win, so the list
    // order the user sees is still a meaningful, predictable tiebreak.
    if (score > bestScore) {
      bestScore = score;
      best = rule;
    }
  }

  if (lanDirect && isLocalTarget(ctx.host) && bestScore < LAN_SPECIFICITY) {
    return { route: 'direct', source: 'lan', rule: null };
  }
  if (best) return { route: best.route, source: 'rule', rule: best };
  return { route: 'proxy', source: 'default', rule: null };
}

// Does this rule set need the per-process dispatcher at all? Domain-only rules
// compile straight into xray and cost nothing; an app rule is the only thing
// that requires knowing which process opened the connection.
function needsDispatcher(mode, rules) {
  if (mode !== 'smart') return false;
  return (Array.isArray(rules) ? rules : []).some((r) => r && r.enabled && r.exe);
}

module.exports = {
  ROUTES, MODES, MAX_RULES, LAN_SPECIFICITY,
  newRuleId, normalizeExe, normalizeDomain, normalizeRule, sanitizeRules,
  isIpv4, isLocalTarget, domainMatches, exeMatches, specificity,
  matchRoute, needsDispatcher,
};
