import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationRegistry } from '../src/integration-registry.js';
import { registerIntegration } from '../src/integrations/index.js';

test('registry.stop ferme toutes les intégrations qui exposent stop', async () => {
  const registry = createIntegrationRegistry();
  const stopped = [];
  registry.register({ id: 'one', stop: async () => stopped.push('one') });
  registry.register({ id: 'two', stop: () => stopped.push('two') });
  registry.register({ id: 'three' });

  await registry.stop();
  assert.deepEqual(stopped.sort(), ['one', 'two']);
});

test('registry.stop tente les autres arrêts lorsqu’une intégration échoue', async () => {
  const registry = createIntegrationRegistry();
  let secondStopped = false;
  registry.register({ id: 'one', stop: () => { throw new Error('échec attendu'); } });
  registry.register({ id: 'two', stop: () => { secondStopped = true; } });

  await registry.stop();
  assert.equal(secondStopped, true);
});

test('registry.healthcheck exécute les vérifications en parallèle', async () => {
  const registry = createIntegrationRegistry();
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const check = async () => { started++; await gate; return { connected: true }; };
  registry.register({ id: 'one', healthcheck: check });
  registry.register({ id: 'two', healthcheck: check });

  const pending = registry.healthcheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 2);
  release();
  assert.deepEqual(await pending, {
    one: { ok: true, connected: true },
    two: { ok: true, connected: true }
  });
});

test('registry.healthcheck borne une vérification bloquée', async () => {
  const registry = createIntegrationRegistry({ healthcheckTimeoutMs: 5 });
  registry.register({ id: 'blocked', healthcheck: () => new Promise(() => {}) });
  const result = await registry.healthcheck();
  assert.equal(result.blocked.ok, false);
  assert.match(result.blocked.error, /expiré/);
});

test('registry masque et refuse les commandes locales depuis le cloud', async () => {
  const registry = createIntegrationRegistry();
  registry.register({
    id: 'scoped',
    commands: {
      'scoped.control': async () => 'cloud-ok',
      'scoped.pair': async () => 'local-ok'
    },
    commandScopes: { 'scoped.pair': 'local' }
  });

  assert.deepEqual(registry.listCommands({ source: 'cloud' }), ['scoped.control']);
  assert.deepEqual(registry.listCommands(), ['scoped.control', 'scoped.pair']);
  assert.equal(await registry.dispatch('scoped.pair', {}, { source: 'local' }), 'local-ok');
  await assert.rejects(
    registry.dispatch('scoped.pair', {}, { source: 'cloud' }),
    (error) => error.code === 'COMMAND_NOT_ALLOWED'
  );
});

test('registry refuse une portée de commande inconnue', () => {
  const registry = createIntegrationRegistry();
  assert.throws(() => registry.register({
    id: 'invalid-scope',
    commands: { 'invalid.command': async () => {} },
    commandScopes: { 'invalid.command': 'internet' }
  }), /Portée invalide/);
});

test('registry échoue fermé pour une source de dispatch inconnue', async () => {
  const registry = createIntegrationRegistry();
  registry.register({ id: 'safe', commands: { 'safe.local': async () => true } });

  await assert.rejects(registry.dispatch('safe.local', {}, { source: 'remote' }), /Source de commande invalide/);
  assert.throws(() => registry.listCommands({ source: 'remote' }), /Source de commande invalide/);
});

test('une intégration SmallRig invalide reste visible avec sa cause exacte', async () => {
  const registry = createIntegrationRegistry();
  registerIntegration(registry, 'smallrig', {
    smallrig: { enabled: true, meshStateJson: '{état invalide' }
  });

  const health = await registry.healthcheck();
  assert.equal(health.smallrig.ok, false);
  assert.match(health.smallrig.error, /SmallRig indisponible/i);
  assert.match(health.smallrig.error, /JSON|état Mesh/i);
  await assert.rejects(
    registry.dispatch('smallrig.list', {}),
    (error) => error.code === 'INTEGRATION_UNAVAILABLE' && /SmallRig indisponible/i.test(error.message)
  );
});
