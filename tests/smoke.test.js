import test from 'node:test';
import assert from 'node:assert/strict';
import { clampDuration, createSmokeIntegration } from '../src/integrations/smoke.js';

const cfg = { defaultMs: 300, minMs: 50, maxMs: 1500 };

// Remplace global.fetch le temps d'un appel et capture la requête envoyée au RPi.
async function captureFetch(response, run) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  try {
    return { calls, result: await run() };
  } finally {
    global.fetch = original;
  }
}

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

test('le token du service fumée est envoyé dans le header X-Smoke-Token', async () => {
  const smoke = createSmokeIntegration({ ...cfg, serviceUrl: 'http://192.168.1.50:8787', token: 'secret-partage' });
  const ok = { ok: true, status: 200 };

  const trigger = await captureFetch(ok, () => smoke.commands['smoke.trigger']({ durationMs: 400 }));
  assert.equal(trigger.calls[0].options.headers['x-smoke-token'], 'secret-partage');
  assert.deepEqual(trigger.result, { durationMs: 400 });

  // Le healthcheck s'authentifie aussi : sinon il rapporterait « injoignable » à tort.
  const health = await captureFetch(ok, () => smoke.healthcheck());
  assert.equal(health.calls[0].options.headers['x-smoke-token'], 'secret-partage');
});

test('sans token configuré, aucun header d’auth n’est envoyé (RPi en loopback)', async () => {
  const smoke = createSmokeIntegration({ ...cfg, serviceUrl: 'http://127.0.0.1:8787', token: '' });
  const { calls } = await captureFetch({ ok: true, status: 200 }, () => smoke.commands['smoke.trigger']({}));
  assert.equal('x-smoke-token' in calls[0].options.headers, false);
});

test('un token refusé par le RPi remonte une erreur explicite', async () => {
  const smoke = createSmokeIntegration({ ...cfg, serviceUrl: 'http://192.168.1.50:8787', token: 'mauvais' });
  const unauthorized = { ok: false, status: 401, text: async () => 'Token invalide' };

  await captureFetch(unauthorized, () => assert.rejects(
    smoke.healthcheck(),
    /Token du service fumée invalide/
  ));
  await captureFetch(unauthorized, () => assert.rejects(
    smoke.commands['smoke.trigger']({}),
    /Service fumée HTTP 401/
  ));
});
