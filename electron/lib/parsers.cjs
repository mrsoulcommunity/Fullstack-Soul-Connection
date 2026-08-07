'use strict';
const crypto = require('crypto');

function b64decode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function looksBase64(s) {
  return /^[A-Za-z0-9+/_\-=\s]+$/.test(s.trim());
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function safeUrl(link) {
  try { return new URL(link); } catch { return null; }
}

function q(u, key) {
  const v = u.searchParams.get(key);
  return v == null ? '' : v;
}

function baseProfile(protocol, link) {
  return {
    id: newId(),
    protocol,
    link,
    name: '',
    address: '',
    port: 443,
    network: 'tcp',
    security: 'none',
    sni: '',
    alpn: '',
    fingerprint: '',
    allowInsecure: false,
    host: '',
    path: '',
    headerType: 'none',
    serviceName: '',
    mode: '',
    createdAt: Date.now(),
    subId: null,
  };
}

function parseVmess(link) {
  const body = link.slice('vmess://'.length);
  let obj;
  try {
    obj = JSON.parse(b64decode(body));
  } catch {
    return null;
  }
  if (!obj || !obj.add || !obj.id) return null;
  const p = baseProfile('vmess', link);
  p.name = obj.ps || `${obj.add}:${obj.port}`;
  p.address = String(obj.add);
  p.port = Number(obj.port) || 443;
  p.uuid = String(obj.id);
  p.alterId = Number(obj.aid) || 0;
  p.scy = obj.scy || 'auto';
  p.network = obj.net || 'tcp';
  p.headerType = obj.type || 'none';
  p.host = obj.host || '';
  p.path = obj.path || '';
  p.security = obj.tls === 'tls' ? 'tls' : 'none';
  p.sni = obj.sni || '';
  p.alpn = obj.alpn || '';
  p.fingerprint = obj.fp || '';
  return p;
}

function fillFromQuery(p, u) {
  p.network = q(u, 'type') || 'tcp';
  p.security = q(u, 'security') || p.security || 'none';
  p.sni = q(u, 'sni') || q(u, 'peer') || '';
  p.alpn = q(u, 'alpn') || '';
  p.fingerprint = q(u, 'fp') || '';
  p.host = q(u, 'host') || '';
  p.path = q(u, 'path') || '';
  p.headerType = q(u, 'headerType') || 'none';
  p.serviceName = q(u, 'serviceName') || '';
  p.mode = q(u, 'mode') || '';
  p.allowInsecure = q(u, 'allowInsecure') === '1' || q(u, 'allowInsecure') === 'true';
  p.publicKey = q(u, 'pbk') || '';
  p.shortId = q(u, 'sid') || '';
  p.spiderX = q(u, 'spx') || '';
}

function parseVless(link) {
  const u = safeUrl(link);
  if (!u || !u.username || !u.hostname) return null;
  const p = baseProfile('vless', link);
  p.uuid = decodeURIComponent(u.username);
  p.address = u.hostname.replace(/^\[|\]$/g, '');
  p.port = Number(u.port) || 443;
  p.name = decodeURIComponent(u.hash.slice(1)) || `${p.address}:${p.port}`;
  fillFromQuery(p, u);
  p.flow = q(u, 'flow') || '';
  p.encryption = q(u, 'encryption') || 'none';
  return p;
}

function parseTrojan(link) {
  const u = safeUrl(link);
  if (!u || !u.username || !u.hostname) return null;
  const p = baseProfile('trojan', link);
  p.password = decodeURIComponent(u.username);
  p.address = u.hostname.replace(/^\[|\]$/g, '');
  p.port = Number(u.port) || 443;
  p.name = decodeURIComponent(u.hash.slice(1)) || `${p.address}:${p.port}`;
  p.security = 'tls';
  fillFromQuery(p, u);
  if (!q(u, 'security')) p.security = 'tls';
  return p;
}

function parseSS(link) {
  let rest = link.slice('ss://'.length);
  let name = '';
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) {
    name = decodeURIComponent(rest.slice(hashIdx + 1));
    rest = rest.slice(0, hashIdx);
  }
  const queryIdx = rest.indexOf('?');
  if (queryIdx >= 0) rest = rest.slice(0, queryIdx);

  let method, password, address, port;
  const atIdx = rest.lastIndexOf('@');
  if (atIdx >= 0) {
    // SIP002: ss://base64url(method:password)@host:port
    let userinfo = rest.slice(0, atIdx);
    const hostpart = rest.slice(atIdx + 1);
    let decoded;
    try {
      decoded = b64decode(userinfo);
      if (!decoded.includes(':')) decoded = decodeURIComponent(userinfo);
    } catch {
      decoded = decodeURIComponent(userinfo);
    }
    const ci = decoded.indexOf(':');
    if (ci < 0) return null;
    method = decoded.slice(0, ci);
    password = decoded.slice(ci + 1);
    const m = hostpart.match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!m) return null;
    address = m[1];
    port = Number(m[2]);
  } else {
    // Legacy: ss://base64(method:password@host:port)
    let decoded;
    try { decoded = b64decode(rest); } catch { return null; }
    const m = decoded.match(/^(.+?):(.+)@(.+?):(\d+)$/);
    if (!m) return null;
    method = m[1];
    password = m[2];
    address = m[3];
    port = Number(m[4]);
  }
  const p = baseProfile('shadowsocks', link);
  p.method = method;
  p.password = password;
  p.address = address;
  p.port = port;
  p.name = name || `${address}:${port}`;
  return p;
}

