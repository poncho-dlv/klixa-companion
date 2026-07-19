import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeshClient } from '../src/integrations/smallrig/mesh-client.js';
import { createEmptyMeshState, serializeMeshState } from '../src/integrations/smallrig/mesh-store.js';
import { deriveNetworkKeys, decryptNetworkPdu, encryptNetworkPdu } from '../src/integrations/smallrig/network-layer.js';
import {
  decodeLowerTransportUnsegmented,
  decodeSegmentHeader,
  decryptUpperTransportAccess,
  deriveAppKeyAid,
  encodeLowerTransportUnsegmented,
  encryptUpperTransportAccess,
  reassembleSegments,
  segmentUpperTransportPdu,
  UNSEGMENTED_MAX_ACCESS_LENGTH
} from '../src/integrations/smallrig/transport-layer.js';
import { createProxyPduReassembler, encodeProxyPdus, PROXY_PDU_TYPE } from '../src/integrations/smallrig/proxy-pdu.js';
import { simulateDeviceSide } from '../src/integrations/smallrig/provisioning.js';
import { decodeAccessOpcode, CONFIG_OPCODE, encodeConfigOpcode } from '../src/integrations/smallrig/config-messages.js';
import { VENDOR_CID } from '../src/integrations/smallrig/lq-protocol.js';

