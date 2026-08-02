import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLogger } from './logger.js';
import { t } from './i18n/core.js';

const log = createLogger('device-hub');

export const DEVICES_WS_PATH = '/devices/ws';
const PROTOCOL_VERSION = 1;
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_ELEMENTS = 20;
const MAX_ACTIONS_PER_ELEMENT = 20;

function isOpen(ws) {
  return ws.readyState === ws.OPEN;
}

// Motif borné au préfixe (pas de quantificateur en fin de pattern qui chevaucherait le
// premier) — même garde anti-ReDoS que extractBearer côté companion-hub.js cloud.
function extractBearer(req) {
  const header = String(req.headers.authorization || '');
  const prefix = /^Bearer\s+/i.exec(header);
  return prefix ? header.slice(prefix[0].length).trim() : '';
}

// Normalise les éléments annoncés par un script à l'enregistrement : jamais de
// confiance aveugle dans ce qu'un device déclare (bornes de taille, types scalaires).
function sanitizeElements(elements) {
  if (!Array.isArray(elements)) return [];
  return elements
    .slice(0, MAX_ELEMENTS)
    .map((el) => ({
      id: String(el?.id || '').trim(),
      type: String(el?.type || 'switch').trim() || 'switch',
      name: String(el?.name || el?.id || '').trim(),
      actions: Array.isArray(el?.actions)
        ? [...new Set(el.actions.map(String))].slice(0, MAX_ACTIONS_PER_ELEMENT)
        : [],
      params: el?.params && typeof el.params === 'object' && !Array.isArray(el.params) ? el.params : {}
    }))
    .filter((el) => el.id);
}

/**
 * Hub des appareils LAN (RPi, ESP...) connectés au compagnon — même topologie que
 * CompanionHub côté cloud (server/companion-hub.js), un niveau plus bas : ici c'est le
 * COMPAGNON qui accepte des connexions WS SORTANTES de scripts tiers. Authentification
 * PAR DEVICE (header `Authorization: Bearer <token>` à l'upgrade, comme /companion/ws),
 * jamais COMPANION_LOCAL_TOKEN — un token device compromis ne permet de se faire passer
 * que pour CE device précis, jamais de déclencher une autre commande du compagnon.
 * Voir docs/local-device-agent-plan.md (repo Klixa) pour le protocole complet.
 */
