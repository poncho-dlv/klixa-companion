import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import electron from 'electron';

const { safeStorage } = electron;

const secretKeys = new Set(['COMPANION_TOKEN', 'OBS_WS_PASSWORD', 'SB_PASSWORD', 'HUE_APP_KEY', 'SMOKE_SERVICE_TOKEN', 'SMALLRIG_MESH_STATE']);

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
      const migratePlaintextMesh = Boolean(
        value.SMALLRIG_MESH_STATE
        && !value.SMALLRIG_MESH_STATE.startsWith?.('encrypted:')
        && this.storage?.isEncryptionAvailable?.()
      );
      for (const key of secretKeys) value[key] = this.#decrypt(key, value[key]);
      // Migration des versions ayant déjà écrit cet état avant qu'il soit classé
      // secret. Une écriture atomique immédiate évite de le laisser en clair jusqu'à
      // la prochaine modification de configuration.
      if (migratePlaintextMesh) this.save(value);
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
    if (!this.storage?.isEncryptionAvailable()) {
      if (key === 'SMALLRIG_MESH_STATE') {
        throw new Error('Stockage sécurisé indisponible : l’état Mesh SmallRig ne sera pas enregistré en clair');
      }
      return value;
    }
    return `encrypted:${this.storage.encryptString(value).toString('base64')}`;
  }

  #decrypt(key, value = '') {
    if (!value.startsWith?.('encrypted:')) {
      if (key === 'SMALLRIG_MESH_STATE' && value && !this.storage?.isEncryptionAvailable?.()) {
        throw new Error('Stockage sécurisé indisponible : refus de charger un état Mesh SmallRig en clair');
      }
      return value;
    }
    try {
      return this.storage.decryptString(Buffer.from(value.slice(10), 'base64'));
    } catch (error) {
      throw new Error(`Impossible de déchiffrer ${key}`, { cause: error });
    }
  }
}
