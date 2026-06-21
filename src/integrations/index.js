import { createSmokeIntegration } from './smoke.js';
import { createLogger } from '../logger.js';

const log = createLogger('integrations');

/**
 * Enregistre les intégrations activées. Point d'extension : ajouter ici les
 * futures intégrations locales (Hue, Streamer.bot, etc.).
 */
export function registerIntegrations(registry, config) {
  if (config.smoke.enabled) {
    try {
      registry.register(createSmokeIntegration(config.smoke));
    } catch (err) {
      log.error('Intégration fumée non chargée', err.message);
    }
  }
}
