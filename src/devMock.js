// Dev-only stub of the preload bridge (window.soul) so the renderer can run
// in a plain browser via `vite` without Electron. Never bundled into the app:
// main.jsx only imports it when import.meta.env.DEV && !window.soul.

// `let`, not `const`: addCustomConfig below must REPLACE this with a new
// array reference (not push() in place) so React's reference-equality check
// on setProfiles() actually sees a change -- mirroring how a real IPC call
// always hands the renderer a freshly-cloned array, never the same object.
let profiles = [
  { id: 'p1', name: 'Tokyo — NTT Premium', address: 'jp1.soulnet.dev', port: 443, protocol: 'vless', network: 'ws', security: 'tls', subId: 's1', totalBytes: 4.2e9, favorite: true, lastUsedAt: Date.now() - 3600e3, link: 'vless://uuid-p1@jp1.soulnet.dev:443?type=ws&security=tls#Tokyo-NTT-Premium' },
  { id: 'p2', name: 'Frankfurt — Hetzner', address: 'de2.soulnet.dev', port: 8443, protocol: 'vmess', network: 'ws', security: 'tls', subId: 's1', totalBytes: 1.1e9, link: 'vmess://eyJhZGQiOiJkZTIuc291bG5ldC5kZXYiLCJwb3J0Ijo4NDQzfQ==' },
  { id: 'p3', name: 'Helsinki — Reality', address: 'fi1.soulnet.dev', port: 443, protocol: 'vless', network: 'tcp', security: 'reality', subId: 's1', totalBytes: 0, link: 'vless://uuid-p3@fi1.soulnet.dev:443?type=tcp&security=reality#Helsinki-Reality' },
  { id: 'p4', name: '🇵🇱 Warsaw — Trojan', address: 'pl3.soulnet.dev', port: 2053, protocol: 'trojan', network: 'grpc', security: 'tls', subId: 's2', totalBytes: 6.4e8, link: 'trojan://pass-p4@pl3.soulnet.dev:2053?type=grpc&security=tls#Warsaw-Trojan' },
  { id: 'p5', name: 'Istanbul — Direct', address: 'tr1.soulnet.dev', port: 443, protocol: 'shadowsocks', network: 'tcp', security: 'none', subId: 's2', totalBytes: 0, link: 'ss://YWVzLTI1Ni1nY206cGFzcw==@tr1.soulnet.dev:443#Istanbul-Direct' },
  { id: 'p6', name: 'خانگی — سرور شخصی', address: '91.108.4.12', port: 8080, protocol: 'vless', network: 'ws', security: 'tls', subId: null, totalBytes: 2.3e10, favorite: true, link: 'vless://uuid-p6@91.108.4.12:8080?type=ws&security=tls#خانگی' },
  { id: 'p7', name: 'US Dallas — Reality', address: 'us4.soulnet.dev', port: 443, protocol: 'vless', network: 'tcp', security: 'reality', subId: 's1', totalBytes: 0, link: 'vless://uuid-p7@us4.soulnet.dev:443?type=tcp&security=reality#US-Dallas-Reality' },
  { id: 'p8', name: 'Amsterdam — WS CDN', address: 'nl1.soulnet.dev', port: 2087, protocol: 'vmess', network: 'ws', security: 'tls', subId: 's1', totalBytes: 3.1e8, link: 'vmess://eyJhZGQiOiJubDEuc291bG5ldC5kZXYiLCJwb3J0IjoyMDg3fQ==' },
  { id: 'p9', name: 'Singapore — Edge', address: 'sg2.soulnet.dev', port: 443, protocol: 'trojan', network: 'ws', security: 'tls', subId: 's2', totalBytes: 0, link: 'trojan://pass-p9@sg2.soulnet.dev:443?type=ws&security=tls#Singapore-Edge' },
];

const subscriptions = [
  { id: 's1', name: 'SoulNet Premium', lastUpdated: Date.now() - 42 * 60000, url: 'https://sub.soulnet.dev/premium/abc123', configCount: 5 },
  { id: 's2', name: 'بکاپ رایگان', lastUpdated: Date.now() - 26 * 3600000, url: 'https://sub.soulnet.dev/free/xyz789', configCount: 3 },
];

const DEFAULT_SETTINGS = {
  launchOnStartup: false,
  runLocalProxyOnStartup: false,
  startMinimized: false,
  restorePreviousSession: false,
  minimizeToTray: true,
  autoReconnect: true,
  killSwitchEnabled: false,
  subAutoUpdateInterval: 0,
  xrayLogLevel: 'warning',
  socksPort: 10808,
  httpPort: 10809,
  socksHost: '127.0.0.1',
  socksUsername: '',
  socksPassword: '',
  httpHost: '127.0.0.1',
  httpUsername: '',
  httpPassword: '',
  customBypass: '',
};

