import { createLogger } from './logger.js';
import { createIntegrationRegistry } from './integration-registry.js';
import { registerIntegrations } from './integrations/index.js';
import { createCloudLink } from './cloud-link.js';
import { createLocalServer } from './local-server.js';

const log = createLogger('runtime');

export function startCompanion(config, { onCloudStatus } = {}) {
  const registry = createIntegrationRegistry();
  const cloudLink = createCloudLink(config.cloud, registry, { onCloudStatus });
  registerIntegrations(registry, config, { emitEvent: (event) => cloudLink.sendEvent(event) });
  const localServer = createLocalServer(config, registry);
  cloudLink.start();
  localServer.start();
  log.info('Compagnon Klixa demarre', { commands: registry.listCommands() });

  let stopping;
  return {
    commands: registry.listCommands(),
    stop() {
      stopping ||= Promise.allSettled([cloudLink.stop(), localServer.stop(), registry.stop()]);
      return stopping;
    }
  };
}
