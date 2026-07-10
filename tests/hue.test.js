import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  hexToXy,
  isHexColor,
  isPrivateBridgeIp,
  mapWithConcurrency,
  normalizeLightIds
} from '../src/integrations/hue.js';

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

test('hexToXy: noir → point blanc par défaut (évite division par zéro)', () => {
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