export function createDeviceHub({
  tokenStore,
  maxDevices = 20,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  onEvent = null
} = {}) {
  if (!tokenStore) throw new Error('DeviceHub requiert un tokenStore');

  const connectionsByDeviceId = new Map(); // deviceId -> ws
  const pending = new Map(); // commandId -> { resolve, reject, timer, ws }
  const wss = new WebSocketServer({ noServer: true });

  function send(ws, obj) {
    if (isOpen(ws)) ws.send(JSON.stringify(obj));
  }

  function rejectPendingForConnection(ws, error) {
    for (const [id, entry] of pending) {
      if (entry.ws === ws) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(error);
      }
    }
  }

  function handleMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        send(ws, { type: 'registered', ok: false, error: t('errors.deviceProtocolVersion') });
        try { ws.close(4400, 'protocol-version'); } catch { /* déjà fermée */ }
        return;
      }
      ws.name = String(msg.name || ws.deviceId).trim();
      ws.elements = sanitizeElements(msg.elements);
      ws.registered = true;
      send(ws, { type: 'registered', ok: true });
      log.info(`Appareil enregistré : ${ws.deviceId}`, { elements: ws.elements.map((el) => el.id) });
      return;
    }

    if (!ws.registered) return; // tout le reste est ignoré tant que le hello n'est pas passé

    if (msg.type === 'event') {
      if (typeof onEvent === 'function') {
        try { onEvent({ deviceId: ws.deviceId, elementId: msg.elementId, data: msg.data }); }
        catch { /* un event KO ne casse pas la liaison */ }
      }
      return;
    }

    if (msg.type === 'ack') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.result ?? null);
      } else {
        const error = new Error(msg.error || t('errors.deviceCommandFailed'));
        error.code = msg.code;
        entry.reject(error);
      }
    }
  }

  function handleClose(ws) {
    if (connectionsByDeviceId.get(ws.deviceId) === ws) {
      connectionsByDeviceId.delete(ws.deviceId);
      log.warn(`Appareil déconnecté : ${ws.deviceId}`);
    }
    rejectPendingForConnection(ws, new Error(t('errors.deviceDisconnected')));
  }

  function handleConnection(ws) {
    // Une seule connexion active par device (script redémarré/reconnecté) : la nouvelle
    // remplace l'ancienne, jamais de doublon.
    const previous = connectionsByDeviceId.get(ws.deviceId);
    if (previous && previous !== ws) {
      try { previous.close(4409, 're-registered'); } catch { /* ignore */ }
    }

    ws.isAlive = true;
    ws.registered = false;
    ws.name = ws.deviceId;
    ws.elements = [];
    ws.connectedAt = Date.now();
    connectionsByDeviceId.set(ws.deviceId, ws);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => handleMessage(ws, data));
    ws.on('close', () => handleClose(ws));
    ws.on('error', () => { /* 'close' suivra */ });
  }

  wss.on('connection', (ws) => handleConnection(ws));

  const heartbeat = setInterval(() => {
    for (const ws of connectionsByDeviceId.values()) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  // Appelé par local-server.js pour le path /devices/ws, APRÈS ses propres gardes
  // anti-CSRF/anti-DNS-rebinding (Origin/Host) — ce hub ne fait que l'auth par token.
  function handleUpgrade(req, socket, head) {
    const token = extractBearer(req);
    const deviceId = tokenStore.resolveDeviceId(token);
    if (!deviceId) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        try { ws.close(4401, 'invalid-token'); } catch { /* déjà fermée */ }
      });
      return;
    }
    if (connectionsByDeviceId.size >= maxDevices && !connectionsByDeviceId.has(deviceId)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        try { ws.close(4409, 'limit-reached'); } catch { /* déjà fermée */ }
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.deviceId = deviceId;
      wss.emit('connection', ws, req);
    });
  }

  // Coupe IMMÉDIATEMENT la connexion live d'un device (ex. token révoqué depuis l'IHM) :
  // sans ça, un device déjà connecté restait pilotable jusqu'à sa prochaine reconnexion
  // (seule la ré-authentification aurait échoué), ce qui contredit l'intention d'un
  // "révoquer" (couper maintenant, pas juste verrouiller la porte pour la prochaine fois).
  function disconnect(deviceId, code = 4403, reason = 'revoked') {
    const ws = connectionsByDeviceId.get(String(deviceId || '').trim());
    if (!ws) return false;
    connectionsByDeviceId.delete(deviceId);
    try { ws.close(code, reason); } catch { /* déjà fermée */ }
    return true;
  }

  function list() {
    return [...connectionsByDeviceId.entries()]
      .filter(([, ws]) => ws.registered)
      .map(([deviceId, ws]) => ({
        deviceId,
        name: ws.name,
        elements: ws.elements,
        connectedAt: ws.connectedAt
      }));
  }

  function trigger(deviceId, elementId, action, { payload = {}, data = {} } = {}) {
    const ws = connectionsByDeviceId.get(String(deviceId || '').trim());
    if (!ws || !isOpen(ws) || !ws.registered) {
      const error = new Error(t('errors.deviceOffline', { deviceId }));
      error.code = 'DEVICE_OFFLINE';
      return Promise.reject(error);
    }
    const element = ws.elements.find((el) => el.id === elementId);
    if (!element || !element.actions.includes(action)) {
      const error = new Error(t('errors.deviceUnknownAction', { action, elementId }));
      error.code = 'DEVICE_UNKNOWN_ACTION';
      return Promise.reject(error);
    }

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(t('errors.deviceTimeout'));
        error.code = 'DEVICE_TIMEOUT';
        reject(error);
      }, commandTimeoutMs);

      pending.set(id, { resolve, reject, timer, ws });
      send(ws, {
        type: 'command',
        id,
        elementId,
        action,
        payload: payload && typeof payload === 'object' ? payload : {},
        data: data && typeof data === 'object' ? data : {}
      });
    });
  }

  function stop() {
    clearInterval(heartbeat);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(t('errors.deviceHubStopped')));
    }
    pending.clear();
    for (const ws of connectionsByDeviceId.values()) {
      try { ws.close(1001, 'shutting-down'); } catch { /* ignore */ }
    }
    connectionsByDeviceId.clear();
  }

  return { handleUpgrade, list, trigger, disconnect, stop };
}
