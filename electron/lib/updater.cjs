'use strict';
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let win = null;

function send(status, extra) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater-status', { status, ...extra });
  }
}

function initUpdater(mainWindow) {
  win = mainWindow;

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => send('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => send('not-available'));
  autoUpdater.on('error', (err) => send('error', { message: err?.message || String(err) }));
  autoUpdater.on('download-progress', (progress) => send('downloading', { percent: progress.percent }));
  autoUpdater.on('update-downloaded', (info) => send('downloaded', { version: info.version }));
}

function checkForUpdates() {
  return autoUpdater.checkForUpdates();
}

function downloadUpdate() {
  return autoUpdater.downloadUpdate();
}

function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

module.exports = { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall };
