import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLightCommandResults, createSmallrigIntegration, mergeBaseline } from '../src/integrations/smallrig/index.js';

test('mergeBaseline conserve la dernière couleur écrite à travers un power off/on', () => {
  const afterColor = mergeBaseline(undefined, { status: { type: 'hsi', hue: 10, sat: 50, intensity: 80 }, poweredOn: true });
  const afterOff = mergeBaseline(afterColor, { poweredOn: false });
  assert.deepEqual(afterOff, { status: { type: 'hsi', hue: 10, sat: 50, intensity: 80 }, poweredOn: false });
  const afterOn = mergeBaseline(afterOff, { poweredOn: true });
  assert.deepEqual(afterOn, { status: { type: 'hsi', hue: 10, sat: 50, intensity: 80 }, poweredOn: true });
});

test('mergeBaseline sans antécédent part d\'une lampe allumée sans mode connu', () => {
  assert.deepEqual(mergeBaseline(undefined, { poweredOn: false }), { status: null, poweredOn: false });
  assert.deepEqual(
    mergeBaseline(null, { status: { type: 'fx', mode: 4, freq: 0, intensity: 0 } }),
    { status: { type: 'fx', mode: 4, freq: 0, intensity: 0 }, poweredOn: true }
  );
});

test('smallrig.color mode simple rejette immédiatement une lampe inconnue (pré-validation avant le blink asynchrone)', async () => {
  const integration = createSmallrigIntegration();

  await assert.rejects(
    integration.commands['smallrig.color']({ lightIds: ['unknown'], color: '#FF0000', mode: 'simple' }),
    /Lampes inconnues/
  );
});

test('smallrig agrège les résultats réussis de toutes les lampes', () => {
  const summary = assertLightCommandResults('Couleur', ['one', 'two'], [
    [{ uuid: 'one', ok: true }],
    [{ uuid: 'two', ok: true }]
  ]);

  assert.equal(summary.lights, 2);
  assert.equal(summary.succeeded, 2);
});

test('smallrig transforme un échec silencieux en erreur de commande', () => {
  assert.throws(
    () => assertLightCommandResults('Couleur', ['one'], [[{ uuid: 'one', ok: false, error: 'GATT fermé' }]]),
    (error) => error.code === 'SMALLRIG_COMMAND_FAILED' && /GATT fermé/.test(error.message)
  );
});

test('smallrig signale les résultats manquants comme succès partiel', () => {
  assert.throws(
    () => assertLightCommandResults('Couleur', ['one', 'two'], [[{ uuid: 'one', ok: true }]]),
    (error) => error.code === 'SMALLRIG_PARTIAL_FAILURE' && /two: aucun résultat/.test(error.message)
  );
});

test('smallrig.fx exige au moins une lampe cible', async () => {
  const integration = createSmallrigIntegration();

  await assert.rejects(
    integration.commands['smallrig.fx']({ mode: 4 }),
    /Aucune lampe cible/
  );
});

test('smallrig.cct exige au moins une lampe cible', async () => {
  const integration = createSmallrigIntegration();

  await assert.rejects(
    integration.commands['smallrig.cct']({ kelvin: 5600 }),
    /Aucune lampe cible/
  );
});

test('smallrig.rgbw exige au moins une lampe cible', async () => {
  const integration = createSmallrigIntegration();

  await assert.rejects(
    integration.commands['smallrig.rgbw']({ r: 255 }),
    /Aucune lampe cible/
  );
});

test('smallrig bloque le provisioning et les opérations suivantes si la persistance échoue', async () => {
  const integration = createSmallrigIntegration({
    onStateChange: async () => { throw new Error('disque plein'); }
  });

  await assert.rejects(
    integration.commands['smallrig.provision']({ bleDeviceId: 'lamp-test' }),
    (error) => error.code === 'SMALLRIG_STATE_PERSIST_FAILED' && /disque plein/.test(error.message)
  );
  await assert.rejects(
    integration.commands['smallrig.list']({}),
    (error) => error.code === 'SMALLRIG_STATE_PERSIST_FAILED'
  );
});
