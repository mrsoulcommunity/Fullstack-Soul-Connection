'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { parseLink, parseMany, newId } = require('./lib/parsers.cjs');
const { buildXrayConfig } = require('./lib/xrayConfig.cjs');
const { XrayProcess } = require('./lib/xrayProcess.cjs');
const systemProxy = require('./lib/systemProxy.cjs');
const { tcpPing } = require('./lib/pingTest.cjs');
const { proxyPing } = require('./lib/proxyPing.cjs');
const serverTest = require('./lib/serverTest.cjs');
const { fetchText } = require('./lib/fetchText.cjs');
const { JsonStore } = require('./lib/store.cjs');
const { findFreePort } = require('./lib/freePort.cjs');
const { isElevated, relaunchElevated } = require('./lib/elevation.cjs');
const { StatsClient } = require('./lib/statsApi.cjs');
const { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } = require('./lib/updater.cjs');

const SOCKS_PORT = 10808;
const HTTP_PORT = 10809;
const API_PORT = 10810;
const LATENCY_POLL_MS = 15000;
const TRAFFIC_POLL_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

const DEFAULT_SETTINGS = {
  launchOnStartup: false,
  autoConnect: false,
  minimizeToTray: true,
  autoReconnect: true,
  subAutoUpdateInterval: 0, // ms; 0 = off
  xrayLogLevel: 'warning',
  socksPort: SOCKS_PORT, // preferred; auto-bumped to the next free port if taken
  httpPort: HTTP_PORT,
  customBypass: '', // extra semicolon-separated hosts/patterns added to the system-proxy bypass list
};

const userDataDir = app.getPath('userData');
const store = new JsonStore(path.join(userDataDir, 'profiles.json'), {
  profiles: [],
  subscriptions: [],
  activeProfileId: null,
  settings: { ...DEFAULT_SETTINGS },
});

const xrayBin = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'xray.exe')
  : path.join(__dirname, '..', 'bin', 'xray.exe');
const xrayWorkDir = path.join(userDataDir, 'xray-run');

const xray = new XrayProcess(xrayBin, xrayWorkDir);
if (process.env.SC_DEBUG) xray.on('log', (l) => console.log('[xray]', l.trim()));

let mainWindow = null;
let tray = null;
let isQuitting = false;
let expectedExit = false;
let reconnectAttempts = 0;
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
  return { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
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

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-changed', {
      connectionState,
      activeProfileId: store.get('activeProfileId', null),
      connectedAt,
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
      const ms = await proxyPing(ports.httpPort);
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAspectRatio(1); // the UI is designed as a 1:1 square, restored on unmaximize/leave-fullscreen below

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

function findProfile(id) {
  return store.get('profiles', []).find((p) => p.id === id);
}

async function connect(profileId) {
  const profile = findProfile(profileId);
  if (!profile) throw new Error('کانفیگ پیدا نشد');
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
    const config = buildXrayConfig(profile, { socksPort, httpPort, apiPort, mode, logLevel: settings.xrayLogLevel });
    await xray.start(config);
    if (mode === 'proxy') {
      await systemProxy.enable('127.0.0.1', httpPort, systemProxy.buildBypass(settings.customBypass));
    }
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
  } catch (err) {
    connectionState = 'disconnected';
    currentPorts = null;
    connectedAt = null;
    sendState();
    if (mode === 'tun' && /access is denied/i.test(err.message || '')) {
      throw new Error('حالت تانل نیاز به اجرای برنامه با دسترسی مدیر (Administrator) دارد');
    }
    throw err;
  }
}

