import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import electron from 'electron';

const { safeStorage } = electron;

// Ancienne clé de l'état mesh SmallRig (support retiré du compagnon) : purgée de la config au chargement.
const LEGACY_MESH_STATE_KEY = 'SMALLRIG_MESH_STATE';

const secretKeys = new Set(['COMPANION_TOKEN', 'OBS_WS_PASSWORD', 'SB_PASSWORD', 'HUE_APP_KEY', 'COMPANION_LOCAL_TOKEN']);

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export class ConfigStore {
  constructor(userDataPath, { storage = safeStorage } = {}) {
    this.file = path.join(userDataPath, 'config.json');
    this.storage = storage;
  }

  load() {
    try {
      fs.chmodSync(this.file, 0o600);
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Le support SmallRig a quitté le compagnon : on retire l'ancien état mesh (chiffré) du fichier.
      const hadLegacyMesh = LEGACY_MESH_STATE_KEY in value;
      delete value[LEGACY_MESH_STATE_KEY];
      for (const key of secretKeys) value[key] = this.#decrypt(key, value[key]);
      if (hadLegacyMesh) this.save(value);
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new Error(`Configuration locale illisible (${this.file}) : ${error.message}`, { cause: error });
    }
  }

  save(value) {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true });
    const stored = { ...value };
    for (const key of secretKeys) stored[key] = this.#encrypt(key, stored[key]);

    const serialized = `${JSON.stringify(stored, null, 2)}\n`;
    const temporaryFile = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryFile, this.file);
      fsyncDirectory(directory);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* déjà fermé */ }
      }
      try { fs.unlinkSync(temporaryFile); } catch { /* rien à nettoyer */ }
      throw error;
    }
  }

  #encrypt(key, value = '') {
    if (!value) return value;
    if (!this.storage?.isEncryptionAvailable()) return value;
    return `encrypted:${this.storage.encryptString(value).toString('base64')}`;
  }

  #decrypt(key, value = '') {
    if (!value.startsWith?.('encrypted:')) return value;
    try {
      return this.storage.decryptString(Buffer.from(value.slice(10), 'base64'));
    } catch (error) {
      throw new Error(`Impossible de déchiffrer ${key}`, { cause: error });
    }
  }
}
