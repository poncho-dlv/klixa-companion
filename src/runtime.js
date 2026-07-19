import { createLogger } from './logger.js';
import { createIntegrationRegistry } from './integration-registry.js';
import { registerIntegration, registerIntegrations } from './integrations/index.js';
import { createCloudLink } from './cloud-link.js';
import { createLocalServer } from './local-server.js';

const log = createLogger('runtime');
const INTEGRATION_STATUS_POLL_MS = 5000;

export function startCompanion(config, { onCloudStatus, onIntegrationStatus } = {}) {
  const registry = createIntegrationRegistry();
  const cloudLink = createCloudLink(config.cloud, registry, { onCloudStatus });
  registerIntegrations(registry, config, { emitEvent: (event) => cloudLink.sendEvent(event) });
  const localServer = createLocalServer(config, registry);
  cloudLink.start();
  localServer.start();
  log.info('Compagnon Klixa demarre', { commands: registry.listCommands() });

  // Statut connecte/deconnecte par integration pour l'UI desktop (OBS, Streamer.bot,
  // fumee, Hue) : reutilise le healthcheck deja expose sur /health, en polling plutot
  // qu'en push, car OBS/Streamer.bot n'exposent pas d'event de connexion et
  // fumee/Hue n'ont pas de connexion persistante (juste des requetes HTTP).
  let healthTimer;
  if (onIntegrationStatus) {
    const pollHealth = async () => {
      try {
        onIntegrationStatus(await registry.healthcheck());
      } catch (err) {
        log.error('Echec healthcheck integrations', err.message);
      }
    };
    pollHealth();
    healthTimer = setInterval(pollHealth, INTEGRATION_STATUS_POLL_MS);
    healthTimer.unref?.();
  }

  let stopping;
  return {
    commands: registry.listCommands(),
    // Dispatch direct d'une commande enregistrée (ex. `smallrig.discover`), pour les
    // actions déclenchées depuis l'IHM desktop (cf. desktop/main.js IPC `smallrig:*`)
    // sans passer par le serveur HTTP local ni recréer l'intégration.
    dispatch(name, payload) {
      return registry.dispatch(name, payload);
    },
    async reconfigureIntegration(id, nextConfig) {
      await registry.unregister(id);
      registerIntegration(registry, id, nextConfig, { emitEvent: (event) => cloudLink.sendEvent(event) });
      if (onIntegrationStatus) onIntegrationStatus(await registry.healthcheck());
    },
    stop() {
      if (healthTimer) clearInterval(healthTimer);
      stopping ||= Promise.allSettled([cloudLink.stop(), localServer.stop(), registry.stop()]);
      return stopping;
    }
  };
}
