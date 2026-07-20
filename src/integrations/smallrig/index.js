import { createLogger } from '../../logger.js';
import { hexToHueSat } from './color-convert.js';
import { createMeshClient } from './mesh-client.js';
import { parseMeshState, serializeMeshState } from './mesh-store.js';
import { isHexColor, clamp, normalizeLightIds, mapWithConcurrency } from '../light-utils.js';

const log = createLogger('smallrig');

// ble-transport.js n'importe plus l'addon natif au chargement : seul un worker Node
// dédié effectue l'import dynamique de webbluetooth. On conserve néanmoins ce
// chargement paresseux afin qu'une anomalie propre au transport SmallRig reste
// confinée à sa commande et ne gêne jamais Hue/OBS/Streamer.bot.
let bleTransportPromise;
function loadBleTransport() {
  if (!bleTransportPromise) {
    bleTransportPromise = import('./ble-transport.js').catch((err) => {
      bleTransportPromise = null; // permet de retenter (ex. pilote Bluetooth installé après coup)
      throw new Error(`Bluetooth indisponible sur cette machine : ${err.message}`);
    });
  }
  return bleTransportPromise;
}

const DEFAULTS = {
  brightness: 85,
  durationMs: 1200,
  pulseMs: 300
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertLightCommandResults(command, lightIds, batches) {
  const results = batches.flatMap((batch) => Array.isArray(batch) ? batch : [batch]).filter(Boolean);
  const failures = results.filter((result) => result.ok !== true);
  const returnedIds = new Set(results.map((result) => result.uuid));
  const missing = lightIds.filter((uuid) => !returnedIds.has(uuid));
  if (failures.length > 0 || missing.length > 0) {
    const details = [
      ...failures.map((failure) => `${failure.uuid}: ${failure.error || 'échec inconnu'}`),
      ...missing.map((uuid) => `${uuid}: aucun résultat`)
    ];
    const error = new Error(`${command} incomplète (${details.join('; ')})`);
    error.code = failures.length === lightIds.length || results.length === 0
      ? 'SMALLRIG_COMMAND_FAILED'
      : 'SMALLRIG_PARTIAL_FAILURE';
    error.results = results;
    throw error;
  }
  return { lights: lightIds.length, succeeded: results.length, results };
}

/**
 * Intégration SmallRig RM75 (lampes Bluetooth Mesh) : pilotage direct depuis le
 * compagnon, sans app tierce. Contrairement à Hue (bridge LAN avec IP/clé
 * persistantes), il n'y a pas de "credentials" à saisir : l'appairage (scan +
 * provisioning) se fait entièrement depuis l'IHM du compagnon (cf. desktop/main.js
 * IPC `smallrig:*`) et l'état mesh (clés réseau, nœuds) est généré et conservé
 * localement — jamais transmis au cloud, même principe que HUE_APP_KEY.
 *
 * Nécessite un adaptateur Bluetooth actif sur la machine qui exécute le compagnon
 * (cf. ble-transport.js). Le format des trames Lq confirmé depuis SmallGoGo est
 * documenté dans RM75_SPEC_DEV.md ; la validation radio RM75 reste nécessaire.
 */
export function createSmallrigIntegration(smallrigConfig = {}) {
  const maxLamps = Math.max(1, Math.min(200, Math.trunc(smallrigConfig.maxLamps) || 50));
  const requestConcurrency = Math.max(1, Math.min(10, Math.trunc(smallrigConfig.concurrency) || 3));

  let state = parseMeshState(smallrigConfig.meshStateJson);
  let persistenceFailure = null;

  async function persistState(nextState) {
    if (smallrigConfig.onStateChange) {
      try {
        await smallrigConfig.onStateChange(serializeMeshState(nextState));
      } catch (err) {
        const failure = new Error(`Échec de la persistance de l'état Mesh SmallRig : ${err.message}`, { cause: err });
        failure.code = 'SMALLRIG_STATE_PERSIST_FAILED';
        persistenceFailure = failure;
        log.error(failure.message);
        throw failure;
      }
    }
    state = nextState;
    persistenceFailure = null;
  }

  const client = createMeshClient({
    getState: () => {
      if (persistenceFailure) throw persistenceFailure;
      return state;
    },
    persistState,
    // Tous les scans sont isolés. Le résultat contient un descripteur sérialisable ;
    // open*Connection rescannera cette identité dans un worker GATT persistant. Le
    // processus principal Electron ne charge ni n'appelle jamais SimpleBLE/WinRT.
    scanForLampAdvertisements: async (...args) => (await loadBleTransport()).scanForLampAdvertisements(...args),
    scanForDisplay: async (...args) => (await loadBleTransport()).scanForLampAdvertisements(...args),
    openProvisioningConnection: async (...args) => (await loadBleTransport()).openProvisioningConnection(...args),
    openProxyConnection: async (...args) => (await loadBleTransport()).openProxyConnection(...args),
    waitForProxyAdvertisement: async (...args) => (await loadBleTransport()).waitForProxyAdvertisement(...args),
    seqBlockSize: Math.max(10, Math.trunc(smallrigConfig.seqBlockSize) || 100)
  });

  function checkLightIds(lightIds) {
    if (lightIds.length === 0) throw new Error('Aucune lampe cible (lightIds vide)');
    if (lightIds.length > maxLamps) throw new Error(`Trop de lampes ciblées (${lightIds.length}, maximum ${maxLamps})`);
  }

  async function executeForLights(command, lightIds, operation) {
    const batches = await mapWithConcurrency(lightIds, requestConcurrency, operation);
    return assertLightCommandResults(command, lightIds, batches);
  }

  // smallrig.discover — scanne localement les lampes RM75 à proximité
  // (provisionnées ou non). Cette commande est réservée à l'IHM du compagnon :
  // aucune opération d'appairage physique n'est déclenchable depuis le cloud.
  async function discover(payload = {}) {
    const timeoutMs = clamp(payload.timeoutMs, 1000, 20000, 6000);
    const found = await client.discover({ timeoutMs });
    log.info('Découverte terminée', { found: found.length });
    return { lamps: found };
  }

  // smallrig.provision — appairage d'une lampe détectée par un précédent discover.
  // Génère les clés réseau au premier appel, alloue une adresse unicast, exécute le
  // handshake PB-GATT complet, puis configure le vendor model (AppKey Add + Model App
  // Bind) — sans cette dernière étape la lampe ignorerait silencieusement les commandes.
  async function provision(payload = {}) {
    const bleDeviceId = String(payload.bleDeviceId || '').trim();
    if (!bleDeviceId) throw new Error('bleDeviceId manquant (relancez smallrig.discover)');
    const deviceUuid = String(payload.deviceUuid || '').trim().toLowerCase() || null;
    if (deviceUuid && !/^[0-9a-f]{32}$/.test(deviceUuid)) throw new Error('deviceUuid SmallRig invalide');
    const name = payload.name ? String(payload.name).trim().slice(0, 128) : null;
    // Une lampe qui réapparaît en beacon « unprovisioned » après un provisioning
    // interrompu doit pouvoir remplacer son entrée locale sans consommer un slot.
    const replacesExistingUuid = Boolean(deviceUuid && state.nodes.some((node) => node.uuid === deviceUuid));
    if (state.nodes.length >= maxLamps && !replacesExistingUuid) {
      throw new Error(`Nombre maximum de lampes atteint (${maxLamps})`);
    }

    try {
      const result = await client.provision({ bleDeviceId, deviceUuid, name });
      if (result.configured === false) log.warn('Lampe provisionnée mais configuration en attente', result);
      else log.info('Lampe provisionnée', result);
      return result;
    } catch (error) {
      // Les erreurs IPC sont autrement renvoyées uniquement au renderer et disparaissent
      // du journal, ce qui rend les diagnostics terrain (GATT/protocole/crypto) aveugles.
      // Ne jamais journaliser les clés Mesh : seulement l'identité publique de la cible.
      log.error('Échec du provisioning', {
        bleDeviceId,
        deviceUuid,
        code: error?.code || null,
        error: error?.message || String(error)
      });
      throw error;
    }
  }

  // smallrig.reconfigure — relance UNIQUEMENT la configuration (AppKey Add + Model App
  // Bind) d'une lampe déjà provisionnée (clés déjà échangées). Utile en secours : la
  // bascule 0x1827 -> 0x1828 après provisioning est parfois plus lente que prévu sur
  // certains matériels/environnements (observé), auquel cas `provision` peut réussir le
  // handshake mais échouer sur cette dernière étape — la lampe reste alors provisionnée
  // (clés valides) mais pas configurée (ignore les commandes en silence). Ce recours
  // évite de devoir tout recommencer (et donc réinitialiser physiquement la lampe).
  async function reconfigure(payload = {}) {
    const uuid = String(payload.uuid || '').trim();
    if (!uuid) throw new Error('uuid manquant');
    const node = state.nodes.find((n) => n.uuid === uuid);
    if (!node) throw new Error('Lampe inconnue (uuid non trouvé parmi les lampes provisionnées)');
    await client.configureNode(node);
    log.info('Lampe reconfigurée', { uuid });
    return { uuid, name: node.name, unicastAddress: node.unicastAddress };
  }

  // smallrig.forget — demande d'abord un Config Node Reset, puis supprime la clé
  // locale. `forceLocal` est un recours explicite après reset usine/perte définitive.
  async function forget(payload = {}) {
    const uuid = String(payload.uuid || '').trim();
    if (!uuid) throw new Error('uuid manquant');
    const result = await client.forget({ uuid, forceLocal: payload.forceLocal === true });
    log.info('Lampe oubliée', { uuid, removed: result.removed });
    return result;
  }

  // smallrig.list — lampes appairées (pour l'UI de sélection dans le wizard d'events).
  async function list() {
    return { lamps: client.listNodes() };
  }

  // smallrig.color — même contrat que hue.color (lightIds, color hex, brightness,
  // transitionMs, durationMs, mode) pour permettre un pilotage cross-marques uniforme
  // côté Klixa. `transitionMs` n'a pas d'équivalent natif RM75 (pas de fondu matériel
  // pour HSI) : ignoré en dehors du calcul de cadence du mode "simple".
  async function color(payload = {}) {
    const lightIds = normalizeLightIds(payload.lightIds ?? payload.smallrigLightIds);
    checkLightIds(lightIds);

    const hex = String(payload.color || payload.smallrigColor || '').trim().toUpperCase();
    if (!isHexColor(hex)) throw new Error(`Couleur invalide: ${hex}`);

    const { hue, sat } = hexToHueSat(hex);
    const intensity = clamp(payload.brightness ?? payload.smallrigBrightness, 1, 100, DEFAULTS.brightness);
    const durationMs = clamp(payload.durationMs ?? payload.smallrigDurationMs, 100, 60000, DEFAULTS.durationMs);
    const mode = String(payload.mode || payload.smallrigMode || '').trim().toLowerCase();

    if (mode === 'simple') {
      await blink(lightIds, { hue, sat, intensity, durationMs });
    } else {
      await executeForLights('Commande couleur', lightIds, (uuid) => client.setHsi([uuid], { hue, sat, intensity }));
    }

    log.info('Commande couleur envoyée', { lights: lightIds.length, color: hex, mode: mode || 'steady' });
    return { lights: lightIds.length, color: hex };
  }

  // Clignotement coloré puis extinction/rallumage (mode alerte, cf. hue.js#blinkLights
  // — pas de restauration d'état précédent ici : les lampes RM75 n'ont pas d'API de
  // lecture d'état aussi complète que Hue pour un snapshot fiable pré-clignotement).
  async function blink(lightIds, { hue, sat, intensity, durationMs }) {
    const endAt = Date.now() + durationMs;
    const pulseMs = Math.max(150, Math.min(400, Math.floor(durationMs / 4)));
    while (Date.now() < endAt) {
      await executeForLights('Impulsion couleur', lightIds, (uuid) => client.setHsi([uuid], { hue, sat, intensity }));
      await sleep(Math.min(pulseMs, Math.max(0, endAt - Date.now())));
      await executeForLights('Extinction de l’impulsion', lightIds, (uuid) => client.setPower([uuid], { on: false }));
      await sleep(Math.min(pulseMs, Math.max(0, endAt - Date.now())));
    }
    await executeForLights('Rallumage après impulsion', lightIds, (uuid) => client.setPower([uuid], { on: true }));
  }

  // smallrig.power — allumage/extinction ou réglage de luminosité (0-100), même esprit
  // que hue.color avec `on`/`brightness` mais sans couleur.
  async function power(payload = {}) {
    const lightIds = normalizeLightIds(payload.lightIds ?? payload.smallrigLightIds);
    checkLightIds(lightIds);
    const level = payload.level ?? payload.brightness;
    const on = payload.on !== false;
    const normalizedLevel = on && Number.isFinite(Number(level)) ? clamp(level, 0, 100, undefined) : undefined;
    await executeForLights('Commande alimentation', lightIds, (uuid) => client.setPower([uuid], { on, level: normalizedLevel }));
    log.info('Commande alimentation envoyée', { lights: lightIds.length, on, level });
    return { lights: lightIds.length };
  }

  // smallrig.status — lecture d'état (mode courant + batterie) d'une seule lampe.
  async function status(payload = {}) {
    const uuid = String(payload.uuid || '').trim();
    if (!uuid) throw new Error('uuid manquant');
    let lightState;
    let capacity;
    try { lightState = await client.readStatus(uuid); } catch (err) { lightState = { error: err.message }; }
    try { capacity = await client.readCapacity(uuid); } catch (err) { capacity = { error: err.message }; }
    if (lightState.error && capacity.error) {
      const error = new Error(`Lecture SmallRig impossible : état (${lightState.error}), batterie (${capacity.error})`);
      error.code = 'SMALLRIG_STATUS_FAILED';
      throw error;
    }
    return { state: lightState, capacity };
  }

  async function healthcheck() {
    return client.healthcheck();
  }

  async function stop() {
    await client.stop();
  }

  return {
    id: 'smallrig',
    commands: {
      'smallrig.discover': discover,
      'smallrig.provision': provision,
      'smallrig.reconfigure': reconfigure,
      'smallrig.forget': forget,
      'smallrig.list': list,
      'smallrig.color': color,
      'smallrig.power': power,
      'smallrig.status': status
    },
    commandScopes: {
      'smallrig.discover': 'local',
      'smallrig.provision': 'local',
      'smallrig.reconfigure': 'local',
      'smallrig.forget': 'local'
    },
    healthcheck,
    stop
  };
}
