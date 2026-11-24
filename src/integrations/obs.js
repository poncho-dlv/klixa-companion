import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { createLogger } from '../logger.js';
import { t } from '../i18n/core.js';

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

// Identifiant d'overlay Klixa d'une source navigateur : premier segment du chemin, en minuscules
// (`https://overlays.klixa.live/Alerts/?wsToken=…` → `alerts`). Jamais l'URL ni le token : ils ne
// quittent pas le compagnon (la commande obs.get-scene-items ne renvoie que cet identifiant).
export function overlayIdFromUrl(rawUrl, base) {
  if (!urlMatchesBase(rawUrl, base)) return '';
  try {
    const basePath = new URL(base).pathname.replace(/\/+$/, '');
    const rest = new URL(rawUrl).pathname.slice(basePath.length);
    const id = rest.split('/').filter(Boolean)[0] || '';
    return /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id.toLowerCase() : '';
  } catch {
    return '';
  }
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Forme de la réponse `obs.get-scene-items` (pure + testée) à partir des réponses brutes d'obs-websocket.
 * @param {{ sceneName: string, canvas: {baseWidth:number, baseHeight:number}, items: object[], inputs: Record<string, object> }} raw
 *   `items` = GetSceneItemList ; `inputs` = sourceName → inputSettings des sources navigateur.
 * @param {string} overlayBase  Origine overlay Klixa (identifie les sources navigateur Klixa).
 */
export function buildSceneItems({ sceneName, canvas, items, inputs }, overlayBase) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const sourceName = String(item?.sourceName || '');
    if (!sourceName) continue;
    const t = item.sceneItemTransform || {};
    const settings = inputs?.[sourceName] || null;
    const isBrowser = item.inputKind === 'browser_source';
    const overlay = isBrowser && settings ? overlayIdFromUrl(String(settings.url || ''), overlayBase) : '';
    out.push({
      sourceName,
      sceneItemId: num(item.sceneItemId),
      enabled: item.sceneItemEnabled !== false,
      kind: overlay ? 'overlay' : isBrowser ? 'browser' : 'other',
      ...(overlay ? { overlay } : {}),
      isGroup: item.isGroup === true,
      sourceWidth: num(t.sourceWidth, num(settings?.width)),
      sourceHeight: num(t.sourceHeight, num(settings?.height)),
      transform: {
        positionX: num(t.positionX), positionY: num(t.positionY),
        scaleX: num(t.scaleX, 1), scaleY: num(t.scaleY, 1),
        rotation: num(t.rotation),
        alignment: num(t.alignment, 5),
        cropLeft: num(t.cropLeft), cropRight: num(t.cropRight), cropTop: num(t.cropTop), cropBottom: num(t.cropBottom),
        width: num(t.width), height: num(t.height),
        boundsType: String(t.boundsType || 'OBS_BOUNDS_NONE')
      }
    });
  }
  return { canvas: { width: num(canvas?.baseWidth), height: num(canvas?.baseHeight) }, currentScene: String(sceneName || ''), items: out };
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
        reject(new Error(t('errors.obsConnectTimeout')));
      }, 10000);
      // SceneItemTransformChanged est un event « haut volume » : absent de `All`, à demander explicitement.
      obs.connect(url, obsConfig.password || undefined, {
        eventSubscriptions: EventSubscription.All | EventSubscription.SceneItemTransformChanged
      })
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

  // Disposition de la scène modifiée (élément activé/masqué, déplacé, redimensionné) : notification
  // minimale, anti-rafale (un glisser-déposer dans OBS émet des dizaines d'events) ; le serveur relit
  // alors obs.get-scene-items. Aucun contenu de scène ne transite dans l'event.
  let itemsTimer = null;
  function notifySceneItemsChanged() {
    clearTimeout(itemsTimer);
    itemsTimer = setTimeout(() => {
      emitEvent?.({ event: { source: 'Obs', type: 'SceneItemsChanged' }, data: {} });
    }, 400);
  }
  obs.on('SceneItemEnableStateChanged', notifySceneItemsChanged);
  obs.on('SceneItemTransformChanged', notifySceneItemsChanged);
  obs.on('SceneItemCreated', notifySceneItemsChanged);
  obs.on('SceneItemRemoved', notifySceneItemsChanged);

  connect();

  // obs.sync-overlay-token — réécrit le token overlay dans les sources navigateur OBS
  // dont l'URL pointe vers `overlayBase`. Port fidèle de ObsSyncOverlayToken.cs.
  async function syncOverlayToken(payload = {}) {
    if (!connected) throw new Error(t('errors.obsNotConnected'));

    const token = String(payload.overlayToken || '').trim();
    if (!token) throw new Error(t('errors.obsMissingOverlayToken'));

    const base = String(payload.overlayBase || '').trim();
    if (!base) throw new Error(t('errors.obsMissingOverlayBase'));

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
    if (!connected) throw new Error(t('errors.obsNotConnected'));

    const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
    const names = (scenes || [])
      .slice()
      .sort((a, b) => (b?.sceneIndex ?? 0) - (a?.sceneIndex ?? 0))
      .map((s) => s?.sceneName)
      .filter(Boolean);

    return { scenes: names, currentScene: currentProgramSceneName || '' };
  }

  // obs.set-scene — bascule la scène active (canevas programme), consommé par la page
  // admin « Régie » (server/routers/obs.js, POST /api/obs/regie/switch). Le serveur a
  // déjà validé la scène contre sa whitelist ; ici on ne fait que transmettre à OBS.
  async function setScene(payload = {}) {
    if (!connected) throw new Error(t('errors.obsNotConnected'));

    const sceneName = String(payload.sceneName || '').trim();
    if (!sceneName) throw new Error(t('errors.obsMissingSceneName'));

    await obs.call('SetCurrentProgramScene', { sceneName });
    return { sceneName };
  }

  // obs.get-sources — liste des sources filtrables (inputs + scènes, un filtre OBS
  // pouvant être posé sur l'un ou l'autre), consommée par la page admin
  // « Automatisations » pour le picker source→filtre de l'action `obsFilter`.
  // GetInputList ne renvoie PAS les scènes (contrairement à syncOverlayToken qui n'en
  // a pas besoin, limité aux browser_source) — on fusionne donc avec GetSceneList.
  async function getSources() {
    if (!connected) throw new Error(t('errors.obsNotConnected'));

    const [{ inputs }, { scenes }] = await Promise.all([
      obs.call('GetInputList'),
      obs.call('GetSceneList')
    ]);

    const names = new Set();
    for (const input of inputs || []) { if (input?.inputName) names.add(input.inputName); }
    for (const scene of scenes || []) { if (scene?.sceneName) names.add(scene.sceneName); }

    return { sources: [...names].sort((a, b) => a.localeCompare(b)) };
  }

  // obs.get-source-filters — liste des filtres posés sur une source précise (nom +
  // état actuel), consommée par le même picker pour peupler le combobox filtre une
  // fois la source choisie.
  async function getSourceFilters(payload = {}) {
    if (!connected) throw new Error(t('errors.obsNotConnected'));

    const sourceName = String(payload.sourceName || '').trim();
    if (!sourceName) throw new Error(t('errors.obsMissingSourceName'));

    const { filters } = await obs.call('GetSourceFilterList', { sourceName });
    return {
      filters: (filters || []).map((filter) => ({
        name: filter?.filterName || '',
        enabled: filter?.filterEnabled !== false,
        kind: filter?.filterKind || ''
      })).filter((filter) => filter.name)
    };
  }

  // obs.set-source-filter-enabled — active/désactive un filtre d'une source, consommé
  // par l'action `obsFilter` de la page « Automatisations » (server/automations-service.js).
  async function setSourceFilterEnabled(payload = {}) {
    if (!connected) throw new Error(t('errors.obsNotConnected'));

    const sourceName = String(payload.sourceName || '').trim();
    if (!sourceName) throw new Error(t('errors.obsMissingSourceName'));

    const filterName = String(payload.filterName || '').trim();
    if (!filterName) throw new Error(t('errors.obsMissingFilterName'));

    const filterEnabled = payload.enabled !== false;
    await obs.call('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled });
    return { sourceName, filterName, enabled: filterEnabled };
  }

  // obs.get-scene-items — éléments de la scène programme courante avec leur transformation, pour que
  // Klixa place la mascotte dans le repère commun du canevas (docs/mascot-movement-plan.md, étape 3).
  // Les URLs des sources navigateur (qui portent le token overlay) ne sont JAMAIS renvoyées : seul
  // l'identifiant d'overlay déduit de l'URL l'est (cf. overlayIdFromUrl).
  async function getSceneItems(payload = {}) {
    if (!connected) throw new Error(t('errors.obsNotConnected'));

    const overlayBase = String(payload.overlayBase || '').trim();
    const [{ sceneName }, canvas] = await Promise.all([
      obs.call('GetCurrentProgramScene'),
      obs.call('GetVideoSettings')
    ]);
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });

    const inputs = {};
    await Promise.all((sceneItems || [])
      .filter((item) => item?.inputKind === 'browser_source' && item.sourceName)
      .map(async (item) => {
        try {
          const { inputSettings } = await obs.call('GetInputSettings', { inputName: item.sourceName });
          inputs[item.sourceName] = inputSettings;
        } catch { /* source illisible : traitée comme navigateur non Klixa */ }
      }));

    return buildSceneItems({ sceneName, canvas, items: sceneItems, inputs }, overlayBase);
  }

  async function healthcheck() {
    if (!connected) throw new Error(t('errors.obsNotConnected'));
    return { url, connected };
  }

  return {
    id: 'obs',
    commands: {
      'obs.sync-overlay-token': syncOverlayToken,
      'obs.get-scenes': getScenes,
      'obs.get-scene-items': getSceneItems,
      'obs.set-scene': setScene,
      'obs.get-sources': getSources,
      'obs.get-source-filters': getSourceFilters,
      'obs.set-source-filter-enabled': setSourceFilterEnabled
    },
    healthcheck,
    stop() { stopped = true; clearTimeout(reconnectTimer); clearTimeout(itemsTimer); obs.disconnect().catch(() => {}); }
  };
}
