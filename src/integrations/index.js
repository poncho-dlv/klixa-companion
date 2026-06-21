import { createSmokeIntegration } from './smoke.js';
import { createHueIntegration } from './hue.js';
import { createObsIntegration } from './obs.js';
import { createLogger } from '../logger.js';

const log = createLogger('integrations');

/**
 * Enregistre les intégrations activées. `emitEvent` permet à une intégration de
 * REMONTER des events vers le cloud (ex. OBS scènes/stream). Point d'extension :
 * ajouter ici les futures intégrations locales (Streamer.bot, etc.).
 */
export function registerIntegrations(registry, config, { emitEvent } = {}) {
  if (config.smoke.enabled) {
    try {
      registry.register(createSmokeIntegration(config.smoke));
    } catch (err) {
      log.error('Intégration fumée non chargée', err.message);
    }
  }

  if (config.hue.enabled) {
    try {
      registry.register(createHueIntegration(config.hue));
    } catch (err) {
      log.error('Intégration Hue non chargée', err.message);
    }
  }

  if (config.obs.enabled) {
    try {
      registry.register(createObsIntegration(config.obs, { emitEvent }));
    } catch (err) {
      log.error('Intégration OBS non chargée', err.message);
    }
  }
}
