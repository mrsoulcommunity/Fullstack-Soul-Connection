'use strict';
const net = require('net');

// A bare IP needs no DNS entry and is matched by an `ip` rule rather than a
// `domain` one -- the distinction decides how the server gets pinned outside
// the tunnel in tunnel mode.
function isIpLiteral(address) {
  return net.isIP(String(address || '').replace(/^\[|\]$/g, '')) !== 0;
}

function streamSettings(p) {
  const s = { network: p.network || 'tcp' };

  if (p.security === 'tls' || p.security === 'reality') {
    s.security = p.security;
    if (p.security === 'tls') {
      s.tlsSettings = {
        serverName: p.sni || p.address,
        allowInsecure: !!p.allowInsecure,
        alpn: p.alpn ? p.alpn.split(',').filter(Boolean) : undefined,
        fingerprint: p.fingerprint || undefined,
      };
    } else {
      s.realitySettings = {
        serverName: p.sni || p.address,
        fingerprint: p.fingerprint || 'chrome',
        publicKey: p.publicKey || '',
        shortId: p.shortId || '',
        spiderX: p.spiderX || '',
      };
    }
  }

  switch (p.network) {
    case 'ws':
      // `host` is the current field. Passing the Host header inside `headers`
      // still works but xray logs a deprecation warning for every connection,
      // and the field is slated for removal.
      s.wsSettings = { path: p.path || '/', host: p.host || undefined };
      break;
    // XHTTP (and the older names it replaced). Without these cases the network
    // was set on the stream but no settings object was emitted, so xray fell
    // back to defaults and ignored the server's path/host/mode entirely -- the
    // tunnel came up and then no traffic passed through it.
    case 'xhttp':
    case 'splithttp':
      s.network = 'xhttp';
      s.xhttpSettings = {
        path: p.path || '/',
        host: p.host || undefined,
        mode: p.mode || 'auto',
      };
      break;
    case 'httpupgrade':
      s.httpupgradeSettings = { path: p.path || '/', host: p.host || undefined };
      break;
    case 'grpc':
      s.grpcSettings = { serviceName: p.serviceName || '', multiMode: p.mode === 'multi' };
      break;
    case 'h2':
    case 'http':
      s.httpSettings = { path: p.path || '/', host: p.host ? [p.host] : [] };
      break;
    case 'tcp':
      if (p.headerType === 'http') {
        s.tcpSettings = {
          header: {
            type: 'http',
            request: { path: [p.path || '/'], headers: p.host ? { Host: [p.host] } : {} },
          },
        };
      }
      break;
    case 'kcp':
      s.kcpSettings = { header: { type: p.headerType || 'none' } };
      break;
  }
  return s;
}

function buildOutbound(p) {
  switch (p.protocol) {
    case 'vmess':
      return {
        protocol: 'vmess',
        settings: {
          vnext: [{
            address: p.address,
            port: p.port,
            users: [{ id: p.uuid, alterId: p.alterId || 0, security: p.scy || 'auto' }],
          }],
        },
        streamSettings: streamSettings(p),
      };
    case 'vless':
      return {
        protocol: 'vless',
        settings: {
          vnext: [{
            address: p.address,
            port: p.port,
            users: [{ id: p.uuid, encryption: p.encryption || 'none', flow: p.flow || undefined }],
          }],
        },
        streamSettings: streamSettings(p),
      };
    case 'trojan':
      return {
        protocol: 'trojan',
        settings: {
          servers: [{ address: p.address, port: p.port, password: p.password }],
        },
        streamSettings: streamSettings(p),
      };
    case 'shadowsocks':
      return {
        protocol: 'shadowsocks',
        settings: {
          servers: [{ address: p.address, port: p.port, method: p.method, password: p.password }],
        },
        streamSettings: streamSettings({ ...p, security: 'none' }),
      };
    default:
      throw new Error(`Unsupported protocol: ${p.protocol}`);
  }
}

