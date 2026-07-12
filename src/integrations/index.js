import { createSmokeIntegration } from './smoke.js';
import { createHueIntegration } from './hue.js';
import { createObsIntegration } from './obs.js';
import { createStreamerbotIntegration } from './streamerbot.js';
import { createLogger } from '../logger.js';

const log = createLogger('integrations');

/**
 * Enregistre les intégrations activées. `emitEvent` permet à une intégration de
 * REMONTER des events vers le cloud (ex. OBS scènes/stream). Point d'extension :
 * ajouter ici les futures intégrations locales (Streamer.bot, etc.).
 */
export function registerIntegrations(registry, config, { emitEvent } = {}) {
  for (const id of ['smoke', 'hue', 'obs', 'streamerbot']) registerIntegration(registry, id, config, { emitEvent });
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
