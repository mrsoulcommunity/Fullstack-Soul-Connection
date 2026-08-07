'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// Windows/Electron quirk: when launched from a UAC elevation prompt (portable
// build run as administrator, or the app's own relaunchElevated() for tunnel
// mode), Chromium can start up with a stale/unscaled DPI reading from before
// the secure-desktop transition finishes settling -- the window then renders
// at the wrong scale, with every row's layout box sized for 100% while the
// actual text/glyphs paint at the real (125%/150%/etc.) scale, so everything
// overlaps. Must be set before app is ready.
app.commandLine.appendSwitch('high-dpi-support', '1');

const { parseLink, parseMany, newId, parseSubscriptionUserinfo, buildCustomProfile } = require('./lib/parsers.cjs');
const { buildXrayConfig } = require('./lib/xrayConfig.cjs');
const { XrayProcess } = require('./lib/xrayProcess.cjs');
const systemProxy = require('./lib/systemProxy.cjs');
const killSwitch = require('./lib/killSwitch.cjs');
const { tcpPing } = require('./lib/pingTest.cjs');
const { proxyPing } = require('./lib/proxyPing.cjs');
const serverTest = require('./lib/serverTest.cjs');
const { testLocalProxy } = require('./lib/localProxyTest.cjs');
const { fetchText } = require('./lib/fetchText.cjs');
const { JsonStore } = require('./lib/store.cjs');
const { findFreePort } = require('./lib/freePort.cjs');
const { isElevated, relaunchElevated } = require('./lib/elevation.cjs');
const { StatsClient } = require('./lib/statsApi.cjs');
const { initUpdater, checkForUpdates, downloadUpdate, downloadAndInstall, quitAndInstall } = require('./lib/updater.cjs');
const { SoulPool } = require('./lib/soulPool.cjs');

const SOCKS_PORT = 10808;
const HTTP_PORT = 10809;
const API_PORT = 10810;
const LATENCY_POLL_MS = 15000;
const TRAFFIC_POLL_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

const DEFAULT_SETTINGS = {
  launchOnStartup: false,
  runLocalProxyOnStartup: false, // replaces the old autoConnect (migrated in getSettings())
  startMinimized: false,
  restorePreviousSession: false, // renderer-owned UI state; main just persists/exposes it
  minimizeToTray: true,
  autoReconnect: true,
  killSwitchEnabled: false,
  subAutoUpdateInterval: 0, // ms; 0 = off
  xrayLogLevel: 'warning',
  socksPort: SOCKS_PORT, // preferred; auto-bumped to the next free port if taken
  httpPort: HTTP_PORT,
  socksHost: '127.0.0.1',
  socksUsername: '',
  socksPassword: '',
  httpHost: '127.0.0.1',
  httpUsername: '',
  httpPassword: '',
  customBypass: '', // extra semicolon-separated hosts/patterns added to the system-proxy bypass list
};

// True portable mode: electron-builder's portable Windows target sets
// PORTABLE_EXECUTABLE_DIR (the folder containing the actual .exe, as opposed
// to the temp dir it's extracted/run from) so the app can keep all of its
// data next to the exe instead of scattering it into the user's AppData --
// carry the exe + its "data" folder anywhere and it's fully self-contained,
// with no trace left on a machine after you delete that folder. Falls back
// to the normal per-user AppData path for the NSIS-installed build and for
// local development (where this env var is never set).
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
}

const userDataDir = app.getPath('userData');
fs.mkdirSync(userDataDir, { recursive: true });
const store = new JsonStore(path.join(userDataDir, 'profiles.json'), {
  profiles: [],
  subscriptions: [],
  activeProfileId: null,
  settings: { ...DEFAULT_SETTINGS },
  systemProxyEnabled: false, // app-owned live state, not a user preference -- set only by systemProxy:enable/disable and the disconnect safety net
});

const xrayBin = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'xray.exe')
  : path.join(__dirname, '..', 'bin', 'xray.exe');
const xrayWorkDir = path.join(userDataDir, 'xray-run');

const xray = new XrayProcess(xrayBin, xrayWorkDir);

// Same work root the manual server tests use -- startTestTunnel() already
// carves a throwaway per-test subdirectory out of it.
const soulPool = new SoulPool({ store, xrayBin, workRoot: xrayWorkDir });

// Local proxy log panel (Network settings): keep a capped ring buffer so a
// freshly opened panel isn't empty, and forward each line live.
const MAX_PROXY_LOGS = 300;
let proxyLogRing = [];
xray.on('log', (text) => {
  const entry = { t: Date.now(), text: text.trim() };
  proxyLogRing.push(entry);
  if (proxyLogRing.length > MAX_PROXY_LOGS) proxyLogRing.splice(0, proxyLogRing.length - MAX_PROXY_LOGS);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proxy-log', entry);
  if (process.env.SC_DEBUG) console.log('[xray]', entry.text);
});

let mainWindow = null;
let tray = null;
let isQuitting = false;
let expectedExit = false;
let reconnectAttempts = 0;
// Kill Switch: `killSwitchBlocking` mirrors whether the outbound-block
// firewall rules are actually in place right now; `killSwitchArmed` tracks
// whether we've had at least one successful tunnel this run (or the user
// just turned the feature on while already connected) -- until armed, a
// disconnect is not "the VPN dropping", it's just "never connected yet",
// so it must not trigger a block.
let killSwitchBlocking = false;
let killSwitchArmed = false;
let latencyTimer = null;
let latencyPollInFlight = false;
let trafficTimer = null;
let trafficPollInFlight = false;
let statsClient = null;
let sessionTraffic = { uplink: 0, downlink: 0 };
let subAutoUpdateTimer = null;
let connectedAt = null;
let currentPorts = null; // { socksPort, httpPort, apiPort } of the live session

// Serializes every external trigger of connect()/disconnect() (IPC, tray,
// auto-reconnect, auto-connect-on-launch) so overlapping calls queue up
// instead of racing each other and corrupting connection state.
let opChain = Promise.resolve();
function serialize(fn) {
  const result = opChain.then(fn, fn);
  opChain = result.then(() => {}, () => {});
  return result;
}
let connectionState = 'disconnected'; // disconnected | connecting | connected | disconnecting

function getSettings() {
  const raw = store.get('settings', {});
  // One-time migration: the old autoConnect toggle became runLocalProxyOnStartup
  // (same trigger -- connect to the last active profile at launch -- but no
  // longer auto-enables system proxy as a side effect). Idempotent: once
  // migrated, 'runLocalProxyOnStartup' in raw is true and this is a no-op.
  if ('autoConnect' in raw && !('runLocalProxyOnStartup' in raw)) {
    raw.runLocalProxyOnStartup = raw.autoConnect;
    delete raw.autoConnect;
    store.set('settings', raw);
  }
  return { ...DEFAULT_SETTINGS, ...raw };
}

function updateSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  store.set('settings', merged);
  return merged;
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, icon: APP_ICON_PATH }).show();
    }
  } catch { /* ignore */ }
}

// The active profile only when it came from the pool -- user profiles are
// already in the renderer's own list and don't need shipping over IPC.
function soulActiveProfile() {
  const p = soulPool.find(store.get('activeProfileId'));
  return p ? { id: p.id, name: p.name, address: p.address, port: p.port, protocol: p.protocol } : null;
}

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-changed', {
      connectionState,
      activeProfileId: store.get('activeProfileId', null),
      connectedAt,
      systemProxyEnabled: store.get('systemProxyEnabled', false),
      killSwitchBlocking,
      soulModeEnabled: store.get('soulModeEnabled', false),
      // The pool server we landed on, so the UI can name it without holding a
      // copy of the whole pool.
      activeSoulProfile: soulActiveProfile(),
    });
  }
  updateTray();
  updateLatencyPolling();
  updateTrafficPolling();
}

function updateTray() {
  if (!tray) return;
  const profile = findProfile(store.get('activeProfileId'));
  const label = connectionState === 'connected' ? `وصل — ${profile ? profile.name : ''}`
    : connectionState === 'connecting' ? 'در حال اتصال…'
    : connectionState === 'disconnecting' ? 'در حال قطع…'
    : 'قطع — Soul Connection';
  tray.setToolTip(label.trim());
  tray.setContextMenu(buildTrayMenu());
}

const TRAY_SERVER_LIST_LIMIT = 12;

