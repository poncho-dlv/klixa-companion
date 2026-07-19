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
function createProxySession({ conn, netKeys, ivIndex, provisionerAddress, seqAllocatorFactory }) {
  const reassembler = createProxyPduReassembler();
  const segmentBuffers = new Map(); // srcAddr:seqZero -> { segments: Map<segO, header>, seqAuth, createdAt }
  const completedSegmented = new Map(); // srcAddr:seqZero -> { segN } — pour ré-acquitter les retransmissions
  const inbox = new Map(); // srcAddr -> asyncQueue of decoded { seq, akf, aid, szmic, upperTransportPdu }
  // Les fragments SAR d'un même Proxy PDU ne doivent jamais être entrelacés avec ceux
  // d'un autre message (§2). Or index.js pilote plusieurs lampes en concurrence sur
  // CETTE session partagée, et avec le MTU par défaut chaque Network PDU part en
  // plusieurs fragments : sans sérialisation, deux send() simultanés s'entrelacent aux
  // points d'await et la lampe jette les deux messages. Toutes les écritures d'un
  // Network PDU passent donc par cette chaîne pour rester atomiques.
  let writeChain = Promise.resolve();

  function inboxFor(src) {
    if (!inbox.has(src)) inbox.set(src, createAsyncQueue());
    return inbox.get(src);
  }

  // SeqAuth (le SEQ entrant dans le nonce des messages segmentés) se dérive de SeqZero
  // et du SEQ d'un segment reçu — PAS le SEQ brut du segment segO=0, qui peut être une
  // retransmission portant un SEQ plus récent que l'original.
  function seqAuthFrom(seq, seqZero) {
    let auth = (seq & ~0x1fff) | seqZero;
    if (auth > seq) auth -= 0x2000;
    return auth;
  }

  function rememberCompleted(key, segN) {
    completedSegmented.set(key, { segN });
    if (completedSegmented.size > 16) completedSegmented.delete(completedSegmented.keys().next().value);
  }

  // Segment Acknowledgement (message de contrôle, opcode 0x00) — exigé par la spec
  // pour tout message segmenté reçu (§6) : sans lui, l'émetteur retransmet en boucle
  // puis finit par considérer l'envoi comme échoué.
  function buildSegmentAck({ seqZero, segN }) {
    const blockAck = (segN >= 31 ? 0xffffffff : (1 << (segN + 1)) - 1) >>> 0;
    return Buffer.from([
      0x00, // SEG=0 | opcode de contrôle 0x00 (Segment Acknowledgement)
      (seqZero >> 6) & 0x7f, // OBO=0 | SeqZero[12:6]
      (seqZero & 0x3f) << 2, // SeqZero[5:0] | RFU
      (blockAck >>> 24) & 0xff, (blockAck >>> 16) & 0xff, (blockAck >>> 8) & 0xff, blockAck & 0xff
    ]);
  }

  async function sendSegmentAck({ dst, seqZero, segN }) {
    if (!seqAllocatorFactory) return;
    try {
      const allocator = seqAllocatorFactory();
      const { seq, crossedBoundary } = nextSeq(allocator.state, allocator.blockSize);
      if (crossedBoundary && allocator.onPersistNeeded) await allocator.onPersistNeeded();
      const transportPdu = buildSegmentAck({ seqZero, segN });
      const networkPdu = encryptNetworkPdu({ ...netKeys, ivi: ivIndex & 1, ivIndex, ctl: true, ttl: DEFAULT_TTL, seq, src: provisionerAddress, dst, transportPdu });
      await sendNetworkPdu(networkPdu);
    } catch (err) {
      log.warn('Envoi du Segment Ack échoué (non bloquant)', err.message);
    }
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

    // Messages de contrôle (CTL=1) : Segment Ack de nos propres envois segmentés
    // (App Key Add dépasse 11 octets, la lampe l'acquitte donc systématiquement),
    // heartbeat, etc. Ne JAMAIS les pousser dans l'inbox : ils ne sont pas chiffrés
    // AppKey/DevKey, et les traiter comme des messages d'accès ferait échouer le
    // déchiffrement de l'attente en cours (donc toute la configuration). Pas de
    // retransmission implémentée côté émission : leur contenu n'a pas d'usage ici.
    if (decoded.ctl) return;

    const seg = (decoded.transportPdu[0] >> 7) & 1;
    if (seg === 0) {
      const { akf, aid, upperTransportPdu } = decodeLowerTransportUnsegmented(decoded.transportPdu);
      inboxFor(decoded.src).push({ seq: decoded.seq, akf, aid, szmic: false, upperTransportPdu });
      return;
    }

    const header = decodeSegmentHeader(decoded.transportPdu);
    const key = `${decoded.src}:${header.seqZero}`;

    // Message déjà réassemblé : une retransmission signifie que la lampe n'a pas reçu
    // notre ack — ré-acquitter sans re-bufferiser (sinon le message serait retraité).
    const completed = completedSegmented.get(key);
    if (completed) {
      void sendSegmentAck({ dst: decoded.src, seqZero: header.seqZero, segN: completed.segN });
      return;
    }

    let buf = segmentBuffers.get(key);
    if (!buf) {
      for (const [staleKey, stale] of segmentBuffers) {
        if (Date.now() - stale.createdAt > 15000) segmentBuffers.delete(staleKey);
      }
      buf = { segments: new Map(), seqAuth: seqAuthFrom(decoded.seq, header.seqZero), createdAt: Date.now() };
      segmentBuffers.set(key, buf);
    }
    // Map par segO : un segment retransmis ne doit compter qu'une fois — un simple
    // tableau ferait croire à un réassemblage complet avec des doublons, et le vrai
    // message serait perdu (MISSING_SEGMENT).
    buf.segments.set(header.segO, header);

    if (buf.segments.size === header.segN + 1) {
      segmentBuffers.delete(key);
      rememberCompleted(key, header.segN);
      void sendSegmentAck({ dst: decoded.src, seqZero: header.seqZero, segN: header.segN });
      try {
        const { akf, aid, szmic, upperTransportPdu } = reassembleSegments([...buf.segments.values()]);
        inboxFor(decoded.src).push({ seq: buf.seqAuth, akf, aid, szmic, upperTransportPdu });
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
    const task = writeChain.then(async () => {
      const fragments = encodeProxyPdus(PROXY_PDU_TYPE.NETWORK, networkPdu, { maxAttributeValueLength: conn.maxAttributeValueLength });
      for (const fragment of fragments) await conn.write(fragment);
    });
    writeChain = task.catch(() => { /* l'erreur est propagée à l'appelant via task */ });
    return task;
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
    const msg = await inboxFor(src).shift(timeoutMs);
    return {
      seq: msg.seq,
      upperTransportPdu: msg.upperTransportPdu,
      szmic: Boolean(msg.szmic),
      keyType: msg.akf ? 'app' : 'device',
      aid: msg.aid
    };
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

  let ensureProxyPromise = null;

  async function ensureProxySession() {
    if (proxySession?.connected) return proxySession;
    // Mutex : deux commandes simultanées (index.js pilote les lampes en concurrence)
    // ne doivent pas ouvrir deux connexions GATT en parallèle vers la même lampe — la
    // seconde échouerait (un périphérique BLE n'accepte qu'un central à la fois) et la
    // première resterait ouverte sans être référencée.
    if (!ensureProxyPromise) {
      ensureProxyPromise = establishProxySession().finally(() => { ensureProxyPromise = null; });
    }
    return ensureProxyPromise;
  }

  async function establishProxySession() {
    const state = getState();
    if (proxySession?.connected) return proxySession;
    await closeProxy();

    if (state.nodes.length === 0) throw new Error('Aucune lampe provisionnée');
    const netKeys = netKeysFor(state);

    // Fenêtre >= 6s : en dessous, le scan manque souvent les annonces exploitables
    // (les premiers paquets publicitaires d'un appareil sont parfois incomplets —
    // vérifié sur matériel réel, cf. patch webbluetooth scanUpdated).
    const candidates = await scanForLampAdvertisements({ timeoutMs: 8000 });
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
          provisionerAddress: forcedProvisionerAddress ?? state.provisionerAddress,
          seqAllocatorFactory: seqAllocator
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

    const found = await scanForLampAdvertisements({ timeoutMs: 8000 });
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
    // commandes de contrôle soient acceptées (§8). En pratique sur matériel réel, cette
    // bascule peut prendre plus de temps que prévu de façon irrégulière (observé) :
    // quelques essais supplémentaires évitent d'échouer tout le provisioning pour un
    // simple délai, alors que le nœud est déjà valide côté clés (juste pas encore
    // configuré).
    const CONFIGURE_ATTEMPTS = 3;
    let lastConfigureError;
    for (let attempt = 1; attempt <= CONFIGURE_ATTEMPTS; attempt++) {
      try {
        await configureNode(node);
        lastConfigureError = null;
        break;
      } catch (err) {
        lastConfigureError = err;
        log.warn(`Configuration post-provisioning échouée (essai ${attempt}/${CONFIGURE_ATTEMPTS})`, err.message);
        if (attempt < CONFIGURE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (lastConfigureError) {
      throw new Error(`Lampe provisionnée mais configuration échouée : ${lastConfigureError.message}`);
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

    // Reconnexion en mode Proxy (0x1828), après le délai de bascule du firmware —
    // observé sur matériel réel : peut prendre plus que les "1 à 3 secondes" indiqués
    // par la doc (§4). Un court délai de repos avant même de scanner (sans activité
    // BLE) semble aider à la fiabilité de la détection juste après une déconnexion
    // GATT (observé empiriquement), en plus d'une marge généreuse sur le scan lui-même.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const proxyLampCandidates = await waitForProxyAdvertisement({ timeoutMs: 15000 });
    // Préférer une lampe qui annonce NOTRE Network ID (type 0x00) : un candidat
    // étranger ne possède pas notre NetKey et ne relayera jamais nos messages de
    // configuration (symptôme : timeouts silencieux sans erreur). Les annonces Node
    // Identity (type 0x01, sans Network ID lisible) restent acceptées en dernier
    // recours — le NID au déchiffrement fera le tri.
    const ourCandidates = proxyLampCandidates.filter((c) => !c.networkId || c.networkId.equals(netKeys.networkId));
    const target = ourCandidates[0] || proxyLampCandidates[0];
    const sessionRef = { feed: () => {} };
    const conn = await openProxyConnection(target.device, { onData: (bytes) => sessionRef.feed(bytes) });
    const session = createProxySession({
      conn, netKeys, ivIndex: state.ivIndex, provisionerAddress: state.provisionerAddress,
      seqAllocatorFactory: seqAllocator
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
        const { upperTransportPdu, keyType, seq, szmic } = await session.receiveFrom(dst, { timeoutMs: CONFIG_RESPONSE_TIMEOUT_MS });
        const accessPayload = decryptUpperTransportAccess({ key: devKey, keyType, aszmic: szmic, seq, src: dst, dst: src, ivIndex: state.ivIndex, encAccessPayload: upperTransportPdu });
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
    const { upperTransportPdu, keyType, seq, szmic } = await session.receiveFrom(node.unicastAddress, { timeoutMs: COMMAND_RESPONSE_TIMEOUT_MS });
    const decrypted = decryptUpperTransportAccess({ key: appKey, keyType, aszmic: szmic, seq, src: node.unicastAddress, dst: src, ivIndex: state.ivIndex, encAccessPayload: upperTransportPdu });
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
