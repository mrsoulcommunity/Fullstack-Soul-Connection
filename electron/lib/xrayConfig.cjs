'use strict';

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

  if (mode === 'tun') {
    inbounds.push({
      tag: 'tun-in',
      protocol: 'tun',
      settings: {
        name: 'soulconnection-tun',
        mtu: 1500,
        gateway: ['10.90.90.1/24'],
        dns: ['1.1.1.1'],
        autoSystemRoutingTable: ['0.0.0.0/0'],
        autoOutboundsInterface: 'auto',
      },
      sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    });
  }

  return assemble(profile, opts, inbounds);
}

// Everything both layouts share: the three outbounds, the routing rule list
// Smart Routing compiled for us, and the optional stats API.
function assemble(profile, opts, inbounds) {
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
      domainStrategy: 'AsIs',
      rules: routingRules,
    },
  };

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

  if (opts.mode === 'tun') {
    // Tunnel mode never passes through the dispatcher (there is no local
    // listener in the path), so its traffic follows the compiled domain rules
    // exactly as it does with the dispatcher off.
    inbounds.push({
      tag: 'tun-in',
      protocol: 'tun',
      settings: {
        name: 'soulconnection-tun',
        mtu: 1500,
        gateway: ['10.90.90.1/24'],
        dns: ['1.1.1.1'],
        autoSystemRoutingTable: ['0.0.0.0/0'],
        autoOutboundsInterface: 'auto',
      },
      sniffing,
    });
  }

  return assemble(profile, opts, inbounds);
}

module.exports = { buildXrayConfig };
