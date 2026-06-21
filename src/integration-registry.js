import { createLogger } from './logger.js';

const log = createLogger('registry');

/**
 * Registre des intégrations locales. Chaque intégration expose :
 *   { id, commands: { 'nom.commande': async (payload) => result }, healthcheck?: async () => ({...}) }
 * Le registre agrège toutes les commandes dans une map unique pour le dispatch.
 */
export function createIntegrationRegistry() {
  const integrations = new Map(); // id -> integration
  const commands = new Map(); // name -> { integrationId, handler }

  function register(integration) {
    if (!integration?.id) throw new Error('Intégration sans id');
    if (integrations.has(integration.id)) {
      throw new Error(`Intégration déjà enregistrée : ${integration.id}`);
    }
    integrations.set(integration.id, integration);
    for (const [name, handler] of Object.entries(integration.commands || {})) {
      if (commands.has(name)) throw new Error(`Commande en double : ${name}`);
      commands.set(name, { integrationId: integration.id, handler });
    }
    log.info(`Intégration enregistrée : ${integration.id}`, Object.keys(integration.commands || {}));
  }

  async function dispatch(name, payload) {
    const entry = commands.get(name);
    if (!entry) {
      const error = new Error(`Commande inconnue : ${name}`);
      error.code = 'UNKNOWN_COMMAND';
      throw error;
    }
    return entry.handler(payload ?? {});
  }

  function listCommands() {
    return [...commands.keys()];
  }

  async function healthcheck() {
    const result = {};
    for (const [id, integration] of integrations) {
      if (typeof integration.healthcheck !== 'function') {
        result[id] = { ok: true };
        continue;
      }
      try {
        result[id] = { ok: true, ...(await integration.healthcheck()) };
      } catch (err) {
        result[id] = { ok: false, error: err.message };
      }
    }
    return result;
  }

  return { register, dispatch, listCommands, healthcheck };
}