function parseLink(link) {
  link = String(link || '').trim();
  if (!link) return null;
  try {
    if (link.startsWith('vmess://')) return parseVmess(link);
    if (link.startsWith('vless://')) return parseVless(link);
    if (link.startsWith('trojan://')) return parseTrojan(link);
    if (link.startsWith('ss://')) return parseSS(link);
  } catch {
    return null;
  }
  return null;
}

// Boundary-aware multi-config scanner. A config's URL runs until whichever
// comes first: another recognized protocol prefix starting right there (so
// configs pasted back-to-back with zero separator still split correctly --
// e.g. "...#Avmess://..."), whitespace, or end of string. No word-boundary
// guard on the prefix itself: a config's fragment/remark can end in any
// character, including a letter, right before the next protocol starts, so
// requiring a non-alphanumeric lookbehind would break exactly the
// no-separator case this is meant to handle. A stray "ss://" matched inside
// unrelated prose (e.g. "express://") is harmless -- it just fails to parse
// as a valid config below and gets silently dropped like any other garbage.
const CONFIG_PROTOCOLS = 'vmess|vless|trojan|ss';
const CONFIG_PREFIX = `(?:${CONFIG_PROTOCOLS}):\\/\\/`;
const CONFIG_SCAN_RE = new RegExp(`${CONFIG_PREFIX}[^\\s]*?(?=${CONFIG_PREFIX}|\\s|$)`, 'gi');

// Trims trailing punctuation a paste source (chat apps, numbered lists,
// sentences describing the config) commonly tacks onto the end of a link
// that isn't actually part of the URL.
//
// Closing brackets get a balance check rather than being stripped outright:
// bracketed remarks like "#[Reality-Tunnel-Google-01]" are extremely common
// in real subscriptions (this project's own feed uses them for every entry),
// and blindly trimming the tail would rename every one of those servers.
// Only a closer with no matching opener inside the link is paste noise.
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const PLAIN_JUNK = new Set([',', ';', '.', '!', '?', '"', "'", '>']);

