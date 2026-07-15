'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { parseLink, parseMany, newId } = require('./lib/parsers.cjs');
const { buildXrayConfig } = require('./lib/xrayConfig.cjs');
const { XrayProcess } = require('./lib/xrayProcess.cjs');
const systemProxy = require('./lib/systemProxy.cjs');
const { tcpPing } = require('./lib/pingTest.cjs');
const { fetchText } = require('./lib/fetchText.cjs');
const { JsonStore } = require('./lib/store.cjs');

const SOCKS_PORT = 10808;
const HTTP_PORT = 10809;

const userDataDir = app.getPath('userData');
const store = new JsonStore(path.join(userDataDir, 'profiles.json'), {
  profiles: [],
  subscriptions: [],
  activeProfileId: null,
});

const xrayBin = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'xray.exe')
  : path.join(__dirname, '..', 'bin', 'xray.exe');
const xrayWorkDir = path.join(userDataDir, 'xray-run');

const xray = new XrayProcess(xrayBin, xrayWorkDir);

let mainWindow = null;
let tray = null;
let connectionState = 'disconnected'; // disconnected | connecting | connected | disconnecting

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-changed', {
      connectionState,
      activeProfileId: store.get('activeProfileId', null),
    });
  }
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const label = connectionState === 'connected' ? 'وصل — Soul Connection'
    : connectionState === 'connecting' ? 'در حال اتصال…'
    : connectionState === 'disconnecting' ? 'در حال قطع…'
    : 'قطع — Soul Connection';
  tray.setToolTip(label);
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

  mainWindow.on('close', async (e) => {
    if (connectionState === 'connected' || connectionState === 'connecting') {
      e.preventDefault();
      await disconnect();
      mainWindow.destroy();
    }
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  try {
    tray = new Tray(icon);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'باز کردن Soul Connection', click: () => mainWindow && mainWindow.show() },
      { type: 'separator' },
      { label: 'خروج', click: () => app.quit() },
    ]));
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
    const config = buildXrayConfig(profile, { socksPort: SOCKS_PORT, httpPort: HTTP_PORT, mode });
    await xray.start(config);
    if (mode === 'proxy') {
      await systemProxy.enable('127.0.0.1', HTTP_PORT);
    }
    store.set('activeProfileId', profileId);
    store.set('activeMode', mode);
    connectionState = 'connected';
    sendState();
  } catch (err) {
    connectionState = 'disconnected';
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
  await xray.stop();
  connectionState = 'disconnected';
  sendState();
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await disconnect();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', async (e) => {
  if (connectionState !== 'disconnected') {
    e.preventDefault();
    await disconnect();
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
  const sub = { id: newId(), url, name: url, createdAt: Date.now() };
  parsed.forEach((p) => { p.subId = sub.id; });

  const subs = store.get('subscriptions', []);
  subs.push(sub);
  store.set('subscriptions', subs);

  const profiles = store.get('profiles', []).concat(parsed);
  store.set('profiles', profiles);
  return { subscription: sub, profiles: parsed };
});

ipcMain.handle('subscriptions:refresh', async (_e, subId) => {
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
    if (connectionState !== 'disconnected') await disconnect();
  }
  return { subscription: sub, profiles: parsed };
});

ipcMain.handle('subscriptions:delete', async (_e, subId) => {
  const remaining = store.get('profiles', []).filter((p) => p.subId !== subId);
  const removedIds = new Set(
    store.get('profiles', []).filter((p) => p.subId === subId).map((p) => p.id)
  );
  if (removedIds.has(store.get('activeProfileId'))) {
    await disconnect();
    store.set('activeProfileId', null);
  }
  store.set('profiles', remaining);
  store.set('subscriptions', store.get('subscriptions', []).filter((s) => s.id !== subId));
  return remaining;
});

ipcMain.handle('connection:connect', async (_e, profileId) => {
  await connect(profileId);
  return { connectionState };
});

ipcMain.handle('connection:disconnect', async () => {
  await disconnect();
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
