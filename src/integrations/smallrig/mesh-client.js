// Orchestrateur mesh : combine crypto, network-layer, transport-layer, proxy-pdu,
// provisioning et lq-protocol par-dessus le transport BLE réel (ble-transport.js) pour
// offrir une API haut niveau — scan, provisioning, configuration, envoi de commandes,
// lecture d'état — consommée par index.js (les commandes `smallrig.*`).
//
// [Couche la moins testable en CI] Contrairement aux couches en dessous (toutes pures
// et couvertes par des tests), ce module orchestre de vraies connexions GATT et n'a pu
// être exercé qu'avec 0 lampe à proximité (cf. tests/smallrig-mesh-client.test.js, qui
// couvre uniquement la logique pure injectable — sélection de candidats, files
// d'attente de réassemblage). La validation avec du matériel réel reste à faire par
// l'utilisateur (RM75_SPEC_DEV.md §12, en particulier le point 1 sur l'opcode vendor).

import { createLogger } from '../../logger.js';
import {
  CONFIG_OPCODE,
  decodeAccessOpcode,
  decodeAppKeyStatus,
  decodeModelAppStatus,
  encodeAppKeyAdd,
  encodeCompositionDataGet,
  encodeModelAppBind,
  parseCompositionDataPage0
} from './config-messages.js';
import {
  decryptNetworkPdu,
  deriveNetworkKeys,
  encryptNetworkPdu
} from './network-layer.js';
import {
  createProxyPduReassembler,
  encodeProxyPdus,
  PROXY_PDU_TYPE
} from './proxy-pdu.js';
import { runProvisioning } from './provisioning.js';
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
} from './transport-layer.js';
import {
  buildVendorAccessPayload,
  decodeCapacity,
  decodeStatus,
  decodeVersion,
  encodeCapacityRead,
  encodeCct,
  encodeFx,
  encodeHsi,
  encodeLumLevel,
  encodeLumOff,
  encodeLumOn,
  encodeRgbw,
  encodeStatusRead,
  encodeVersionRead,
  VENDOR_CID
} from './lq-protocol.js';
import {
  addNode,
  allocateUnicastAddress,
  appKeyBuffer,
  ensureNetworkKeys,
  findNode,
  netKeyBuffer,
  nextSeq,
  nodeDeviceKeyBuffer,
  removeNode
} from './mesh-store.js';

const log = createLogger('smallrig-mesh');

const VENDOR_MODEL_ID = 0x0004005d; // MESH_MODEL_DATATRANS_SERVER
const DEFAULT_TTL = 5;
const CONFIG_RESPONSE_TIMEOUT_MS = 8000;
const COMMAND_RESPONSE_TIMEOUT_MS = 5000;

function createAsyncQueue() {
  const items = [];
  const waiters = [];
  return {
    push(value) {
      if (waiters.length) waiters.shift().resolve(value);
      else items.push(value);
    },
    async shift(timeoutMs) {
      if (items.length) return items.shift();
      return new Promise((resolve, reject) => {
        const waiter = { resolve };
        waiters.push(waiter);
        if (timeoutMs) {
          setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx !== -1) {
              waiters.splice(idx, 1);
              reject(new Error('Délai dépassé en attente de réponse'));
            }
          }, timeoutMs);
        }
      });
    }
  };
}

