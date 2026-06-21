import { createSmokeIntegration } from './smoke.js';
import { createHueIntegration } from './hue.js';
import { createLogger } from '../logger.js';

const log = createLogger('integrations');

/**
 * Enregistre les intégrations activées. Point d'extension : ajouter ici les
 * futures intégrations locales (Streamer.bot, OBS, etc.).
 */
export function registerIntegrations(registry, config) {
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
}