function buildTrayMenu() {
  const connected = connectionState === 'connected';
  const busy = connectionState === 'connecting' || connectionState === 'disconnecting';
  const activeId = store.get('activeProfileId');
  const profile = findProfile(activeId);
  const mode = store.get('connectionMode', 'proxy');
  const allProfiles = store.get('profiles', []);

  const serverItems = allProfiles.slice(0, TRAY_SERVER_LIST_LIMIT).map((p) => ({
    label: p.name || `${p.address}:${p.port}`,
    type: 'radio',
    checked: p.id === activeId,
    enabled: !busy,
    click: () => {
      if (p.id === activeId && connected) return;
      serialize(() => connect(p.id)).catch(() => {});
    },
  }));

  return Menu.buildFromTemplate([
    {
      label: profile ? `سرور: ${profile.name}` : 'کانفیگی انتخاب نشده',
      enabled: false,
    },
    { label: `حالت: ${mode === 'tun' ? 'تانل کامل' : 'پروکسی سیستم'}`, enabled: false },
    { type: 'separator' },
    {
      label: connected ? 'قطع اتصال' : 'اتصال',
      enabled: !busy && !!profile,
      click: () => {
        if (connected) serialize(disconnect).catch(() => {});
        else if (profile) serialize(() => connect(profile.id)).catch(() => {});
      },
    },
    {
      label: 'انتخاب سریع سرور',
      enabled: serverItems.length > 0,
      submenu: serverItems.length ? serverItems : [{ label: 'کانفیگی وجود ندارد', enabled: false }],
    },
    { type: 'separator' },
    { label: 'باز کردن Soul Connection', click: () => mainWindow && mainWindow.show() },
    {
      label: 'تنظیمات',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.webContents.send('open-settings');
      },
    },
    { type: 'separator' },
    { label: 'خروج', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function updateLatencyPolling() {
  if (latencyTimer) { clearInterval(latencyTimer); latencyTimer = null; }
  if (connectionState !== 'connected' || !currentPorts) return;
  const ports = currentPorts;
  const poll = async () => {
    if (latencyPollInFlight) return;
    latencyPollInFlight = true;
    try {
      // Credentials matter here: if the user configured HTTP proxy auth, an
      // unauthenticated probe is rejected by xray locally with a 407 and never
      // leaves the machine -- which would report a ~1ms "tunnel latency".
      const settings = getSettings();
      const ms = await proxyPing({
        host: dialHost(settings.httpHost),
        port: ports.httpPort,
        username: settings.httpUsername,
        password: settings.httpPassword,
      });
      if (mainWindow && !mainWindow.isDestroyed() && connectionState === 'connected' && currentPorts === ports) {
        mainWindow.webContents.send('latency-update', { ms });
      }
    } finally {
      latencyPollInFlight = false;
    }
  };
  poll();
  latencyTimer = setInterval(poll, LATENCY_POLL_MS);
}

function updateTrafficPolling() {
  if (trafficTimer) { clearInterval(trafficTimer); trafficTimer = null; }
  if (statsClient) { statsClient.close(); statsClient = null; }
  if (connectionState !== 'connected' || !currentPorts || !currentPorts.apiPort) return;

  const ports = currentPorts;
  sessionTraffic = { uplink: 0, downlink: 0 };
  let last = { uplink: 0, downlink: 0, time: Date.now() };

  try {
    statsClient = new StatsClient(ports.apiPort);
  } catch {
    return; // Stats are a nice-to-have; a failure here must not break the connection.
  }

  const poll = async () => {
    if (trafficPollInFlight || currentPorts !== ports) return;
    trafficPollInFlight = true;
    try {
      const { uplink, downlink } = await statsClient.queryOutboundTraffic('proxy');
      const now = Date.now();
      const elapsed = Math.max((now - last.time) / 1000, 0.001);
      const uplinkSpeed = Math.max(0, (uplink - last.uplink) / elapsed);
      const downlinkSpeed = Math.max(0, (downlink - last.downlink) / elapsed);
      last = { uplink, downlink, time: now };
      sessionTraffic = { uplink, downlink };

      if (process.env.SC_DEBUG) console.log('[traffic]', uplink, downlink);
      if (mainWindow && !mainWindow.isDestroyed() && connectionState === 'connected' && currentPorts === ports) {
        const profile = findProfile(store.get('activeProfileId'));
        const lifetimeBase = profile ? (profile.totalBytes || 0) : 0;
        mainWindow.webContents.send('traffic-update', {
          uplink, downlink, uplinkSpeed, downlinkSpeed,
          sessionTotal: uplink + downlink,
          lifetimeTotal: lifetimeBase + uplink + downlink,
        });
      }
    } catch (err) {
      // Transient gRPC hiccup -- skip this tick, try again next interval.
      if (process.env.SC_DEBUG) console.error('[traffic] poll error:', err.message);
    } finally {
      trafficPollInFlight = false;
    }
  };
  poll();
  trafficTimer = setInterval(poll, TRAFFIC_POLL_MS);
}

function persistSessionTraffic() {
  if (sessionTraffic.uplink === 0 && sessionTraffic.downlink === 0) return;
  const profileId = store.get('activeProfileId');
  if (!profileId) return;
  const profiles = store.get('profiles', []);
  const profile = profiles.find((p) => p.id === profileId);
  if (profile) {
    profile.totalBytes = (profile.totalBytes || 0) + sessionTraffic.uplink + sessionTraffic.downlink;
    store.set('profiles', profiles);
  }
  sessionTraffic = { uplink: 0, downlink: 0 };
}

const APP_ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 880,
    minWidth: 720,
    minHeight: 720,
    backgroundColor: '#0a0d13',
    autoHideMenuBar: true,
    icon: APP_ICON_PATH,
    frame: false, // fully custom title bar, drawn in the renderer
    roundedCorners: true, // native DWM corner rounding on Windows 11 when not maximized
    show: false, // paired with 'ready-to-show' below so launch never flashes an unpainted frame
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAspectRatio(1); // the UI is designed as a 1:1 square, restored on unmaximize/leave-fullscreen below

  // Belt-and-suspenders for the same elevated-launch DPI quirk noted above:
  // nudging the size by a pixel and immediately back forces Chromium to
  // actually re-run layout against the display's real (by-then-settled)
  // scale factor, instead of whatever it cached at the moment of construction.
  const nudgeResizeForDpiRefresh = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getSize();
    mainWindow.setSize(w + 1, h + 1);
    setImmediate(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setSize(w, h);
    });
  };

  mainWindow.once('ready-to-show', () => {
    const settings = getSettings();
    if (settings.startMinimized) {
      // Tray-enabled: stay fully hidden -- the tray icon's click handler
      // (and its "باز کردن" menu item) already call mainWindow.show() to restore.
      if (!settings.minimizeToTray) {
        mainWindow.show();
        mainWindow.minimize();
        nudgeResizeForDpiRefresh();
      }
    } else {
      mainWindow.show();
      nudgeResizeForDpiRefresh();
    }
  });

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  mainWindow.loadFile(indexPath);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const sendWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-state', {
        maximized: mainWindow.isMaximized(),
        fullscreen: mainWindow.isFullScreen(),
      });
    }
  };
  // Maximize/fullscreen fill the whole screen, so the 1:1 lock has to relax
  // for that duration and snap back the moment the window is a normal square again.
  mainWindow.on('maximize', () => { mainWindow.setAspectRatio(0); sendWindowState(); });
  mainWindow.on('unmaximize', () => { mainWindow.setAspectRatio(1); sendWindowState(); });
  mainWindow.on('enter-full-screen', () => { mainWindow.setAspectRatio(0); sendWindowState(); });
  mainWindow.on('leave-full-screen', () => { mainWindow.setAspectRatio(1); sendWindowState(); });
  mainWindow.webContents.once('did-finish-load', sendWindowState);

  mainWindow.on('close', (e) => {
    if (!isQuitting && getSettings().minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
    // Otherwise let the window close normally; the 'will-quit' handler is the
    // single authoritative gate that disconnects before the app actually exits.
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  try {
    tray = new Tray(icon);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => mainWindow && mainWindow.show());
  } catch {
    tray = null;
  }
}

// Soul Connection pool servers are connectable but live outside the user's
// own list (see soulPool.cjs), so every lookup that resolves an id to a
// profile has to consider both. This is the single place that happens.
function findProfile(id) {
  return store.get('profiles', []).find((p) => p.id === id) || soulPool.find(id);
}

// The address the app itself must dial to reach its own local proxy. The
// SOCKS/HTTP listener host is user-configurable (Network settings even
// advertises 0.0.0.0 as "reachable from the LAN"), but a wildcard bind is not
// a connectable address -- and neither is it what Windows should be pointed at
// as a system proxy. Everything that connects *to* our own listener (latency
// polling, the connection test, the system-proxy registry value) goes through
// here so a custom host actually works instead of silently probing loopback.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);
function dialHost(host) {
  const h = String(host || '').trim();
  return !h || WILDCARD_HOSTS.has(h) ? '127.0.0.1' : h;
}

async function connect(profileId) {
  const profile = findProfile(profileId);
  if (!profile) throw new Error('کانفیگ پیدا نشد');
  if (!fs.existsSync(xrayBin)) {
    throw new Error('فایل xray.exe پیدا نشد. احتمالاً آنتی‌ویروس آن را حذف یا قرنطینه کرده. لطفاً پوشه‌ی برنامه را به لیست استثناهای آنتی‌ویروس اضافه کن و برنامه را دوباره نصب/اجرا کن.');
  }
  if (connectionState === 'connected' || connectionState === 'connecting') {
    await disconnect();
  }
  connectionState = 'connecting';
  sendState();
  const mode = store.get('connectionMode', 'proxy');
  const settings = getSettings();
  try {
    const socksPort = await findFreePort(settings.socksPort);
    const preferredHttp = settings.httpPort === socksPort ? settings.httpPort + 1 : settings.httpPort;
    const httpPort = await findFreePort(preferredHttp);
    const apiPort = await findFreePort(API_PORT === socksPort || API_PORT === httpPort ? httpPort + 1 : API_PORT);
    const config = buildXrayConfig(profile, {
      socksPort, httpPort, apiPort, mode, logLevel: settings.xrayLogLevel,
      socksHost: settings.socksHost, httpHost: settings.httpHost,
      socksAccounts: settings.socksUsername ? [{ user: settings.socksUsername, pass: settings.socksPassword || '' }] : undefined,
      httpAccounts: settings.httpUsername ? [{ user: settings.httpUsername, pass: settings.httpPassword || '' }] : undefined,
    });
    // Connecting only starts the local proxy (xray) -- System Proxy is a fully
    // separate, user-controlled toggle (see systemProxy:enable/disable below)
    // so flipping it on/off never restarts the tunnel.
    await xray.start(config);
    store.set('activeProfileId', profileId);
    store.set('activeMode', mode);
    {
      // Remember when this profile was last used, for "recently used" sorting.
      const profiles = store.get('profiles', []);
      const p = profiles.find((x) => x.id === profileId);
      if (p) { p.lastUsedAt = Date.now(); store.set('profiles', profiles); }
    }
    currentPorts = { socksPort, httpPort, apiPort };
    connectedAt = Date.now();
    reconnectAttempts = 0;
    connectionState = 'connected';
    sendState();
    notify('Soul Connection', `به «${profile.name}» متصل شدی`);
    if (getSettings().killSwitchEnabled) {
      killSwitchArmed = true;
      await clearKillSwitchBlock();
    }
  } catch (err) {
    connectionState = 'disconnected';
    currentPorts = null;
    connectedAt = null;
    sendState();
    if (mode === 'tun' && /access is denied/i.test(err.message || '')) {
      throw new Error('حالت تانل نیاز به اجرای برنامه با دسترسی مدیر (Administrator) دارد');
    }
    if (err.code === 'ENOENT') {
      throw new Error('فایل xray.exe پیدا نشد. احتمالاً آنتی‌ویروس آن را حذف یا قرنطینه کرده. لطفاً پوشه‌ی برنامه را به لیست استثناهای آنتی‌ویروس اضافه کن و برنامه را دوباره نصب/اجرا کن.');
    }
    throw err;
  }
}

// Safety net: a dead local proxy port left as the active Windows system proxy
// means no internet for the user, so any time the tunnel actually stops we
// clear system proxy too. This is distinct from systemProxy:disable, which
// the user can call independently at any time without touching the tunnel.
async function disableSystemProxySafetyNet() {
  if (!store.get('systemProxyEnabled', false)) return;
  try { await systemProxy.disable(); } catch { /* ignore */ }
  store.set('systemProxyEnabled', false);
}

// Engages the outbound-block firewall rules. Idempotent and best-effort --
// if it fails (most likely: not actually elevated), we surface a notification
// but must not claim protection we don't have, so killSwitchBlocking stays false.
async function applyKillSwitchBlock() {
  if (killSwitchBlocking) return;
  try {
    await killSwitch.enable(xrayBin);
    killSwitchBlocking = true;
  } catch (err) {
    notify('خطا در Kill Switch', 'مسدودسازی ترافیک ناموفق بود: ' + (err.message || ''));
  }
  sendState();
}

// Lifts the block. Always safe to call even if nothing is currently
// blocking -- this is also the emergency escape hatch invoked the moment
// the user flips the setting off.
async function clearKillSwitchBlock() {
  if (!killSwitchBlocking) return;
  try { await killSwitch.disable(); } catch { /* best effort */ }
  killSwitchBlocking = false;
  sendState();
}

async function disconnect() {
  if (connectionState === 'disconnected') return;
  connectionState = 'disconnecting';
  sendState();
  await disableSystemProxySafetyNet();
  // Only claim an exit if there's actually a process left to exit. Setting this
  // unconditionally leaks a stale `true` whenever we disconnect with no live
  // process (e.g. tearing down a failed 'connecting' attempt), and the next
  // genuine crash then gets swallowed as "expected" -- no auto-reconnect, and
  // a UI still showing "connected" over a dead tunnel.
  expectedExit = xray.isRunning;
  await xray.stop();
  connectionState = 'disconnected';
  persistSessionTraffic();
  currentPorts = null;
  connectedAt = null;
  sendState();
  // Kill Switch means "no traffic outside the tunnel, for any reason" --
  // that includes the user's own deliberate disconnect, not just drops.
  if (killSwitchArmed && getSettings().killSwitchEnabled) {
    await applyKillSwitchBlock();
  }
}

// Detects the tunnel dropping on its own (crash, server-side kick, network
// change) as opposed to a user-initiated disconnect, and tries to recover.
xray.on('exit', async () => {
  if (expectedExit) { expectedExit = false; return; }
  if (connectionState !== 'connected') return;

  connectionState = 'disconnected';
  persistSessionTraffic();
  currentPorts = null;
  connectedAt = null;
  sendState();

  const killSwitchSettings = getSettings();
  if (killSwitchArmed && killSwitchSettings.killSwitchEnabled) {
    // Block immediately -- before any reconnect attempt -- so the gap while
    // we're retrying (which can take several seconds) never leaks traffic.
    // A successful reconnect (below, or a later retry) lifts it again via
    // connect()'s own success path.
    await applyKillSwitchBlock();
  }

  if (!getSettings().autoReconnect) {
    await disableSystemProxySafetyNet();
    notify('اتصال قطع شد', 'تونل به‌طور غیرمنتظره قطع شد.');
    return;
  }

  const profileId = store.get('activeProfileId');
  if (!profileId || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    await disableSystemProxySafetyNet();
    notify('اتصال قطع شد', 'تلاش برای اتصال مجدد ناموفق بود.');
    reconnectAttempts = 0;
    return;
  }

  reconnectAttempts++;
  notify('اتصال قطع شد', `در حال تلاش برای اتصال مجدد (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
  await new Promise((r) => setTimeout(r, 2000 * reconnectAttempts));

  // In pool mode the server was chosen because it was the best one *at the
  // time*. If it just died, retrying it is the one thing guaranteed not to
  // work -- re-run the selection and land on whatever is healthy now.
  if (store.get('soulModeEnabled', false) && soulPool.find(profileId)) {
    try {
      await connectBestSoul();
      if (store.get('systemProxyEnabled', false) && currentPorts) {
        try {
          const s = getSettings();
          await systemProxy.enable(dialHost(s.httpHost), currentPorts.httpPort, systemProxy.buildBypass(s.customBypass));
        } catch { /* ignore */ }
      }
    } catch { /* the retry cap above still governs how often this repeats */ }
    return;
  }

  try {
    await serialize(() => connect(profileId));
    // A successful reconnect can land on a different port than before (port
    // conflict fallback) -- if system proxy was on, resync it to the new
    // port instead of leaving it pointed at the now-dead old one.
    if (store.get('systemProxyEnabled', false) && currentPorts) {
      try {
        const s = getSettings();
        await systemProxy.enable(dialHost(s.httpHost), currentPorts.httpPort, systemProxy.buildBypass(s.customBypass));
      } catch { /* ignore */ }
    }
  } catch { /* xray's own 'exit' event will fire again and retry, up to the cap */ }
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.kasra.soulconnection');

  // If we're persisted in tunnel mode from a previous session but this launch
  // isn't elevated, re-launch elevated before ever showing a window -- avoids
  // a flash of a window that can't actually connect in tunnel mode.
  const persistedMode = store.get('connectionMode', 'proxy');
  if (persistedMode === 'tun' && !(await isElevated())) {
    const relaunched = await relaunchElevated(app);
    if (relaunched) return; // this instance is exiting; the elevated one takes over
    // UAC prompt was declined or failed -- fall back to proxy mode instead of
    // exiting with no window ever shown.
    store.set('connectionMode', 'proxy');
    notify('دسترسی مدیر رد شد', 'حالت تانل نیاز به دسترسی مدیر دارد. برنامه در حالت پروکسی سیستم باز شد.');
  }

  createWindow();
  createTray();

  initUpdater(mainWindow, {
    onAvailable: (version) => notify(
      'نسخه‌ی جدید موجود است',
      `Soul Connection ${version} منتشر شد. برای دانلود و نصب، برنامه را باز کنید.`
    ),
    onReadyToInstall: installUpdate,
  });
  if (app.isPackaged) {
    // One check shortly after launch, then every 6 hours, so a release that
    // lands while the app is sitting in the tray still reaches the user.
    setTimeout(() => checkForUpdates().catch(() => {}), 5000);
    setInterval(() => checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  }

  const settings = getSettings();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchOnStartup });
  scheduleSubAutoUpdate();

  // Sync in-memory Kill Switch state with whatever's actually on the
  // firewall right now. If the feature is off, proactively clean up any
  // rule left behind by a previous crash -- the stored preference is the
  // source of truth for whether blocking *should* be happening. If it's on,
  // leave a lingering block exactly as-is: that's the previous session's
  // protection still doing its job until the user reconnects or disables it.
  if (!settings.killSwitchEnabled) {
    killSwitch.disable().catch(() => {});
  } else {
    killSwitch.isActive().then((active) => {
      killSwitchBlocking = active;
      sendState();
    }).catch(() => {});
  }

  if (settings.runLocalProxyOnStartup) {
    const profileId = store.get('activeProfileId');
    if (profileId && findProfile(profileId)) {
      serialize(() => connect(profileId)).then(
        () => { if (process.env.SC_DEBUG) console.log('[connect] resolved, state=', connectionState); },
        (err) => { if (process.env.SC_DEBUG) console.error('[connect] rejected:', err); }
      );
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

// Hand off to the NSIS installer, but only once the machine is back in a
// clean state. The installer replaces the app's files and restarts it, so
// anything still live at that moment is a problem: an xray process holding
// the proxy port, a WinINET system-proxy pointing at 127.0.0.1, or a Kill
// Switch firewall rule would all outlive the app that owns them. Tear the
// tunnel down first, persist the store synchronously, and only then quit.
let installingUpdate = false;
async function installUpdate() {
  // Reachable from two directions -- the card's one-click flow and the button
  // in Settings -- and the teardown below is async, so without this a second
  // click during the disconnect would spawn setup.exe twice.
  if (installingUpdate) return;
  installingUpdate = true;
  isQuitting = true;
  try {
    if (connectionState !== 'disconnected') {
      await serialize(disconnect);
    }
  } catch (e) {
    console.error('Failed to disconnect before installing the update:', e);
    // Fall through: leaving the user stuck on an old version is worse than a
    // disconnect that didn't fully report success. disconnect() is itself
    // defensive, and the safety net below covers the proxy either way.
  }

  // Belt and braces -- if the tunnel teardown above threw partway, make sure
  // the system proxy isn't left pointing at a port nothing is listening on.
  try {
    if (store.get('systemProxyEnabled', false)) await systemProxy.disable();
  } catch { /* best effort */ }

  store.flush();
  quitAndInstall();
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', async (e) => {
  if (connectionState !== 'disconnected') {
    e.preventDefault();
    await serialize(disconnect);
    store.flush();
    app.quit();
  } else {
    store.flush();
  }
});

// ---- IPC handlers ----

// ---- Window controls (custom title bar) ----

ipcMain.handle('window:minimize', () => { mainWindow?.minimize(); });
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => { mainWindow?.close(); });
ipcMain.handle('window:isMaximized', () => !!mainWindow?.isMaximized());

ipcMain.handle('profiles:list', () => ({
  profiles: store.get('profiles', []),
  subscriptions: store.get('subscriptions', []),
  activeProfileId: store.get('activeProfileId', null),
  connectionMode: store.get('connectionMode', 'proxy'),
  connectionState,
  connectedAt,
  settings: getSettings(),
  systemProxyEnabled: store.get('systemProxyEnabled', false),
  killSwitchBlocking,
  soulModeEnabled: store.get('soulModeEnabled', false),
  soulCount: soulPool.list().length,
  activeSoulProfile: soulActiveProfile(),
}));

ipcMain.handle('settings:setMode', async (_e, mode) => {
  if (mode !== 'proxy' && mode !== 'tun') throw new Error('حالت نامعتبر');
  if (connectionState !== 'disconnected') throw new Error('اول باید قطع اتصال کنی');

  if (mode === 'tun' && !(await isElevated())) {
    notify('اجرای مجدد با دسترسی مدیر', 'حالت تانل نیاز به دسترسی مدیر دارد. برنامه به‌زودی دوباره باز می‌شود…');
    const relaunched = await relaunchElevated(app);
    if (!relaunched) {
      throw new Error('برای فعال‌سازی حالت تانل باید درخواست دسترسی مدیر (UAC) رو تایید کنی');
    }
    return mode; // unreachable in practice -- app.exit() fires inside relaunchElevated
  }

  store.set('connectionMode', mode);
  return mode;
});

ipcMain.handle('profiles:addLink', (_e, text) => {
  // Accepts a single link or a whole clipboard/textarea paste containing
  // several -- parseMany scans for every valid config regardless of how
  // they're separated (or not separated at all) and dedupes within the paste.
  const parsed = parseMany(text);
  if (!parsed.length) throw new Error('کانفیگ نامعتبر است یا پشتیبانی نمی‌شود');

  const profiles = store.get('profiles', []);
  const existingLinks = new Set(profiles.map((p) => p.link).filter(Boolean));
  const added = [];
  for (const p of parsed) {
    if (existingLinks.has(p.link)) continue; // already saved -- skip duplicate
    existingLinks.add(p.link);
    added.push(p);
  }
  if (!added.length) throw new Error('همه‌ی کانفیگ‌های شناسایی‌شده از قبل اضافه شده بودند');

  store.set('profiles', profiles.concat(added));
  return { profiles: added, duplicates: parsed.length - added.length };
});

ipcMain.handle('profiles:addCustom', (_e, fields) => {
  const profile = buildCustomProfile(fields);
  const profiles = store.get('profiles', []);
  profiles.push(profile);
  store.set('profiles', profiles);
  return profile;
});

ipcMain.handle('profiles:delete', async (_e, id) => {
  if (store.get('activeProfileId') === id) {
    await serialize(disconnect);
    store.set('activeProfileId', null);
  }
  const profiles = store.get('profiles', []).filter((p) => p.id !== id);
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('profiles:rename', (_e, { id, name }) => {
  const profiles = store.get('profiles', []);
  const p = profiles.find((x) => x.id === id);
  if (p) p.name = name;
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('profiles:update', (_e, { id, link }) => {
  const parsed = parseLink(link);
  if (!parsed) throw new Error('کانفیگ نامعتبر است یا پشتیبانی نمی‌شود');
  if (id === store.get('activeProfileId') && connectionState !== 'disconnected') {
    throw new Error('اول باید قطع اتصال کنی');
  }
  const profiles = store.get('profiles', []);
  const existing = profiles.find((p) => p.id === id);
  if (!existing) throw new Error('کانفیگ پیدا نشد');
  Object.assign(existing, parsed, {
    id: existing.id,
    subId: existing.subId,
    favorite: existing.favorite,
    totalBytes: existing.totalBytes,
    createdAt: existing.createdAt,
    lastUsedAt: existing.lastUsedAt,
  });
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('subscriptions:add', async (_e, url) => {
  const { text, headers } = await fetchText(url);
  const parsed = parseMany(text);
  if (!parsed.length) throw new Error('هیچ کانفیگی در این ساب‌اسکریپشن پیدا نشد');
  const usage = parseSubscriptionUserinfo(headers['subscription-userinfo']);
  const sub = { id: newId(), url, name: url, createdAt: Date.now(), lastUpdated: Date.now(), configCount: parsed.length, usage };
  parsed.forEach((p) => { p.subId = sub.id; });

  const subs = store.get('subscriptions', []);
  subs.push(sub);
  store.set('subscriptions', subs);

  const profiles = store.get('profiles', []).concat(parsed);
  store.set('profiles', profiles);
  return { subscription: sub, profiles: parsed };
});

async function refreshSubscription(subId) {
  const subs = store.get('subscriptions', []);
  const sub = subs.find((s) => s.id === subId);
  if (!sub) throw new Error('ساب‌اسکریپشن پیدا نشد');
  const { text, headers } = await fetchText(sub.url);
  const parsed = parseMany(text);
  // Never let a broken/blocked/rate-limited response wipe the whole group:
  // replacing N working configs with zero is far worse than a failed refresh.
  if (!parsed.length) throw new Error('هیچ کانفیگی در این ساب‌اسکریپشن پیدا نشد');
  const usage = parseSubscriptionUserinfo(headers['subscription-userinfo']);

  const allProfiles = store.get('profiles', []);
  const previousByLink = new Map();
  for (const p of allProfiles) {
    if (p.subId === subId && p.link) previousByLink.set(p.link, p);
  }

  // A refresh almost always re-lists the same servers, but parseMany mints a
  // brand-new id for every entry it parses. Re-attaching the previous id (and
  // the user-owned state hanging off it) is what makes a re-listed server
  // still be *the same* profile: otherwise every refresh -- including the
  // silent auto-update timer -- looks like "the server you're connected to was
  // deleted", tearing down a perfectly healthy tunnel and resetting favorites
  // and lifetime usage counters along with it.
  const refreshed = parsed.map((fresh) => {
    fresh.subId = subId;
    const prev = previousByLink.get(fresh.link);
    if (!prev) return fresh;
    return {
      ...fresh,
      id: prev.id,
      favorite: prev.favorite,
      totalBytes: prev.totalBytes,
      lastUsedAt: prev.lastUsedAt,
      createdAt: prev.createdAt,
    };
  });

  const activeId = store.get('activeProfileId');
  const nextProfiles = allProfiles.filter((p) => p.subId !== subId).concat(refreshed);
  // Only a server genuinely dropped from the feed should end the session.
  const activeVanished = activeId && !nextProfiles.some((p) => p.id === activeId);
  store.set('profiles', nextProfiles);
  if (activeVanished) {
    store.set('activeProfileId', null);
    if (connectionState !== 'disconnected') await serialize(disconnect);
  }

  sub.lastUpdated = Date.now();
  sub.configCount = refreshed.length;
  if (usage) sub.usage = usage;
  store.set('subscriptions', subs);

  return { subscription: sub, profiles: refreshed };
}

async function refreshAllSubscriptions() {
  const subs = store.get('subscriptions', []);
  // Each refreshSubscription() call's store read-modify-write is a single
  // synchronous span (no `await` in between), so running them concurrently
  // is safe -- and turns N sequential network round-trips into one.
  return Promise.all(subs.map((sub) =>
    refreshSubscription(sub.id).catch((err) => ({ subscription: sub, error: err.message }))
  ));
}

function scheduleSubAutoUpdate() {
  if (subAutoUpdateTimer) { clearInterval(subAutoUpdateTimer); subAutoUpdateTimer = null; }
  const interval = getSettings().subAutoUpdateInterval;
  if (!interval || interval <= 0) return;
  subAutoUpdateTimer = setInterval(async () => {
    const results = await refreshAllSubscriptions();
    if (results.length) {
      notify('ساب‌اسکریپشن‌ها به‌روزرسانی شدند', `${results.length} ساب‌اسکریپشن بررسی شد`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('profiles-changed');
    }
  }, interval);
}

ipcMain.handle('subscriptions:refresh', async (_e, subId) => {
  return refreshSubscription(subId);
});

ipcMain.handle('subscriptions:delete', async (_e, subId) => {
  const remaining = store.get('profiles', []).filter((p) => p.subId !== subId);
  const removedIds = new Set(
    store.get('profiles', []).filter((p) => p.subId === subId).map((p) => p.id)
  );
  if (removedIds.has(store.get('activeProfileId'))) {
    await serialize(disconnect);
    store.set('activeProfileId', null);
  }
  store.set('profiles', remaining);
  store.set('subscriptions', store.get('subscriptions', []).filter((s) => s.id !== subId));
  return remaining;
});

ipcMain.handle('subscriptions:update', (_e, { id, name, url }) => {
  const subs = store.get('subscriptions', []);
  const sub = subs.find((s) => s.id === id);
  if (!sub) throw new Error('ساب‌اسکریپشن پیدا نشد');
  if (name !== undefined) sub.name = name;
  if (url !== undefined) sub.url = url;
  store.set('subscriptions', subs);
  return subs;
});

ipcMain.handle('connection:connect', async (_e, profileId) => {
  // Connecting to a specific server by hand is an explicit exit from "let the
  // pool choose" -- otherwise the next connect would silently override the
  // server the user just picked.
  cancelSoulSelection();
  if (store.get('soulModeEnabled', false) && !soulPool.find(profileId)) {
    store.set('soulModeEnabled', false);
  }
  await serialize(() => connect(profileId));
  return { connectionState };
});

ipcMain.handle('connection:disconnect', async () => {
  // Cancels a selection sweep in flight too -- otherwise "disconnect" would
  // leave probes and test tunnels running and then connect anyway.
  cancelSoulSelection();
  await serialize(disconnect);
  return { connectionState };
});

// ---- Soul Connection server pool ----

let soulSelection = null; // AbortController while a sweep is running

function cancelSoulSelection() {
  if (soulSelection) {
    soulSelection.abort();
    soulSelection = null;
  }
}

function sendSoulProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('soul-progress', payload);
  }
}

ipcMain.handle('soul:list', async (_e, { force = false } = {}) => {
  const profiles = await soulPool.refresh({ force });
  return { count: profiles.length, fetchedAt: store.get('soulProfilesFetchedAt', 0) };
});

ipcMain.handle('soul:setEnabled', (_e, enabled) => {
  const on = !!enabled;
  store.set('soulModeEnabled', on);

  // Entering pool mode while idle drops the manual selection, so the connect
  // button can't show one server while the pool is about to pick another.
  // While *connected*, activeProfileId still names the live server -- the
  // tray, traffic accounting and disconnect all read it -- so it stays put
  // and the switch happens on the next connect instead.
  if (on && connectionState === 'disconnected') {
    store.set('activeProfileId', null);
    sendState();
  }

  // Deliberately no sendState() when leaving pool mode: main changes nothing
  // the renderer doesn't already know, and while disconnected main's
  // activeProfileId is intentionally stale (a manual pick isn't persisted
  // until connect) -- pushing it here would overwrite the selection the user
  // just made in the sidebar.
  return { soulModeEnabled: on };
});

ipcMain.handle('soul:cancel', () => {
  cancelSoulSelection();
  return true;
});

// Test, rank, then connect to the winner. Deliberately NOT wrapped in
// serialize() for its whole duration: the sweep can take ten seconds or more,
// and holding the connection lock that long would block disconnect and leave
// the user unable to cancel. Only the actual connect() takes the lock.
async function connectBestSoul() {
  if (soulSelection) throw new Error('انتخاب سرور از قبل در جریان است');

  const controller = new AbortController();
  soulSelection = controller;
  connectionState = 'connecting';
  sendState();

  try {
    const { profile, metrics } = await soulPool.selectBest({
      signal: controller.signal,
      emit: sendSoulProgress,
    });
    if (controller.signal.aborted) throw Object.assign(new Error('لغو شد'), { code: 'ABORTED' });

    sendSoulProgress({ phase: 'connecting', server: profile.name });
    await serialize(() => connect(profile.id));
    sendSoulProgress({ phase: 'done', server: profile.name, ...metrics });
    return { connectionState, profile, metrics };
  } catch (err) {
    // connect() manages its own failure state; every other path here has to
    // put the UI back to idle itself.
    if (connectionState === 'connecting') {
      connectionState = 'disconnected';
      sendState();
    }
    sendSoulProgress({ phase: 'error', message: err.code === 'ABORTED' ? null : (err.message || 'خطا') });
    if (err.code === 'ABORTED') return { connectionState, cancelled: true };
    throw err;
  } finally {
    if (soulSelection === controller) soulSelection = null;
  }
}

ipcMain.handle('soul:connectBest', () => connectBestSoul());

ipcMain.handle('connection:status', () => ({
  connectionState,
  activeProfileId: store.get('activeProfileId', null),
  killSwitchBlocking,
}));

ipcMain.handle('ping:test', async (_e, profileId) => {
  const profile = findProfile(profileId);
  if (!profile) throw new Error('کانفیگ پیدا نشد');
  const ms = await tcpPing(profile.address, profile.port, 5000);
  return { profileId, ms };
});

// ---- Server Finder test engine ----

function emitTestEvent(token, type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('test-event', { token, type, ...data });
  }
}

function requireProfile(profileId) {
  const profile = findProfile(profileId);
  if (!profile) throw new Error('کانفیگ پیدا نشد');
  return profile;
}

ipcMain.handle('test:ping', async (_e, { profileId, token }) => {
  const profile = requireProfile(profileId);
  const signal = serverTest.begin(token);
  try {
    return await serverTest.pingStats(profile, {
      signal,
      onSample: (s) => emitTestEvent(token, 'sample', s),
    });
  } finally {
    serverTest.end(token);
  }
});

ipcMain.handle('test:real', async (_e, { profileId, token }) => {
  const profile = requireProfile(profileId);
  const signal = serverTest.begin(token);
  try {
    return await serverTest.realPing(profile, {
      xrayBin, workRoot: xrayWorkDir, signal,
      emit: (type, data) => emitTestEvent(token, type, data),
    });
  } finally {
    serverTest.end(token);
  }
});

ipcMain.handle('test:speed', async (_e, { profileId, token }) => {
  const profile = requireProfile(profileId);
  const signal = serverTest.begin(token);
  try {
    return await serverTest.speedTest(profile, {
      xrayBin, workRoot: xrayWorkDir, signal,
      emit: (type, data) => emitTestEvent(token, type, data),
    });
  } finally {
    serverTest.end(token);
  }
});

ipcMain.handle('test:cancel', (_e, token) => {
  serverTest.cancel(token);
});

ipcMain.handle('profiles:setFavorite', (_e, { id, favorite }) => {
  const profiles = store.get('profiles', []);
  const p = profiles.find((x) => x.id === id);
  if (p) p.favorite = !!favorite;
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('subscriptions:refreshAll', async () => {
  return refreshAllSubscriptions();
});

ipcMain.handle('settings:get', () => getSettings());

const LOG_LEVELS = new Set(['none', 'error', 'warning', 'info', 'debug']);
const BOOLEAN_SETTINGS = new Set([
  'launchOnStartup', 'runLocalProxyOnStartup', 'startMinimized', 'restorePreviousSession',
  'minimizeToTray', 'autoReconnect', 'killSwitchEnabled',
]);
const PORT_SETTINGS = new Set(['socksPort', 'httpPort']);
const HOST_SETTINGS = new Set(['socksHost', 'httpHost']);
const TEXT_SETTINGS = new Set(['socksUsername', 'socksPassword', 'httpUsername', 'httpPassword']);
const isValidPort = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
// Accepts a dotted IPv4 address (with octet range checking) or a bare
// hostname/domain, matching the "127.0.0.1 or any custom IP/domain" spec.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
function isValidHost(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const m = v.match(IPV4_RE);
  if (m) return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
  return HOSTNAME_RE.test(v);
}

ipcMain.handle('settings:update', async (_e, patch) => {
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  const clean = {};
  for (const key of Object.keys(patch || {})) {
    if (!allowed.has(key)) continue;
    const value = patch[key];
    if (BOOLEAN_SETTINGS.has(key)) {
      if (typeof value !== 'boolean') continue;
    } else if (key === 'subAutoUpdateInterval') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    } else if (key === 'xrayLogLevel') {
      if (!LOG_LEVELS.has(value)) continue;
    } else if (PORT_SETTINGS.has(key)) {
      if (!isValidPort(value)) continue;
    } else if (HOST_SETTINGS.has(key)) {
      if (!isValidHost(value)) continue;
    } else if (TEXT_SETTINGS.has(key)) {
      if (typeof value !== 'string' || value.length > 256) continue;
    } else if (key === 'customBypass') {
      if (typeof value !== 'string' || value.length > 2000) continue;
    }
    clean[key] = value;
  }

  if ('socksPort' in clean || 'httpPort' in clean) {
    const prospective = { ...getSettings(), ...clean };
    if (prospective.socksPort === prospective.httpPort) {
      throw new Error('پورت SOCKS و HTTP باید متفاوت باشند');
    }
  }

  if ('killSwitchEnabled' in clean) {
    if (clean.killSwitchEnabled) {
      if (!(await isElevated())) {
        notify('اجرای مجدد با دسترسی مدیر', 'Kill Switch نیاز به دسترسی مدیر دارد. برنامه به‌زودی دوباره باز می‌شود…');
        const relaunched = await relaunchElevated(app);
        if (!relaunched) {
          throw new Error('برای فعال‌سازی Kill Switch باید درخواست دسترسی مدیر (UAC) رو تایید کنی');
        }
        return; // unreachable in practice -- app.exit() fires inside relaunchElevated
      }
      // Already connected when the user turns this on: arm immediately so a
      // drop later in *this* session is still caught, instead of waiting for
      // the next successful connect() to set the flag.
      if (connectionState === 'connected') killSwitchArmed = true;
    } else {
      // Turning it off is the emergency escape hatch -- always lift any
      // active block right away, regardless of connection state.
      await clearKillSwitchBlock();
      killSwitchArmed = false;
    }
  }

  const settings = updateSettings(clean);

  if ('launchOnStartup' in clean) {
    app.setLoginItemSettings({ openAtLogin: !!settings.launchOnStartup });
  }
  if ('subAutoUpdateInterval' in clean) {
    scheduleSubAutoUpdate();
  }
  return settings;
});

ipcMain.handle('app:openLogsFolder', () => {
  shell.openPath(xrayWorkDir);
});

ipcMain.handle('app:openProxyFolder', () => {
  shell.openPath(xrayWorkDir);
});

// System Proxy is fully decoupled from the tunnel: enabling it only points
// Windows at the already-running local proxy, disabling it only resets the
// registry -- neither one starts/stops xray.
ipcMain.handle('systemProxy:enable', async () => {
  if (connectionState !== 'connected' || !currentPorts) {
    throw new Error('اول باید پروکسی محلی را روشن کنی (به یک سرور وصل شو)');
  }
  const settings = getSettings();
  await systemProxy.enable(dialHost(settings.httpHost), currentPorts.httpPort, systemProxy.buildBypass(settings.customBypass));
  store.set('systemProxyEnabled', true);
  sendState();
  return true;
});

ipcMain.handle('systemProxy:disable', async () => {
  await systemProxy.disable();
  store.set('systemProxyEnabled', false);
  sendState();
  return true;
});

ipcMain.handle('network:testConnection', async (_e, { protocol }) => {
  if (connectionState !== 'connected' || !currentPorts) {
    return { ok: false, reason: 'not-running', message: 'پروکسی محلی در حال اجرا نیست' };
  }
  const settings = getSettings();
  const isSocks = protocol === 'socks';
  return testLocalProxy({
    protocol,
    host: dialHost(isSocks ? settings.socksHost : settings.httpHost),
    port: isSocks ? currentPorts.socksPort : currentPorts.httpPort,
    username: isSocks ? settings.socksUsername : settings.httpUsername,
    password: isSocks ? settings.socksPassword : settings.httpPassword,
  });
});

ipcMain.handle('network:getRecentLogs', () => proxyLogRing);

const NETWORK_RESET_KEYS = ['socksHost', 'socksPort', 'socksUsername', 'socksPassword', 'httpHost', 'httpPort', 'httpUsername', 'httpPassword', 'customBypass'];
ipcMain.handle('network:resetDefaults', () => {
  if (connectionState !== 'disconnected') throw new Error('اول باید قطع اتصال کنی');
  const patch = {};
  for (const key of NETWORK_RESET_KEYS) patch[key] = DEFAULT_SETTINGS[key];
  return updateSettings(patch);
});

ipcMain.handle('app:getInfo', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
}));

ipcMain.handle('updater:check', () => checkForUpdates());
ipcMain.handle('updater:download', () => downloadUpdate());
ipcMain.handle('updater:downloadAndInstall', () => downloadAndInstall());
ipcMain.handle('updater:install', () => installUpdate());

ipcMain.handle('profiles:resetUsage', (_e, id) => {
  const profiles = store.get('profiles', []);
  const p = profiles.find((x) => x.id === id);
  if (p) p.totalBytes = 0;
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('profiles:resetAllUsage', () => {
  const profiles = store.get('profiles', []).map((p) => ({ ...p, totalBytes: 0 }));
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('app:exportBackup', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'پشتیبان‌گیری از کانفیگ‌ها',
    defaultPath: `soul-connection-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { canceled: true };

  const backup = {
    version: 1,
    exportedAt: Date.now(),
    profiles: store.get('profiles', []),
    subscriptions: store.get('subscriptions', []),
    settings: getSettings(),
  };
  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf8');
  return { canceled: false, filePath };
});

ipcMain.handle('app:saveImage', async (_e, { dataUrl, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'ذخیره‌ی تصویر QR',
    defaultPath: defaultName || 'qrcode.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { canceled: false, filePath };
});

ipcMain.handle('app:copyImage', (_e, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(img);
  return true;
});

ipcMain.handle('app:importBackup', async () => {
  if (connectionState !== 'disconnected') throw new Error('اول باید قطع اتصال کنی');

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'بازیابی کانفیگ‌ها',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { canceled: true };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  } catch {
    throw new Error('فایل پشتیبان معتبر نیست');
  }
  if (!Array.isArray(data.profiles)) throw new Error('فایل پشتیبان معتبر نیست');

  store.set('profiles', data.profiles);
  store.set('subscriptions', Array.isArray(data.subscriptions) ? data.subscriptions : []);
  if (data.settings && typeof data.settings === 'object') {
    const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    const clean = {};
    for (const key of Object.keys(data.settings)) {
      if (allowedKeys.has(key)) clean[key] = data.settings[key];
    }
    updateSettings(clean);
  }
  store.set('activeProfileId', null);
  return { canceled: false, profiles: data.profiles.length };
});
