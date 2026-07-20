import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import {
  createLocalServer,
  integrationsAreHealthy,
  isAllowedOrigin,
  isAllowedRequestHost,
  isLoopbackHost,
  readBody,
  tokenMatches
} from '../src/local-server.js';

function request(body, headers = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.headers = headers;
  return req;
}

test('readBody accepte un petit corps', async () => {
  assert.equal(await readBody(request('{"ok":true}'), 64), '{"ok":true}');
});

test('readBody rejette un Content-Length supérieur à la limite', async () => {
  await assert.rejects(
    readBody(request('', { 'content-length': '65' }), 64),
    { code: 'PAYLOAD_TOO_LARGE' }
  );
});

test('readBody rejette un corps reçu supérieur à la limite', async () => {
  await assert.rejects(readBody(request('x'.repeat(65)), 64), { code: 'PAYLOAD_TOO_LARGE' });
});

test('readBody rejette un Content-Length invalide', async () => {
  await assert.rejects(
    readBody(request('', { 'content-length': '-1' }), 64),
    { code: 'INVALID_CONTENT_LENGTH' }
  );
});

test('integrationsAreHealthy reflète un état dégradé', () => {
  assert.equal(integrationsAreHealthy({ obs: { ok: true }, hue: { ok: true } }), true);
  assert.equal(integrationsAreHealthy({ obs: { ok: false }, hue: { ok: true } }), false);
});

test('tokenMatches compare le token local sans comparaison directe', () => {
  assert.equal(tokenMatches('secret', 'secret'), true);
  assert.equal(tokenMatches('incorrect', 'secret'), false);
  assert.equal(tokenMatches(undefined, 'secret'), false);
});

test('isAllowedOrigin refuse une origine cross-origin mais laisse passer l’absence d’Origin', () => {
  // Client hors navigateur (curl, script, healthcheck) : pas de header Origin.
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(''), true);
  // Loopback (aucun client légitime, mais inoffensif) autorisé.
  assert.equal(isAllowedOrigin('http://127.0.0.1:8786'), true);
  assert.equal(isAllowedOrigin('http://localhost'), true);
  // Page web malveillante : Origin présent et non-loopback → refusé.
  assert.equal(isAllowedOrigin('https://attacker.example'), false);
  assert.equal(isAllowedOrigin('http://192.168.1.10'), false);
  assert.equal(isAllowedOrigin('null'), false);
});

test('isAllowedRequestHost refuse un domaine (anti DNS-rebinding) mais accepte IP et loopback', () => {
  assert.equal(isAllowedRequestHost('127.0.0.1:8786', '127.0.0.1'), true);
  assert.equal(isAllowedRequestHost('localhost:8786', '127.0.0.1'), true);
  assert.equal(isAllowedRequestHost('[::1]:8786', '127.0.0.1'), true);
  // IP littérale LAN : non rebindable, autorisée.
  assert.equal(isAllowedRequestHost('192.168.1.50:8786', '0.0.0.0'), true);
  // Domaine rebindé vers la loopback : refusé.
  assert.equal(isAllowedRequestHost('attacker.example:8786', '127.0.0.1'), false);
  // Host configuré explicitement (ex. hostname interne) : autorisé.
  assert.equal(isAllowedRequestHost('nas.local', 'nas.local'), true);
  assert.equal(isAllowedRequestHost('', '127.0.0.1'), false);
});

test('le serveur rejette une requête cross-origin ou rebindée avec 403', async () => {
  const registry = {
    healthcheck: async () => ({}),
    listCommands: () => ['smoke.trigger'],
    dispatch: async () => ({ triggered: true })
  };
  const server = createLocalServer({ host: '127.0.0.1', port: 0, production: false, localToken: '' }, registry);
  server.start();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listen timeout')), 2000);
    const poll = () => {
      if (server.address()) { clearTimeout(timer); resolve(); }
      else setTimeout(poll, 10);
    };
    poll();
  });
  const port = server.address().port;

  // fetch() filtre les headers interdits (Origin, Host) : on utilise http.request brut
  // pour simuler fidèlement une requête forgée par un navigateur / une attaque rebinding.
  const rawPost = (headers) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/commands/smoke.trigger', headers },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    req.on('error', reject);
    req.end('{"durationMs":300}');
  });

  try {
    // CSRF : Origin d'un site tiers (Content-Type text/plain → pas de préflight CORS).
    assert.equal(await rawPost({ origin: 'https://attacker.example', 'content-type': 'text/plain' }), 403);
    // DNS-rebinding : Host = domaine résolvant vers la loopback.
    assert.equal(await rawPost({ host: 'attacker.example', 'content-type': 'application/json' }), 403);
    // Client local légitime : pas d'Origin, Host loopback → dispatché.
    assert.equal(await rawPost({ 'content-type': 'application/json' }), 200);
  } finally {
    await server.stop();
  }
});

test('le serveur refuse une écoute LAN anonyme en production', () => {
  const registry = { healthcheck: async () => ({}), listCommands: () => [] };
  assert.throws(
    () => createLocalServer({ host: '0.0.0.0', port: 8786, production: true, localToken: '' }, registry),
    /COMPANION_LOCAL_TOKEN obligatoire/
  );
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});