// Smart Routing hands us either a compiled rule list (domain rules, LAN
// handling, the mode default) or -- when a rule names an executable -- a
// dispatcher layout, where xray stops owning the public ports and instead
// exposes four private inbounds whose tags encode the decision the dispatcher
// already made. See lib/routing/ for both halves.
function buildXrayConfig(profile, opts = {}) {
  if (opts.dispatchPorts) return buildDispatchConfig(profile, opts);
  const socksPort = opts.socksPort || 10808;
  const httpPort = opts.httpPort || 10809;
  const socksHost = opts.socksHost || '127.0.0.1';
  const httpHost = opts.httpHost || '127.0.0.1';
  const mode = opts.mode || 'proxy'; // 'proxy' | 'tun'

  const socksSettings = { udp: true, auth: 'noauth' };
  if (opts.socksAccounts && opts.socksAccounts.length) {
    socksSettings.auth = 'password';
    socksSettings.accounts = opts.socksAccounts; // [{ user, pass }]
  }
  const httpSettings = {};
  if (opts.httpAccounts && opts.httpAccounts.length) {
    // Presence of `accounts` is what turns on auth for xray's http inbound.
    httpSettings.accounts = opts.httpAccounts; // [{ user, pass }]
  }

  const inbounds = [
    {
      tag: 'socks-in',
      listen: socksHost,
      port: socksPort,
      protocol: 'socks',
      settings: socksSettings,
      sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    },
    {
      tag: 'http-in',
      listen: httpHost,
      port: httpPort,
      protocol: 'http',
      settings: httpSettings,
      sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    },
  ];

  if (mode === 'tun') inbounds.push(tunInbound());

  return assemble(profile, opts, inbounds);
}

// Tunnel-mode constants. The address plan is arbitrary but must agree with what
// tunNetwork.cjs configures on the adapter, so both read it from here.
const TUN_NAME = 'soulconnection-tun';
const TUN_MTU = 1500;
const TUN_ADDRESS = '10.90.90.2';
const TUN_GATEWAY = '10.90.90.1';
const TUN_PREFIX = 24;
const TUN_DNS = ['1.1.1.1', '8.8.8.8'];

// xray.proxy.tun.Config has exactly three fields -- name, MTU, user_level --
// confirmed against the protobuf descriptor embedded in the shipped binary.
// The previous config also passed `gateway`, `dns`, `autoSystemRoutingTable`
// and `autoOutboundsInterface`; none of those exist, and xray accepts unknown
// setting keys without complaint, so they were silently discarded. That is why
// Tunnel Mode produced an adapter with no address and no routes, which Windows
// had no reason to send traffic to. Address/route/DNS setup lives in
// lib/tunNetwork.cjs, where the OS actually accepts it.
//
// Sniffing is not optional here: traffic arrives as raw IP packets addressed to
// an IP, so without recovering the hostname from the HTTP/TLS handshake, domain
// routing rules would have nothing to match on.
function tunInbound() {
  return {
    tag: 'tun-in',
    protocol: 'tun',
    settings: { name: TUN_NAME, MTU: TUN_MTU },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
  };
}

