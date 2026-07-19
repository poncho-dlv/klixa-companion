const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('klixa', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config, integrationId) => ipcRenderer.invoke('config:save', config, { integrationId }),
  hueRegister: (bridgeIp, bridgePort) => ipcRenderer.invoke('hue:register', { bridgeIp, bridgePort }),
  hueDisconnect: () => ipcRenderer.invoke('hue:disconnect'),
  smallrigDiscover: (timeoutMs) => ipcRenderer.invoke('smallrig:discover', { timeoutMs }),
  smallrigProvision: (bleDeviceId, name) => ipcRenderer.invoke('smallrig:provision', { bleDeviceId, name }),
  smallrigForget: (uuid) => ipcRenderer.invoke('smallrig:forget', { uuid }),
  smallrigList: () => ipcRenderer.invoke('smallrig:list'),
  getStatus: () => ipcRenderer.invoke('runtime:status'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('auto-launch:set', enabled),
  onStatus: (callback) => ipcRenderer.on('runtime:status', (_event, status) => callback(status)),
  getCloudStatus: () => ipcRenderer.invoke('cloud:status'),
  onCloudStatus: (callback) => ipcRenderer.on('cloud:status', (_event, cloudStatus) => callback(cloudStatus)),
  getIntegrationStatus: () => ipcRenderer.invoke('integration:status'),
  onIntegrationStatus: (callback) => ipcRenderer.on('integration:status', (_event, status) => callback(status)),
  pairingStart: (options) => ipcRenderer.invoke('pairing:start', options),
  pairingCancel: () => ipcRenderer.invoke('pairing:cancel'),
  onPairingStatus: (callback) => ipcRenderer.on('pairing:status', (_event, status) => callback(status)),
  disconnect: () => ipcRenderer.invoke('cloud:disconnect'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  onUpdateStatus: (callback) => ipcRenderer.on('update:status', (_event, status) => callback(status)),
  installUpdate: () => ipcRenderer.invoke('update:install')
});