// Simulateur minimal de firmware RM75 : implémente le rôle "device" du provisioning
// (déjà couvert par simulateDeviceSide) PUIS le rôle "nœud mesh" côté Proxy — répond
// aux messages de configuration (§8) et aux commandes Lq (§9). Réutilise les mêmes
// couches pures (network-layer/transport-layer/proxy-pdu) que le mesh-client réel :
// c'est légitime ici car ce qui est testé est l'ORCHESTRATION de mesh-client.js (bon
// enchaînement, bon adressage, bon opcode), pas la crypto elle-même (déjà validée
// indépendamment par les autres suites de tests).
function createFakeLamp({ deviceUuid, capabilities = { numElements: 1, algorithms: 1, publicKeyType: 0, staticOobType: 0, outputOobSize: 0, outputOobAction: 0, inputOobSize: 0, inputOobAction: 0 } }) {
  const state = { provisioned: false, deviceKey: null, unicastAddress: null, netKey: null, appKey: null, boundModel: false };
  let onFragmentToProvisioner = null;
  let reassembler = null;

  function makeProvisioningTransport() {
    const incoming = [];
    const waiters = [];
    return {
      pushIncoming(msg) {
        if (waiters.length) waiters.shift()(msg);
        else incoming.push(msg);
      },
      async send(type, params) {
        const data = Buffer.concat([Buffer.from([type]), params]);
        for (const fragment of encodeProxyPdus(PROXY_PDU_TYPE.PROVISIONING, data, { maxAttributeValueLength: 20 })) {
          onFragmentToProvisioner(fragment);
        }
      },
      async receive(expectedType) {
        const raw = incoming.length ? incoming.shift() : await new Promise((resolve) => waiters.push(resolve));
        const type = raw[0];
        if (type !== expectedType) throw new Error(`Device : type inattendu (attendu ${expectedType}, reçu ${type})`);
        return raw.subarray(1);
      }
    };
  }

  let provisioningTransport;

  return {
    deviceUuid,
    get kind() { return state.provisioned ? 'provisioned' : 'unprovisioned'; },
    get networkId() { return state.netKey ? deriveNetworkKeys(state.netKey).networkId : null; },

    // --- Lien de provisioning (0x1827) ---
    openProvisioningLink(onData) {
      onFragmentToProvisioner = onData;
      reassembler = createProxyPduReassembler();
      provisioningTransport = makeProvisioningTransport();

      simulateDeviceSide({ transport: provisioningTransport, capabilities }).then(({ deviceKey, provisioningData }) => {
        state.deviceKey = deviceKey;
        state.unicastAddress = provisioningData.unicastAddress;
        state.netKey = provisioningData.netKey;
        state.provisioned = true;
      }).catch((err) => { state.provisionError = err; });

      return {
        write: async (fragment) => {
          const msg = reassembler.feed(fragment);
          if (msg && msg.type === PROXY_PDU_TYPE.PROVISIONING) provisioningTransport.pushIncoming(msg.data);
        },
        close: () => {},
        maxAttributeValueLength: 20
      };
    },

    // --- Lien Proxy (0x1828) ---
    openProxyLink(onData) {
      const proxyReassembler = createProxyPduReassembler();
      const segmentBuffers = new Map();

      const sendNetworkPdu = (transportPdu, { ctl = false, seq }) => {
        const netKeys = deriveNetworkKeys(state.netKey);
        const pdu = encryptNetworkPdu({ ...netKeys, ivi: 0, ivIndex: 0, ctl, ttl: 5, seq, src: state.unicastAddress, dst: 0x0001, transportPdu });
        for (const fragment of encodeProxyPdus(PROXY_PDU_TYPE.NETWORK, pdu, { maxAttributeValueLength: 20 })) onData(fragment);
      };

      let replySeq = 500; // compteur SEQ indépendant côté firmware simulé

      const handleAccessMessage = ({ akf, accessPayload }) => {
        if (!akf) {
          // Message de configuration (DevKey)
          const { opcode, params } = decodeAccessOpcode(accessPayload);
          let replyPayload;
          if (opcode === CONFIG_OPCODE.COMPOSITION_DATA_GET) {
            // Compose une Composition Data Status volontairement > 11 octets pour
            // exercer la réassemblage en réception (segmentation, cf. transport-layer).
            // Page(1) + CID(2 LE) + PID(2 LE) + VID(2 LE) + CRPL(2 LE) + Features(2 LE) = 11 octets
            const header = Buffer.from([0x00, 0x5d, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
            const element = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x5d, 0x00, 0x04, 0x00]);
            replyPayload = Buffer.concat([encodeConfigOpcode(CONFIG_OPCODE.COMPOSITION_DATA_STATUS), header, element]);
          } else if (opcode === CONFIG_OPCODE.APP_KEY_ADD) {
            state.appKey = params.subarray(3, 19);
            replyPayload = Buffer.concat([encodeConfigOpcode(CONFIG_OPCODE.APP_KEY_STATUS), Buffer.from([0x00]), params.subarray(0, 3)]);
          } else if (opcode === CONFIG_OPCODE.MODEL_APP_BIND) {
            state.boundModel = true;
            replyPayload = Buffer.concat([encodeConfigOpcode(CONFIG_OPCODE.MODEL_APP_STATUS), Buffer.from([0x00]), params.subarray(0, 8)]);
          } else {
            return;
          }
          const enc = encryptUpperTransportAccess({ key: state.deviceKey, keyType: 'device', seq: replySeq, src: state.unicastAddress, dst: 0x0001, ivIndex: 0, accessPayload: replyPayload });
          if (replyPayload.length <= UNSEGMENTED_MAX_ACCESS_LENGTH) {
            sendNetworkPdu(encodeLowerTransportUnsegmented({ akf: false, aid: 0, upperTransportPdu: enc }), { seq: replySeq });
            replySeq += 1;
          } else {
            const seqZero = replySeq & 0x1fff;
            const segments = segmentUpperTransportPdu({ akf: false, aid: 0, seqZero, szmic: false, upperTransportPdu: enc });
            for (const seg of segments) { sendNetworkPdu(seg, { seq: replySeq }); replySeq += 1; }
          }
          return;
        }

        // Message applicatif (AppKey) : commande Lq vendor
        const decoded = decodeAccessOpcode(accessPayload);
        if (!decoded.isVendor || decoded.vendorCid !== VENDOR_CID) return;
        state.lastLqFrame = decoded.params; // trame Lq brute reçue (sans l'opcode vendor)

        // Réponse uniquement pour STATUS (0x43) : renvoie un statut HSI fixe pour le test.
        if (decoded.params[0] === 0x43) {
          const values = [0x00, 0x00, 0x64, 0x64];
          const xor = values.reduce((a, b) => a ^ b, 0);
          const statusFrame = Buffer.from([3, values.length, xor, ...values]);
          const vendorReply = Buffer.concat([Buffer.from([0xe4, VENDOR_CID & 0xff, (VENDOR_CID >> 8) & 0xff]), statusFrame]);
          const aid = deriveAppKeyAid(state.appKey);
          const enc = encryptUpperTransportAccess({ key: state.appKey, keyType: 'app', seq: replySeq, src: state.unicastAddress, dst: 0x0001, ivIndex: 0, accessPayload: vendorReply });
          sendNetworkPdu(encodeLowerTransportUnsegmented({ akf: true, aid, upperTransportPdu: enc }), { seq: replySeq });
          replySeq += 1;
        }
      };

      return {
        write: async (fragment) => {
          const msg = proxyReassembler.feed(fragment);
          if (!msg || msg.type !== PROXY_PDU_TYPE.NETWORK) return;
          const netKeys = deriveNetworkKeys(state.netKey);
          const decoded = decryptNetworkPdu({ ...netKeys, ivIndex: 0, pdu: msg.data });
          if (decoded.dst !== state.unicastAddress) return;

          const seg = (decoded.transportPdu[0] >> 7) & 1;
          if (seg === 0) {
            const { akf, upperTransportPdu } = decodeLowerTransportUnsegmented(decoded.transportPdu);
            const keyType = akf ? 'app' : 'device';
            const key = akf ? state.appKey : state.deviceKey;
            const accessPayload = decryptUpperTransportAccess({ key, keyType, seq: decoded.seq, src: decoded.src, dst: decoded.dst, ivIndex: 0, encAccessPayload: upperTransportPdu });
            handleAccessMessage({ akf, accessPayload });
            return;
          }

          const header = decodeSegmentHeader(decoded.transportPdu);
          const key = `${header.seqZero}`;
          let buf = segmentBuffers.get(key);
          if (!buf) { buf = { segments: [] }; segmentBuffers.set(key, buf); }
          if (header.segO === 0) buf.segO0Seq = decoded.seq;
          buf.segments.push(header);
          if (buf.segments.length === header.segN + 1) {
            segmentBuffers.delete(key);
            const { akf, upperTransportPdu } = reassembleSegments(buf.segments);
            const keyType = akf ? 'app' : 'device';
            const key2 = akf ? state.appKey : state.deviceKey;
            const accessPayload = decryptUpperTransportAccess({ key: key2, keyType, seq: buf.segO0Seq, src: decoded.src, dst: decoded.dst, ivIndex: 0, encAccessPayload: upperTransportPdu });
            handleAccessMessage({ akf, accessPayload });
          }
        },
        close: () => {},
        get connected() { return true; },
        maxAttributeValueLength: 20
      };
    },

    _state: state
  };
}