export function installDevMock() {
  let settings = { ...DEFAULT_SETTINGS };
  let systemProxyEnabled = false;
  let state = {
    activeProfileId: 'p1',
    connectionMode: 'proxy',
    connectionState: 'disconnected',
    connectedAt: null,
    killSwitchBlocking: false,
  };
  let killSwitchArmed = false;
  const listeners = { state: [], latency: [], traffic: [], profiles: [], settings: [], updater: [], test: [], proxyLog: [] };
  const cancelled = new Set();
  let proxyLogRing = [];
  let proxyLogTimer = null;

  const emitTest = (payload) => listeners.test.forEach((fn) => fn(payload));
  const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
  // Per-server "true" characteristics so repeated tests look coherent.
  const nature = {};
  const natureOf = (id) => {
    if (!nature[id]) {
      nature[id] = {
        base: rnd(45, 420),
        jitter: rnd(3, 60),
        loss: Math.random() < 0.7 ? 0 : rnd(0, 20),
        down: rnd(0.4e6, 12e6),
        up: rnd(0.1e6, 3e6),
        dead: Math.random() < 0.12,
      };
    }
    return nature[id];
  };
  const checkCancel = (token) => {
    if (cancelled.has(token)) {
      cancelled.delete(token);
      throw new Error('cancelled');
    }
  };
  let trafficTimer = null;
  let latencyTimer = null;
  let sessionTotal = 0;

  const emitState = () => listeners.state.forEach((fn) => fn({ ...state, systemProxyEnabled }));
  const emitUpdater = (payload) => listeners.updater.forEach((fn) => fn(payload));
  const on = (key) => (fn) => {
    listeners[key].push(fn);
    return () => listeners[key].splice(listeners[key].indexOf(fn), 1);
  };

  function startTelemetry() {
    sessionTotal = 0;
    trafficTimer = setInterval(() => {
      const down = 0.4e6 + Math.random() * 2.4e6;
      const up = 0.05e6 + Math.random() * 0.4e6;
      sessionTotal += down + up;
      listeners.traffic.forEach((fn) => fn({ downlinkSpeed: down, uplinkSpeed: up, sessionTotal }));
    }, 1000);
    latencyTimer = setInterval(() => {
      listeners.latency.forEach((fn) => fn({ ms: 38 + Math.round(Math.random() * 30) }));
    }, 2000);
    const PROXY_LOG_LINES = [
      'accepted socks:127.0.0.1', 'accepted http:127.0.0.1', '[Warning] transport/internet/tcp: dial tcp failed, retrying',
      'tunnel: handshake completed', 'proxy/socks: TCP Connect', 'app/dispatcher: sniffed domain: example.com',
    ];
    proxyLogTimer = setInterval(() => {
      const entry = { t: Date.now(), text: PROXY_LOG_LINES[Math.floor(Math.random() * PROXY_LOG_LINES.length)] };
      proxyLogRing = [...proxyLogRing, entry].slice(-300);
      listeners.proxyLog.forEach((fn) => fn(entry));
    }, 1800);
  }

  function stopTelemetry() {
    clearInterval(trafficTimer);
    clearInterval(latencyTimer);
    clearInterval(proxyLogTimer);
  }

  window.soul = {
    listProfiles: async () => ({
      profiles, subscriptions, ...state,
      settings,
      systemProxyEnabled,
    }),
    getAppInfo: async () => ({ version: '2.0.0-dev', xrayVersion: '25.1.30' }),
    connect: async (id) => {
      state = { ...state, activeProfileId: id, connectionState: 'connecting' };
      emitState();
      await new Promise((r) => setTimeout(r, 1400));
      state = { ...state, connectionState: 'connected', connectedAt: Date.now() };
      if (settings.killSwitchEnabled) {
        killSwitchArmed = true;
        state = { ...state, killSwitchBlocking: false };
      }
      emitState();
      startTelemetry();
    },
    disconnect: async () => {
      state = { ...state, connectionState: 'disconnecting' };
      emitState();
      await new Promise((r) => setTimeout(r, 700));
      stopTelemetry();
      // Mirrors the real app's disconnect-time safety net: a dead local
      // proxy left as the active system proxy would break the user's internet.
      systemProxyEnabled = false;
      state = { ...state, connectionState: 'disconnected', connectedAt: null };
      // Mirrors the real Kill Switch: any disconnect while armed blocks traffic.
      if (killSwitchArmed && settings.killSwitchEnabled) {
        state = { ...state, killSwitchBlocking: true };
      }
      emitState();
    },
    setMode: async (mode) => { state = { ...state, connectionMode: mode }; },
    pingTest: async () => {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 900));
      if (Math.random() < 0.15) throw new Error('timeout');
      return { ms: 40 + Math.round(Math.random() * 500) };
    },
    addLink: async () => { throw new Error('در حالت پیش‌نمایش در دسترس نیست'); },
    addSubscription: async () => { throw new Error('در حالت پیش‌نمایش در دسترس نیست'); },
    addCustomConfig: async (fields) => {
      await new Promise((r) => setTimeout(r, 300));
      if (!fields.address?.trim()) throw new Error('آدرس سرور را وارد کن');
      const port = Number(fields.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('پورت باید بین ۱ تا ۶۵۵۳۵ باشد');
      if ((fields.protocol === 'vmess' || fields.protocol === 'vless') && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(fields.uuid || '')) {
        throw new Error('UUID نامعتبر است (فرمت: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)');
      }
      if ((fields.protocol === 'trojan' || fields.protocol === 'shadowsocks') && !fields.password?.trim()) {
        throw new Error('رمز عبور را وارد کن');
      }
      const profile = {
        id: `custom-${Date.now()}`,
        protocol: fields.protocol,
        name: fields.name?.trim() || `${fields.address}:${port}`,
        address: fields.address.trim(),
        port,
        network: fields.network || 'tcp',
        security: fields.security || 'none',
        link: `${fields.protocol}://preview-custom@${fields.address}:${port}`,
        subId: null,
        totalBytes: 0,
        createdAt: Date.now(),
      };
      profiles = [...profiles, profile];
      return profile;
    },
    refreshSubscription: async () => { await new Promise((r) => setTimeout(r, 900)); return { profiles: [] }; },
    refreshAllSubscriptions: async () => { await new Promise((r) => setTimeout(r, 900)); },
    deleteSubscription: async () => profiles,
    deleteProfile: async (id) => profiles.filter((p) => p.id !== id),
    renameProfile: async (id, name) => {
      const p = profiles.find((x) => x.id === id);
      if (p) p.name = name;
      return [...profiles];
    },
    updateProfile: async () => { throw new Error('در حالت پیش‌نمایش در دسترس نیست'); },
    updateSubscription: async (id, patch) => {
      const s = subscriptions.find((x) => x.id === id);
      if (s) Object.assign(s, patch);
      return [...subscriptions];
    },
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      if ('killSwitchEnabled' in patch) {
        if (patch.killSwitchEnabled) {
          if (state.connectionState === 'connected') killSwitchArmed = true;
        } else {
          killSwitchArmed = false;
          state = { ...state, killSwitchBlocking: false };
          emitState();
        }
      }
      return { ...settings };
    },
    exportBackup: async () => ({ canceled: true }),
    importBackup: async () => ({ canceled: true }),
    saveImage: async () => ({ canceled: true }),
    copyImage: async () => true,
    resetUsage: async () => profiles,
    resetAllUsage: async () => profiles,
    // Walks the same status sequence electron-updater emits against GitHub, so
    // the update banner and the About section can be exercised in the browser.
    checkForUpdates: () => {
      emitUpdater({ status: 'checking' });
      setTimeout(() => emitUpdater({ status: 'available', version: '2.1.0' }), 700);
    },
    downloadUpdate: () => {
      let percent = 0;
      const timer = setInterval(() => {
        percent += 12;
        if (percent >= 100) {
          clearInterval(timer);
          emitUpdater({ status: 'downloaded', version: '2.1.0' });
        } else {
          emitUpdater({ status: 'downloading', percent });
        }
      }, 250);
    },
    installUpdate: () => {},
    openLogsFolder: () => {},
    openProxyFolder: () => {},

    systemProxyEnable: async () => {
      if (state.connectionState !== 'connected') throw new Error('اول باید پروکسی محلی را روشن کنی (به یک سرور وصل شو)');
      await new Promise((r) => setTimeout(r, 250));
      systemProxyEnabled = true;
      emitState();
      return true;
    },
    systemProxyDisable: async () => {
      await new Promise((r) => setTimeout(r, 150));
      systemProxyEnabled = false;
      emitState();
      return true;
    },
    testProxyConnection: async (protocol) => {
      if (state.connectionState !== 'connected') return { ok: false, reason: 'not-running', message: 'پروکسی محلی در حال اجرا نیست' };
      await new Promise((r) => setTimeout(r, 600 + Math.random() * 600));
      const user = protocol === 'socks' ? settings.socksUsername : settings.httpUsername;
      if (user && Math.random() < 0.2) return { ok: false, reason: 'auth-failed', message: 'نام کاربری یا رمز عبور اشتباه است' };
      return { ok: true, ms: 20 + Math.round(Math.random() * 60) };
    },
    resetNetworkDefaults: async () => {
      const keys = ['socksHost', 'socksPort', 'socksUsername', 'socksPassword', 'httpHost', 'httpPort', 'httpUsername', 'httpPassword', 'customBypass'];
      const patch = {};
      for (const k of keys) patch[k] = DEFAULT_SETTINGS[k];
      settings = { ...settings, ...patch };
      return { ...settings };
    },
    getRecentProxyLogs: async () => [...proxyLogRing],
    onProxyLog: on('proxyLog'),

    // The browser preview has no real OS window chrome to control.
    windowMinimize: () => {},
    windowToggleMaximize: () => {},
    windowClose: () => {},
    windowIsMaximized: async () => false,
    onWindowState: () => () => {},

    setFavorite: async (id, favorite) => {
      const p = profiles.find((x) => x.id === id);
      if (p) p.favorite = favorite;
      return [...profiles];
    },
    testCancel: async (token) => { cancelled.add(token); },
    testPing: async (id, token) => {
      const n = natureOf(id);
      const samples = [];
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, rnd(80, 220)));
        checkCancel(token);
        const fail = n.dead || Math.random() * 100 < n.loss;
        const ms = fail ? -1 : Math.round(n.base * 0.7 + rnd(0, n.jitter * 2));
        samples.push(ms);
        emitTest({ token, type: 'sample', index: i, ms });
      }
      const ok = samples.filter((s) => s > 0);
      if (!ok.length) throw new Error('سرور به هیچ‌کدام از تست‌های پینگ پاسخ نداد');
      const avg = Math.round(ok.reduce((a, b) => a + b, 0) / ok.length);
      return {
        method: 'tcp', samples, avg, min: Math.min(...ok), max: Math.max(...ok),
        jitter: Math.round(n.jitter), loss: Math.round(((samples.length - ok.length) / samples.length) * 100),
      };
    },
    testReal: async (id, token) => {
      const n = natureOf(id);
      for (const phase of ['boot', 'reach', 'handshake', 'probe']) {
        emitTest({ token, type: 'phase', phase });
        await new Promise((r) => setTimeout(r, rnd(250, phase === 'boot' ? 900 : 500)));
        checkCancel(token);
      }
      if (n.dead) throw new Error('تونل برقرار شد ولی هیچ ترافیکی از آن عبور نکرد');
      const samples = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, rnd(120, 300)));
        checkCancel(token);
        const ms = Math.round(n.base + rnd(0, n.jitter * 2));
        samples.push(ms);
        emitTest({ token, type: 'sample', index: i, ms });
      }
      const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
      return {
        bootMs: Math.round(rnd(500, 1600)), tcpMs: Math.round(n.base * 0.6),
        firstMs: Math.round(avg + rnd(200, 900)), handshakeMs: Math.round(rnd(180, 700)),
        avg, min: Math.min(...samples), max: Math.max(...samples),
        jitter: Math.round(n.jitter), loss: 0, samples,
      };
    },
    testSpeed: async (id, token) => {
      const n = natureOf(id);
      emitTest({ token, type: 'phase', phase: 'boot' });
      await new Promise((r) => setTimeout(r, rnd(400, 1000)));
      checkCancel(token);
      if (n.dead) throw new Error('تونل برقرار شد ولی ترافیک از آن عبور نکرد');
      emitTest({ token, type: 'phase', phase: 'warmup' });
      await new Promise((r) => setTimeout(r, 500));

      const run = async (dir, target, ms) => {
        emitTest({ token, type: 'phase', phase: dir === 'down' ? 'download' : 'upload' });
        const samples = [];
        let bytes = 0;
        const start = Date.now();
        while (Date.now() - start < ms) {
          await new Promise((r) => setTimeout(r, 220));
          checkCancel(token);
          const bps = target * rnd(0.6, 1.3);
          bytes += bps * 0.22;
          samples.push({ t: Date.now() - start, bps });
          emitTest({ token, type: 'speed', dir, bps, bytes, elapsed: Date.now() - start });
        }
        return { samples, bps: bytes / ((Date.now() - start) / 1000), bytes };
      };
      const down = await run('down', n.down, 4500);
      const up = await run('up', n.up, 2500);
      return {
        bootMs: Math.round(rnd(500, 1500)),
        downBps: Math.round(down.bps), downBytes: Math.round(down.bytes), downSamples: down.samples,
        upBps: Math.round(up.bps), upBytes: Math.round(up.bytes), upSamples: up.samples,
        stability: Math.round(rnd(55, 98)),
        rttAvg: Math.round(n.base), rttJitter: Math.round(n.jitter),
      };
    },
    onStateChanged: on('state'),
    onLatencyUpdate: on('latency'),
    onTrafficUpdate: on('traffic'),
    onProfilesChanged: on('profiles'),
    onOpenSettings: on('settings'),
    onUpdaterStatus: on('updater'),
    onTestEvent: on('test'),
  };
}
