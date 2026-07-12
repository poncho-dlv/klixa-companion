import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createConfig } from '../src/config.js';
import { startCompanion } from '../src/runtime.js';
import { ConfigStore } from './config-store.js';
import electronUpdaterPkg from 'electron-updater';
import { createLogger, setLogFile } from '../src/logger.js';

const { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } = electron;
const directory = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(app.getPath('userData'), 'logs');
setLogFile(path.join(logDir, 'companion.log'));
const log = createLogger('desktop');

process.on('uncaughtException', (error) => {
  log.error('uncaughtException', error.stack || error.message);
  app.quit();
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason?.stack || String(reason));
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.warn('Verrou instance unique refuse, une instance tourne deja');
  app.quit();
  process.exit(0);
}

let window;
let tray;
let runtime;
let store;
let status = { running: false, message: 'Demarrage...' };
let quitting = false;
// Statut du handshake cloud (distinct de `status` : le runtime local peut demarrer
// sans que la liaison WS au serveur Klixa soit etablie). Pilote l'affichage des
// sections d'integration dans le renderer (masquees tant que non connecte).
let cloudStatus = { connected: false, features: {} };

function trayImage() {
  return nativeImage.createFromPath(path.join(directory, 'icon.ico')).resize({ width: 16, height: 16 });
}

function showWindow() {
  window?.show();
  window?.focus();
}

