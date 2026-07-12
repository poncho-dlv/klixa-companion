import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const { safeStorage } = electron;

const secretKeys = new Set(['COMPANION_TOKEN', 'OBS_WS_PASSWORD', 'SB_PASSWORD', 'HUE_APP_KEY']);

export class ConfigStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'config.json');
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of secretKeys) value[key] = this.#decrypt(value[key]);
      return value;
    } catch {
      return {};
    }
  }

  save(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const stored = { ...value };
    for (const key of secretKeys) stored[key] = this.#encrypt(stored[key]);
    fs.writeFileSync(this.file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  }

  #encrypt(value = '') {
    if (!value || !safeStorage.isEncryptionAvailable()) return value;
    return `encrypted:${safeStorage.encryptString(value).toString('base64')}`;
  }

  #decrypt(value = '') {
    if (!value.startsWith?.('encrypted:')) return value;
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(10), 'base64'));
    } catch {
      return '';
    }
  }
}
