import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHueLight,
  clamp,
  createHueIntegration,
  dynamicsFor,
  hexToXy,
  isHexColor,
  isPrivateBridgeIp,
  kelvinToMirek,
  mapWithConcurrency,
  normalizeLightIds,
  selectHueLights,
  toBridgeLight
} from '../src/integrations/hue.js';
import { createConfig } from '../src/config.js';

test('classifyHueLight: lampe couleur (color présent, même avec color_temperature)', () => {
  assert.deepEqual(
    classifyHueLight({ dimming: {}, color: { xy: {} }, color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } } }),
    { kind: 'color' }
  );
});

test('classifyHueLight: blanc réglable, bornes converties mirek → Kelvin', () => {
  assert.deepEqual(
    classifyHueLight({ dimming: {}, color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } } }),
    { kind: 'tunable_white', minKelvin: 2000, maxKelvin: 6536 }
  );
});

test('classifyHueLight: blanc réglable sans schéma exploitable → type sans bornes', () => {
  assert.deepEqual(classifyHueLight({ color_temperature: {} }), { kind: 'tunable_white' });
  assert.deepEqual(
    classifyHueLight({ color_temperature: { mirek_schema: { mirek_minimum: 0, mirek_maximum: 0 } } }),
    { kind: 'tunable_white' }
  );
});

test('classifyHueLight: dimmable sans couleur ni température', () => {
  assert.deepEqual(classifyHueLight({ on: { on: true }, dimming: { brightness: 50 } }), { kind: 'dimmable' });
});

test('classifyHueLight: prise tierce (on seulement, archétype inconnu) → onoff', () => {
  assert.deepEqual(
    classifyHueLight({ on: { on: true }, metadata: { archetype: 'unknown_archetype' } }),
    { kind: 'onoff' }
  );
  assert.deepEqual(classifyHueLight({}), { kind: 'onoff' });
});

test('kelvinToMirek: conversion et bornage à la plage Hue', () => {
  assert.equal(kelvinToMirek(4000), 250);
  assert.equal(kelvinToMirek(2000), 500);
  assert.equal(kelvinToMirek(1000), 500);
  assert.equal(kelvinToMirek(10000), 153);
  assert.equal(kelvinToMirek('abc'), 366);
});

test('isHexColor: accepte #RRGGBB, rejette le reste', () => {
  assert.equal(isHexColor('#FF0000'), true);
  assert.equal(isHexColor('#abc123'), true);
  assert.equal(isHexColor('FF0000'), false);
  assert.equal(isHexColor('#FFF'), false);
  assert.equal(isHexColor('#GG0000'), false);
  assert.equal(isHexColor(null), false);
});

test('hexToXy: rouge pur', () => {
  const { x, y } = hexToXy('#FF0000');
  assert.equal(x, 0.7006);
  assert.equal(y, 0.2993);
});

test('hexToXy: noir vers point blanc par défaut (évite division par zéro)', () => {
  assert.deepEqual(hexToXy('#000000'), { x: 0.3127, y: 0.3290 });
});

test('hexToXy: blanc reste dans le gamut (somme = 1)', () => {
  const { x, y } = hexToXy('#FFFFFF');
  assert.ok(x > 0 && x < 1);
  assert.ok(y > 0 && y < 1);
});

test('clamp: borne et retombe sur le défaut si invalide', () => {
  assert.equal(clamp(50, 1, 100, 85), 50);
  assert.equal(clamp(0, 1, 100, 85), 1);
  assert.equal(clamp(200, 1, 100, 85), 100);
  assert.equal(clamp('abc', 1, 100, 85), 85);
  assert.equal(clamp(undefined, 1, 100, 85), 85);
});

test('isPrivateBridgeIp accepte uniquement les IP locales littérales', () => {
  assert.equal(isPrivateBridgeIp('192.168.1.40'), true);
  assert.equal(isPrivateBridgeIp('10.0.0.2'), true);
  assert.equal(isPrivateBridgeIp('172.16.0.2'), true);
  assert.equal(isPrivateBridgeIp('fd00::1'), true);
  assert.equal(isPrivateBridgeIp('8.8.8.8'), false);
  assert.equal(isPrivateBridgeIp('bridge.local'), false);
  assert.equal(isPrivateBridgeIp('192.168.1.40.example.com'), false);
});

test('normalizeLightIds déduplique et rejette les valeurs complexes', () => {
  assert.deepEqual(normalizeLightIds([' a ', 'a', 'b', {}, '', null]), ['a', 'b']);
  assert.deepEqual(normalizeLightIds('["a","a","b"]'), ['a', 'b']);
});

