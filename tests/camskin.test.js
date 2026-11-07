import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createCamskinIntegration, listSkins, normalizeSkin, normalizeDuration, sanitizeFace, MAX_DURATION_MS } from '../src/integrations/camskin.js';
import { createIntegrationRegistry } from '../src/integration-registry.js';

async function start(options, cfg = {}) {
  const integration = createCamskinIntegration({ port: 0, ...cfg }, options);
  await integration.ready;
  return integration;
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('listSkins expose les skins de la page avec leur libelle', () => {
  const skins = listSkins();
  assert.deepEqual(skins.map((s) => s.id), ['frog', 'cat', 'flower']);
  assert.ok(skins.every((s) => s.label));
});

test('normalizeSkin : vide / none = aucun skin, inconnu = erreur', () => {
  assert.equal(normalizeSkin(''), null);
  assert.equal(normalizeSkin('none'), null);
  assert.equal(normalizeSkin(undefined), null);
  assert.equal(normalizeSkin(' Frog '), 'frog');
  assert.throws(() => normalizeSkin('dragon'), (err) => err.code === 'INVALID_SKIN');
  assert.throws(() => normalizeSkin('__proto__'), (err) => err.code === 'INVALID_SKIN');
});

test('normalizeDuration : absent = permanent, bornes strictes', () => {
  assert.equal(normalizeDuration(undefined), 0);
  assert.equal(normalizeDuration(0), 0);
  assert.equal(normalizeDuration(5000), 5000);
  assert.equal(normalizeDuration(MAX_DURATION_MS), MAX_DURATION_MS);
  for (const bad of [-1, 1.5, 'abc', MAX_DURATION_MS + 1]) {
    assert.throws(() => normalizeDuration(bad), (err) => err.code === 'INVALID_DURATION');
  }
});

test('set-skin met a jour l\'etat, status le reflete', async () => {
  const camskin = await start();
  try {
    const state = await camskin.commands['camskin.set-skin']({ skin: 'cat' });
    assert.deepEqual(state, { skin: 'cat', expiresAt: null });
    const status = await camskin.commands['camskin.status']();
    assert.equal(status.skin, 'cat');
    assert.equal(status.port, camskin.port);
    assert.equal(status.url, `http://127.0.0.1:${camskin.port}/`);
    const reset = await camskin.commands['camskin.set-skin']({ skin: 'none' });
    assert.deepEqual(reset, { skin: null, expiresAt: null });
  } finally {
    await camskin.stop();
  }
});

test('set-skin refuse un skin inconnu sans modifier l\'etat', async () => {
  const camskin = await start();
  try {
    await camskin.commands['camskin.set-skin']({ skin: 'frog' });
    await assert.rejects(camskin.commands['camskin.set-skin']({ skin: 'dragon' }));
    assert.equal((await camskin.commands['camskin.status']()).skin, 'frog');
  } finally {
    await camskin.stop();
  }
});

test('une duree retire le skin a l\'echeance et previent le cloud', async () => {
  const sent = [];
  const camskin = await start({ emitEvent: (e) => sent.push(e) });
  try {
    const state = await camskin.commands['camskin.set-skin']({ skin: 'frog', durationMs: 40 });
    assert.ok(state.expiresAt > Date.now() - 1);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await camskin.commands['camskin.status']()).skin, null);
    assert.deepEqual(sent.map((e) => e.event), [{ source: 'CamSkin', type: 'Expired' }]);
  } finally {
    await camskin.stop();
  }
});

test('un nouveau set-skin annule l\'echeance precedente', async () => {
  const camskin = await start();
  try {
    await camskin.commands['camskin.set-skin']({ skin: 'frog', durationMs: 40 });
    await camskin.commands['camskin.set-skin']({ skin: 'cat' });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await camskin.commands['camskin.status']()).skin, 'cat');
  } finally {
    await camskin.stop();
  }
});

test('le serveur sert la page, le modele et le wasm ; refuse la traversee de chemin', async () => {
  const camskin = await start();
  try {
    const page = await get(camskin.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /overlay\.js/, 'la racine est l overlay OBS');
    const tracker = await get(camskin.port, '/tracker.html');
    assert.equal(tracker.status, 200);
    assert.match(tracker.body, /tracker\.js/);
    assert.match(page.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
    assert.equal((await get(camskin.port, '/models/face_landmarker.task')).status, 200);
    const wasm = await get(camskin.port, '/vendor/wasm/vision_wasm_internal.wasm');
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers['content-type'], 'application/wasm');
    assert.equal((await get(camskin.port, '/..%2f..%2fpackage.json')).status, 404);
    assert.equal((await get(camskin.port, '/vendor/../../package.json')).status, 404);
    const state = await get(camskin.port, '/state');
    assert.deepEqual(JSON.parse(state.body), { skin: null, expiresAt: null, overlays: 0, trackers: 0 });
  } finally {
    await camskin.stop();
  }
});

