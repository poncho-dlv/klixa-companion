import test from 'node:test';
import assert from 'node:assert/strict';
import { createHoldRegistry, MAX_HOLD_MS } from '../src/integrations/light-utils.js';

// Timers injectés : on déclenche l'échéance à la main, aucune attente réelle.
function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    fire(timer) { if (!timer.cleared) timer.fn(); }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('arm : restaure le snapshot d\'origine à l\'échéance puis libère la lampe', async () => {
  const fake = createFakeTimers();
  const registry = createHoldRegistry(fake);
  const restored = [];

  registry.arm('a', { on: true }, 5000, (origin) => restored.push(origin));
  assert.equal(registry.has('a'), true);
  assert.equal(fake.timers[0].delay, 5000);

  fake.fire(fake.timers[0]);
  await flush();

  assert.deepEqual(restored, [{ on: true }]);
  assert.equal(registry.has('a'), false);
});

test('arm : un second maintien garde le snapshot d\'origine et ré-arme le timer', async () => {
  const fake = createFakeTimers();
  const registry = createHoldRegistry(fake);
  const restored = [];

  registry.arm('a', { color: 'origine' }, 1000, (origin) => restored.push(origin));
  // Le second appel reçoit un snapshot « intermédiaire » (état du premier maintien) : il ne
  // doit JAMAIS devenir l'état restauré, sinon la lampe reste bloquée sur le premier effet.
  registry.arm('a', { color: 'intermediaire' }, 2000, (origin) => restored.push(origin));

  assert.equal(fake.timers[0].cleared, true);
  assert.equal(registry.size, 1);
  assert.deepEqual(registry.snapshotOf('a'), { color: 'origine' });

  fake.fire(fake.timers[0]);
  fake.fire(fake.timers[1]);
  await flush();

  assert.deepEqual(restored, [{ color: 'origine' }]);
});

test('cancel : un état permanent annule le maintien, la restauration ne part jamais', async () => {
  const fake = createFakeTimers();
  const registry = createHoldRegistry(fake);
  const restored = [];

  registry.arm('a', { on: true }, 1000, (origin) => restored.push(origin));
  registry.arm('b', { on: true }, 1000, (origin) => restored.push(origin));
  registry.cancel(['a', 'inconnue']);

  assert.equal(registry.has('a'), false);
  assert.equal(registry.has('b'), true);

  for (const timer of fake.timers) fake.fire(timer);
  await flush();

  assert.equal(restored.length, 1);
});

test('arm : borne la durée (min 1 ms, max 24 h) et ne jette pas si la restauration échoue', async () => {
  const fake = createFakeTimers();
  const registry = createHoldRegistry(fake);

  registry.arm('a', {}, 0, () => {});
  registry.arm('b', {}, MAX_HOLD_MS * 10, () => { throw new Error('bridge injoignable'); });

  assert.equal(fake.timers[0].delay, 1);
  assert.equal(fake.timers[1].delay, MAX_HOLD_MS);

  fake.fire(fake.timers[1]);
  await flush(); // ne doit pas produire d'unhandled rejection
  assert.equal(registry.has('b'), false);
});

test('clear : annule tous les maintiens', () => {
  const fake = createFakeTimers();
  const registry = createHoldRegistry(fake);

  registry.arm('a', {}, 1000, () => {});
  registry.arm('b', {}, 1000, () => {});
  registry.clear();

  assert.equal(registry.size, 0);
  assert.ok(fake.timers.every((timer) => timer.cleared));
});
