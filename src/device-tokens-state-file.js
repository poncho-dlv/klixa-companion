import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicWrite(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* déjà fermé */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* rien à nettoyer */ }
    throw error;
  }
}

/**
 * Branche une persistance durable pour le mode headless (mêmes garanties que
 * configureHeadlessSmallrigState, cf. smallrig-state-file.js) : sans fichier explicite,
 * générer un token échoue plutôt que de laisser le registre disparaître silencieusement
 * au prochain redémarrage (perte de tokens déjà distribués à des scripts en prod).
 */
export function configureHeadlessDeviceTokensState(devicesConfig, { cwd = process.cwd() } = {}) {
  if (!devicesConfig?.enabled) return devicesConfig;

  const configuredPath = String(devicesConfig.tokensFile || '').trim();
  if (!configuredPath) {
    devicesConfig.onTokensChange = async () => {
      const error = new Error('DEVICES_TOKENS_FILE est obligatoire en mode headless pour persister les tokens des appareils');
      error.code = 'DEVICES_TOKENS_FILE_REQUIRED';
      throw error;
    };
    return devicesConfig;
  }

  const file = path.resolve(cwd, configuredPath);
  try {
    fs.chmodSync(file, 0o600);
    devicesConfig.tokensJson = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`État des tokens device illisible (${file}) : ${error.message}`, { cause: error });
    }
  }

  devicesConfig.onTokensChange = async (tokensJson) => {
    atomicWrite(file, `${tokensJson}\n`);
  };
  devicesConfig.tokensFile = file;
  return devicesConfig;
}
