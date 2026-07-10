import { WebSocket } from 'ws';
import { createLogger } from './logger.js';

const log = createLogger('cloud-link');
const COMMAND_CACHE_TTL_MS = 5 * 60 * 1000;
const COMMAND_CACHE_MAX_ENTRIES = 1000;

export function createWebSocketHeartbeat(socket, {
  intervalMs = 30000,
  onTimeout = () => socket.terminate(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  let alive = true;
  const onPong = () => { alive = true; };
  socket.on('pong', onPong);
  const timer = setIntervalFn(() => {
    if (!alive) {
      onTimeout();
      return;
    }
    alive = false;
    socket.ping();
  }, intervalMs);
  timer.unref?.();

  return function stopHeartbeat() {
    clearIntervalFn(timer);
    socket.off('pong', onPong);
  };
}

export function createCommandDeduplicator({
  ttlMs = COMMAND_CACHE_TTL_MS,
  maxEntries = COMMAND_CACHE_MAX_ENTRIES,
  now = Date.now
} = {}) {
  const entries = new Map();

  function purgeExpired() {
    const currentTime = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt > currentTime) break;
      entries.delete(id);
    }
  }

  function execute(id, task) {
    purgeExpired();
    const existing = entries.get(id);
    if (existing) return existing.promise;

    const promise = Promise.resolve().then(task);
    entries.set(id, { expiresAt: now() + ttlMs, promise });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    return promise;
  }

  return { execute };
}

/**
 * Liaison SORTANTE et persistante vers le serveur Klixa cloud. Le compagnon est
 * client : il ouvre la connexion, le cloud pousse des commandes dedans. Aucune
 * connexion entrante n'est nécessaire (NAS/RPi restent injoignables de l'extérieur).
 */
export function createCloudLink(config, registry) {
  let ws = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;
  let stopHeartbeat = null;
  const commandDeduplicator = createCommandDeduplicator();

  function scheduleReconnect() {
    if (stopped) return;
    attempt += 1;
    const { minDelayMs, maxDelayMs } = config.reconnect;
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** (attempt - 1));
    log.warn(`Reconnexion dans ${delay} ms (tentative ${attempt})`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Remontée d'un event local vers le cloud (ex. OBS scènes/stream). Forme du payload =
  // event « brut » { event:{source,type}, data } directement consommable par le cloud
  // (processRawEvent). Émis seulement si la liaison est ouverte (pas de file : un event
  // physique tardif n'a pas de sens à rejouer).
  function sendEvent(payload) {
    send({ type: 'event', payload });
  }

  async function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn('Message illisible ignoré');
      return;
    }
    if (msg.type !== 'command') return;
    const { id, name, payload } = msg;
    if (typeof id !== 'string' || !id.trim()) {
      send({ type: 'ack', id: id ?? null, ok: false, error: 'Identifiant de commande invalide', code: 'INVALID_COMMAND_ID' });
      return;
    }
    const ack = await commandDeduplicator.execute(id, async () => {
      try {
        const result = await registry.dispatch(name, payload);
        return { type: 'ack', id, ok: true, result };
      } catch (err) {
        log.error(`Échec commande ${name}`, err.message);
        return { type: 'ack', id, ok: false, error: err.message, code: err.code };
      }
    });
    send(ack);
  }

  function connect() {
    if (stopped) return;
    if (!config.url) {
      log.warn('CLOUD_WS_URL non défini — liaison cloud désactivée (mode local seul)');
      return;
    }
    log.info(`Connexion à ${config.url}`);
    ws = new WebSocket(config.url, {
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
      // Échoue vite si le handshake n'aboutit pas (ex. 524 Cloudflare ~100 s) pour
      // que le backoff de reconnexion s'applique au lieu de pendre.
      handshakeTimeout: 10000,
    });

    ws.on('open', () => {
      attempt = 0;
      log.info('Liaison cloud établie');
      stopHeartbeat?.();
      stopHeartbeat = createWebSocketHeartbeat(ws, {
        intervalMs: config.heartbeatMs || 30000,
        onTimeout: () => {
          log.warn('Heartbeat cloud expiré — reconnexion');
          ws.terminate();
        }
      });
      send({
        type: 'hello',
        tenantId: config.tenantId,
        token: config.token,
        capabilities: registry.listCommands(),
      });
    });
    ws.on('message', (data) => handleMessage(data.toString()));
    ws.on('close', (code, reason) => {
      stopHeartbeat?.();
      stopHeartbeat = null;
      const detail = reason?.toString() || '';
      log.warn(`Liaison cloud fermée${code ? ` (code ${code}${detail ? ` : ${detail}` : ''})` : ''}`);
      scheduleReconnect();
    });
    ws.on('error', (err) => {
      // 'close' suivra et déclenchera la reconnexion.
      log.error('Erreur liaison cloud', err.message);
    });
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopHeartbeat?.();
    stopHeartbeat = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const socket = ws;
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 2000);
      timer.unref?.();
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
    });
  }

  return { start, stop, send, sendEvent };
}
