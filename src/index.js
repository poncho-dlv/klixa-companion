import process from 'node:process';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { startCompanion } from './runtime.js';

const log = createLogger('main');
const runtime = startCompanion(config);
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Arret (${signal})`);
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5000);
    timer.unref?.();
  });
  const result = await Promise.race([runtime.stop(), timeout]);
  if (result === 'timeout') log.warn('Delai maximal d arret atteint');
  process.exitCode = 0;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
