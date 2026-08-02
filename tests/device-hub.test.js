import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createDeviceHub, DEVICES_WS_PATH } from '../src/device-hub.js';
import { createDeviceTokenStore } from '../src/device-token-store.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function startHarness(hubOptions = {}) {
  const tokenStore = hubOptions.tokenStore || createDeviceTokenStore();
  const hub = createDeviceHub({ heartbeatIntervalMs: 60000, ...hubOptions, tokenStore });
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  return { hub, tokenStore, server };
}

function connectDevice(port, token) {
  return new WebSocket(`ws://127.0.0.1:${port}${DEVICES_WS_PATH}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
}

function once(ws, event) {
  return new Promise((resolve) => ws.once(event, (...args) => resolve(args)));
}

async function nextMessage(ws) {
  const [data] = await once(ws, 'message');
  return JSON.parse(data.toString());
}

async function stopHarness({ hub, server }) {
  hub.stop();
  await new Promise((resolve) => server.close(resolve));
}

test('un token invalide ferme la connexion avec le code 4401', async () => {
  const harness = startHarness();
  const port = await listen(harness.server);
  try {
    const ws = connectDevice(port, 'kxd_inconnu');
    const [code] = await once(ws, 'close');
    assert.equal(code, 4401);
  } finally {
    await stopHarness(harness);
  }
});

test('hello valide déclenche registered:true et rend le device visible dans list()', async () => {
  const harness = startHarness();
  const { token } = await harness.tokenStore.generate('smoke-machine', 'Machine à fumée');
  const port = await listen(harness.server);
  try {
    const ws = connectDevice(port, token);
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      deviceId: 'smoke-machine',
      name: 'Machine à fumée',
      elements: [{ id: 'relay', type: 'switch', name: 'Relais', actions: ['trigger'] }]
    }));
    const reply = await nextMessage(ws);
    assert.deepEqual(reply, { type: 'registered', ok: true });

    const [entry] = harness.hub.list();
    assert.equal(entry.deviceId, 'smoke-machine');
    assert.equal(entry.elements[0].id, 'relay');
    ws.close();
  } finally {
    await stopHarness(harness);
  }
});

test('une version de protocole non supportée est refusée', async () => {
  const harness = startHarness();
  const { token } = await harness.tokenStore.generate('smoke-machine', 'Machine à fumée');
  const port = await listen(harness.server);
  try {
    const ws = connectDevice(port, token);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: 99, deviceId: 'smoke-machine', elements: [] }));
    const reply = await nextMessage(ws);
    assert.equal(reply.ok, false);
    const [code] = await once(ws, 'close');
    assert.equal(code, 4400);
  } finally {
    await stopHarness(harness);
  }
});

test('trigger() relaie la commande et résout avec le résultat de l’ack', async () => {
  const harness = startHarness();
  const { token } = await harness.tokenStore.generate('smoke-machine', 'Machine à fumée');
  const port = await listen(harness.server);
  try {
    const ws = connectDevice(port, token);
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      deviceId: 'smoke-machine',
      elements: [{ id: 'relay', type: 'switch', actions: ['trigger'] }]
    }));
    await nextMessage(ws); // registered

    ws.on('message', (raw) => {
      const command = JSON.parse(raw.toString());
      if (command.type === 'command') {
        ws.send(JSON.stringify({ type: 'ack', id: command.id, ok: true, result: { durationMs: command.payload.durationMs } }));
      }
    });

    const result = await harness.hub.trigger('smoke-machine', 'relay', 'trigger', { payload: { durationMs: 300 } });
    assert.deepEqual(result, { durationMs: 300 });
    ws.close();
  } finally {
    await stopHarness(harness);
  }
});

test('trigger() rejette explicitement un device hors ligne', async () => {
  const harness = startHarness();
  try {
    await assert.rejects(
      harness.hub.trigger('inconnu', 'relay', 'trigger'),
      (error) => error.code === 'DEVICE_OFFLINE'
    );
  } finally {
    await stopHarness(harness);
  }
});

test('trigger() rejette une action non déclarée par l’élément', async () => {
  const harness = startHarness();
  const { token } = await harness.tokenStore.generate('smoke-machine', 'Machine à fumée');
  const port = await listen(harness.server);
  try {
    const ws = connectDevice(port, token);
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      deviceId: 'smoke-machine',
      elements: [{ id: 'relay', type: 'switch', actions: ['on'] }]
    }));
    await nextMessage(ws);

    await assert.rejects(
      harness.hub.trigger('smoke-machine', 'relay', 'off'),
      (error) => error.code === 'DEVICE_UNKNOWN_ACTION'
    );
    ws.close();
  } finally {
    await stopHarness(harness);
  }
});

test('trigger() timeout si le device ne répond pas', async () => {
  const harness = startHarness({ commandTimeoutMs: 50 });
  const { token } = await harness.tokenStore.generate('smoke-machine', 'Machine à fumée');
  const port = await listen(harness.server);
  try {
    const ws = connectDevice(port, token);
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      deviceId: 'smoke-machine',
      elements: [{ id: 'relay', type: 'switch', actions: ['trigger'] }]
    }));
    await nextMessage(ws); // registered, mais le device ne répond jamais aux commandes

    await assert.rejects(
      harness.hub.trigger('smoke-machine', 'relay', 'trigger'),
      (error) => error.code === 'DEVICE_TIMEOUT'
    );
    ws.close();
  } finally {
    await stopHarness(harness);
  }
});

test('une reconnexion avec le même deviceId remplace l’ancienne connexion', async () => {
  const harness = startHarness();
  const { token } = await harness.tokenStore.generate('smoke-machine', 'Machine à fumée');
  const port = await listen(harness.server);
  try {
    const helloMsg = JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      deviceId: 'smoke-machine',
      elements: [{ id: 'relay', type: 'switch', actions: ['trigger'] }]
    });

    const first = connectDevice(port, token);
    await once(first, 'open');
    first.send(helloMsg);
    await nextMessage(first);

    const firstClosed = once(first, 'close');
    const second = connectDevice(port, token);
    await once(second, 'open');
    second.send(helloMsg);
    await nextMessage(second);

    const [code] = await firstClosed;
    assert.equal(code, 4409);
    assert.equal(harness.hub.list().length, 1);
    second.close();
  } finally {
    await stopHarness(harness);
  }
});

test('disconnect() coupe immédiatement une connexion live (ex. token révoqué)', async () => {
  const harness = startHarness();
  const { token } = await harness.tokenStore.generate('smoke-machine', 'Machine à fumée');
  const port = await listen(harness.server);
  try {
    const ws = connectDevice(port, token);
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      deviceId: 'smoke-machine',
      elements: [{ id: 'relay', type: 'switch', actions: ['trigger'] }]
    }));
    await nextMessage(ws);
    assert.equal(harness.hub.list().length, 1);

    const closed = once(ws, 'close');
    assert.equal(harness.hub.disconnect('smoke-machine'), true);
    const [code] = await closed;
    assert.equal(code, 4403);
    assert.equal(harness.hub.list().length, 0);

    // Idempotent : rien à couper une deuxième fois.
    assert.equal(harness.hub.disconnect('smoke-machine'), false);
  } finally {
    await stopHarness(harness);
  }
});

test('la limite maxDevices refuse une nouvelle connexion avec le code 4409', async () => {
  const tokenStore = createDeviceTokenStore();
  const harness = startHarness({ tokenStore, maxDevices: 1 });
  const { token: tokenA } = await tokenStore.generate('device-a', 'A');
  const { token: tokenB } = await tokenStore.generate('device-b', 'B');
  const port = await listen(harness.server);
  try {
    const a = connectDevice(port, tokenA);
    await once(a, 'open');
    a.send(JSON.stringify({ type: 'hello', protocolVersion: 1, deviceId: 'device-a', elements: [] }));
    await nextMessage(a);

    const b = connectDevice(port, tokenB);
    const [code] = await once(b, 'close');
    assert.equal(code, 4409);
    a.close();
  } finally {
    await stopHarness(harness);
  }
});
