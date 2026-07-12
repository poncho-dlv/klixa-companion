const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('klixa', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  getStatus: () => ipcRenderer.invoke('runtime:status'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('auto-launch:set', enabled),
  onStatus: (callback) => ipcRenderer.on('runtime:status', (_event, status) => callback(status)),
  pairingStart: (options) => ipcRenderer.invoke('pairing:start', options),
  pairingCancel: () => ipcRenderer.invoke('pairing:cancel'),
  onPairingStatus: (callback) => ipcRenderer.on('pairing:status', (_event, status) => callback(status))
});