async function disconnect() {
  if (connectionState === 'disconnected') return;
  connectionState = 'disconnecting';
  sendState();
  const activeMode = store.get('activeMode', 'proxy');
  if (activeMode === 'proxy') {
    try {
      await systemProxy.disable();
    } catch { /* ignore */ }
  }
  expectedExit = true;
  await xray.stop();
  connectionState = 'disconnected';
  persistSessionTraffic();
  currentPorts = null;
  connectedAt = null;
  sendState();
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

  if (!getSettings().autoReconnect) {
    notify('اتصال قطع شد', 'تونل به‌طور غیرمنتظره قطع شد.');
    return;
  }

  const profileId = store.get('activeProfileId');
  if (!profileId || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    notify('اتصال قطع شد', 'تلاش برای اتصال مجدد ناموفق بود.');
    reconnectAttempts = 0;
    return;
  }

  reconnectAttempts++;
  notify('اتصال قطع شد', `در حال تلاش برای اتصال مجدد (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
  await new Promise((r) => setTimeout(r, 2000 * reconnectAttempts));
  try {
    await serialize(() => connect(profileId));
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

  initUpdater(mainWindow);
  if (app.isPackaged) {
    setTimeout(() => checkForUpdates().catch(() => {}), 5000);
  }

  const settings = getSettings();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchOnStartup });
  scheduleSubAutoUpdate();

  if (settings.autoConnect) {
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
    app.quit();
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

ipcMain.handle('profiles:addLink', (_e, link) => {
  const profile = parseLink(link);
  if (!profile) throw new Error('کانفیگ نامعتبر است یا پشتیبانی نمی‌شود');
  const profiles = store.get('profiles', []);
  profiles.push(profile);
  store.set('profiles', profiles);
  return profile;
});

ipcMain.handle('profiles:delete', (_e, id) => {
  const profiles = store.get('profiles', []).filter((p) => p.id !== id);
  store.set('profiles', profiles);
  if (store.get('activeProfileId') === id) store.set('activeProfileId', null);
  return profiles;
});

ipcMain.handle('profiles:rename', (_e, { id, name }) => {
  const profiles = store.get('profiles', []);
  const p = profiles.find((x) => x.id === id);
  if (p) p.name = name;
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('subscriptions:add', async (_e, url) => {
  const text = await fetchText(url);
  const parsed = parseMany(text);
  if (!parsed.length) throw new Error('هیچ کانفیگی در این ساب‌اسکریپشن پیدا نشد');
  const sub = { id: newId(), url, name: url, createdAt: Date.now(), lastUpdated: Date.now(), configCount: parsed.length };
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
  const text = await fetchText(sub.url);
  const parsed = parseMany(text);
  parsed.forEach((p) => { p.subId = subId; });

  const activeId = store.get('activeProfileId');
  const remaining = store.get('profiles', []).filter((p) => p.subId !== subId);
  const wasActiveInSub = activeId && !remaining.find((p) => p.id === activeId);
  const merged = remaining.concat(parsed);
  store.set('profiles', merged);
  if (wasActiveInSub) {
    store.set('activeProfileId', null);
    if (connectionState !== 'disconnected') await serialize(disconnect);
  }

  sub.lastUpdated = Date.now();
  sub.configCount = parsed.length;
  store.set('subscriptions', subs);

  return { subscription: sub, profiles: parsed };
}

async function refreshAllSubscriptions() {
  const subs = store.get('subscriptions', []);
  const results = [];
  for (const sub of subs) {
    try {
      results.push(await refreshSubscription(sub.id));
    } catch (err) {
      results.push({ subscription: sub, error: err.message });
    }
  }
  return results;
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

ipcMain.handle('connection:connect', async (_e, profileId) => {
  await serialize(() => connect(profileId));
  return { connectionState };
});

ipcMain.handle('connection:disconnect', async () => {
  await serialize(disconnect);
  return { connectionState };
});

ipcMain.handle('connection:status', () => ({
  connectionState,
  activeProfileId: store.get('activeProfileId', null),
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
const BOOLEAN_SETTINGS = new Set(['launchOnStartup', 'autoConnect', 'minimizeToTray', 'autoReconnect']);
const PORT_SETTINGS = new Set(['socksPort', 'httpPort']);
const isValidPort = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;

ipcMain.handle('settings:update', (_e, patch) => {
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

ipcMain.handle('app:getInfo', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
}));

ipcMain.handle('updater:check', () => checkForUpdates());
ipcMain.handle('updater:download', () => downloadUpdate());
ipcMain.handle('updater:install', () => quitAndInstall());

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
