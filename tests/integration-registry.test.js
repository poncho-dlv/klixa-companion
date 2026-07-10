import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationRegistry } from '../src/integration-registry.js';

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
