import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToXy, isHexColor, clamp } from '../src/integrations/hue.js';

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