// Une session Proxy GATT ouverte vers N'IMPORTE QUEL nœud du mesh suffit à atteindre
// TOUS les nœuds (relayage mesh standard, cf. RM75_SPEC_DEV.md §10) : on ne maintient
// qu'une seule connexion active à la fois, réutilisée pour toutes les commandes.
function createProxySession({ conn, netKeys, ivIndex, provisionerAddress }) {
  const reassembler = createProxyPduReassembler();
  const segmentBuffers = new Map(); // srcAddr -> { segO0Seq, segments: [] }
  const inbox = new Map(); // srcAddr -> asyncQueue of decoded { seq, akf, aid, accessPayload }

  function inboxFor(src) {
    if (!inbox.has(src)) inbox.set(src, createAsyncQueue());
    return inbox.get(src);
  }

  function handleNetworkPdu(pdu) {
    let decoded;
    try {
      decoded = decryptNetworkPdu({ ...netKeys, ivIndex, pdu });
    } catch (err) {
      if (err.code !== 'UNKNOWN_NID') log.warn('Network PDU ignoré (déchiffrement)', err.message);
      return;
    }
    if (decoded.dst !== provisionerAddress) return; // pas pour nous (autre unicast/groupe)

    const seg = (decoded.transportPdu[0] >> 7) & 1;
    if (seg === 0) {
      const { akf, aid, upperTransportPdu } = decodeLowerTransportUnsegmented(decoded.transportPdu);
      inboxFor(decoded.src).push({ seq: decoded.seq, akf, aid, upperTransportPdu });
      return;
    }

    const header = decodeSegmentHeader(decoded.transportPdu);
    const key = `${decoded.src}:${header.seqZero}`;
    let buf = segmentBuffers.get(key);
    if (!buf) {
      buf = { segments: [] };
      segmentBuffers.set(key, buf);
    }
    if (header.segO === 0) buf.segO0Seq = decoded.seq;
    buf.segments.push(header);

    if (buf.segments.length === header.segN + 1) {
      segmentBuffers.delete(key);
      try {
        const { akf, aid, upperTransportPdu } = reassembleSegments(buf.segments);
        inboxFor(decoded.src).push({ seq: buf.segO0Seq, akf, aid, upperTransportPdu });
      } catch (err) {
        log.warn('Réassemblage de segments échoué', err.message);
      }
    }
  }

  function feed(bytes) {
    const msg = reassembler.feed(bytes);
    if (msg && msg.type === PROXY_PDU_TYPE.NETWORK) handleNetworkPdu(msg.data);
  }

  async function sendNetworkPdu(networkPdu) {
    const fragments = encodeProxyPdus(PROXY_PDU_TYPE.NETWORK, networkPdu, { maxAttributeValueLength: conn.maxAttributeValueLength });
    for (const fragment of fragments) await conn.write(fragment);
  }

  // Envoie un Access Payload en clair, chiffré ici (AppKey ou DevKey), segmenté si
  // nécessaire, et transmis comme un ou plusieurs Network PDU.
  async function send({ seqAllocator, ttl = DEFAULT_TTL, src, dst, key, keyType, aid, accessPayload }) {
    const { seq: firstSeq, crossedBoundary } = nextSeq(seqAllocator.state, seqAllocator.blockSize);
    if (crossedBoundary && seqAllocator.onPersistNeeded) await seqAllocator.onPersistNeeded();

    const upperTransportPdu = encryptUpperTransportAccess({ key, keyType, seq: firstSeq, src, dst, ivIndex, accessPayload });

    if (accessPayload.length <= UNSEGMENTED_MAX_ACCESS_LENGTH) {
      const transportPdu = encodeLowerTransportUnsegmented({ akf: keyType === 'app', aid, upperTransportPdu });
      const networkPdu = encryptNetworkPdu({ ...netKeys, ivi: ivIndex & 1, ivIndex, ctl: false, ttl, seq: firstSeq, src, dst, transportPdu });
      await sendNetworkPdu(networkPdu);
      return;
    }

    const seqZero = firstSeq & 0x1fff;
    const segments = segmentUpperTransportPdu({ akf: keyType === 'app', aid, seqZero, szmic: false, upperTransportPdu });
    for (let i = 0; i < segments.length; i++) {
      let seq = firstSeq;
      if (i > 0) {
        const allocated = nextSeq(seqAllocator.state, seqAllocator.blockSize);
        seq = allocated.seq;
        if (allocated.crossedBoundary && seqAllocator.onPersistNeeded) await seqAllocator.onPersistNeeded();
      }
      const networkPdu = encryptNetworkPdu({ ...netKeys, ivi: ivIndex & 1, ivIndex, ctl: false, ttl, seq, src, dst, transportPdu: segments[i] });
      await sendNetworkPdu(networkPdu);
    }
  }

  async function receiveFrom(src, { timeoutMs = COMMAND_RESPONSE_TIMEOUT_MS } = {}) {
    const { seq, upperTransportPdu, keyType } = await (async () => {
      const msg = await inboxFor(src).shift(timeoutMs);
      return { ...msg, keyType: msg.akf ? 'app' : 'device' };
    })();
    return { seq, upperTransportPdu, keyType, aid: undefined };
  }

  return { feed, send, receiveFrom, get connected() { return conn.connected; }, close: () => conn.close() };
}

