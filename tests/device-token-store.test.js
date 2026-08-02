import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeviceTokenStore,
  hashDeviceToken,
  isValidDeviceId,
  DEVICE_TOKEN_PREFIX
} from '../src/device-token-store.js';

test('hashDeviceToken est stable et vide pour une valeur vide', () => {
  assert.equal(hashDeviceToken(''), '');
  assert.equal(hashDeviceToken('  '), '');
  assert.equal(hashDeviceToken('abc'), hashDeviceToken('abc'));
  assert.notEqual(hashDeviceToken('abc'), hashDeviceToken('abd'));
});

test('isValidDeviceId accepte un identifiant simple, rejette le reste', () => {
  assert.equal(isValidDeviceId('smoke-machine'), true);
  assert.equal(isValidDeviceId('smoke_machine-1'), true);
  assert.equal(isValidDeviceId(''), false);
  assert.equal(isValidDeviceId('-leading-dash'), false);
  assert.equal(isValidDeviceId('avec espace'), false);
  assert.equal(isValidDeviceId('a'.repeat(65)), false);
});

test('generate refuse un deviceId invalide ou déjà pris', async () => {
  const store = createDeviceTokenStore();
  await assert.rejects(store.generate('', 'x'), /invalide/i);
  await store.generate('smoke-machine', 'Machine à fumée');
  await assert.rejects(store.generate('smoke-machine', 'Doublon'), /existe déjà/i);
});

test('generate retourne un token en clair préfixé, résolvable ensuite par hash', async () => {
  const store = createDeviceTokenStore();
  const { deviceId, token } = await store.generate('smoke-machine', 'Machine à fumée');
  assert.equal(deviceId, 'smoke-machine');
  assert.ok(token.startsWith(DEVICE_TOKEN_PREFIX));
  assert.equal(store.resolveDeviceId(token), 'smoke-machine');
  assert.equal(store.resolveDeviceId('kxd_inconnu'), null);
  assert.equal(store.resolveDeviceId(''), null);
});

test('revoke retire le device et invalide son token', async () => {
  const store = createDeviceTokenStore();
  const { token } = await store.generate('smoke-machine', 'Machine à fumée');
  assert.equal(await store.revoke('inconnu'), false);
  assert.equal(await store.revoke('smoke-machine'), true);
  assert.equal(store.resolveDeviceId(token), null);
  assert.deepEqual(store.list(), []);
});

test('list expose name/createdAt mais jamais le tokenHash', async () => {
  const store = createDeviceTokenStore();
  await store.generate('smoke-machine', 'Machine à fumée');
  const [entry] = store.list();
  assert.equal(entry.deviceId, 'smoke-machine');
  assert.equal(entry.name, 'Machine à fumée');
  assert.ok(entry.createdAt);
  assert.equal('tokenHash' in entry, false);
});

test('onChange est appelé à chaque mutation, avec un JSON rechargeable', async () => {
  const changes = [];
  const store = createDeviceTokenStore({ onChange: (json) => changes.push(json) });
  const { token } = await store.generate('smoke-machine', 'Machine à fumée');
  await store.revoke('smoke-machine');
  assert.equal(changes.length, 2);

  const reloaded = createDeviceTokenStore({ initialJson: changes[0] });
  assert.equal(reloaded.resolveDeviceId(token), 'smoke-machine');
});

test('un JSON initial invalide lève une erreur explicite', () => {
  assert.throws(() => createDeviceTokenStore({ initialJson: '{not json' }), /illisible|invalide/i);
});

test('un échec de persistance ne laisse pas le store dans un état fantôme (regression)', async () => {
  // Bug trouvé en test manuel du compagnon (mode headless sans DEVICES_TOKENS_FILE) :
  // generate() mutait la Map en mémoire AVANT d'appeler onChange, donc un onChange qui
  // rejette laissait le deviceId bloqué "déjà pris" sans qu'aucun token n'existe nulle
  // part. generate() doit rester réessayable après un échec de persistance.
  const store = createDeviceTokenStore({
    onChange: () => { throw new Error('disque plein'); }
  });

  await assert.rejects(store.generate('smoke-machine', 'Machine à fumée'), /disque plein/);
  assert.deepEqual(store.list(), []);
  assert.equal(store.resolveDeviceId('kxd_quelquechose'), null);

  // Toujours réessayable après l'échec — pas de "déjà pris" fantôme.
  await assert.rejects(store.generate('smoke-machine', 'Machine à fumée'), /disque plein/);
});

test('un échec de persistance sur revoke ne retire pas le device en mémoire', async () => {
  let shouldFail = false;
  const store = createDeviceTokenStore({
    onChange: () => { if (shouldFail) throw new Error('disque plein'); }
  });
  const { token } = await store.generate('smoke-machine', 'Machine à fumée');

  shouldFail = true;
  await assert.rejects(store.revoke('smoke-machine'), /disque plein/);
  assert.equal(store.resolveDeviceId(token), 'smoke-machine');
  assert.equal(store.list().length, 1);
});
