'use strict';
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let win = null;
// Set by downloadAndInstall() so the one-click flow knows to hand off to the
// installer as soon as the download lands, while a plain downloadUpdate()
// still just downloads and waits for the user.
let installWhenDownloaded = false;
// electron-updater emits 'update-downloaded' again for an already-downloaded
// update, and a second quitAndInstall() while the installer is spawning would
// launch setup.exe twice.
let installStarted = false;
let downloadInFlight = null;
let onReadyToInstall = null;

function send(status, extra) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater-status', { status, ...extra });
  }
}

// `onAvailable` raises an OS notification the moment a newer release shows up
// on GitHub -- the in-app card only helps if the window is open and in front,
// and the app spends most of its life minimized to tray.
//
// `onReadyToInstall` hands control back to main.cjs instead of quitting here:
// the installer overwrites the app's files, so the tunnel has to be torn down
// and the system proxy restored *first*, or the machine is left with a dead
// proxy pointing at an app that no longer exists.
function initUpdater(mainWindow, handlers = {}) {
  win = mainWindow;
  onReadyToInstall = handlers.onReadyToInstall || null;
  const { onAvailable } = handlers;

  autoUpdater.on('checking-for-update', () => send('checking'));

  autoUpdater.on('update-available', (info) => {
    send('available', { version: info.version, releaseNotes: info.releaseNotes || '' });
    if (onAvailable) {
      try { onAvailable(info.version); } catch { /* never let a notification break the updater */ }
    }
  });

  autoUpdater.on('update-not-available', () => send('not-available'));

  autoUpdater.on('error', (err) => {
    // A failed download must not strand the UI in a "downloading" state with
    // no way back -- reset so the card can offer a retry.
    installWhenDownloaded = false;
    downloadInFlight = null;
    send('error', { message: err?.message || String(err) });
  });

  autoUpdater.on('download-progress', (progress) => {
    send('downloading', { percent: progress.percent, transferred: progress.transferred, total: progress.total });
  });

  autoUpdater.on('update-downloaded', (info) => {
    send('downloaded', { version: info.version });
    if (installWhenDownloaded) {
      installWhenDownloaded = false;
      install();
    }
  });
}

function checkForUpdates() {
  return autoUpdater.checkForUpdates();
}

// Shared by both the manual "download" button and the one-click flow. Reusing
// the in-flight promise means a double click can't start two downloads over
// the same partial file.
function downloadUpdate() {
  if (!downloadInFlight) {
    downloadInFlight = autoUpdater.downloadUpdate()
      .catch((err) => {
        // The 'error' event already reported this to the UI; swallow here so
        // the rejection isn't also unhandled.
        return null;
      })
      .finally(() => { downloadInFlight = null; });
  }
  return downloadInFlight;
}

function downloadAndInstall() {
  if (installStarted) return Promise.resolve();
  installWhenDownloaded = true;
  send('downloading', { percent: 0 });
  return downloadUpdate();
}

function install() {
  if (installStarted) return;
  installStarted = true;
  send('installing');
  if (onReadyToInstall) {
    // main.cjs disconnects, flushes the store, then calls quitAndInstall().
    Promise.resolve()
      .then(() => onReadyToInstall())
      .catch((err) => {
        installStarted = false;
        send('error', { message: err?.message || String(err) });
      });
  } else {
    autoUpdater.quitAndInstall();
  }
}

function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

module.exports = { initUpdater, checkForUpdates, downloadUpdate, downloadAndInstall, install, quitAndInstall };