test('le serveur refuse un Host non loopback (DNS rebinding) et une Origin etrangere', async () => {
  const camskin = await start();
  try {
    assert.equal((await get(camskin.port, '/state', { Host: 'evil.example' })).status, 403);
    assert.equal((await get(camskin.port, '/state', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await get(camskin.port, '/state', { Origin: 'http://127.0.0.1:4777' })).status, 200);
  } finally {
    await camskin.stop();
  }
});

function connectWs(port, role, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`, { headers });
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const validFace = () => ({
  w: 960, h: 540, cx: 480, cy: 200, u: 90, angle: 0.1, jaw: 0.2,
  nose: { x: 480, y: 260 }, mouth: { x: 480, y: 320 }, look: { x: 0, y: 0 },
  oval: [{ x: 400, y: 100 }, { x: 560, y: 100 }]
});

test('sanitizeFace accepte un visage valide et refuse les formes invalides', () => {
  assert.deepEqual(sanitizeFace(validFace()), validFace());
  assert.equal(sanitizeFace(null), null);
  assert.equal(sanitizeFace({ ...validFace(), cx: NaN }), null);
  assert.equal(sanitizeFace({ ...validFace(), w: 100000 }), null);
  assert.equal(sanitizeFace({ ...validFace(), nose: null }), null);
  assert.equal(sanitizeFace({ ...validFace(), oval: new Array(65).fill({ x: 1, y: 1 }) }), null);
  assert.equal(sanitizeFace({ ...validFace(), oval: [{ x: 'a', y: 1 }] }), null);
  // Les champs inconnus ne sont jamais relayes.
  assert.equal(sanitizeFace({ ...validFace(), extra: '<script>' }).extra, undefined);
});

test('WebSocket : l overlay recoit letat courant puis chaque changement', async () => {
  const camskin = await start();
  try {
    const overlay = await connectWs(camskin.port, 'overlay');
    await wait(30);
    await camskin.commands['camskin.set-skin']({ skin: 'flower' });
    await wait(30);
    const skins = overlay.messages.filter((m) => m.type === 'state').map((m) => m.skin);
    assert.deepEqual(skins.slice(0, 1), [null]);
    assert.equal(skins.at(-1), 'flower');
    assert.equal((await camskin.commands['camskin.status']()).overlays, 1);
    overlay.ws.close();
  } finally {
    await camskin.stop();
  }
});

test('WebSocket : le suivi envoie des visages relayes uniquement aux overlays', async () => {
  const camskin = await start();
  try {
    const overlay = await connectWs(camskin.port, 'overlay');
    const tracker = await connectWs(camskin.port, 'tracker');
    tracker.ws.send(JSON.stringify({ type: 'face', face: validFace() }));
    tracker.ws.send(JSON.stringify({ type: 'face', face: { ...validFace(), cx: 'x' } }));
    tracker.ws.send(JSON.stringify({ type: 'face', face: null }));
    tracker.ws.send('pas du json');
    await wait(60);
    const faces = overlay.messages.filter((m) => m.type === 'face');
    assert.equal(faces.length, 2);
    assert.deepEqual(faces[0].face, validFace());
    assert.equal(faces[1].face, null);
    assert.equal(tracker.messages.some((m) => m.type === 'face'), false, 'pas d echo vers le suivi');
    const status = await camskin.commands['camskin.status']();
    assert.equal(status.trackers, 1);
    overlay.ws.close();
    tracker.ws.close();
  } finally {
    await camskin.stop();
  }
});

test('WebSocket : un overlay ne peut pas injecter de visage', async () => {
  const camskin = await start();
  try {
    const first = await connectWs(camskin.port, 'overlay');
    const second = await connectWs(camskin.port, 'overlay');
    first.ws.send(JSON.stringify({ type: 'face', face: validFace() }));
    await wait(60);
    assert.equal(second.messages.some((m) => m.type === 'face'), false);
    first.ws.close();
    second.ws.close();
  } finally {
    await camskin.stop();
  }
});

test('WebSocket : refuse une Origin etrangere, un Host rebinde et un role inconnu', async () => {
  const camskin = await start();
  try {
    await assert.rejects(connectWs(camskin.port, 'overlay', { Origin: 'https://evil.example' }), (e) => e.status === 403);
    await assert.rejects(connectWs(camskin.port, 'overlay', { Host: 'evil.example' }), (e) => e.status === 403);
    await assert.rejects(connectWs(camskin.port, 'admin'), (e) => e.status === 403);
  } finally {
    await camskin.stop();
  }
});

test('onTrackingDemand : demande quand un skin est actif, retire quand il disparait', async () => {
  const calls = [];
  const camskin = await start(undefined, { onTrackingDemand: (needed) => calls.push(needed) });
  try {
    await camskin.commands['camskin.set-skin']({ skin: 'cat' });
    await camskin.commands['camskin.set-skin']({ skin: 'frog' });
    await camskin.commands['camskin.set-skin']({ skin: 'none' });
    await camskin.commands['camskin.set-skin']({ skin: 'frog', durationMs: 30 });
    await wait(100);
    assert.deepEqual(calls, [true, false, true, false]);
  } finally {
    await camskin.stop();
  }
});

test('un port deja pris fait echouer le healthcheck sans lever a la creation', async () => {
  const first = await start();
  try {
    const second = createCamskinIntegration({ port: first.port });
    await assert.rejects(second.healthcheck());
    await second.stop();
  } finally {
    await first.stop();
  }
});

test('les commandes sont accessibles depuis le cloud via le registre', async () => {
  const registry = createIntegrationRegistry();
  const camskin = await start();
  try {
    registry.register(camskin);
    assert.ok(registry.listCommands({ source: 'cloud' }).includes('camskin.set-skin'));
    const result = await registry.dispatch('camskin.set-skin', { skin: 'cat', durationMs: 1000 }, { source: 'cloud' });
    assert.equal(result.skin, 'cat');
    const skins = await registry.dispatch('camskin.list-skins', {}, { source: 'cloud' });
    assert.equal(skins.skins.length, 3);
  } finally {
    await registry.stop();
  }
});
