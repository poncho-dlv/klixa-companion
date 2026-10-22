import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLightPayload, createDeviceLightController, sanitizeLightFields } from '../src/device-light.js';
import { createHoldRegistry } from '../src/integrations/light-utils.js';

const COLOR_LAMP = {
  id: 'lamp',
  type: 'light',
  actions: ['set', 'getState'],
  capabilities: ['onoff', 'dimming', 'color', 'color_temperature'],
  kelvin: { min: 2000, max: 6500 },
  fxModes: [{ id: 'rainbow', label: 'Arc-en-ciel' }]
};

test('sanitizeLightFields : capacités filtrées, plage Kelvin cohérente, effets dédoublonnés', () => {
  const fields = sanitizeLightFields({
    capabilities: ['color', 'inconnue', 'color'],
    kelvin: { min: 6500, max: 2000 },
    fxModes: [{ id: 'a', label: 'A' }, { id: 'a' }, { id: '' }, { id: 'b' }]
  });
  assert.deepEqual(fields.capabilities, ['color']);
  assert.equal(fields.kelvin, undefined);
  assert.deepEqual(fields.fxModes, [{ id: 'a', label: 'A' }, { id: 'b', label: 'b' }]);
});

test('sanitizeLightFields : sans capacité valide, la lampe est on/off', () => {
  assert.deepEqual(sanitizeLightFields({ capabilities: ['nope'] }).capabilities, ['onoff']);
  assert.deepEqual(sanitizeLightFields({}).capabilities, ['onoff']);
});

test('buildLightPayload : n\'envoie que ce que la lampe supporte', () => {
  const plug = { capabilities: ['onoff'] };
  assert.deepEqual(buildLightPayload({ on: true, color: '#ff0000', brightness: 50, kelvin: 3000 }, plug), { on: true });

  const dimmable = { capabilities: ['onoff', 'dimming'] };
  assert.deepEqual(buildLightPayload({ color: '#ff0000', brightness: 150 }, dimmable), { on: true, brightness: 100 });

  assert.deepEqual(buildLightPayload({ color: '#ff8800', brightness: 40, kelvin: 3000 }, COLOR_LAMP), { on: true, color: '#FF8800', brightness: 40 });
  assert.deepEqual(buildLightPayload({ kelvin: 9000 }, COLOR_LAMP), { on: true, kelvin: 6500 });
});

test('buildLightPayload : éteindre n\'emporte rien d\'autre, un effet inconnu est ignoré', () => {
  assert.deepEqual(buildLightPayload({ on: false, color: '#ffffff' }, COLOR_LAMP), { on: false });
  assert.deepEqual(buildLightPayload({ fx: 'rainbow', color: '#ffffff' }, COLOR_LAMP), { on: true, fx: 'rainbow' });
  assert.deepEqual(buildLightPayload({ fx: 'inconnu' }, COLOR_LAMP), { on: true });
});

function makeHub(element, getStateResult = { on: true, color: '#00FF00', brightness: 80 }) {
  const calls = [];
  return {
    calls,
    getElement: (deviceId, elementId) => (deviceId === 'd1' && elementId === element.id ? element : null),
    trigger: async (deviceId, elementId, action, { payload } = {}) => {
      calls.push({ action, payload });
      return action === 'getState' ? getStateResult : {};
    }
  };
}

function makeController(hub) {
  const timers = [];
  const registry = createHoldRegistry({
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; }
  });
  return { controller: createDeviceLightController(hub, { registry }), timers };
}

test('setLight sans maintien : applique l\'état, sans snapshot', async () => {
  const hub = makeHub(COLOR_LAMP);
  const { controller } = makeController(hub);
  const result = await controller.setLight({ deviceId: 'd1', elementId: 'lamp', state: { color: '#ff0000', brightness: 70 } });
  assert.deepEqual(result, { applied: true });
  assert.deepEqual(hub.calls, [{ action: 'set', payload: { on: true, color: '#FF0000', brightness: 70 } }]);
});

test('setLight avec maintien : snapshot, application, puis restauration à l\'échéance', async () => {
  const hub = makeHub(COLOR_LAMP);
  const { controller, timers } = makeController(hub);
  const result = await controller.setLight({ deviceId: 'd1', elementId: 'lamp', state: { color: '#ff0000' }, holdMs: 3000 });
  assert.deepEqual(result, { applied: true, restorable: true });
  assert.deepEqual(hub.calls.map((c) => c.action), ['getState', 'set']);
  assert.equal(timers[0].ms, 3000);

  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hub.calls.at(-1), { action: 'set', payload: { on: true, color: '#00FF00', brightness: 80 } });
});

test('un second maintien garde le snapshot d\'origine', async () => {
  const hub = makeHub(COLOR_LAMP);
  const { controller, timers } = makeController(hub);
  await controller.setLight({ deviceId: 'd1', elementId: 'lamp', state: { color: '#ff0000' }, holdMs: 3000 });
  await controller.setLight({ deviceId: 'd1', elementId: 'lamp', state: { color: '#0000ff' }, holdMs: 3000 });
  assert.equal(hub.calls.filter((c) => c.action === 'getState').length, 1);

  timers.at(-1).fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hub.calls.at(-1).payload, { on: true, color: '#00FF00', brightness: 80 });
});

test('un état permanent annule le maintien en cours', async () => {
  const hub = makeHub(COLOR_LAMP);
  const { controller, timers } = makeController(hub);
  await controller.setLight({ deviceId: 'd1', elementId: 'lamp', state: { color: '#ff0000' }, holdMs: 3000 });
  await controller.setLight({ deviceId: 'd1', elementId: 'lamp', state: { color: '#0000ff' } });
  assert.equal(timers[0].cleared, true);
});

test('sans getState : l\'état reste appliqué (restorable: false), aucune restauration armée', async () => {
  const hub = makeHub({ ...COLOR_LAMP, actions: ['set'] });
  const { controller, timers } = makeController(hub);
  const result = await controller.setLight({ deviceId: 'd1', elementId: 'lamp', state: { on: false }, holdMs: 3000 });
  assert.deepEqual(result, { applied: true, restorable: false });
  assert.equal(timers.length, 0);
});

test('getState vide ou en échec : appliqué, non restorable', async () => {
  const hub = makeHub(COLOR_LAMP, {});
  const { controller } = makeController(hub);
  assert.deepEqual(
    await controller.setLight({ deviceId: 'd1', elementId: 'lamp', state: { on: false }, holdMs: 1000 }),
    { applied: true, restorable: false }
  );
});

test('un élément qui n\'est pas une lampe est refusé', async () => {
  const hub = makeHub({ id: 'relay', type: 'switch', actions: ['trigger'] });
  const { controller } = makeController(hub);
  await assert.rejects(
    controller.setLight({ deviceId: 'd1', elementId: 'relay', state: {} }),
    (error) => error.code === 'DEVICE_NOT_A_LIGHT'
  );
});
