'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soul', {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  addLink: (link) => ipcRenderer.invoke('profiles:addLink', link),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  renameProfile: (id, name) => ipcRenderer.invoke('profiles:rename', { id, name }),

  addSubscription: (url) => ipcRenderer.invoke('subscriptions:add', url),
  refreshSubscription: (id) => ipcRenderer.invoke('subscriptions:refresh', id),
  refreshAllSubscriptions: () => ipcRenderer.invoke('subscriptions:refreshAll'),
  deleteSubscription: (id) => ipcRenderer.invoke('subscriptions:delete', id),

  setMode: (mode) => ipcRenderer.invoke('settings:setMode', mode),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  openLogsFolder: () => ipcRenderer.invoke('app:openLogsFolder'),

  connect: (profileId) => ipcRenderer.invoke('connection:connect', profileId),
  disconnect: () => ipcRenderer.invoke('connection:disconnect'),
  status: () => ipcRenderer.invoke('connection:status'),
  pingTest: (profileId) => ipcRenderer.invoke('ping:test', profileId),

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
});
