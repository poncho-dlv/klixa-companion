import { createLogger } from '../../logger.js';
import { hexToHueSat } from './color-convert.js';
import { createMeshClient } from './mesh-client.js';
import { parseMeshState, serializeMeshState } from './mesh-store.js';
import { isHexColor, clamp, normalizeLightIds, mapWithConcurrency } from '../light-utils.js';

const log = createLogger('smallrig');

// ble-transport.js charge le binaire natif `webbluetooth` DÈS L'IMPORT (au niveau
// module, pas à la première connexion — cf. node_modules/webbluetooth/dist/adapters/
// simpleble-adapter.js). Un import statique en tête de fichier ferait donc planter
// TOUT le compagnon au démarrage si ce binaire échoue à charger sur la machine de
// l'utilisateur (driver manquant, antivirus, etc.) — pas seulement SmallRig, mais
// aussi Hue/OBS/Streamer.bot qui partagent le même graphe de modules. On importe
// donc paresseusement, au premier vrai besoin BLE, pour que l'échec reste confiné à
// une erreur de commande SmallRig normale (cf. registerIntegration qui catch déjà
// les erreurs de `createSmallrigIntegration`, mais pas une exception au chargement
// du module lui-même).
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

/**
 * Intégration SmallRig RM75 (lampes Bluetooth Mesh) : pilotage direct depuis le
 * compagnon, sans app tierce. Contrairement à Hue (bridge LAN avec IP/clé
 * persistantes), il n'y a pas de "credentials" à saisir : l'appairage (scan +
 * provisioning) se fait entièrement depuis l'IHM du compagnon (cf. desktop/main.js
 * IPC `smallrig:*`) et l'état mesh (clés réseau, nœuds) est généré et conservé
 * localement — jamais transmis au cloud, même principe que HUE_APP_KEY.
 *
 * Nécessite un adaptateur Bluetooth actif sur la machine qui exécute le compagnon
 * (cf. ble-transport.js). Le format des trames/l'opcode vendor sont documentés dans
 * RM75_SPEC_DEV.md — voir en particulier §12 pour les points non vérifiés sur
 * matériel réel (opcode vendor hypothèse A/B, configurable via SMALLRIG_VENDOR_OPCODE_MODE).
 */
export function createSmallrigIntegration(smallrigConfig = {}) {
  const maxLamps = Math.max(1, Math.min(200, Math.trunc(smallrigConfig.maxLamps) || 50));
  const requestConcurrency = Math.max(1, Math.min(10, Math.trunc(smallrigConfig.concurrency) || 3));

  let state = parseMeshState(smallrigConfig.meshStateJson);

  async function persistState(nextState) {
    state = nextState;
    if (smallrigConfig.onStateChange) {
      try {
        await smallrigConfig.onStateChange(serializeMeshState(nextState));
      } catch (err) {
        log.error('Échec de la persistance de l\'état mesh SmallRig', err.message);
      }
    }
  }

  const client = createMeshClient({
    getState: () => state,
    persistState,
    scanForLampAdvertisements: async (...args) => (await loadBleTransport()).scanForLampAdvertisements(...args),
    openProvisioningConnection: async (...args) => (await loadBleTransport()).openProvisioningConnection(...args),
    openProxyConnection: async (...args) => (await loadBleTransport()).openProxyConnection(...args),
    waitForProxyAdvertisement: async (...args) => (await loadBleTransport()).waitForProxyAdvertisement(...args),
    vendorOpcodeMode: smallrigConfig.vendorOpcodeMode === 'B' ? 'B' : 'A',
    seqBlockSize: Math.max(10, Math.trunc(smallrigConfig.seqBlockSize) || 100)
  });

  function checkLightIds(lightIds) {
    if (lightIds.length === 0) throw new Error('Aucune lampe cible (lightIds vide)');
    if (lightIds.length > maxLamps) throw new Error(`Trop de lampes ciblées (${lightIds.length}, maximum ${maxLamps})`);
  }

  // smallrig.discover — scanne les lampes RM75 à proximité (provisionnées ou non).
  // Résultat renvoyé au cloud pour affichage dans le wizard d'appairage (comme
  // hue.discover), sans jamais exposer de clé.
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
    const name = payload.name ? String(payload.name).trim().slice(0, 128) : null;
    if (state.nodes.length >= maxLamps) throw new Error(`Nombre maximum de lampes atteint (${maxLamps})`);

    const node = await client.provision({ bleDeviceId, name });
    log.info('Lampe provisionnée', node);
    return node;
  }

  // smallrig.forget — désappaire une lampe (la clé réseau reste valide pour les autres).
  async function forget(payload = {}) {
    const uuid = String(payload.uuid || '').trim();
    if (!uuid) throw new Error('uuid manquant');
    const result = await client.forget({ uuid });
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
      await mapWithConcurrency(lightIds, requestConcurrency, (uuid) => client.setHsi([uuid], { hue, sat, intensity }));
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
      await mapWithConcurrency(lightIds, requestConcurrency, (uuid) => client.setHsi([uuid], { hue, sat, intensity }));
      await sleep(Math.min(pulseMs, Math.max(0, endAt - Date.now())));
      await mapWithConcurrency(lightIds, requestConcurrency, (uuid) => client.setPower([uuid], { on: false }));
      await sleep(Math.min(pulseMs, Math.max(0, endAt - Date.now())));
    }
    await mapWithConcurrency(lightIds, requestConcurrency, (uuid) => client.setPower([uuid], { on: true }));
  }

  // smallrig.power — allumage/extinction ou réglage de luminosité (0-100), même esprit
  // que hue.color avec `on`/`brightness` mais sans couleur.
  async function power(payload = {}) {
    const lightIds = normalizeLightIds(payload.lightIds ?? payload.smallrigLightIds);
    checkLightIds(lightIds);
    const level = payload.level ?? payload.brightness;
    const on = payload.on !== false;
    await mapWithConcurrency(lightIds, requestConcurrency, (uuid) => client.setPower([uuid], { on, level: Number.isFinite(Number(level)) ? clamp(level, 0, 100, undefined) : undefined }));
    log.info('Commande alimentation envoyée', { lights: lightIds.length, on, level });
    return { lights: lightIds.length };
  }

  // smallrig.status — lecture d'état (mode courant + batterie) d'une seule lampe.
  async function status(payload = {}) {
    const uuid = String(payload.uuid || '').trim();
    if (!uuid) throw new Error('uuid manquant');
    const [lightState, capacity] = await Promise.all([
      client.readStatus(uuid).catch((err) => ({ error: err.message })),
      client.readCapacity(uuid).catch((err) => ({ error: err.message }))
    ]);
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
      'smallrig.forget': forget,
      'smallrig.list': list,
      'smallrig.color': color,
      'smallrig.power': power,
      'smallrig.status': status
    },
    healthcheck,
    stop
  };
}
