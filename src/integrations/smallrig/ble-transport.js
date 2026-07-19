// Liaison matérielle Bluetooth LE réelle, via la lib `webbluetooth` (implémentation
// Node de l'API Web Bluetooth, adaptateur natif SimpleBLE — prébuilts win32/linux/
// darwin x64+arm64, cf. package.json). Isolé du reste du code (crypto/network/
// transport/provisioning/proxy-pdu sont tous purs et testés sans matériel) : c'est ICI
// et uniquement ici que ce module dépend d'un vrai adaptateur Bluetooth actif sur la
// machine qui exécute le compagnon.
//
// [NON TESTABLE EN CI — nécessite du matériel réel] Cette couche n'a pas pu être
// validée avec de vraies lampes RM75 (aucun accès matériel dans l'environnement de
// développement). L'API webbluetooth utilisée ici (requestDevice + deviceFound +
// device._adData.serviceData, characteristic.writeValueWithoutResponse/
// startNotifications) est vérifiée contre le code source du paquet installé
// (node_modules/webbluetooth), mais le comportement réel sur lampe physique reste à
// confirmer — cf. RM75_SPEC_DEV.md §12 pour le point bloquant sur l'opcode vendor.

import { Bluetooth } from 'webbluetooth';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../logger.js';

const log = createLogger('smallrig-ble');
const SCAN_WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ble-scan-worker.js');
// Marge laissée au processus enfant au-delà du timeout de scan demandé, avant de
// considérer qu'il est bloqué et de le tuer de force (cf. scanForLampAdvertisements).
const SCAN_WORKER_KILL_GRACE_MS = 5000;

export const GATT = {
  PROVISIONING_SERVICE: 0x1827,
  PROVISIONING_DATA_IN: 0x2adb,
  PROVISIONING_DATA_OUT: 0x2adc,
  PROXY_SERVICE: 0x1828,
  PROXY_DATA_IN: 0x2add,
  PROXY_DATA_OUT: 0x2ade
};

// Taille utile par écriture GATT par défaut (MTU 23 legacy - 3 octets d'en-tête ATT).
// webbluetooth n'expose pas le MTU négocié post-connexion ; rester sur cette valeur
// conservatrice est sans risque, la segmentation Proxy PDU (proxy-pdu.js) absorbe la
// différence si le MTU réel est plus grand (juste plus de fragments que nécessaire).
export const DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH = 20;

function serviceUuidString(shortUuid) {
  return `0000${shortUuid.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

function toBuffer(dataView) {
  return Buffer.from(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}

// Scanne les lampes RM75 à proximité (provisionnées ou non) en lisant les Service Data
// publicitaires — sans jamais se connecter (§2 "Découverte"). `deviceFound` ne
// sélectionne jamais un device (retourne toujours false) : on laisse le scan courir
// `timeoutMs` et on récupère la liste complète à la fin (requestDevice rejette alors
// avec "no devices found", ce qui est le comportement normal ici, pas une erreur).
//
// Implémentation IN-PROCESS : sur certaines machines, l'appel natif sous-jacent
// (SimpleBLE -> WinRT) peut se bloquer durablement sans jamais relâcher la main
// (observé en production : CPU bas, aucune réponse). Cette fonction reste utilisée
// telle quelle par provision()/reconnexion (qui ont besoin d'un handle `device` réel,
// non sérialisable entre processus) ; l'écran "Scanner" de l'UI passe par
// `scanForLampAdvertisements` ci-dessous, qui isole cet appel dans un processus
// séparé avec un timeout dur — voir ble-scan-worker.js pour le pourquoi.
export async function scanForLampAdvertisementsInProcess({ timeoutMs = 6000, adapterIndex } = {}) {
  const found = new Map();

  const bt = new Bluetooth({
    scanTime: Math.max(1, timeoutMs / 1000),
    adapterIndex,
    deviceFound: (device) => {
      const adData = device._adData;
      const serviceData = adData?.serviceData;
      if (!serviceData) return false;

      const unprovisioned = serviceData.get(serviceUuidString(GATT.PROVISIONING_SERVICE));
      if (unprovisioned && unprovisioned.byteLength >= 16) {
        found.set(device.id, {
          bleDeviceId: device.id,
          device,
          kind: 'unprovisioned',
          deviceUuid: toBuffer(unprovisioned).subarray(0, 16),
          rssi: adData.rssi,
          name: device.name || null
        });
        return false;
      }

      const provisioned = serviceData.get(serviceUuidString(GATT.PROXY_SERVICE));
      if (provisioned && provisioned.byteLength >= 1) {
        const buf = toBuffer(provisioned);
        const isNetworkId = buf[0] === 0x00 && buf.length >= 9;
        found.set(device.id, {
          bleDeviceId: device.id,
          device,
          kind: 'provisioned',
          networkId: isNetworkId ? buf.subarray(1, 9) : null,
          rssi: adData.rssi,
          name: device.name || null
        });
      }
      return false;
    }
  });

  try {
    await bt.requestDevice({
      filters: [{ services: [GATT.PROVISIONING_SERVICE] }, { services: [GATT.PROXY_SERVICE] }]
    });
  } catch (err) {
    // "no devices found" après expiration du scan : attendu (deviceFound ne
    // sélectionne jamais). Toute autre erreur (ex. adaptateur Bluetooth absent/
    // désactivé) doit remonter.
    if (!/no devices found/i.test(String(err))) {
      log.warn('Scan BLE interrompu', String(err));
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  return [...found.values()];
}

// Scan d'affichage (bouton "Scanner" de l'UI / commande `smallrig.discover`), isolé
// dans un processus enfant dédié avec un timeout DUR (kill forcé). Un timeout côté JS
// dans CE process (Promise.race, setTimeout) ne suffirait pas : si l'appel natif
// bloque la boucle d'événements du process principal, plus rien ne s'y exécute — y
// compris les timers — et tout le compagnon (Hue/OBS/Streamer.bot inclus) resterait
// figé avec lui. En isolant l'appel, seul ce processus enfant peut se bloquer ; le
// process principal reste réactif et peut le tuer de force s'il ne répond pas à temps.
// Retourne des champs simples (deviceUuid/networkId en hex string) : le handle
// `device` natif ne survit pas au changement de processus, donc pas exploitable ici —
// provision()/reconnexion utilisent `scanForLampAdvertisementsInProcess` à la place.
//
// En pratique (testé sur cette machine avec un dongle Bluetooth réel), l'appel natif
// sous-jacent (SimpleBLE/WinRT) reste parfois bloqué de façon intermittente — pas à
// chaque scan, mais assez souvent pour être gênant. Comme un nouvel essai réussit
// généralement, on retente une fois automatiquement avant de remonter une erreur à
// l'utilisateur (double la latence dans le pire cas, mais évite un aller-retour manuel
// pour la plupart des échecs).
export async function scanForLampAdvertisements({ timeoutMs = 6000 } = {}) {
  try {
    return await scanOnceIsolated({ timeoutMs });
  } catch (err) {
    log.warn('Premier essai de scan BLE échoué, nouvelle tentative', err.message);
    // Un SIGKILL en plein appel natif ne laisse pas au processus la chance de
    // libérer proprement le radio Bluetooth côté OS ; un court délai avant de
    // retenter réduit le risque d'enchaîner sur un second échec pour la même raison.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return scanOnceIsolated({ timeoutMs });
  }
}

async function scanOnceIsolated({ timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimeout;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      child.removeAllListeners();
      try { child.kill(); } catch { /* déjà arrêté */ }
      fn(value);
    };

    const child = fork(SCAN_WORKER_PATH, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });

    hardTimeout = setTimeout(() => {
      log.warn('Scan BLE : le processus de scan ne répond pas, arrêt forcé', { timeoutMs });
      try { child.kill('SIGKILL'); } catch { /* déjà arrêté */ }
      finish(reject, new Error(
        'Le scan Bluetooth ne répond pas (adaptateur bloqué ou indisponible). '
        + 'Vérifie que le Bluetooth est bien activé, puis réessaie ; si ça persiste, redémarre le compagnon.'
      ));
    }, timeoutMs + SCAN_WORKER_KILL_GRACE_MS);

    child.on('message', (msg) => {
      if (!msg || msg.type !== 'result') return;
      if (msg.ok) finish(resolve, msg.lamps);
      else finish(reject, new Error(msg.error));
    });
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => {
      if (!settled) finish(reject, new Error(`Le processus de scan Bluetooth s'est arrêté de manière inattendue (code ${code})`));
    });

    child.send({ type: 'scan', timeoutMs });
  });
}

