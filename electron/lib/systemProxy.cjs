'use strict';
const { execFile } = require('child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function broadcastSettingsChange() {
  // Tell already-running WinINet-based apps (Edge, IE-based components, etc.)
  // to pick up the registry change immediately. INTERNET_OPTION_SETTINGS_CHANGED
  // (39) alone is not enough -- INTERNET_OPTION_REFRESH (37) must follow it or
  // already-open apps keep using their cached (old) proxy config until restarted.
  return new Promise((resolve) => {
    execFile('rundll32.exe', ['wininet.dll,InternetSetOption', '0', '39', '0', '0'], () => {
      execFile('rundll32.exe', ['wininet.dll,InternetSetOption', '0', '37', '0', '0'], () => resolve());
    });
  });
}

// RFC1918 private ranges only. NOTE: this must enumerate every 172.16-172.31
// octet explicitly -- a broad "172.2*" wildcard here previously matched
// Google/YouTube's own public CDN ranges (172.217.0.0/16, 172.253.0.0/16),
// which silently bypassed the proxy for exactly those sites while everything
// else worked fine.
const PRIVATE_172_RANGE = Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`).join(';');
const DEFAULT_BYPASS = `localhost;127.*;10.*;${PRIVATE_172_RANGE};192.168.*;<local>`;

// Appends the user's own extra bypass entries (settings.customBypass, a
// semicolon/comma/newline-separated list) to the built-in private-range list.
function buildBypass(customBypass) {
  if (!customBypass) return DEFAULT_BYPASS;
  const extra = customBypass
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!extra.length) return DEFAULT_BYPASS;
  return `${DEFAULT_BYPASS};${extra.join(';')}`;
}

async function enable(host, port, bypass = DEFAULT_BYPASS) {
  // Explicit per-protocol form instead of a bare "host:port" -- removes any
  // ambiguity about whether HTTPS traffic is actually covered.
  const proxyServer = `http=${host}:${port};https=${host}:${port}`;
  await run(['add', REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', proxyServer, '/f']);
  await run(['add', REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', bypass, '/f']);
  await run(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await broadcastSettingsChange();
}

async function disable() {
  await run(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
  await broadcastSettingsChange();
}

// Reads what Windows currently has configured. Returns null for values that
// aren't set, so callers can tell "no proxy" from "a proxy we can't parse".
async function read() {
  const out = { enabled: false, server: '', host: null, port: null };
  try {
    const enableOut = await run(['query', REG_KEY, '/v', 'ProxyEnable']);
    out.enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOut);
  } catch {
    return out; // value missing entirely == no proxy
  }
  try {
    const serverOut = await run(['query', REG_KEY, '/v', 'ProxyServer']);
    const m = serverOut.match(/ProxyServer\s+REG_SZ\s+(.*)/i);
    out.server = m ? m[1].trim() : '';
  } catch { /* no ProxyServer value */ }

  // Accepts both forms we might meet: the per-protocol string enable() writes
  // ("http=127.0.0.1:10809;https=..."), and a bare "host:port".
  const first = out.server.split(';')[0] || '';
  const hostPort = first.includes('=') ? first.split('=')[1] : first;
  const hm = (hostPort || '').match(/^\[?([^\]]*)\]?:(\d+)$/);
  if (hm) {
    out.host = hm[1];
    out.port = Number(hm[2]);
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
function isLoopback(host) {
  return LOOPBACK.has(String(host || '').trim().toLowerCase());
}

module.exports = { enable, disable, buildBypass, read, isLoopback };
