// État persistant du réseau mesh (CDB simplifié, cf. RM75_SPEC_DEV.md §6/§10) :
// NetKey, AppKey, IVIndex, SEQ (avec réservation par blocs), et la liste des nœuds
// provisionnés (DevKey + adresse unicast + UUID). Fonctions pures sur un objet JS —
// aucune dépendance filesystem/Electron ici (cf. index.js pour le branchement de la
// persistance réelle, mêmes principes que desktop/config-store.js pour Hue).

import { randomBytes } from './mesh-crypto.js';

export const PROVISIONER_ADDRESS = 0x0001;
export const FIRST_NODE_ADDRESS = 0x0002;
export const MAX_UNICAST_ADDRESS = 0x7fff;
export const DEFAULT_SEQ_BLOCK_SIZE = 100;

export function createEmptyMeshState() {
  return {
    netKey: null,
    appKey: null,
    ivIndex: 0,
    provisionerAddress: PROVISIONER_ADDRESS,
    nextUnicastAddress: FIRST_NODE_ADDRESS,
    seq: 0,
    seqAllocatedUpTo: 0,
    nodes: []
  };
}

export function parseMeshState(json) {
  if (!json) return createEmptyMeshState();
  try {
    const parsed = JSON.parse(json);
    return { ...createEmptyMeshState(), ...parsed, nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [] };
  } catch {
    return createEmptyMeshState();
  }
}

export function serializeMeshState(state) {
  return JSON.stringify(state);
}

// Génère NetKey/AppKey localement au premier provisioning (jamais fournies par le
// cloud — même principe que HUE_APP_KEY : générées et conservées uniquement en local).
export function ensureNetworkKeys(state) {
  if (!state.netKey) state.netKey = randomBytes(16).toString('hex');
  if (!state.appKey) state.appKey = randomBytes(16).toString('hex');
  return state;
}

export function netKeyBuffer(state) {
  return Buffer.from(state.netKey, 'hex');
}

export function appKeyBuffer(state) {
  return Buffer.from(state.appKey, 'hex');
}

// Réserve un bloc d'adresses unicast pour un nœud de `elementCount` éléments.
export function allocateUnicastAddress(state, elementCount) {
  const address = state.nextUnicastAddress;
  if (address + elementCount - 1 > MAX_UNICAST_ADDRESS) {
    throw new Error('Plage d\'adresses unicast épuisée');
  }
  state.nextUnicastAddress = address + elementCount;
  return address;
}

// SEQ avec réservation par blocs (RM75_SPEC_DEV.md §7) : quand `seq` atteint la borne
// déjà persistée, on avance la borne AVANT de renvoyer le numéro, pour que
// `crossedBoundary` indique qu'il faut persister l'état avant d'émettre ce message
// (sinon un crash pourrait faire réutiliser un SEQ déjà vu par les nœuds -> message
// silencieusement ignoré, cf. doc §7).
export function nextSeq(state, blockSize = DEFAULT_SEQ_BLOCK_SIZE) {
  let crossedBoundary = false;
  if (state.seq >= state.seqAllocatedUpTo) {
    state.seqAllocatedUpTo = state.seq + blockSize;
    crossedBoundary = true;
  }
  const seq = state.seq;
  state.seq += 1;
  return { seq, crossedBoundary };
}

export function addNode(state, { uuid, name, unicastAddress, elementCount, deviceKey, vendorElementAddress }) {
  const node = {
    uuid,
    name: name || uuid,
    unicastAddress,
    elementCount,
    deviceKey: Buffer.isBuffer(deviceKey) ? deviceKey.toString('hex') : deviceKey,
    vendorElementAddress: vendorElementAddress ?? unicastAddress
  };
  state.nodes = [...state.nodes.filter((n) => n.uuid !== uuid), node];
  return node;
}

export function removeNode(state, uuid) {
  const before = state.nodes.length;
  state.nodes = state.nodes.filter((n) => n.uuid !== uuid);
  return state.nodes.length < before;
}

export function findNode(state, uuid) {
  return state.nodes.find((n) => n.uuid === uuid) || null;
}

export function nodeDeviceKeyBuffer(node) {
  return Buffer.from(node.deviceKey, 'hex');
}
