import test from 'node:test';
import assert from 'node:assert/strict';
import { clampDuration } from '../src/integrations/smoke.js';

const cfg = { defaultMs: 300, minMs: 50, maxMs: 1500 };

test('clampDuration: valeur valide conservée', () => {
  assert.equal(clampDuration(500, cfg), 500);
});

test('clampDuration: défaut si invalide', () => {
  assert.equal(clampDuration(undefined, cfg), 300);
  assert.equal(clampDuration('abc', cfg), 300);
  assert.equal(clampDuration(null, cfg), 300);
});

test('clampDuration: borne haute', () => {
  assert.equal(clampDuration(99999, cfg), 1500);
});

test('clampDuration: borne basse', () => {
  assert.equal(clampDuration(1, cfg), 50);
});

test('clampDuration: tronque les décimales', () => {
  assert.equal(clampDuration('300.9', cfg), 300);
});
