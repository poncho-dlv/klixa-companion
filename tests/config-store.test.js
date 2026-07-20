import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../desktop/config-store.js';

function encryptedStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`secure:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^secure:/, '')
  };
}

test('ConfigStore remplace atomiquement la configuration et relit les secrets', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-config-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory, { storage: encryptedStorage() });

  store.save({ CLOUD_WS_URL: 'wss://one', SMALLRIG_MESH_STATE: '{"seq":1}' });
  store.save({ CLOUD_WS_URL: 'wss://two', SMALLRIG_MESH_STATE: '{"seq":2}' });

  assert.deepEqual(store.load().SMALLRIG_MESH_STATE, '{"seq":2}');
  assert.equal(store.load().CLOUD_WS_URL, 'wss://two');
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')).length, 0);
  assert.match(fs.readFileSync(store.file, 'utf8'), /encrypted:/);
});

test('ConfigStore refuse de persister un état Mesh en clair', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-config-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory, {
    storage: { isEncryptionAvailable: () => false }
  });

  assert.throws(
    () => store.save({ SMALLRIG_MESH_STATE: '{"netKey":"secret"}' }),
    /Stockage sécurisé indisponible/
  );
  assert.equal(fs.existsSync(store.file), false);
});

test('ConfigStore refuse aussi de charger un ancien état Mesh en clair sans chiffrement', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-config-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory, {
    storage: { isEncryptionAvailable: () => false }
  });
  fs.writeFileSync(store.file, JSON.stringify({ SMALLRIG_MESH_STATE: '{"netKey":"secret"}' }), 'utf8');

  assert.throws(() => store.load(), /refus de charger.*en clair/i);
});

test('ConfigStore migre immédiatement un ancien état Mesh en clair si le chiffrement est disponible', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-config-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory, { storage: encryptedStorage() });
  fs.writeFileSync(store.file, JSON.stringify({ SMALLRIG_MESH_STATE: '{"seq":12}' }), 'utf8');

  assert.equal(store.load().SMALLRIG_MESH_STATE, '{"seq":12}');
  assert.match(fs.readFileSync(store.file, 'utf8'), /encrypted:/);
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /\\"seq\\":12/);
});

test('ConfigStore ne masque plus un fichier corrompu', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-config-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory, { storage: encryptedStorage() });
  fs.writeFileSync(store.file, '{invalide', 'utf8');

  assert.throws(() => store.load(), /Configuration locale illisible/);
});

test('ConfigStore resserre les permissions d’un fichier existant', {
  skip: process.platform === 'win32'
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klixa-config-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory, { storage: encryptedStorage() });
  fs.writeFileSync(store.file, '{}\n', { encoding: 'utf8', mode: 0o644 });
  fs.chmodSync(store.file, 0o644);

  store.load();
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});
