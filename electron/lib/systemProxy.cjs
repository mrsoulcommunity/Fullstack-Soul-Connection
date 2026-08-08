'use strict';
// Windows system-proxy plumbing (HKCU Internet Settings).
//
// Three things here are load-bearing and were each a real bug at some point:
//
//  1. WRITES ARE VERIFIED. Every apply/clear reads the registry back and throws
//     if Windows didn't end up in the requested state. Callers used to assume
//     success and cache a boolean, which is how the UI ended up claiming the
//     proxy was on while Windows had it off.
//
//  2. WinINet IS NOTIFIED PROPERLY. The old code shelled out to
//     `rundll32 wininet.dll,InternetSetOption 0 39 0 0`, which cannot work:
//     rundll32 calls `void CALLBACK Entry(HWND, HINSTANCE, LPSTR, int)`, so
//     InternetSetOption received an HINSTANCE where dwOption belongs and a
//     pointer to the literal string "0 39 0 0" where lpBuffer belongs -- and
//     rundll32 exits 0 regardless, so it always looked like it worked. Apps
//     already running (Edge, anything on WinINet/.NET) therefore kept their
//     cached "direct" config and the proxy appeared to do nothing. The P/Invoke
//     below is the real call and reports whether it succeeded.
//
//  3. PAC BEATS MANUAL PROXY. If AutoConfigURL is set, WinINet ignores
//     ProxyServer entirely -- traffic silently goes direct while every value we
//     write looks correct. It has to be cleared (and restored) with the rest.
const { execFile } = require('child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim()));
      resolve(stdout || '');
    });
  });
}

// For deletes of values that may legitimately not exist.
async function regQuiet(args) {
  try { await reg(args); return true; } catch { return false; }
}

// ---- WinINet change notification ----
//
// INTERNET_OPTION_SETTINGS_CHANGED (39) tells WinINet to re-read the registry;
// INTERNET_OPTION_REFRESH (37) must follow or already-open handles keep the old
// config. PowerShell is used purely as a P/Invoke host so this needs no native
// module. Costs ~500ms, so callers fire it without awaiting the result -- the
// registry write is what makes the change authoritative for new processes.
const PINVOKE_SIG =
  '[DllImport("wininet.dll", SetLastError=true)] '
  + 'public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);';

function notifyWinInet() {
  const script = [
    `$s='${PINVOKE_SIG.replace(/'/g, "''")}';`,
    '$w=Add-Type -MemberDefinition $s -Name SCWinINet -Namespace SC -PassThru;',
    '$a=$w::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0);',
    '$b=$w::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0);',
    'if ($a -and $b) { exit 0 } else { exit 1 }',
  ].join('');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 10000 },
      (err) => resolve(!err)
    );
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

// Explicit per-protocol form instead of a bare "host:port" -- removes any
// ambiguity about whether HTTPS traffic is covered. (A bare "host:port" is
// also what a SOCKS-port mix-up looks like in the wild: WinINet treats it as
// an HTTP proxy and every request fails.)
function serverString(host, port) {
  return `http=${host}:${port};https=${host}:${port}`;
}

function parseHostPort(server) {
  const first = String(server || '').split(';')[0] || '';
  const hostPort = first.includes('=') ? first.split('=').slice(1).join('=') : first;
  const m = hostPort.trim().match(/^\[?([^\]]*?)\]?:(\d+)$/);
  return m ? { host: m[1], port: Number(m[2]) } : { host: null, port: null };
}

// One `reg query` for the whole key rather than one per value: this runs on a
// timer for drift detection, so it needs to stay cheap (~20ms, one process).
async function read() {
  const out = {
    enabled: false, server: '', host: null, port: null,
    bypass: '', pac: null, autoDetect: false, readable: true,
  };
  let text;
  try {
    text = await reg(['query', REG_KEY]);
  } catch {
    out.readable = false;
    return out;
  }

  const value = (name, type) => {
    const m = text.match(new RegExp(`^\\s*${name}\\s+${type}\\s+(.*)$`, 'im'));
    return m ? m[1].trim() : null;
  };

  const enable = value('ProxyEnable', 'REG_DWORD');
  out.enabled = enable != null && Number.parseInt(enable, 16) === 1;
  out.server = value('ProxyServer', 'REG_SZ') || '';
  out.bypass = value('ProxyOverride', 'REG_SZ') || '';
  const pac = value('AutoConfigURL', 'REG_SZ');
  out.pac = pac || null; // an empty AutoConfigURL is not a PAC config
  const detect = value('AutoDetect', 'REG_DWORD');
  out.autoDetect = detect != null && Number.parseInt(detect, 16) === 1;

  Object.assign(out, parseHostPort(out.server));
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
function isLoopback(host) {
  return LOOPBACK.has(String(host || '').trim().toLowerCase());
}

// Does what Windows currently has configured match what we intended to set?
// Host comparison is loose on purpose: we may have written "localhost" while
// the registry reports "127.0.0.1" (or vice versa) and they mean the same
// listener, but a different PORT is always a real mismatch.
function pointsAt(state, host, port) {
  if (!state.enabled || state.port !== Number(port)) return false;
  if (state.pac) return false; // a PAC file wins over ProxyServer -- not really applied
  const a = String(state.host || '').toLowerCase();
  const b = String(host || '').toLowerCase();
  return a === b || (isLoopback(a) && isLoopback(b));
}

/**
 * Point Windows at host:port and confirm it took.
 * Returns the verified registry state; throws if Windows disagrees.
 */
async function apply(host, port, bypass = DEFAULT_BYPASS) {
  await reg(['add', REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', serverString(host, port), '/f']);
  await reg(['add', REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', bypass, '/f']);
  // See note 3 at the top of the file: with this present, nothing below matters.
  await regQuiet(['delete', REG_KEY, '/v', 'AutoConfigURL', '/f']);
  await reg(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);

  notifyWinInet();

  const after = await read();
  if (!pointsAt(after, host, port)) {
    throw new Error(
      `ویندوز تنظیمات پروکسی را نپذیرفت (انتظار ${host}:${port}، مقدار فعلی «${after.server || 'خالی'}»`
      + `${after.pac ? ' با اسکریپت PAC فعال' : ''}${after.enabled ? '' : ' و غیرفعال'})`
    );
  }
  return after;
}

/**
 * Turn the system proxy off and confirm it. `restore` is a snapshot previously
 * returned by read(): when the user had their own proxy configured before we
 * touched anything, put it back rather than leaving them with no proxy at all.
 * Otherwise the stale ProxyServer string is removed too, so nothing is left
 * behind pointing at a port we no longer listen on.
 */
async function clear({ restore = null } = {}) {
  if (restore && restore.server) {
    await reg(['add', REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', restore.server, '/f']);
    if (restore.bypass) {
      await reg(['add', REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', restore.bypass, '/f']);
    }
  } else {
    await regQuiet(['delete', REG_KEY, '/v', 'ProxyServer', '/f']);
  }
  if (restore && restore.pac) {
    await reg(['add', REG_KEY, '/v', 'AutoConfigURL', '/t', 'REG_SZ', '/d', restore.pac, '/f']);
  }
  const enable = restore && restore.enabled ? '1' : '0';
  await reg(['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enable, '/f']);

  notifyWinInet();

  const after = await read();
  if (!restore && after.enabled) {
    throw new Error('ویندوز پروکسی سیستم را خاموش نکرد');
  }
  return after;
}

module.exports = {
  apply, clear, read, buildBypass, isLoopback, pointsAt, serverString, parseHostPort,
  notifyWinInet, DEFAULT_BYPASS, REG_KEY,
};
