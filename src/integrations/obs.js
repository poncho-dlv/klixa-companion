import OBSWebSocket from 'obs-websocket-js';
import { createLogger } from '../logger.js';

const log = createLogger('obs');

// Paramètres d'URL où peut vivre le token overlay (ordre de préférence).
const TOKEN_PARAMS = ['wsToken', 'overlayToken', 'token'];

// ── Manipulation d'URL (pures + testées) ─────────────────────────────────────
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
  return String(rawUrl).toLowerCase().startsWith(String(base).toLowerCase().replace(/\/+$/, ''));
}

/**
 * Intégration OBS NATIVE (obs-websocket) : le compagnon parle directement à OBS sur
 * le LAN. Remplace l'action Streamer.bot ObsSyncOverlayToken.cs ET la souscription SB
 * aux events de scène/stream. Deux sens :
 *  - commande `obs.sync-overlay-token` (cloud → compagnon) : réécrit le token overlay
 *    dans les URLs des sources navigateur OBS.
 *  - events `Obs.SceneChanged` / `Obs.StreamingStarted|Stopped` (compagnon → cloud).
 */
export function createObsIntegration(obsConfig = {}, { emitEvent } = {}) {
  const obs = new OBSWebSocket();
  const url = obsConfig.url || 'ws://127.0.0.1:4455';
  let connected = false;
  let stopped = false;
  let reconnectTimer = null;
  // Anti-spam : OBS hors ligne → on tente toutes les 5 s. On logge la perte UNE fois,
  // puis silence jusqu'au retour (connect() réussi remet le flag à zéro).
  let loggedOffline = false;

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
  }

  async function connect() {
    if (stopped || connected) return;
    try {
      await obs.connect(url, obsConfig.password || undefined);
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

    const { scenes } = await obs.call('GetSceneList');
    const processed = new Set();
    let updated = 0;
    let alreadyOk = 0;

    for (const scene of scenes || []) {
      const sceneName = scene?.sceneName;
      if (!sceneName) continue;

      let sceneItems;
      try { ({ sceneItems } = await obs.call('GetSceneItemList', { sceneName })); }
      catch { continue; }

      for (const item of sceneItems || []) {
        const sourceName = item?.sourceName;
        const inputKind = item?.inputKind;
        if (!sourceName) continue;
        if (inputKind && inputKind !== 'browser_source') continue;
        if (processed.has(sourceName)) continue;
        processed.add(sourceName);

        let inputSettings;
        try { ({ inputSettings } = await obs.call('GetInputSettings', { inputName: sourceName })); }
        catch { continue; }

        const currentUrl = inputSettings?.url || '';
        if (!currentUrl || !urlMatchesBase(currentUrl, base)) continue;
        if (extractToken(currentUrl) === token) { alreadyOk++; continue; }

        await obs.call('SetInputSettings', { inputName: sourceName, inputSettings: { url: setToken(currentUrl, token) } });
        updated++;
      }
    }

    log.info('Sync token overlay terminé', { updated, alreadyOk, sources: processed.size });
    return { updated, alreadyOk, sources: processed.size };
  }

  async function healthcheck() {
    if (!connected) throw new Error('OBS non connecté');
    return { url, connected };
  }

  return {
    id: 'obs',
    commands: { 'obs.sync-overlay-token': syncOverlayToken },
    healthcheck,
    stop() { stopped = true; clearTimeout(reconnectTimer); obs.disconnect().catch(() => {}); }
  };
}
