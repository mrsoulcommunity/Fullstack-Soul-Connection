'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const { parseLink, parseMany, newId } = require('./lib/parsers.cjs');
const { buildXrayConfig } = require('./lib/xrayConfig.cjs');
const { XrayProcess } = require('./lib/xrayProcess.cjs');
const systemProxy = require('./lib/systemProxy.cjs');
const { tcpPing } = require('./lib/pingTest.cjs');
const { proxyPing } = require('./lib/proxyPing.cjs');
const { fetchText } = require('./lib/fetchText.cjs');
const { JsonStore } = require('./lib/store.cjs');
const { findFreePort } = require('./lib/freePort.cjs');

const SOCKS_PORT = 10808;
const HTTP_PORT = 10809;
const LATENCY_POLL_MS = 15000;
const MAX_RECONNECT_ATTEMPTS = 5;

const DEFAULT_SETTINGS = {
  launchOnStartup: false,
  autoConnect: false,
  minimizeToTray: true,
  autoReconnect: true,
  subAutoUpdateInterval: 0, // ms; 0 = off
  xrayLogLevel: 'warning',
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

let mainWindow = null;
let tray = null;
let isQuitting = false;
let expectedExit = false;
let reconnectAttempts = 0;
let latencyTimer = null;
let latencyPollInFlight = false;
let subAutoUpdateTimer = null;
let connectedAt = null;
let currentPorts = null; // { socksPort, httpPort } of the live session

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
      new Notification({ title, body }).show();
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  mainWindow.loadFile(indexPath);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

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
  const icon = nativeImage.createEmpty();
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
  try {
    const socksPort = await findFreePort(SOCKS_PORT);
    const httpPort = await findFreePort(HTTP_PORT === socksPort ? HTTP_PORT + 1 : HTTP_PORT);
    const config = buildXrayConfig(profile, { socksPort, httpPort, mode, logLevel: getSettings().xrayLogLevel });
    await xray.start(config);
    if (mode === 'proxy') {
      await systemProxy.enable('127.0.0.1', httpPort);
    }
    store.set('activeProfileId', profileId);
    store.set('activeMode', mode);
    currentPorts = { socksPort, httpPort };
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
  createWindow();
  createTray();

  const settings = getSettings();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchOnStartup });
  scheduleSubAutoUpdate();

  if (settings.autoConnect) {
    const profileId = store.get('activeProfileId');
    if (profileId && findProfile(profileId)) {
      serialize(() => connect(profileId)).catch(() => {});
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

ipcMain.handle('profiles:list', () => ({
  profiles: store.get('profiles', []),
  subscriptions: store.get('subscriptions', []),
  activeProfileId: store.get('activeProfileId', null),
  connectionMode: store.get('connectionMode', 'proxy'),
  connectionState,
  connectedAt,
  settings: getSettings(),
}));

ipcMain.handle('settings:setMode', (_e, mode) => {
  if (mode !== 'proxy' && mode !== 'tun') throw new Error('حالت نامعتبر');
  if (connectionState !== 'disconnected') throw new Error('اول باید قطع اتصال کنی');
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

ipcMain.handle('subscriptions:refreshAll', async () => {
  return refreshAllSubscriptions();
});

ipcMain.handle('settings:get', () => getSettings());

const LOG_LEVELS = new Set(['none', 'error', 'warning', 'info', 'debug']);
const BOOLEAN_SETTINGS = new Set(['launchOnStartup', 'autoConnect', 'minimizeToTray', 'autoReconnect']);

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
    }
    clean[key] = value;
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
