'use strict';
// Answers one question: what IP does the public internet see us as?
//
// The only honest way to know is to ask something on the outside, so that is
// exactly what this does -- an HTTP request to an echo service, sent THROUGH a
// given local proxy inbound when one is passed. Nothing here is derived from
// the config, the server address, or any panel/API: the address reported back
// is whatever the far end of the tunnel egresses from, which is the address the
// user is actually browsing with.
//
// Plain HTTP on purpose (not HTTPS): the request rides an HTTP proxy inbound in
// absolute-URI form, which needs no CONNECT tunnel and no TLS stack in front of
// it. The reply carries no secret -- it is our own public address, which every
// site we visit already sees -- so there is nothing here for TLS to protect,
// and the response is validated as a well-formed public IP before being used.
const http = require('http');
const net = require('net');

const MAX_BODY = 64 * 1024;

// Ordered by how much they tell us. The first one that answers with a valid
// public address wins; the rest are there for when a provider is blocked,
// rate-limited, or simply down.
const PROVIDERS = [
  {
    name: 'ip-api.com',
    url: 'http://ip-api.com/json/?fields=status,message,country,countryCode,city,isp,org,as,query',
    parse: (body) => {
      const j = JSON.parse(body);
      if (j.status && j.status !== 'success') throw new Error(j.message || 'lookup failed');
      return {
        ip: j.query,
        country: j.country || null,
        countryCode: j.countryCode || null,
        city: j.city || null,
        isp: j.isp || j.org || null,
        asn: j.as || null,
      };
    },
  },
  {
    name: 'ipinfo.io',
    url: 'http://ipinfo.io/json',
    parse: (body) => {
      const j = JSON.parse(body);
      return {
        ip: j.ip,
        country: null,
        countryCode: j.country || null,
        city: j.city || null,
        isp: j.org || null,
        asn: null,
      };
    },
  },
  {
    name: 'ipify.org',
    url: 'http://api.ipify.org/?format=json',
    parse: (body) => ({ ip: JSON.parse(body).ip }),
  },
  {
    name: 'aws',
    url: 'http://checkip.amazonaws.com/',
    parse: (body) => ({ ip: body.trim() }),
  },
];

// Guards against a captive portal / DNS hijack answering with something that
// isn't a real internet address -- reporting 192.168.x.x as "your public IP"
// would be worse than reporting nothing.
function isPublicIp(ip) {
  if (typeof ip !== 'string' || !net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
    return true;
  }
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return false;
  if (/^fe[89ab]/.test(low)) return false; // link-local
  if (/^f[cd]/.test(low)) return false;    // unique-local
  return true;
}

// `proxy` omitted -> straight out of this machine (the baseline "real" IP).
// `proxy` given   -> through that local inbound, i.e. out of the tunnel.
function httpGet(url, { proxy, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const options = proxy
      ? {
        host: proxy.host || '127.0.0.1',
        port: proxy.port,
        method: 'GET',
        path: url, // absolute-form: what an HTTP proxy expects
        headers: { Host: target.host, Connection: 'close', 'User-Agent': 'SoulConnection/1.0' },
        timeout: timeoutMs,
      }
      : {
        host: target.hostname,
        port: target.port || 80,
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers: { Host: target.host, Connection: 'close', 'User-Agent': 'SoulConnection/1.0' },
        timeout: timeoutMs,
      };

    if (proxy && proxy.username) {
      const token = Buffer.from(`${proxy.username}:${proxy.password || ''}`, 'utf8').toString('base64');
      options.headers['Proxy-Authorization'] = `Basic ${token}`;
    }

    const req = http.request(options, (res) => {
      // 407/403 are the proxy itself refusing -- the request never left the
      // machine, so whatever it says about "our" IP is meaningless.
      if (res.statusCode === 407 || res.statusCode === 403) {
        res.resume();
        return reject(new Error(`پروکسی محلی درخواست را نپذیرفت (HTTP ${res.statusCode})`));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) { req.destroy(); reject(new Error('پاسخ بیش از حد بزرگ بود')); }
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('زمان درخواست تمام شد')); });
    req.on('error', reject);
    req.end();
  });
}

// Walks the provider chain until one returns a valid public address.
// `timeoutMs` is per provider, not for the whole chain.
async function lookupPublicIp({ proxy = null, timeoutMs = 9000 } = {}) {
  const errors = [];
  for (const provider of PROVIDERS) {
    try {
      const body = await httpGet(provider.url, { proxy, timeoutMs });
      const info = provider.parse(body);
      if (!isPublicIp(info.ip)) throw new Error('پاسخ یک IP عمومی معتبر نبود');
      return {
        ip: info.ip,
        family: net.isIPv6(info.ip) ? 6 : 4,
        country: info.country ?? null,
        countryCode: info.countryCode ?? null,
        city: info.city ?? null,
        isp: info.isp ?? null,
        asn: info.asn ?? null,
        source: provider.name,
      };
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }
  const err = new Error('هیچ‌کدام از سرویس‌های تشخیص IP پاسخ ندادند');
  err.detail = errors.join(' | ');
  throw err;
}

module.exports = { lookupPublicIp, isPublicIp };
