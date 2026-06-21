import process from 'node:process';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { createIntegrationRegistry } from './integration-registry.js';
import { registerIntegrations } from './integrations/index.js';
import { createCloudLink } from './cloud-link.js';
import { createLocalServer } from './local-server.js';

const log = createLogger('main');

const registry = createIntegrationRegistry();
const cloudLink = createCloudLink(config.cloud, registry);

// Les intégrations remontent leurs events via la liaison cloud (ex. OBS scènes/stream).
registerIntegrations(registry, config, { emitEvent: (event) => cloudLink.sendEvent(event) });

const localServer = createLocalServer(config, registry);

cloudLink.start();
localServer.start();

log.info('Compagnon Klixa démarré', { commands: registry.listCommands() });

function shutdown(signal) {
  log.info(`Arrêt (${signal})`);
  cloudLink.stop();
  localServer.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