test('mesh-client : découverte, provisioning, configuration et commande HSI de bout en bout (firmware simulé)', async () => {
  const lamp = createFakeLamp({ deviceUuid: Buffer.alloc(16, 0x42) });
  const persisted = [];

  // getState()/persistState() doivent partager le MÊME objet mutable entre appels au
  // sein d'une opération (ex. ensureNetworkKeys puis addNode dans provision()).
  let liveState = createEmptyMeshState();
  const client = createMeshClient({
    getState: () => liveState,
    persistState: async (state) => { liveState = state; persisted.push(serializeMeshState(state)); },
    scanForLampAdvertisements: async () => {
      if (lamp.kind === 'unprovisioned') {
        return [{ bleDeviceId: 'lamp-1', kind: 'unprovisioned', deviceUuid: lamp.deviceUuid, device: lamp, rssi: -50, name: null }];
      }
      return [{ bleDeviceId: 'lamp-1', kind: 'provisioned', networkId: lamp.networkId, device: lamp, rssi: -50, name: null }];
    },
    openProvisioningConnection: async (device, { onData }) => device.openProvisioningLink(onData),
    openProxyConnection: async (device, { onData }) => device.openProxyLink(onData),
    waitForProxyAdvertisement: async () => [{ bleDeviceId: 'lamp-1', kind: 'provisioned', device: lamp }]
  });

  const discovered = await client.discover({ timeoutMs: 100 });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].kind, 'unprovisioned');

  const provisioned = await client.provision({ bleDeviceId: 'lamp-1', name: 'Lampe test' });
  assert.equal(provisioned.name, 'Lampe test');
  assert.equal(lamp._state.provisioned, true);
  assert.equal(lamp._state.boundModel, true);
  assert.ok(lamp._state.appKey, 'AppKey doit avoir été transmise pendant la configuration');
  assert.ok(persisted.length >= 2, 'l\'état doit avoir été persisté (clés générées + nœud ajouté)');

  const results = await client.setHsi([provisioned.uuid], { hue: 0, sat: 100, intensity: 100 });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.ok(lamp._state.lastLqFrame, 'la lampe doit avoir reçu une trame Lq');
  assert.equal(lamp._state.lastLqFrame[0], 0x33); // opcode HSI
  assert.deepEqual([...lamp._state.lastLqFrame.subarray(3)], [0x00, 0x00, 0x64, 0x64]); // hue=0, sat=100, int=100

  const status = await client.readStatus(provisioned.uuid);
  assert.deepEqual(status, { type: 'hsi', hue: 0, sat: 0x64, intensity: 0x64 });

  await client.stop();
});
