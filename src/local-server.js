import http from 'node:http';
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

  return { start, stop };
}
