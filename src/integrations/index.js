import { createSmokeIntegration } from './smoke.js';
import { createHueIntegration } from './hue.js';
import { createSmallrigIntegration } from './smallrig/index.js';
import { createObsIntegration } from './obs.js';
import { createStreamerbotIntegration } from './streamerbot.js';
import { createLogger } from '../logger.js';

const log = createLogger('integrations');

const SMALLRIG_COMMAND_SCOPES = {
  'smallrig.discover': 'local',
  'smallrig.provision': 'local',
  'smallrig.reconfigure': 'local',
  'smallrig.forget': 'local',
  'smallrig.list': 'all',
  'smallrig.color': 'all',
  'smallrig.power': 'all',
  'smallrig.fx': 'all',
  'smallrig.status': 'all'
};

function registerUnavailableSmallrig(registry, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const unavailable = async () => {
    const error = new Error(`Intégration SmallRig indisponible : ${detail}`, { cause });
    error.code = 'INTEGRATION_UNAVAILABLE';
    throw error;
  };
  registry.register({
    id: 'smallrig',
    commands: Object.fromEntries(Object.keys(SMALLRIG_COMMAND_SCOPES).map((name) => [name, unavailable])),
    commandScopes: SMALLRIG_COMMAND_SCOPES,
    healthcheck: unavailable
  });
}

/**
 * Enregistre les intégrations activées. `emitEvent` permet à une intégration de
 * REMONTER des events vers le cloud (ex. OBS scènes/stream). Point d'extension :
 * ajouter ici les futures intégrations locales (Streamer.bot, etc.).
 */
export function registerIntegrations(registry, config, { emitEvent } = {}) {
  for (const id of ['smoke', 'hue', 'smallrig', 'obs', 'streamerbot']) registerIntegration(registry, id, config, { emitEvent });
}

export function registerIntegration(registry, id, config, { emitEvent } = {}) {
  if (id === 'smoke' && config.smoke.enabled) {
    try {
      registry.register(createSmokeIntegration(config.smoke));
    } catch (err) {
      log.error('Intégration fumée non chargée', err.message);
    }
  }

  if (id === 'hue' && config.hue.enabled) {
    try {
      registry.register(createHueIntegration(config.hue));
    } catch (err) {
      log.error('Intégration Hue non chargée', err.message);
    }
  }

  if (id === 'smallrig' && config.smallrig.enabled) {
    try {
      registry.register(createSmallrigIntegration(config.smallrig));
    } catch (err) {
      log.error('Intégration SmallRig non chargée', err.message);
      // Conserver une entrée dégradée rend l'échec visible dans le healthcheck et
      // renvoie la cause réelle aux IPC au lieu de « Commande inconnue ».
      registerUnavailableSmallrig(registry, err);
    }
  }

  if (id === 'obs' && config.obs.enabled) {
    try {
      registry.register(createObsIntegration(config.obs, { emitEvent }));
    } catch (err) {
      log.error('Intégration OBS non chargée', err.message);
    }
  }

  if (id === 'streamerbot' && config.streamerbot.enabled) {
    try {
      registry.register(createStreamerbotIntegration(config.streamerbot, { emitEvent }));
    } catch (err) {
      log.error('Intégration Streamer.bot non chargée', err.message);
    }
  }
}
