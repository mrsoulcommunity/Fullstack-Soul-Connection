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

// `onAvailable` lets main.cjs raise an OS notification the moment a newer
// release shows up on GitHub -- the in-app banner only helps if the window is
// open and in front, and the app spends most of its life minimized to tray.
function initUpdater(mainWindow, { onAvailable } = {}) {
  win = mainWindow;

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => {
    send('available', { version: info.version, releaseNotes: info.releaseNotes || '' });
    if (onAvailable) {
      try { onAvailable(info.version); } catch { /* never let a notification break the updater */ }
    }
  });
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