test('mapWithConcurrency borne les opérations simultanées', async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return value * 2;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});

test('toBridgeLight: id, nom et type de la ressource light du bridge', () => {
  assert.deepEqual(
    toBridgeLight({ id: 'a1', metadata: { name: 'Bureau' }, dimming: {}, color: {} }),
    { id: 'a1', name: 'Bureau', kind: 'color' }
  );
  assert.deepEqual(toBridgeLight({ id: 'p1' }), { id: 'p1', name: 'p1', kind: 'onoff' });
});

test('selectHueLights: ne garde que les lampes choisies, les ids disparus du bridge sont ignorés', () => {
  const bridge = [
    { id: 'a', name: 'A', kind: 'color' },
    { id: 'b', name: 'B', kind: 'onoff' },
    { id: 'c', name: 'C', kind: 'dimmable' }
  ];
  assert.deepEqual(selectHueLights(bridge, ['c', 'a', 'disparue']).map((l) => l.id), ['a', 'c']);
  assert.deepEqual(selectHueLights(bridge, []), []);
});

test('config: sélection Hue absente = jamais choisie, [] = choix explicite vide', () => {
  const never = createConfig({}).hue;
  assert.equal(never.selectionConfigured, false);
  assert.deepEqual(never.lightIds, []);

  const empty = createConfig({ HUE_LIGHT_IDS: '[]' }).hue;
  assert.equal(empty.selectionConfigured, true);
  assert.deepEqual(empty.lightIds, []);

  const chosen = createConfig({ HUE_LIGHT_IDS: '["a","b","a"]' }).hue;
  assert.equal(chosen.selectionConfigured, true);
  assert.deepEqual(chosen.lightIds, ['a', 'b']);
});

function createHueForTest(hueConfig) {
  const events = [];
  const integration = createHueIntegration(hueConfig, { emitEvent: (event) => events.push(event) });
  return { integration, events };
}

test('hue.lights: sélection jamais choisie → rien à remonter, Klixa garde sa sélection', async () => {
  const { integration } = createHueForTest({ bridgeIp: '192.168.1.40', appKey: 'k', selectionConfigured: false, lightIds: [] });
  try {
    assert.deepEqual(await integration.commands['hue.lights'](), { selectionConfigured: false, lights: [] });
  } finally {
    await integration.stop();
  }
});

test('hue.status: expose selectionConfigured (sans IP ni clé)', async () => {
  const { integration } = createHueForTest({ bridgeIp: '192.168.1.40', appKey: 'k', selectionConfigured: true, lightIds: ['a'] });
  try {
    assert.deepEqual(await integration.commands['hue.status'](), { bridgeConfigured: true, paired: true, selectionConfigured: true });
  } finally {
    await integration.stop();
  }
});

test('hue: notifie Klixa (LightsChanged) uniquement si une sélection est configurée et le bridge appairé', async () => {
  const configured = createHueForTest({ bridgeIp: '192.168.1.40', appKey: 'k', selectionConfigured: true, lightIds: ['a'] });
  const notConfigured = createHueForTest({ bridgeIp: '192.168.1.40', appKey: 'k', selectionConfigured: false, lightIds: [] });
  const unpaired = createHueForTest({ bridgeIp: '192.168.1.40', appKey: '', selectionConfigured: true, lightIds: ['a'] });

  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(configured.events.length, 1);
  assert.deepEqual(configured.events[0].event, { source: 'Hue', type: 'LightsChanged' });
  assert.equal(notConfigured.events.length, 0);
  assert.equal(unpaired.events.length, 0);

  await Promise.all([configured, notConfigured, unpaired].map(({ integration }) => integration.stop()));
});

test('hue: stop() annule la notification différée (intégration remplacée avant l\'envoi)', async () => {
  const { integration, events } = createHueForTest({ bridgeIp: '192.168.1.40', appKey: 'k', selectionConfigured: true, lightIds: ['a'] });
  await integration.stop();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(events.length, 0);
});

test('dynamicsFor: durée de transition envoyée seulement si > 0 (prise on/off : rien)', () => {
  assert.deepEqual(dynamicsFor(350), { dynamics: { duration: 350 } });
  assert.deepEqual(dynamicsFor(0), {});
  assert.deepEqual(dynamicsFor(undefined), {});
  assert.deepEqual(dynamicsFor(-5), {});
});