function createWindow() {
  window = new BrowserWindow({
    width: 720,
    height: 780,
    minWidth: 620,
    minHeight: 650,
    title: 'Klixa Companion',
    show: false,
    webPreferences: {
      preload: path.join(directory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.setMenuBarVisibility(false);
  window.loadFile(path.join(directory, 'renderer', 'index.html'));
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function updateStatus(next) {
  status = next;
  window?.webContents.send('runtime:status', status);
  tray?.setToolTip(`Klixa Companion - ${status.message}`);
}

function updateCloudStatus(next) {
  cloudStatus = { connected: false, features: {}, ...next };
  window?.webContents.send('cloud:status', cloudStatus);
}

async function restartRuntime(values) {
  updateStatus({ running: false, message: 'Redemarrage...' });
  updateCloudStatus({ connected: false, features: {} });
  await runtime?.stop();
  try {
    runtime = startCompanion(
      createConfig({ ...process.env, ...values, NODE_ENV: 'production' }),
      { onCloudStatus: updateCloudStatus }
    );
    updateStatus({ running: true, message: values.CLOUD_WS_URL ? 'Compagnon actif' : 'Actif en mode local' });
  } catch (error) {
    log.error('Echec du demarrage du runtime', error.stack || error.message);
    updateStatus({ running: false, message: `Erreur : ${error.message}` });
    throw error;
  }
}

const LOGIN_ITEM_ARGS = ['--hidden'];

// Pairing device-code (cf. server/companion-pairing-service.js cote Klixa) : le
// compagnon demande un code a l'instance cloud (URL par defaut, surchargeable pour
// le self-host), affiche le userCode 6 chiffres et poll jusqu'a ce que le streamer
// l'ait saisi dans la console admin. Etat garde en memoire du process main uniquement
// (jamais persiste : un redemarrage pendant un pairing en cours force juste a relancer).
const DEFAULT_CLOUD_PAIR_URL = 'https://klixa.live';
let pairingPoll = null;

function stopPairingPoll() {
  if (pairingPoll?.timer) clearInterval(pairingPoll.timer);
  pairingPoll = null;
}

function sendPairingStatus(payload) {
  window?.webContents.send('pairing:status', payload);
}

async function pollPairingOnce() {
  if (!pairingPoll) return;
  const { deviceCode, baseUrl } = pairingPoll;

  let data;
  try {
    const response = await fetch(`${baseUrl}/api/companion-pair/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode })
    });
    data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  } catch (error) {
    // Erreur reseau ponctuelle : on ne coupe pas la boucle, le prochain tick reessaiera
    // jusqu'a expiration cote serveur (le pairing lui-meme a un TTL).
    log.warn('Echec du poll de pairing', error.message);
    return;
  }

  if (data.status === 'pending') return;

  stopPairingPoll();

  if (data.status === 'expired') {
    sendPairingStatus({ phase: 'expired' });
    return;
  }

  if (data.status === 'claimed') {
    const current = store.load();
    const next = { ...current, CLOUD_WS_URL: data.wsUrl, COMPANION_TOKEN: data.token };
    store.save(next);
    try {
      await restartRuntime(next);
      sendPairingStatus({ phase: 'claimed' });
    } catch (error) {
      sendPairingStatus({ phase: 'error', message: error.message });
    }
  }
}

function publicConfig(values) {
  const result = { ...values };
  for (const key of ['COMPANION_TOKEN', 'OBS_WS_PASSWORD', 'SB_PASSWORD', 'HUE_APP_KEY', 'SMOKE_SERVICE_TOKEN']) {
    result[`${key}_CONFIGURED`] = Boolean(result[key]);
    delete result[key];
  }
  result.AUTO_LAUNCH = app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin;
  return result;
}

function registerIpc() {
  ipcMain.handle('config:get', () => publicConfig(store.load()));
  ipcMain.handle('runtime:status', () => status);
  ipcMain.handle('cloud:status', () => cloudStatus);
  ipcMain.handle('auto-launch:set', (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true, args: LOGIN_ITEM_ARGS });
    return app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin;
  });
  ipcMain.handle('config:save', async (_event, submitted) => {
    const current = store.load();
    const next = { ...current, ...submitted };
    for (const key of ['COMPANION_TOKEN', 'OBS_WS_PASSWORD', 'SB_PASSWORD', 'HUE_APP_KEY', 'SMOKE_SERVICE_TOKEN']) {
      if (!submitted[key]) next[key] = current[key] || '';
    }
    if (next.CLOUD_WS_URL && !/^wss?:\/\//i.test(next.CLOUD_WS_URL)) throw new Error('URL cloud invalide (ws:// ou wss:// attendu)');
    store.save(next);
    await restartRuntime(next);
    return publicConfig(next);
  });
  ipcMain.handle('pairing:start', async (_event, { baseUrl } = {}) => {
    stopPairingPoll();
    const resolvedBaseUrl = String(baseUrl || store.load().CLOUD_PAIR_URL || DEFAULT_CLOUD_PAIR_URL)
      .trim()
      .replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(resolvedBaseUrl)) throw new Error('URL d\'instance invalide (http:// ou https:// attendu)');

    const response = await fetch(`${resolvedBaseUrl}/api/companion-pair/start`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

    pairingPoll = {
      deviceCode: data.deviceCode,
      baseUrl: resolvedBaseUrl,
      timer: setInterval(pollPairingOnce, Math.max(1000, Number(data.intervalMs) || 3000))
    };

    return { userCode: data.userCode, expiresInMs: data.expiresInMs };
  });
  ipcMain.handle('pairing:cancel', () => {
    stopPairingPoll();
  });
}

function configureUpdates(values) {
  const updateUrl = values.UPDATE_URL || process.env.KLIXA_UPDATE_URL;
  if (!app.isPackaged || !updateUrl) return;
  const { autoUpdater } = electronUpdaterPkg;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
    autoUpdater.on('update-downloaded', () => updateStatus({ running: true, message: 'Mise a jour prete pour le prochain demarrage' }));
    autoUpdater.on('error', (error) => console.warn('[updater]', error.message));
    autoUpdater.checkForUpdatesAndNotify();
  } catch (error) {
    console.warn('[updater]', error.message);
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('live.klixa.companion');
  store = new ConfigStore(app.getPath('userData'));
  createWindow();
  tray = new Tray(trayImage());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir Klixa Companion', click: showWindow },
    { label: 'Ouvrir les logs', click: () => shell.openPath(logDir) },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWindow);
  registerIpc();
  await restartRuntime(store.load());
  configureUpdates(store.load());
  if (!process.argv.includes('--hidden')) showWindow();
}).catch((error) => {
  log.error('Echec du demarrage de l\'application', error.stack || error.message);
  showWindow();
});

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { stopPairingPoll(); runtime?.stop(); });
