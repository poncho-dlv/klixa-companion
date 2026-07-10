import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  createLocalServer,
  integrationsAreHealthy,
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

test('le serveur refuse une écoute LAN anonyme en production', () => {
  const registry = { healthcheck: async () => ({}), listCommands: () => [] };
  assert.throws(
    () => createLocalServer({ host: '0.0.0.0', port: 8786, production: true, localToken: '' }, registry),
    /COMPANION_LOCAL_TOKEN obligatoire/
  );
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});
