import OBSWebSocket from 'obs-websocket-js';
import { createLogger } from '../logger.js';

const log = createLogger('obs');

// Paramètres d'URL où peut vivre le token overlay (ordre de préférence).
const TOKEN_PARAMS = ['wsToken', 'overlayToken', 'token'];

// Manipulation d'URL (pures + testées)
export function extractToken(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const p of TOKEN_PARAMS) {
      if (u.searchParams.has(p)) return u.searchParams.get(p);
    }
  } catch { /* URL non standard */ }
  return '';
}

export function setToken(rawUrl, token) {
  try {
    const u = new URL(rawUrl);
    const existing = TOKEN_PARAMS.find((p) => u.searchParams.has(p));
    u.searchParams.set(existing || 'wsToken', token);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function urlMatchesBase(rawUrl, base) {
  if (!base) return false;
  try {
    const current = new URL(rawUrl);
    const expected = new URL(base);
    if (current.origin !== expected.origin) return false;

    const basePath = expected.pathname.replace(/\/+$/, '');
    if (!basePath) return true;
    return current.pathname === basePath || current.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

// Décide quoi faire de l'URL d'une source navigateur (pur + testé) :
//  - 'skip'   : URL hors origine overlay, ne pas toucher
//  - 'ok'     : déjà le bon token, rien à faire
//  - 'update' : réécrire avec l'URL renvoyée
export function resolveOverlayUrlUpdate(currentUrl, base, token) {
  if (!currentUrl || !urlMatchesBase(currentUrl, base)) return { action: 'skip', url: currentUrl };
  if (extractToken(currentUrl) === token) return { action: 'ok', url: currentUrl };
  return { action: 'update', url: setToken(currentUrl, token) };
}

/**
 * Intégration OBS NATIVE (obs-websocket) : le compagnon parle directement à OBS sur
 * le LAN. Remplace l'action Streamer.bot ObsSyncOverlayToken.cs ET la souscription SB
 * aux events de scène/stream. Deux sens :
 *  - commande `obs.sync-overlay-token` (cloud vers compagnon) : réécrit le token overlay
 *    dans les URLs des sources navigateur OBS.
 *  - events `Obs.SceneChanged` / `Obs.StreamingStarted|Stopped` (compagnon vers cloud).
 */
export function createObsIntegration(obsConfig = {}, { emitEvent } = {}) {
  const obs = new OBSWebSocket();
  const url = obsConfig.url || 'ws://127.0.0.1:4455';
  let connected = false;
  let stopped = false;
  let reconnectTimer = null;
  // Anti-spam : si OBS est hors ligne, on tente toutes les 5 s. On logge la perte UNE fois,
  // puis silence jusqu'au retour (connect() réussi remet le flag à zéro).
  let loggedOffline = false;

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
  }

  // Si OBS est hors ligne avec un pare-feu qui « drop » les paquets, obs.connect() peut rester
  // bloqué ~2 min (timeout TCP de l'OS) avant d'échouer, ce qui fige la reconnexion et
  // empêche de détecter le lancement d'OBS. On borne donc l'attente à 10 s puis on coupe.
  function connectWithTimeout() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        obs.disconnect().catch(() => {});
        reject(new Error('timeout de connexion (10 s)'));
      }, 10000);
      obs.connect(url, obsConfig.password || undefined)
        .then(() => { clearTimeout(timer); resolve(); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  async function connect() {
    if (stopped || connected) return;
    try {
      await connectWithTimeout();
      connected = true;
      loggedOffline = false;
      log.info('Connecté à OBS', { url });
    } catch (err) {
      connected = false;
      if (!loggedOffline) {
        loggedOffline = true;
        log.warn('Connexion OBS indisponible (nouvelle tentative toutes les 5 s)', err.message);
      }
      scheduleReconnect();
    }
  }

  obs.on('ConnectionClosed', () => {
    connected = false;
    if (!stopped) {
      if (!loggedOffline) {
        loggedOffline = true;
        log.warn('Connexion OBS fermée (reconnexion auto)');
      }
      scheduleReconnect();
    }
  });

  obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
    emitEvent?.({ event: { source: 'Obs', type: 'SceneChanged' }, data: { scene: { sceneName } } });
  });

  obs.on('StreamStateChanged', ({ outputActive }) => {
    emitEvent?.({
      event: { source: 'Obs', type: outputActive ? 'StreamingStarted' : 'StreamingStopped' },
      data: {}
    });
  });

  connect();

  // obs.sync-overlay-token — réécrit le token overlay dans les sources navigateur OBS
  // dont l'URL pointe vers `overlayBase`. Port fidèle de ObsSyncOverlayToken.cs.
  async function syncOverlayToken(payload = {}) {
    if (!connected) throw new Error('OBS non connecté');

    const token = String(payload.overlayToken || '').trim();
    if (!token) throw new Error('overlayToken manquant');

    const base = String(payload.overlayBase || '').trim();
    if (!base) throw new Error('overlayBase manquant (fourni par le serveur)');

    // GetInputList renvoie TOUTES les sources connues d'OBS, quel que soit leur
    // canevas/scène (y compris les sources non placées dans une scène). On ne parcourt
    // donc plus les scènes horizontales classiques (GetSceneList), qui rataient les
    // sources navigateur d'Aitum Vertical : celles-ci vivent sur un canevas séparé,
    // absent de GetSceneList, mais bien présentes ici comme inputs `browser_source`.
    const { inputs } = await obs.call('GetInputList');
    let updated = 0;
    let alreadyOk = 0;
    let scanned = 0;

    for (const input of inputs || []) {
      const inputName = input?.inputName;
      if (!inputName || input?.inputKind !== 'browser_source') continue;
      scanned++;

      let inputSettings;
      try { ({ inputSettings } = await obs.call('GetInputSettings', { inputName })); }
      catch { continue; }

      const decision = resolveOverlayUrlUpdate(inputSettings?.url || '', base, token);
      if (decision.action === 'ok') { alreadyOk++; continue; }
      if (decision.action !== 'update') continue;

      await obs.call('SetInputSettings', { inputName, inputSettings: { url: decision.url } });
      updated++;
    }

    log.info('Sync token overlay terminé', { updated, alreadyOk, sources: scanned });
    return { updated, alreadyOk, sources: scanned };
  }

  // obs.get-scenes — liste les scènes du canevas programme (GetSceneList), ordonnées
  // comme dans l'UI OBS (de haut en bas : GetSceneList renvoie les sceneIndex croissants,
  // 0 = bas de liste), + la scène courante. Consommé par la page admin « Écran
  // dynamique » (mapping entre scène et titre/étapes).
  async function getScenes() {
    if (!connected) throw new Error('OBS non connecté');

    const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
    const names = (scenes || [])
      .slice()
      .sort((a, b) => (b?.sceneIndex ?? 0) - (a?.sceneIndex ?? 0))
      .map((s) => s?.sceneName)
      .filter(Boolean);

    return { scenes: names, currentScene: currentProgramSceneName || '' };
  }

  async function healthcheck() {
    if (!connected) throw new Error('OBS non connecté');
    return { url, connected };
  }

  return {
    id: 'obs',
    commands: {
      'obs.sync-overlay-token': syncOverlayToken,
      'obs.get-scenes': getScenes
    },
    healthcheck,
    stop() { stopped = true; clearTimeout(reconnectTimer); obs.disconnect().catch(() => {}); }
  };
}
