import { WebSocket } from 'ws';
import { createLogger } from './logger.js';

const log = createLogger('cloud-link');

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
    try {
      const result = await registry.dispatch(name, payload);
      send({ type: 'ack', id, ok: true, result });
    } catch (err) {
      log.error(`Échec commande ${name}`, err.message);
      send({ type: 'ack', id, ok: false, error: err.message, code: err.code });
    }
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
      send({
        type: 'hello',
        tenantId: config.tenantId,
        token: config.token,
        capabilities: registry.listCommands(),
      });
    });
    ws.on('message', (data) => handleMessage(data.toString()));
    ws.on('close', () => {
      log.warn('Liaison cloud fermée');
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
    if (ws) ws.close();
  }

  return { start, stop, send };
}
