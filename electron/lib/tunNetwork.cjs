'use strict';
// The OS half of Tunnel Mode.
//
// WHY THIS EXISTS
// ---------------
// Xray's `tun` inbound is a low-level primitive: its entire config schema is
// {name, MTU, user_level} (verified against the protobuf descriptor embedded in
// the shipped binary), and the binary contains WintunCreateAdapter but *no*
// route, address or DNS APIs at all. It creates a Wintun adapter, reads packets
// off it, and nothing else.
//
// Everything that makes those packets actually arrive -- giving the adapter an
// address, installing routes, pointing DNS at it, and keeping the tunnel's own
// connection to the server outside the tunnel -- is the application's job. That
// work was never written, which is why Tunnel Mode created an adapter that
// Windows had no reason to send anything to: apps set to "Direct" simply used
// the physical NIC, unproxied.
//
// HOW THE ROUTING WORKS
// ---------------------
// Rather than replacing the system default route (destructive, and awkward to
// put back), this installs the two halves of the address space as /1 routes:
//
//     0.0.0.0/1    -> tun gateway
//     128.0.0.0/1  -> tun gateway
//
// Together they cover everything, and both are strictly more specific than the
// real 0.0.0.0/0, so they win on longest-prefix match while the original
// default route stays untouched underneath. Removing them restores normal
// routing exactly, with no need to remember what was there before.
//
// The one thing that must NOT go through the tunnel is xray's own connection to
// the proxy server -- that would be a routing loop. A host route for each
// server IP, pointed at the real gateway, is pinned before the /1 routes go in.
const { execFile } = require('child_process');
const net = require('net');
const dns = require('dns');

const ADAPTER_WAIT_MS = 15000;
const ADAPTER_POLL_MS = 250;

function run(file, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        out: (stdout || '').toString(),
        err: ((stderr || '') + (err && !stderr ? err.message : '')).toString(),
      });
    });
  });
}

// PowerShell is used for the queries that have no reasonable netsh equivalent
// (interface index lookup, best-route discovery). Output is JSON so nothing
// depends on locale-specific table formatting -- `route print` and `netsh`
// output are translated on non-English Windows and cannot be parsed safely.
async function ps(script) {
  const r = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  return r;
}

async function psJson(script) {
  const r = await ps(`$ErrorActionPreference='Stop'; ${script} | ConvertTo-Json -Compress -Depth 4`);
  if (!r.ok) return null;
  const text = r.out.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the Wintun adapter xray creates to show up, and return its
 * ifIndex. Creation is asynchronous with respect to xray reporting "started",
 * so this has to poll rather than assume.
 */
async function waitForAdapter(name, timeoutMs = ADAPTER_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await psJson(
      `Get-NetAdapter -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue `
      + '| Select-Object -First 1 ifIndex, Name, Status'
    );
    if (info && info.ifIndex) return info;
    if (Date.now() > deadline) return null;
    await sleep(ADAPTER_POLL_MS);
  }
}

/**
 * The route the machine uses to reach the internet right now, captured BEFORE
 * our own routes go in. Needed to pin the server host-route to the real path.
 */
async function currentDefaultRoute() {
  const r = await psJson(
    'Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue '
    + '| Sort-Object -Property RouteMetric, ifMetric '
    + '| Select-Object -First 1 ifIndex, NextHop, RouteMetric'
  );
  if (!r || !r.ifIndex) return null;
  return { ifIndex: r.ifIndex, nextHop: r.NextHop };
}

// Resolve the server address to every IP we might dial, so each can be pinned
// outside the tunnel. An address that is already an IP needs no lookup.
async function resolveServerIps(address) {
  if (!address) return [];
  if (net.isIP(address)) return [address];
  try {
    const res = await dns.promises.lookup(address, { all: true, verbatim: false });
    return res.map((r) => r.address).filter((ip) => net.isIPv4(ip));
  } catch {
    return [];
  }
}

