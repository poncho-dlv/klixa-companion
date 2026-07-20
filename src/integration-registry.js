import { createLogger } from './logger.js';

const log = createLogger('registry');

/**
 * Registre des intégrations locales. Chaque intégration expose :
 *   { id, commands: { 'nom.commande': async (payload) => result },
 *     commandScopes?: { 'nom.commande': 'all' | 'local' }, healthcheck?: async () => ({...}) }
 * Le registre agrège toutes les commandes dans une map unique pour le dispatch.
 */
export function createIntegrationRegistry({ healthcheckTimeoutMs = 5000 } = {}) {
  const integrations = new Map(); // id -> integration
  const commands = new Map(); // name -> { integrationId, handler }

  function validateSource(source) {
    if (!['local', 'cloud'].includes(source)) throw new Error(`Source de commande invalide : ${source}`);
  }

  function register(integration) {
    if (!integration?.id) throw new Error('Intégration sans id');
    if (integrations.has(integration.id)) {
      throw new Error(`Intégration déjà enregistrée : ${integration.id}`);
    }
    integrations.set(integration.id, integration);
    for (const [name, handler] of Object.entries(integration.commands || {})) {
      if (commands.has(name)) throw new Error(`Commande en double : ${name}`);
      const scope = integration.commandScopes?.[name] ?? 'all';
      if (!['all', 'local'].includes(scope)) {
        throw new Error(`Portée invalide pour la commande ${name} : ${scope}`);
      }
      commands.set(name, { integrationId: integration.id, handler, scope });
    }
    log.info(`Intégration enregistrée : ${integration.id}`, Object.keys(integration.commands || {}));
  }

  async function unregister(id) {
    const integration = integrations.get(id);
    if (!integration) return;
    integrations.delete(id);
    for (const [name, entry] of commands) {
      if (entry.integrationId === id) commands.delete(name);
    }
    if (typeof integration.stop === 'function') await integration.stop();
  }

  async function dispatch(name, payload, { source = 'local' } = {}) {
    validateSource(source);
    const entry = commands.get(name);
    if (!entry) {
      const error = new Error(`Commande inconnue : ${name}`);
      error.code = 'UNKNOWN_COMMAND';
      throw error;
    }
    if (source === 'cloud' && entry.scope === 'local') {
      const error = new Error(`Commande réservée au compagnon local : ${name}`);
      error.code = 'COMMAND_NOT_ALLOWED';
      throw error;
    }
    return entry.handler(payload ?? {});
  }

  function listCommands({ source = 'local' } = {}) {
    validateSource(source);
    return [...commands]
      .filter(([, entry]) => source !== 'cloud' || entry.scope !== 'local')
      .map(([name]) => name);
  }

  async function healthcheck() {
    const checks = [...integrations].map(async ([id, integration]) => {
      if (typeof integration.healthcheck !== 'function') {
        return [id, { ok: true }];
      }
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Healthcheck expiré après ${healthcheckTimeoutMs} ms`)), healthcheckTimeoutMs);
        });
        const details = await Promise.race([integration.healthcheck(), timeout]);
        return [id, { ok: true, ...details }];
      } catch (err) {
        return [id, { ok: false, error: err.message }];
      } finally {
        clearTimeout(timer);
      }
    });
    return Object.fromEntries(await Promise.all(checks));
  }

  async function stop() {
    const stops = [];
    for (const integration of integrations.values()) {
      if (typeof integration.stop === 'function') {
        stops.push(Promise.resolve().then(() => integration.stop()));
      }
    }
    const results = await Promise.allSettled(stops);
    for (const result of results) {
      if (result.status === 'rejected') log.error('Erreur à l’arrêt d’une intégration', result.reason?.message);
    }
  }

  return { register, unregister, dispatch, listCommands, healthcheck, stop };
}
