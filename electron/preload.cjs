'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soul', {
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowState: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('window-state', handler);
    return () => ipcRenderer.removeListener('window-state', handler);
  },

  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  addLink: (link) => ipcRenderer.invoke('profiles:addLink', link),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  renameProfile: (id, name) => ipcRenderer.invoke('profiles:rename', { id, name }),
  updateProfile: (id, link) => ipcRenderer.invoke('profiles:update', { id, link }),

  addSubscription: (url) => ipcRenderer.invoke('subscriptions:add', url),
  refreshSubscription: (id) => ipcRenderer.invoke('subscriptions:refresh', id),
  refreshAllSubscriptions: () => ipcRenderer.invoke('subscriptions:refreshAll'),
  deleteSubscription: (id) => ipcRenderer.invoke('subscriptions:delete', id),
  updateSubscription: (id, patch) => ipcRenderer.invoke('subscriptions:update', { id, ...patch }),

  setMode: (mode) => ipcRenderer.invoke('settings:setMode', mode),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  openLogsFolder: () => ipcRenderer.invoke('app:openLogsFolder'),
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  exportBackup: () => ipcRenderer.invoke('app:exportBackup'),
  importBackup: () => ipcRenderer.invoke('app:importBackup'),
  saveImage: (dataUrl, defaultName) => ipcRenderer.invoke('app:saveImage', { dataUrl, defaultName }),
  copyImage: (dataUrl) => ipcRenderer.invoke('app:copyImage', dataUrl),

  openProxyFolder: () => ipcRenderer.invoke('app:openProxyFolder'),
  systemProxyEnable: () => ipcRenderer.invoke('systemProxy:enable'),
  systemProxyDisable: () => ipcRenderer.invoke('systemProxy:disable'),
  testProxyConnection: (protocol) => ipcRenderer.invoke('network:testConnection', { protocol }),
  resetNetworkDefaults: () => ipcRenderer.invoke('network:resetDefaults'),
  getRecentProxyLogs: () => ipcRenderer.invoke('network:getRecentLogs'),
  onProxyLog: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('proxy-log', handler);
    return () => ipcRenderer.removeListener('proxy-log', handler);
  },
  resetUsage: (id) => ipcRenderer.invoke('profiles:resetUsage', id),
  resetAllUsage: () => ipcRenderer.invoke('profiles:resetAllUsage'),

  connect: (profileId) => ipcRenderer.invoke('connection:connect', profileId),
  disconnect: () => ipcRenderer.invoke('connection:disconnect'),
  status: () => ipcRenderer.invoke('connection:status'),
  pingTest: (profileId) => ipcRenderer.invoke('ping:test', profileId),

  testPing: (profileId, token) => ipcRenderer.invoke('test:ping', { profileId, token }),
  testReal: (profileId, token) => ipcRenderer.invoke('test:real', { profileId, token }),
  testSpeed: (profileId, token) => ipcRenderer.invoke('test:speed', { profileId, token }),
  testCancel: (token) => ipcRenderer.invoke('test:cancel', token),
  setFavorite: (id, favorite) => ipcRenderer.invoke('profiles:setFavorite', { id, favorite }),
  onTestEvent: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('test-event', handler);
    return () => ipcRenderer.removeListener('test-event', handler);
  },

  onStateChanged: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('state-changed', handler);
    return () => ipcRenderer.removeListener('state-changed', handler);
  },
  onLatencyUpdate: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('latency-update', handler);
    return () => ipcRenderer.removeListener('latency-update', handler);
  },
  onTrafficUpdate: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('traffic-update', handler);
    return () => ipcRenderer.removeListener('traffic-update', handler);
  },
  onProfilesChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('profiles-changed', handler);
    return () => ipcRenderer.removeListener('profiles-changed', handler);
  },
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-settings', handler);
    return () => ipcRenderer.removeListener('open-settings', handler);
  },
  onUpdaterStatus: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('updater-status', handler);
    return () => ipcRenderer.removeListener('updater-status', handler);
  },
});
