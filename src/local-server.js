import http from 'node:http';
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('local-server');
const MAX_BODY_BYTES = 64 * 1024;

export function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const declaredLength = req.headers?.['content-length'];
    if (declaredLength !== undefined) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length < 0) {
        const error = new Error('Content-Length invalide');
        error.code = 'INVALID_CONTENT_LENGTH';
        reject(error);
        return;
      }
      if (length > maxBytes) {
        const error = new Error('Corps de requête trop volumineux');
        error.code = 'PAYLOAD_TOO_LARGE';
        reject(error);
        return;
      }
    }
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('Corps de requête trop volumineux');
        error.code = 'PAYLOAD_TOO_LARGE';
        reject(error);
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString() || '{}'));
    req.on('error', reject);
    req.on('aborted', () => {
      const error = new Error('Requête interrompue');
      error.code = 'REQUEST_ABORTED';
      reject(error);
    });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function integrationsAreHealthy(integrations) {
  return Object.values(integrations).every((integration) => integration?.ok === true);
}

export function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase());
}

// Extrait le nom d'hôte (sans port, crochets IPv6 retirés) d'un header Host ou d'une
// valeur Origin. Renvoie '' si non analysable.
function hostnameOf(value) {
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`http://${value}`);
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

// Anti-CSRF : un navigateur envoie TOUJOURS un header Origin sur une requête
// cross-origin (et sur les POST). Un client légitime hors navigateur (curl, script,
// healthcheck) n'en envoie pas. On refuse donc tout Origin présent qui ne
// pointe pas vers la loopback — ce qui neutralise une page malveillante visitée par
// le streamer, quel que soit le Content-Type.
export function isAllowedOrigin(originHeader) {
  if (originHeader === undefined || originHeader === null || originHeader === '') return true;
  return isLoopbackHost(hostnameOf(String(originHeader)));
}

// Anti-DNS-rebinding : une attaque par rebinding fait résoudre un NOM de domaine
// (attacker.example) vers 127.0.0.1 pour parler au serveur en « same-origin ». Le
// header Host porte alors ce domaine. On n'autorise donc que la loopback, une IP
// littérale (impossible à rebinder), ou l'hôte explicitement configuré.
export function isAllowedRequestHost(hostHeader, configHost) {
  const hostname = hostnameOf(String(hostHeader ?? ''));
  if (!hostname) return false;
  if (isLoopbackHost(hostname)) return true;
  if (net.isIP(hostname)) return true;
  return Boolean(configHost) && hostname === String(configHost).toLowerCase();
}

export function tokenMatches(actual, expected) {
  if (!expected || typeof actual !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

/**
 * Serveur HTTP local : santé + déclenchement manuel des commandes (test sans
 * cloud, ou pilotage depuis le LAN). Même chemin de dispatch que la liaison cloud.
 */
export function createLocalServer(config, registry) {
  const host = config.host || '127.0.0.1';
  if (config.production && !isLoopbackHost(host) && !config.localToken) {
    throw new Error('COMPANION_LOCAL_TOKEN obligatoire en production lorsque le serveur écoute sur le LAN');
  }
  const server = http.createServer(async (req, res) => {
    try {
      // Le serveur n'a AUCUN client navigateur légitime (le renderer desktop passe par
      // IPC, jamais par HTTP). On rejette donc toute requête cross-origin ou dont le Host
      // est un domaine non autorisé : sans ça, une page web visitée par le streamer
      // pourrait piloter les commandes locales (fumée, actions Streamer.bot, Hue, OBS)
      // via une « simple request » non soumise au préflight CORS.
      if (!isAllowedOrigin(req.headers.origin) || !isAllowedRequestHost(req.headers.host, host)) {
        json(res, 403, { ok: false, error: 'Origine non autorisée' });
        return;
      }

      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/live') {
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        const integrations = await registry.healthcheck();
        const ok = integrationsAreHealthy(integrations);
        json(res, ok ? 200 : 503, { ok, commands: registry.listCommands(), integrations });
        return;
      }

      // POST /commands/:name — déclenchement local (ex. POST /commands/smoke.trigger {"durationMs":300})
      const match = url.pathname.match(/^\/commands\/([\w.-]+)$/);
      if (req.method === 'POST' && match) {
        if (config.localToken && !tokenMatches(req.headers['x-companion-token'], config.localToken)) {
          json(res, 401, { ok: false, error: 'Token invalide' });
          return;
        }
        let payload = {};
        try {
          payload = JSON.parse(await readBody(req));
        } catch (err) {
          const status = err.code === 'PAYLOAD_TOO_LARGE' ? 413
            : err.code === 'REQUEST_ABORTED' ? 408
              : 400;
          json(res, status, { ok: false, error: err.code ? err.message : 'JSON invalide' });
          return;
        }
        try {
          const result = await registry.dispatch(match[1], payload);
          json(res, 200, { ok: true, result });
        } catch (err) {
          json(res, err.code === 'UNKNOWN_COMMAND' ? 404 : 500, { ok: false, error: err.message });
        }
        return;
      }

      json(res, 404, { ok: false, error: 'Route inconnue' });
    } catch (err) {
      log.error('Erreur serveur local', err.message);
      json(res, 500, { ok: false, error: err.message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 15000;

  function start() {
    server.listen(config.port, host, () => log.info(`Serveur local sur ${host}:${config.port}`));
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  }

  return { start, stop, address: () => server.address() };
}
