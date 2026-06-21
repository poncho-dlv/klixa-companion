import http from 'node:http';
import { createLogger } from './logger.js';

const log = createLogger('local-server');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString() || '{}'));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * Serveur HTTP local : santé + déclenchement manuel des commandes (test sans
 * cloud, ou pilotage depuis le LAN). Même chemin de dispatch que la liaison cloud.
 */
export function createLocalServer(config, registry) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        const integrations = await registry.healthcheck();
        json(res, 200, { ok: true, commands: registry.listCommands(), integrations });
        return;
      }

      // POST /commands/:name — déclenchement local (ex. POST /commands/smoke.trigger {"durationMs":300})
      const match = url.pathname.match(/^\/commands\/([\w.-]+)$/);
      if (req.method === 'POST' && match) {
        if (config.localToken && req.headers['x-companion-token'] !== config.localToken) {
          json(res, 401, { ok: false, error: 'Token invalide' });
          return;
        }
        let payload = {};
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { ok: false, error: 'JSON invalide' });
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

  function start() {
    server.listen(config.port, () => log.info(`Serveur local sur le port ${config.port}`));
  }

  function stop() {
    server.close();
  }

  return { start, stop };
}
