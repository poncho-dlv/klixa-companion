import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCommandDeduplicator, createWebSocketHeartbeat } from '../src/cloud-link.js';

test('le déduplicateur exécute une commande simultanée une seule fois', async () => {
  const deduplicator = createCommandDeduplicator();
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const task = async () => {
    calls++;
    await blocked;
    return { ok: true };
  };

  const first = deduplicator.execute('cmd-1', task);
  const duplicate = deduplicator.execute('cmd-1', task);
  release();

  assert.strictEqual(first, duplicate);
  assert.deepEqual(await first, { ok: true });
  assert.equal(calls, 1);
});

test('le déduplicateur réexécute une commande après expiration', async () => {
  let time = 1000;
  const deduplicator = createCommandDeduplicator({ ttlMs: 100, now: () => time });
  let calls = 0;
  const task = async () => ++calls;

  assert.equal(await deduplicator.execute('cmd-1', task), 1);
  time += 101;
  assert.equal(await deduplicator.execute('cmd-1', task), 2);
});

test('le déduplicateur borne le nombre de commandes mémorisées', async () => {
  const deduplicator = createCommandDeduplicator({ maxEntries: 2 });
  let calls = 0;
  const task = async () => ++calls;

  await deduplicator.execute('cmd-1', task);
  await deduplicator.execute('cmd-2', task);
  await deduplicator.execute('cmd-3', task);
  assert.equal(await deduplicator.execute('cmd-1', task), 4);
});

test('le heartbeat envoie un ping et accepte un pong', () => {
  const socket = new EventEmitter();
  let ticks;
  let pings = 0;
  let timedOut = false;
  socket.ping = () => { pings++; };
  const stop = createWebSocketHeartbeat(socket, {
    setIntervalFn: (callback) => { ticks = callback; return { unref() {} }; },
    clearIntervalFn: () => {},
    onTimeout: () => { timedOut = true; }
  });

  ticks();
  socket.emit('pong');
  ticks();
  assert.equal(pings, 2);
  assert.equal(timedOut, false);
  stop();
  assert.equal(socket.listenerCount('pong'), 0);
});

test('le heartbeat expire après un ping sans pong', () => {
  const socket = new EventEmitter();
  let ticks;
  let timedOut = false;
  socket.ping = () => {};
  createWebSocketHeartbeat(socket, {
    setIntervalFn: (callback) => { ticks = callback; return { unref() {} }; },
    clearIntervalFn: () => {},
    onTimeout: () => { timedOut = true; }
  });

  ticks();
  ticks();
  assert.equal(timedOut, true);
});