// Everything both layouts share: the three outbounds, the routing rule list
// Smart Routing compiled for us, and the optional stats API.
function assemble(profile, opts, inbounds) {
  const tunMode = opts.mode === 'tun';
  const outbounds = [
    { ...buildOutbound(profile), tag: 'proxy' },
    { protocol: 'freedom', tag: 'direct', settings: {} },
    { protocol: 'blackhole', tag: 'block', settings: {} },
  ];

  // Falls back to the historical behaviour (LAN direct, everything else
  // through the tunnel) when no routing policy was supplied.
  const routingRules = Array.isArray(opts.routingRules)
    ? opts.routingRules.slice()
    : [{ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' }];

  const config = {
    log: { loglevel: opts.logLevel || 'warning' },
    inbounds,
    outbounds,
    routing: {
      // In tunnel mode connections arrive already resolved to an IP, so geosite
      // rules would never match on their own. IPIfNonMatch lets a domain rule
      // still be decided by resolving it, with sniffing recovering the hostname
      // for anything that speaks HTTP or TLS.
      domainStrategy: tunMode ? 'IPIfNonMatch' : 'AsIs',
      rules: routingRules,
    },
  };

  if (tunMode) {
    // ---- DNS, and why it has to work this way ----
    //
    // Windows hands apps the tunnel adapter's DNS server, so every lookup
    // arrives as a UDP:53 packet inside the tunnel. Sending that to the proxy
    // outbound makes name resolution depend on the server relaying UDP, which
    // plenty of servers (and plenty of CDN-fronted WebSocket setups) simply do
    // not do -- and when it fails, *nothing* resolves and every app looks
    // broken while TCP through the tunnel is perfectly healthy.
    //
    // The `dns` outbound removes that dependency: it intercepts those queries
    // and re-issues them through xray's own resolver over DoH, which is
    // ordinary TCP and rides any transport. Apps still think they are talking
    // to 1.1.1.1 over UDP.
    outbounds.push({ protocol: 'dns', tag: 'dns-out', settings: { nonIPQuery: 'drop' } });

    const servers = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];
    // The server's own hostname is the one name that cannot be resolved through
    // the tunnel -- the tunnel does not exist yet. Give it a plain resolver,
    // pinned direct by the routing rule added below.
    if (profile && profile.address && !isIpLiteral(profile.address)) {
      servers.unshift({
        address: '1.1.1.1',
        domains: [`full:${profile.address}`],
        skipFallback: true,
      });
    }
    config.dns = {
      servers,
      // AAAA answers are withheld: only 0.0.0.0/1 and 128.0.0.0/1 are captured,
      // so any IPv6 an app obtained would leave the machine outside the tunnel.
      queryStrategy: 'UseIPv4',
      disableCache: false,
    };

    // Order is load-bearing; these go in front of every user rule.
    const front = [
      // Hijack DNS before anything else can claim it.
      { type: 'field', inboundTag: ['tun-in'], port: 53, outboundTag: 'dns-out' },
    ];
    // Keep xray's own connection to the server outside the tunnel it is
    // building. tunNetwork.cjs pins the same address with a host route; this is
    // the matching half inside xray, and covers the case where the pin-route
    // could not be installed.
    if (profile && profile.address) {
      front.push({
        type: 'field',
        [isIpLiteral(profile.address) ? 'ip' : 'domain']:
          [isIpLiteral(profile.address) ? profile.address : `full:${profile.address}`],
        outboundTag: 'direct',
      });
    }
    // QUIC is UDP-only. If the transport cannot carry UDP the browser stalls on
    // it before falling back; refusing it outright makes that fallback instant.
    front.push({ type: 'field', network: 'udp', port: 443, outboundTag: 'block' });
    // The machine's own LAN has to stay reachable (router, printers, NAS).
    // The compiled rule set usually carries this already; only add it when it
    // doesn't, so the list stays readable in the logs.
    const hasPrivateRule = routingRules.some(
      (r) => Array.isArray(r.ip) && r.ip.includes('geoip:private') && r.outboundTag === 'direct'
    );
    if (!hasPrivateRule) front.push({ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' });

    routingRules.unshift(...front);
  }

  // Traffic stats: exposes a local gRPC StatsService that statsApi.cjs polls
  // for live upload/download counters on the 'proxy' outbound.
  if (opts.apiPort) {
    config.api = { tag: 'api', services: ['StatsService'] };
    config.stats = {};
    config.policy = {
      system: { statsOutboundUplink: true, statsOutboundDownlink: true },
    };
    inbounds.push({
      tag: 'api-in',
      listen: '127.0.0.1',
      port: opts.apiPort,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
    });
    outbounds.push({ tag: 'api', protocol: 'freedom', settings: {} });
    routingRules.unshift({ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' });
  }

  return config;
}

// Dispatcher layout. The four inbounds are loopback-only and unadvertised:
// nothing but the dispatcher ever connects to them, and the routing rules
// (compiled by routing/xrayRouting.cjs) map each tag straight to an outbound.
//
// SOCKS auth is deliberately absent here even when the user configured it --
// the dispatcher owns the public port and has already checked the credentials
// before any of these ports are reached. HTTP auth stays on, because the
// dispatcher forwards HTTP requests verbatim and lets xray answer the 407.
function buildDispatchConfig(profile, opts) {
  const p = opts.dispatchPorts;
  const sniffing = { enabled: true, destOverride: ['http', 'tls'] };
  const httpSettings = {};
  if (opts.httpAccounts && opts.httpAccounts.length) httpSettings.accounts = opts.httpAccounts;

  const inbounds = [
    { tag: 'smart-proxy-socks', listen: '127.0.0.1', port: p.proxySocks, protocol: 'socks', settings: { udp: true, auth: 'noauth' }, sniffing },
    { tag: 'smart-proxy-http', listen: '127.0.0.1', port: p.proxyHttp, protocol: 'http', settings: httpSettings, sniffing },
    { tag: 'smart-direct-socks', listen: '127.0.0.1', port: p.directSocks, protocol: 'socks', settings: { udp: true, auth: 'noauth' }, sniffing },
    { tag: 'smart-direct-http', listen: '127.0.0.1', port: p.directHttp, protocol: 'http', settings: httpSettings, sniffing },
  ];

  // Tunnel mode never passes through the dispatcher (there is no local listener
  // in the path), so its traffic follows the compiled domain rules exactly as it
  // does with the dispatcher off.
  if (opts.mode === 'tun') inbounds.push(tunInbound());

  return assemble(profile, opts, inbounds);
}

// The address plan is shared with tunNetwork.cjs, which has to configure the
// adapter to match what the inbound was told to create.
module.exports = {
  buildXrayConfig,
  TUN_NAME,
  TUN_MTU,
  TUN_ADDRESS,
  TUN_GATEWAY,
  TUN_PREFIX,
  TUN_DNS,
};