export function createMeshClient({
  getState,
  persistState,
  scanForLampAdvertisements,
  // Scan utilisé UNIQUEMENT par discover() (bouton "Scanner" de l'UI, affichage pur —
  // pas de connexion GATT derrière). Peut être isolé dans un processus séparé
  // (cf. ble-transport.js#scanForLampAdvertisements côté isolé) sans casser
  // provision()/ensureProxySession(), qui ont besoin d'un handle `device` réel pour se
  // connecter et continuent donc à utiliser `scanForLampAdvertisements` (in-process).
  // Retombe sur `scanForLampAdvertisements` si non fourni (rétrocompatible).
  scanForDisplay,
  openProvisioningConnection,
  openProxyConnection,
  waitForProxyAdvertisement,
  vendorOpcodeMode = 'A',
  seqBlockSize = 100,
  provisionerAddress: forcedProvisionerAddress
}) {
  const scanForDisplayFn = scanForDisplay || scanForLampAdvertisements;
  let proxySession = null;
  let proxyConn = null;

  function seqAllocator() {
    const state = getState();
    return { state, blockSize: seqBlockSize, onPersistNeeded: persistState ? () => persistState(state) : null };
  }

  function netKeysFor(state) {
    return deriveNetworkKeys(netKeyBuffer(state));
  }

  async function closeProxy() {
    if (proxyConn) { try { proxyConn.close(); } catch { /* déjà fermé */ } }
    proxyConn = null;
    proxySession = null;
  }

  async function ensureProxySession() {
    const state = getState();
    if (proxySession?.connected) return proxySession;
    await closeProxy();

    if (state.nodes.length === 0) throw new Error('Aucune lampe provisionnée');
    const netKeys = netKeysFor(state);

    const candidates = await scanForLampAdvertisements({ timeoutMs: 5000 });
    const proxyCandidates = candidates.filter((c) => c.kind === 'provisioned'
      && (!c.networkId || c.networkId.equals(netKeys.networkId)));
    if (proxyCandidates.length === 0) throw new Error('Aucune lampe SmallRig joignable en Bluetooth à proximité');

    let lastError;
    for (const candidate of proxyCandidates) {
      try {
        const sessionRef = { feed: () => {} };
        const conn = await openProxyConnection(candidate.device, { onData: (bytes) => sessionRef.feed(bytes) });
        const session = createProxySession({
          conn,
          netKeys,
          ivIndex: state.ivIndex,
          provisionerAddress: forcedProvisionerAddress ?? state.provisionerAddress
        });
        sessionRef.feed = session.feed;
        proxyConn = conn;
        proxySession = session;
        return session;
      } catch (err) {
        lastError = err;
        log.warn('Connexion Proxy échouée sur un candidat, essai suivant', err.message);
      }
    }
    throw lastError || new Error('Connexion Proxy impossible');
  }

  // --- Découverte -----------------------------------------------------------------

  // deviceUuid/networkId arrivent en Buffer (scan in-process) ou en hex string (scan
  // isolé dans un processus séparé, cf. ble-transport.js) — on normalise en string.
  function toHex(value) {
    if (!value) return null;
    return Buffer.isBuffer(value) ? value.toString('hex') : String(value);
  }

  async function discover({ timeoutMs = 6000 } = {}) {
    const state = getState();
    const netKeys = state.netKey ? netKeysFor(state) : null;
    const ourNetworkIdHex = netKeys ? toHex(netKeys.networkId) : null;
    const found = await scanForDisplayFn({ timeoutMs });

    return found.map((f) => {
      if (f.kind === 'unprovisioned') {
        return { bleDeviceId: f.bleDeviceId, kind: 'unprovisioned', deviceUuid: toHex(f.deviceUuid), rssi: f.rssi, name: f.name };
      }
      const isOurs = Boolean(ourNetworkIdHex && f.networkId && toHex(f.networkId) === ourNetworkIdHex);
      return { bleDeviceId: f.bleDeviceId, kind: 'provisioned', ours: isOurs, rssi: f.rssi, name: f.name };
    });
  }

  // --- Provisioning -----------------------------------------------------------------

  async function provision({ bleDeviceId, name, attentionDurationS = 0 } = {}) {
    const state = getState();
    ensureNetworkKeys(state);
    if (persistState) await persistState(state);

    const found = await scanForLampAdvertisements({ timeoutMs: 6000 });
    const target = found.find((f) => f.bleDeviceId === bleDeviceId && f.kind === 'unprovisioned');
    if (!target) throw new Error('Lampe introuvable (relancez une découverte, elle est peut-être hors de portée ou déjà provisionnée)');

    await closeProxy(); // libère l'adaptateur pour la connexion de provisioning

    const reassembler = createProxyPduReassembler();
    const pending = createAsyncQueue();
    const conn = await openProvisioningConnection(target.device, {
      onData: (bytes) => {
        const msg = reassembler.feed(bytes);
        if (msg && msg.type === PROXY_PDU_TYPE.PROVISIONING) pending.push(msg.data);
      }
    });

    const transport = {
      async send(type, params) {
        const data = Buffer.concat([Buffer.from([type]), params]);
        const fragments = encodeProxyPdus(PROXY_PDU_TYPE.PROVISIONING, data, { maxAttributeValueLength: conn.maxAttributeValueLength });
        for (const fragment of fragments) await conn.write(fragment);
      },
      async receive(expectedType) {
        const raw = await pending.shift(CONFIG_RESPONSE_TIMEOUT_MS);
        const type = raw[0];
        if (type !== expectedType) throw new Error(`Provisioning : type inattendu (attendu ${expectedType}, reçu ${type})`);
        return raw.subarray(1);
      }
    };

    let result;
    try {
      result = await runProvisioning({
        transport,
        netKey: netKeyBuffer(state),
        keyIndex: 0,
        ivIndex: state.ivIndex,
        unicastAddress: (capabilities) => allocateUnicastAddress(state, Math.max(1, capabilities.numElements)),
        attentionDurationS
      });
    } finally {
      conn.close();
    }

    const node = addNode(state, {
      uuid: target.deviceUuid.toString('hex'),
      name: name || null,
      unicastAddress: result.unicastAddress,
      elementCount: result.numElements,
      deviceKey: result.deviceKey
    });
    if (persistState) await persistState(state);

    // La lampe bascule 0x1827 -> 0x1828 après le Complete (§4) : laisse-lui le temps
    // puis configure (AppKey Add + Model App Bind), condition nécessaire pour que les
    // commandes de contrôle soient acceptées (§8).
    try {
      await configureNode(node);
    } catch (err) {
      log.warn('Configuration post-provisioning échouée (la lampe est provisionnée mais pas encore configurée)', err.message);
      throw new Error(`Lampe provisionnée mais configuration échouée : ${err.message}`);
    }

    return { uuid: node.uuid, name: node.name, unicastAddress: node.unicastAddress, elementCount: node.elementCount };
  }

  async function forget({ uuid } = {}) {
    const state = getState();
    const removed = removeNode(state, uuid);
    if (removed && persistState) await persistState(state);
    await closeProxy(); // le nœud oublié ne doit plus être utilisé comme proxy
    return { removed };
  }

  // --- Configuration post-provisioning (§8) -----------------------------------------

  async function configureNode(node) {
    const state = getState();
    const netKeys = netKeysFor(state);
    const devKey = nodeDeviceKeyBuffer(node);

    // Reconnexion en mode Proxy (0x1828), après le délai de bascule du firmware.
    const proxyLampCandidates = await waitForProxyAdvertisement({ timeoutMs: 6000 });
    const target = proxyLampCandidates[0];
    const sessionRef = { feed: () => {} };
    const conn = await openProxyConnection(target.device, { onData: (bytes) => sessionRef.feed(bytes) });
    const session = createProxySession({
      conn, netKeys, ivIndex: state.ivIndex, provisionerAddress: state.provisionerAddress
    });
    sessionRef.feed = session.feed;

    try {
      const allocator = seqAllocator();
      const src = state.provisionerAddress;
      const dst = node.unicastAddress;

      async function sendConfig(accessPayload) {
        await session.send({ seqAllocator: allocator, src, dst, key: devKey, keyType: 'device', aid: 0, accessPayload });
      }
      async function receiveConfig() {
        const { upperTransportPdu, keyType, seq } = await session.receiveFrom(dst, { timeoutMs: CONFIG_RESPONSE_TIMEOUT_MS });
        const accessPayload = decryptUpperTransportAccess({ key: devKey, keyType, seq, src: dst, dst: src, ivIndex: state.ivIndex, encAccessPayload: upperTransportPdu });
        return decodeAccessOpcode(accessPayload);
      }

      await sendConfig(encodeCompositionDataGet(0));
      const compositionResponse = await receiveConfig();
      if (compositionResponse.opcode === CONFIG_OPCODE.COMPOSITION_DATA_STATUS) {
        try {
          const parsed = parseCompositionDataPage0(compositionResponse.params);
          const hasVendorModel = parsed.elements.some((e) => e.vendorModels.includes(VENDOR_MODEL_ID));
          if (!hasVendorModel) log.warn('Vendor model DATATRANS_SERVER absent de la Composition Data (§12 point 4)', { uuid: node.uuid });
        } catch (err) {
          log.warn('Analyse Composition Data impossible (non bloquant)', err.message);
        }
      }

      const appKey = appKeyBuffer(state);
      await sendConfig(encodeAppKeyAdd({ netKeyIndex: 0, appKeyIndex: 0, appKey }));
      const appKeyStatusResponse = await receiveConfig();
      const appKeyStatus = decodeAppKeyStatus(appKeyStatusResponse.params);
      if (!appKeyStatus.ok) throw new Error(`App Key Add refusé (status ${appKeyStatus.status})`);

      await sendConfig(encodeModelAppBind({ elementAddress: node.unicastAddress, appKeyIndex: 0, modelId: VENDOR_MODEL_ID, isVendorModel: true }));
      const modelAppStatusResponse = await receiveConfig();
      const modelAppStatus = decodeModelAppStatus(modelAppStatusResponse.params);
      if (!modelAppStatus.ok) throw new Error(`Model App Bind refusé (status ${modelAppStatus.status})`);

      log.info('Nœud configuré (AppKey + Model App Bind)', { uuid: node.uuid, address: node.unicastAddress });
    } finally {
      conn.close();
    }
  }

  // --- Commandes de contrôle (Lq, §9) -----------------------------------------------

  async function sendLqToNode(node, lqFrame) {
    const state = getState();
    const session = await ensureProxySession();
    const appKey = appKeyBuffer(state);
    const aid = deriveAppKeyAid(appKey);
    const accessPayload = buildVendorAccessPayload(lqFrame, { vendorOpcodeMode, cid: VENDOR_CID });
    await session.send({
      seqAllocator: seqAllocator(),
      src: forcedProvisionerAddress ?? state.provisionerAddress,
      dst: node.unicastAddress,
      key: appKey,
      keyType: 'app',
      aid,
      accessPayload
    });
  }

  async function readLqFromNode(node, readFrame) {
    const state = getState();
    const session = await ensureProxySession();
    const appKey = appKeyBuffer(state);
    const aid = deriveAppKeyAid(appKey);
    const src = forcedProvisionerAddress ?? state.provisionerAddress;
    const accessPayload = buildVendorAccessPayload(readFrame, { vendorOpcodeMode, cid: VENDOR_CID });

    await session.send({ seqAllocator: seqAllocator(), src, dst: node.unicastAddress, key: appKey, keyType: 'app', aid, accessPayload });
    const { upperTransportPdu, keyType, seq } = await session.receiveFrom(node.unicastAddress, { timeoutMs: COMMAND_RESPONSE_TIMEOUT_MS });
    const decrypted = decryptUpperTransportAccess({ key: appKey, keyType, seq, src: node.unicastAddress, dst: src, ivIndex: state.ivIndex, encAccessPayload: upperTransportPdu });
    const { params } = decodeAccessOpcode(decrypted);
    return params;
  }

  function resolveNodes(uuids) {
    const state = getState();
    const nodes = uuids.map((uuid) => findNode(state, uuid)).filter(Boolean);
    if (nodes.length === 0) throw new Error('Aucune lampe cible connue (uuid inconnu ou non provisionnée)');
    return nodes;
  }

  async function forEachNode(uuids, fn) {
    const nodes = resolveNodes(uuids);
    const results = [];
    for (const node of nodes) {
      try {
        results.push({ uuid: node.uuid, ok: true, result: await fn(node) });
      } catch (err) {
        results.push({ uuid: node.uuid, ok: false, error: err.message });
      }
    }
    return results;
  }

  async function setHsi(uuids, { hue, sat, intensity }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, encodeHsi({ hue, sat, intensity })));
  }

  async function setCct(uuids, { kelvin, intensity, gm }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, encodeCct({ kelvin, intensity, gm })));
  }

  async function setRgbw(uuids, { r, g, b, w }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, encodeRgbw({ r, g, b, w })));
  }

  async function setFx(uuids, { mode, param1, param2 }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, encodeFx({ mode, param1, param2 })));
  }

  async function setPower(uuids, { on, level }) {
    return forEachNode(uuids, (node) => sendLqToNode(node, Number.isFinite(level) ? encodeLumLevel(level) : (on ? encodeLumOn() : encodeLumOff())));
  }

  async function readStatus(uuid) {
    const [node] = resolveNodes([uuid]);
    const params = await readLqFromNode(node, encodeStatusRead());
    return decodeStatus(params);
  }

  async function readCapacity(uuid) {
    const [node] = resolveNodes([uuid]);
    const params = await readLqFromNode(node, encodeCapacityRead());
    return decodeCapacity(params);
  }

  async function readVersion(uuid) {
    const [node] = resolveNodes([uuid]);
    const params = await readLqFromNode(node, encodeVersionRead());
    return decodeVersion(params);
  }

  function listNodes() {
    return getState().nodes.map((n) => ({ uuid: n.uuid, name: n.name, unicastAddress: n.unicastAddress }));
  }

  async function healthcheck() {
    const state = getState();
    return { paired: state.nodes.length > 0, lamps: state.nodes.length, proxyConnected: Boolean(proxySession?.connected) };
  }

  async function stop() {
    await closeProxy();
  }

  return {
    discover, provision, forget, configureNode, listNodes,
    setHsi, setCct, setRgbw, setFx, setPower,
    readStatus, readCapacity, readVersion,
    healthcheck, stop
  };
}