// Ouvre une connexion GATT vers un device déjà repéré par scanForLampAdvertisements
// (ou par un scan ciblé équivalent), sur le service Provisioning (0x1827) ou Proxy
// (0x1828), avec notifications actives sur la caractéristique Data Out.
export async function openGattConnection(device, { serviceUuid, dataInUuid, dataOutUuid, onData, maxAttributeValueLength = DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH }) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(serviceUuidString(serviceUuid));
  const dataIn = await service.getCharacteristic(serviceUuidString(dataInUuid));
  const dataOut = await service.getCharacteristic(serviceUuidString(dataOutUuid));

  const listener = () => {
    const view = dataOut.value;
    if (view) onData(toBuffer(view));
  };
  dataOut.addEventListener('characteristicvaluechanged', listener);
  await dataOut.startNotifications();

  let closed = false;
  return {
    maxAttributeValueLength,
    async write(buffer) {
      if (closed) throw new Error('Connexion GATT fermée');
      await dataIn.writeValueWithoutResponse(buffer);
    },
    close() {
      if (closed) return;
      closed = true;
      dataOut.removeEventListener('characteristicvaluechanged', listener);
      try { device.gatt.disconnect(); } catch (err) { log.warn('Erreur à la déconnexion GATT', err.message); }
    },
    get connected() {
      return !closed && device.gatt.connected;
    }
  };
}

export async function openProvisioningConnection(device, { onData } = {}) {
  return openGattConnection(device, {
    serviceUuid: GATT.PROVISIONING_SERVICE,
    dataInUuid: GATT.PROVISIONING_DATA_IN,
    dataOutUuid: GATT.PROVISIONING_DATA_OUT,
    onData
  });
}

export async function openProxyConnection(device, { onData } = {}) {
  return openGattConnection(device, {
    serviceUuid: GATT.PROXY_SERVICE,
    dataInUuid: GATT.PROXY_DATA_IN,
    dataOutUuid: GATT.PROXY_DATA_OUT,
    onData
  });
}

// Après le Provisioning Complete, la lampe passe de l'annonce 0x1827 à 0x1828 et il
// faut se reconnecter (§4 "Après le Complete"). Rescanne spécifiquement le service
// Proxy en filtrant sur le Device UUID déjà connu si possible (sinon renvoie le
// premier device Proxy vu — le mesh-client validera via le NID au déchiffrement).
export async function waitForProxyAdvertisement({ timeoutMs = 5000, retryDelayMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const found = await scanForLampAdvertisementsInProcess({ timeoutMs: Math.min(2000, deadline - Date.now()) });
      const proxy = found.filter((f) => f.kind === 'provisioned');
      if (proxy.length > 0) return proxy;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (lastError) throw lastError;
  throw new Error('Aucune lampe en mode Proxy détectée après provisioning');
}
