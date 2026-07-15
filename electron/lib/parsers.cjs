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

// Parse a block of text: multiple share links, or a base64-encoded
// subscription payload containing one link per line.
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
  for (const line of text.split(/[\r\n]+/)) {
    const p = parseLink(line);
    if (p) out.push(p);
  }
  return out;
}

module.exports = { parseLink, parseMany, newId };
