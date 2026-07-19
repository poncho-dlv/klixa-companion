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
import { createLogger } from '../../logger.js';

const log = createLogger('smallrig-ble');

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
export async function scanForLampAdvertisements({ timeoutMs = 6000, adapterIndex } = {}) {
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
      const found = await scanForLampAdvertisements({ timeoutMs: Math.min(2000, deadline - Date.now()) });
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
