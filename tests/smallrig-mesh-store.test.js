import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addNode,
  allocateUnicastAddress,
  createEmptyMeshState,
  ensureNetworkKeys,
  findNode,
  nextSeq,
  parseMeshState,
  removeNode,
  serializeMeshState
} from '../src/integrations/smallrig/mesh-store.js';

test('createEmptyMeshState: valeurs par défaut cohérentes', () => {
  const state = createEmptyMeshState();
  assert.equal(state.netKey, null);
  assert.equal(state.nextUnicastAddress, 0x0002);
  assert.equal(state.provisionerAddress, 0x0001);
  assert.deepEqual(state.nodes, []);
});

test('ensureNetworkKeys: génère NetKey/AppKey une seule fois', () => {
  const state = createEmptyMeshState();
  ensureNetworkKeys(state);
  const netKey = state.netKey;
  const appKey = state.appKey;
  assert.equal(Buffer.from(netKey, 'hex').length, 16);
  assert.equal(Buffer.from(appKey, 'hex').length, 16);
  ensureNetworkKeys(state);
  assert.equal(state.netKey, netKey);
  assert.equal(state.appKey, appKey);
});

test('serializeMeshState/parseMeshState: round-trip', () => {
  const state = createEmptyMeshState();
  ensureNetworkKeys(state);
  addNode(state, { uuid: 'aa', name: 'Lampe salon', unicastAddress: 2, elementCount: 1, deviceKey: Buffer.alloc(16, 1) });
  const json = serializeMeshState(state);
  const restored = parseMeshState(json);
  assert.deepEqual(restored, state);
});

test('parseMeshState: JSON invalide ou absent -> état vide', () => {
  assert.deepEqual(parseMeshState(''), createEmptyMeshState());
  assert.deepEqual(parseMeshState('not json'), createEmptyMeshState());
  assert.deepEqual(parseMeshState(null), createEmptyMeshState());
});

test('allocateUnicastAddress: incrémente selon elementCount, refuse le débordement', () => {
  const state = createEmptyMeshState();
  const a = allocateUnicastAddress(state, 1);
  const b = allocateUnicastAddress(state, 2);
  assert.equal(a, 0x0002);
  assert.equal(b, 0x0003);
  assert.equal(state.nextUnicastAddress, 0x0005);

  state.nextUnicastAddress = 0x7fff;
  assert.throws(() => allocateUnicastAddress(state, 2));
});

test('nextSeq: réservation par blocs, crossedBoundary uniquement à la frontière', () => {
  const state = createEmptyMeshState();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(nextSeq(state, 2));
  // bloc de 2 : seq 0 (crossed), seq 1 (pas crossed), seq 2 (crossed), seq 3, seq 4 (crossed)
  assert.deepEqual(results.map((r) => r.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(results.map((r) => r.crossedBoundary), [true, false, true, false, true]);
  assert.equal(state.seqAllocatedUpTo, 6);
});

test('addNode/removeNode/findNode', () => {
  const state = createEmptyMeshState();
  addNode(state, { uuid: 'aa', unicastAddress: 2, elementCount: 1, deviceKey: Buffer.alloc(16) });
  addNode(state, { uuid: 'bb', unicastAddress: 3, elementCount: 1, deviceKey: Buffer.alloc(16) });
  assert.equal(state.nodes.length, 2);
  assert.ok(findNode(state, 'aa'));

  // Re-provisionner le même uuid remplace l'entrée plutôt que de la dupliquer
  addNode(state, { uuid: 'aa', unicastAddress: 9, elementCount: 1, deviceKey: Buffer.alloc(16) });
  assert.equal(state.nodes.length, 2);
  assert.equal(findNode(state, 'aa').unicastAddress, 9);

  assert.equal(removeNode(state, 'aa'), true);
  assert.equal(state.nodes.length, 1);
  assert.equal(removeNode(state, 'zz'), false);
});