function countChar(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

function stripTrailingJunk(link) {
  let out = link;
  // One character at a time, so ".)" and "])" style tails resolve correctly
  // and each closer is re-balanced against what actually remains.
  for (;;) {
    const last = out.slice(-1);
    if (PLAIN_JUNK.has(last)) {
      out = out.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && countChar(out, last) > countChar(out, opener)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

// Extracts every individual share-link found anywhere in a block of text,
// regardless of how they're separated (newlines, spaces, nothing at all) or
// what other text surrounds them.
function extractConfigLinks(text) {
  const raw = String(text || '');
  const matches = raw.match(CONFIG_SCAN_RE) || [];
  return matches.map(stripTrailingJunk).filter(Boolean);
}

// Parse a block of text: one or many share links in any arrangement --
// separated by newlines/spaces, concatenated with no separator, interspersed
// with unrelated text -- or a base64-encoded subscription payload.
function parseMany(text) {
  text = String(text || '').trim();
  if (!text) return [];
  if (!text.includes('://') && looksBase64(text)) {
    try {
      const decoded = b64decode(text);
      if (decoded.includes('://')) text = decoded;
    } catch { /* keep original */ }
  }
  const out = [];
  const seen = new Set();
  for (const link of extractConfigLinks(text)) {
    if (seen.has(link)) continue; // same link appearing more than once in this paste
    const p = parseLink(link);
    if (!p) continue;
    seen.add(link);
    out.push(p);
  }
  return out;
}

function parseSubscriptionUserinfo(headerValue) {
  if (!headerValue) return null;
  const out = {};
  for (const part of headerValue.split(';')) {
    const [key, val] = part.trim().split('=');
    if (key && val !== undefined && !Number.isNaN(Number(val))) out[key.trim()] = Number(val);
  }
  if (out.upload === undefined && out.download === undefined && out.total === undefined && out.expire === undefined) {
    return null;
  }
  return {
    uploadBytes: out.upload || 0,
    downloadBytes: out.download || 0,
    totalBytes: out.total || 0,
    expireAt: out.expire ? out.expire * 1000 : null,
  };
}

// ---- Custom config: build a share-link back out of a profile object ----
// The reverse of fillFromQuery()/parseVmess() etc. -- lets a manually-built
// (Custom tab) profile carry a real `link`, so copy/QR/edit-via-link keep
// working on it exactly like on any imported profile. Field/default choices
// mirror the parse side field-for-field so a build->parse round trip is a no-op.

function qs(pairs) {
  const parts = [];
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function streamQueryPairs(p) {
  return [
    ['type', p.network && p.network !== 'tcp' ? p.network : undefined],
    ['sni', p.sni || undefined],
    ['alpn', p.alpn || undefined],
    ['fp', p.fingerprint || undefined],
    ['host', p.host || undefined],
    ['path', p.path || undefined],
    ['headerType', p.headerType && p.headerType !== 'none' ? p.headerType : undefined],
    ['serviceName', p.serviceName || undefined],
    ['mode', p.mode || undefined],
    ['allowInsecure', p.allowInsecure ? '1' : undefined],
    ['pbk', p.publicKey || undefined],
    ['sid', p.shortId || undefined],
    ['spx', p.spiderX || undefined],
  ];
}

function buildVmessLink(p) {
  const obj = {
    v: '2',
    ps: p.name || '',
    add: p.address,
    port: p.port,
    id: p.uuid,
    aid: p.alterId || 0,
    scy: p.scy || 'auto',
    net: p.network || 'tcp',
    type: p.headerType || 'none',
    host: p.host || '',
    path: p.path || '',
    tls: p.security === 'tls' ? 'tls' : '',
    sni: p.sni || '',
    alpn: p.alpn || '',
    fp: p.fingerprint || '',
  };
  return `vmess://${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')}`;
}

function buildVlessLink(p) {
  const pairs = streamQueryPairs(p);
  pairs.push(['security', p.security && p.security !== 'none' ? p.security : undefined]);
  pairs.push(['flow', p.flow || undefined]);
  pairs.push(['encryption', p.encryption && p.encryption !== 'none' ? p.encryption : undefined]);
  const name = encodeURIComponent(p.name || '');
  return `vless://${encodeURIComponent(p.uuid)}@${p.address}:${p.port}${qs(pairs)}#${name}`;
}

function buildTrojanLink(p) {
  const pairs = streamQueryPairs(p);
  // Unlike vless, parseTrojan forces security back to 'tls' whenever the
  // query has no explicit `security` param -- always spell it out here so a
  // deliberately-chosen 'none'/'reality' isn't silently overwritten on reparse.
  pairs.push(['security', p.security || 'tls']);
  const name = encodeURIComponent(p.name || '');
  return `trojan://${encodeURIComponent(p.password)}@${p.address}:${p.port}${qs(pairs)}#${name}`;
}

function buildSsLink(p) {
  const userinfo = b64UrlEncode(`${p.method}:${p.password}`);
  const name = encodeURIComponent(p.name || '');
  return `ss://${userinfo}@${p.address}:${p.port}#${name}`;
}

function b64UrlEncode(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildLink(p) {
  switch (p.protocol) {
    case 'vmess': return buildVmessLink(p);
    case 'vless': return buildVlessLink(p);
    case 'trojan': return buildTrojanLink(p);
    case 'shadowsocks': return buildSsLink(p);
    default: return null;
  }
}

// ---- Custom config: validate manual form input into a full profile ----

const CUSTOM_PROTOCOLS = new Set(['vmess', 'vless', 'trojan', 'shadowsocks']);
const CUSTOM_NETWORKS = new Set(['tcp', 'ws', 'grpc', 'h2', 'http', 'kcp']);
const CUSTOM_SECURITIES = new Set(['none', 'tls', 'reality']);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SS_METHODS = new Set([
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
  'chacha20-ietf-poly1305', 'chacha20-poly1305', 'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'none', 'plain',
]);

function str(v, max = 256) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function buildCustomProfile(fields) {
  const f = fields || {};
  const protocol = str(f.protocol);
  if (!CUSTOM_PROTOCOLS.has(protocol)) throw new Error('پروتکل نامعتبر است');

  const address = str(f.address, 253);
  if (!address) throw new Error('آدرس سرور را وارد کن');

  const port = Number(f.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('پورت باید بین ۱ تا ۶۵۵۳۵ باشد');

  const network = str(f.network) || 'tcp';
  if (!CUSTOM_NETWORKS.has(network)) throw new Error('نوع شبکه نامعتبر است');

  let security = str(f.security) || 'none';
  if (!CUSTOM_SECURITIES.has(security)) throw new Error('نوع امنیت نامعتبر است');
  if (protocol === 'vmess' && security === 'reality') security = 'tls'; // vmess has no Reality support

  const p = baseProfile(protocol, null);
  p.name = str(f.name, 100);
  p.address = address;
  p.port = port;
  p.network = network;
  p.security = security;
  p.sni = str(f.sni, 253);
  p.alpn = str(f.alpn, 128);
  p.fingerprint = str(f.fingerprint, 32);
  p.allowInsecure = !!f.allowInsecure;
  p.host = str(f.host, 253);
  p.path = str(f.path, 512);
  p.headerType = str(f.headerType) || 'none';
  p.serviceName = str(f.serviceName, 256);
  p.mode = str(f.mode, 32);
  p.publicKey = str(f.publicKey, 128);
  p.shortId = str(f.shortId, 32);
  p.spiderX = str(f.spiderX, 256);

  if (protocol === 'vmess' || protocol === 'vless') {
    const uuid = str(f.uuid);
    if (!UUID_RE.test(uuid)) throw new Error('UUID نامعتبر است (فرمت صحیح: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)');
    p.uuid = uuid;
  }
  if (protocol === 'vmess') {
    const alterId = Number(f.alterId);
    p.alterId = Number.isInteger(alterId) && alterId >= 0 ? alterId : 0;
    p.scy = str(f.scy) || 'auto';
  }
  if (protocol === 'vless') {
    p.flow = str(f.flow);
    p.encryption = str(f.encryption) || 'none';
  }
  if (protocol === 'trojan') {
    const password = str(f.password, 256);
    if (!password) throw new Error('رمز عبور را وارد کن');
    p.password = password;
    if (!f.security) p.security = 'tls'; // matches parseTrojan's own forced default
  }
  if (protocol === 'shadowsocks') {
    const method = str(f.method);
    if (!SS_METHODS.has(method)) throw new Error('روش رمزنگاری نامعتبر است');
    const password = str(f.password, 256);
    if (!password) throw new Error('رمز عبور را وارد کن');
    p.method = method;
    p.password = password;
    p.network = 'tcp';
    p.security = 'none';
  }

  if (!p.name) p.name = `${p.address}:${p.port}`;
  p.link = buildLink(p);
  return p;
}

module.exports = {
  parseLink, parseMany, newId, parseSubscriptionUserinfo,
  buildLink, buildCustomProfile,
};