class TunNetwork {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.applied = null; // { adapterName, ifIndex, serverIps, gatewayIfIndex, gatewayNextHop }
  }

  get isApplied() {
    return !!this.applied;
  }

  /**
   * Bring the adapter into service: address, DNS, server pin-routes, then the
   * two /1 routes that actually capture the machine's traffic.
   *
   * Order matters. The server pin-routes go in BEFORE the /1 routes, so there
   * is never a window where xray's own connection to the server could be
   * captured by the tunnel it is building.
   */
  async apply({
    adapterName,
    address = '10.90.90.2',
    prefixLength = 24,
    gateway = '10.90.90.1',
    dnsServers = ['1.1.1.1', '8.8.8.8'],
    serverAddress = null,
    metric = 1,
  }) {
    const adapter = await waitForAdapter(adapterName);
    if (!adapter) {
      throw new Error(
        `آداپتور تونل («${adapterName}») ساخته نشد. مطمئن شوید برنامه با دسترسی مدیر اجرا شده است.`
      );
    }
    const ifIndex = adapter.ifIndex;
    this.log(`[tun] adapter ${adapterName} is ifIndex ${ifIndex}`);

    // Captured before we touch the table, so cleanup and pinning both refer to
    // the machine's real path to the internet.
    const def = await currentDefaultRoute();
    const serverIps = await resolveServerIps(serverAddress);
    this.log(`[tun] default via ${def ? def.nextHop + ' if' + def.ifIndex : 'unknown'}; server ips ${serverIps.join(',') || 'none'}`);

    // Record what we are about to do BEFORE doing it: a failure halfway through
    // still has to be fully undoable.
    this.applied = {
      adapterName, ifIndex, serverIps,
      gatewayIfIndex: def ? def.ifIndex : null,
      gatewayNextHop: def ? def.nextHop : null,
      dnsServers,
    };

    // 1. Address on the tunnel adapter.
    let r = await run('netsh', [
      'interface', 'ip', 'set', 'address',
      `name=${ifIndex}`, 'static', address, maskFromPrefix(prefixLength),
    ]);
    if (!r.ok) {
      // Some Windows builds reject `name=<index>`; fall back to the literal name.
      r = await run('netsh', [
        'interface', 'ip', 'set', 'address',
        `name=${adapterName}`, 'static', address, maskFromPrefix(prefixLength),
      ]);
    }
    if (!r.ok) {
      await this.teardown();
      throw new Error(`تنظیم آدرس روی آداپتور تونل ناموفق بود: ${(r.err || r.out).trim().slice(0, 200)}`);
    }

    // 2. DNS on the tunnel adapter. Queries are hijacked by xray's routing
    //    (port 53 -> dns outbound) so these addresses never have to be
    //    reachable as such -- they only have to be what Windows hands to apps.
    await run('netsh', ['interface', 'ip', 'set', 'dnsservers', `name=${ifIndex}`, 'static', dnsServers[0], 'primary', 'validate=no']);
    for (let i = 1; i < dnsServers.length; i++) {
      await run('netsh', ['interface', 'ip', 'add', 'dnsservers', `name=${ifIndex}`, dnsServers[i], `index=${i + 1}`, 'validate=no']);
    }

    // 3. Pin the proxy server outside the tunnel. Without this the outbound
    //    connection to the server is itself captured -> immediate loop.
    if (def && def.nextHop && def.nextHop !== '0.0.0.0') {
      for (const ip of serverIps) {
        await run('route', ['add', ip, 'mask', '255.255.255.255', def.nextHop, 'metric', '1', 'if', String(def.ifIndex)]);
      }
    } else if (serverIps.length) {
      this.log('[tun] no usable default gateway found; server pin-routes skipped');
    }

    // 4. The two halves of the address space. More specific than 0.0.0.0/0, so
    //    they take precedence without disturbing it.
    for (const [dest, mask] of [['0.0.0.0', '128.0.0.0'], ['128.0.0.0', '128.0.0.0']]) {
      const rr = await run('route', ['add', dest, 'mask', mask, gateway, 'metric', String(metric), 'if', String(ifIndex)]);
      if (!rr.ok) {
        await this.teardown();
        throw new Error(`افزودن مسیر تونل ناموفق بود: ${(rr.err || rr.out).trim().slice(0, 200)}`);
      }
    }

    // 5. Flush the resolver so nothing keeps answering from a pre-tunnel cache.
    await run('ipconfig', ['/flushdns']);

    this.log('[tun] routes installed');
    return { ifIndex, serverIps };
  }

  /**
   * Undo everything apply() did. Safe to call at any time, including when
   * nothing was applied, and deliberately best-effort per step: one failing
   * command must not strand the rest of the cleanup, because what is left
   * behind is the user's internet connection.
   */
  async teardown() {
    const state = this.applied;
    this.applied = null;
    if (!state) return;

    for (const [dest, mask] of [['0.0.0.0', '128.0.0.0'], ['128.0.0.0', '128.0.0.0']]) {
      await run('route', ['delete', dest, 'mask', mask]);
    }
    for (const ip of state.serverIps || []) {
      await run('route', ['delete', ip, 'mask', '255.255.255.255']);
    }
    if (state.ifIndex) {
      await run('netsh', ['interface', 'ip', 'set', 'dnsservers', `name=${state.ifIndex}`, 'dhcp']);
    }
    await run('ipconfig', ['/flushdns']);
    this.log('[tun] routes removed');
  }

  /**
   * Remove any tunnel routes left behind by a previous run that died without
   * cleaning up. Matched by the tunnel gateway address, so a route belonging to
   * anything else is never touched. Runs at startup, like the system-proxy
   * reconcile, because a stranded /1 pair means no internet at all.
   */
  static async reconcileStale(gateway = '10.90.90.1') {
    const rows = await psJson(
      'Get-NetRoute -ErrorAction SilentlyContinue '
      + `| Where-Object { $_.NextHop -eq '${gateway}' } `
      + '| Select-Object DestinationPrefix, ifIndex'
    );
    if (!rows) return 0;
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) return 0;
    for (const row of list) {
      if (!row || !row.DestinationPrefix) continue;
      await ps(
        `Remove-NetRoute -DestinationPrefix '${row.DestinationPrefix}' `
        + `-NextHop '${gateway}' -Confirm:$false -ErrorAction SilentlyContinue`
      );
    }
    return list.length;
  }
}

function maskFromPrefix(prefix) {
  const bits = ~((1 << (32 - prefix)) - 1) >>> 0;
  return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join('.');
}

module.exports = { TunNetwork, maskFromPrefix };
