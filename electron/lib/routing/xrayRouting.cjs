'use strict';
// Compiles a Smart Routing rule set into xray's own routing rules.
//
// Domain rules are handled natively here rather than in the dispatcher: xray
// matches them in Go, on the data path it already owns, for free. The
// dispatcher only exists for the one thing xray cannot express -- "which
// process opened this connection" -- so the less it has to touch, the better.
//
// Two shapes come out of this file:
//
//   dispatcher OFF  the rules describe the whole policy (LAN, then domains,
//                   then the mode default).
//   dispatcher ON   the dispatcher has already decided, per connection, and
//                   encodes its decision by picking which inbound to hand the
//                   bytes to -- so the rules degenerate to "this inbound goes
//                   to proxy, that one goes to direct" and nothing else may
//                   second-guess it.

const { isLocalTarget } = require('./rules.cjs');

// Inbound tags the dispatcher forwards into. Named (not derived from ports) so
// the routing rules stay stable no matter which ports we end up binding.
const DISPATCH_TAGS = {
  proxy: { socks: 'smart-proxy-socks', http: 'smart-proxy-http' },
  direct: { socks: 'smart-direct-socks', http: 'smart-direct-http' },
};

// Hostnames that must never leave the machine. geoip:private covers the IP
// side; these cover the name side, before any DNS lookup happens.
const LOCAL_DOMAIN_RULES = [
  'domain:localhost',
  'domain:local',
  'domain:lan',
  'domain:home',
  'domain:internal',
  'domain:intranet',
  'domain:corp',
  'domain:home.arpa',
];

// xray picks the FIRST matching rule, so emitting exact matches ahead of
// wildcards is what preserves the specificity order rules.cjs defines. Within
// a kind, the longer (deeper) domain goes first for the same reason.
function domainRuleTokens(rules, route) {
  const exact = [];
  const suffix = [];
  for (const r of rules) {
    if (!r || !r.enabled || r.route !== route) continue;
    if (r.domainKind === 'exact') exact.push(r.domainValue);
    else if (r.domainKind === 'suffix') suffix.push(r.domainValue);
  }
  const byDepth = (a, b) => b.split('.').length - a.split('.').length || b.length - a.length;
  return {
    exact: [...new Set(exact)].sort(byDepth).map((d) => `full:${d}`),
    suffix: [...new Set(suffix)].sort(byDepth).map((d) => `domain:${d}`),
  };
}

// Domain-only rules, in specificity order:
//   exact direct / exact proxy / wildcard direct / wildcard proxy
// Each tier is emitted as a single xray rule -- one rule with N domains is
// matched by the same trie as N rules with one domain each, and keeps the
// generated config readable.
function domainRules(rules) {
  const direct = domainRuleTokens(rules, 'direct');
  const proxy = domainRuleTokens(rules, 'proxy');
  const out = [];
  const push = (domain, outboundTag) => {
    if (domain.length) out.push({ type: 'field', domain, outboundTag });
  };
  push(direct.exact, 'direct');
  push(proxy.exact, 'proxy');
  push(direct.suffix, 'direct');
  push(proxy.suffix, 'proxy');
  return out;
}

// An exact rule for a LAN name/IP has to be able to say "yes, tunnel this
// one" -- so any rule whose destination is itself local jumps ahead of the
// blanket LAN-direct rule instead of being shadowed by it.
function localOverrideRules(rules) {
  const out = [];
  for (const r of rules) {
    if (!r || !r.enabled || r.route !== 'proxy') continue;
    if (r.domainKind === 'any' || !isLocalTarget(r.domainValue)) continue;
    out.push({
      type: 'field',
      domain: [r.domainKind === 'exact' ? `full:${r.domainValue}` : `domain:${r.domainValue}`],
      outboundTag: 'proxy',
    });
  }
  return out;
}

function lanRules() {
  return [
    { type: 'field', domain: LOCAL_DOMAIN_RULES, outboundTag: 'direct' },
    { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
  ];
}

// mode: 'proxy' | 'direct' | 'smart'
function compileRoutingRules({ mode = 'proxy', rules = [], lanDirect = true, dispatcher = false } = {}) {
  if (dispatcher) {
    // The dispatcher owns the decision entirely. No LAN rule, no domain rule:
    // it already applied both (via the same rules.cjs matcher) before choosing
    // the inbound, and a second opinion here could only contradict it.
    return [
      {
        type: 'field',
        inboundTag: [DISPATCH_TAGS.direct.socks, DISPATCH_TAGS.direct.http],
        outboundTag: 'direct',
      },
      {
        type: 'field',
        inboundTag: [DISPATCH_TAGS.proxy.socks, DISPATCH_TAGS.proxy.http],
        outboundTag: 'proxy',
      },
    ];
  }

  const out = [];
  if (mode === 'smart') out.push(...localOverrideRules(rules));
  if (lanDirect) out.push(...lanRules());
  if (mode === 'smart') out.push(...domainRules(rules));
  // 'proxy' needs no trailing rule: the proxy outbound is first in the list and
  // xray falls through to it. 'direct' has to say so explicitly.
  if (mode === 'direct') out.push({ type: 'field', network: 'tcp,udp', outboundTag: 'direct' });
  return out;
}

module.exports = { compileRoutingRules, DISPATCH_TAGS, LOCAL_DOMAIN_RULES };
