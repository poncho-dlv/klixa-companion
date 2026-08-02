import crypto from 'node:crypto';
import { t } from './i18n/core.js';

// Préfixe identifiable (support/debug), distinct de kxc_ (control-access côté cloud) et
// de COMPANION_TOKEN — trois secrets différents, jamais interchangeables.
export const DEVICE_TOKEN_PREFIX = 'kxd_';

const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Hash SHA-256 (hex) d'un token device — la seule forme conservée en mémoire/sur
 * disque. Même principe que hashControlToken côté cloud (control-access-service.js) :
 * le token en clair n'est jamais relu, seule sa comparaison hashée compte.
 * @param {string} token
 * @returns {string} Hash hex (64 caractères), '' si le token est vide.
 */
export function hashDeviceToken(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateTokenValue() {
  return `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Identifiant choisi par le streamer à la génération du token (pas par le script) :
 * c'est ce qui empêche un script connecté avec le token A de s'annoncer sous l'id d'un
 * device B (cf. docs/local-device-agent-plan.md §3, règle « le deviceId appartient au
 * token »).
 * @param {string} value
 * @returns {boolean}
 */
export function isValidDeviceId(value) {
  return DEVICE_ID_PATTERN.test(String(value ?? ''));
}

/**
 * Registre des tokens device (deviceId -> { name, tokenHash, createdAt }). Persistance
 * déléguée à l'appelant (`onChange`, JSON sérialisé) pour rester identique en mode
 * headless (fichier, cf. device-tokens-state-file.js) et en mode desktop (ConfigStore
 * Electron, cf. desktop/main.js) — comme l'état Mesh SmallRig.
 * @param {{ initialJson?: string, onChange?: (json: string) => (void|Promise<void>) }} [options]
 */
export function createDeviceTokenStore({ initialJson = '', onChange } = {}) {
  const recordsById = new Map();
  const deviceIdByHash = new Map();

  function loadFromJson(json) {
    recordsById.clear();
    deviceIdByHash.clear();
    const trimmed = String(json || '').trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(t('errors.deviceTokensStateInvalid'), { cause: error });
    }
    for (const record of Array.isArray(parsed) ? parsed : []) {
      const deviceId = String(record?.deviceId || '').trim();
      const tokenHash = String(record?.tokenHash || '').trim();
      if (!deviceId || !tokenHash) continue;
      recordsById.set(deviceId, {
        name: String(record.name || deviceId).trim(),
        tokenHash,
        createdAt: record.createdAt || null
      });
      deviceIdByHash.set(tokenHash, deviceId);
    }
  }

  loadFromJson(initialJson);

  function serializeMap(records) {
    return JSON.stringify([...records].map(([deviceId, record]) => ({ deviceId, ...record })));
  }

  function serialize() {
    return serializeMap(recordsById);
  }

  // Persiste un snapshot HYPOTHÉTIQUE (pas encore appliqué à recordsById/deviceIdByHash)
  // — voir generate()/revoke() : si onChange échoue (ex. mode headless sans
  // DEVICES_TOKENS_FILE), l'état en mémoire ne doit JAMAIS diverger de ce qui est
  // réellement sur disque. Sans ça, un token qui échoue à se sauvegarder laissait son
  // deviceId bloqué « déjà pris » pour toujours, sans qu'aucun token valide n'existe
  // nulle part (bug trouvé en test manuel du 2026-08-02).
  async function persistSnapshot(nextRecords) {
    if (typeof onChange === 'function') await onChange(serializeMap(nextRecords));
  }

  function list() {
    return [...recordsById].map(([deviceId, record]) => ({
      deviceId,
      name: record.name,
      createdAt: record.createdAt
    }));
  }

  function resolveDeviceId(token) {
    const hash = hashDeviceToken(token);
    if (!hash) return null;
    return deviceIdByHash.get(hash) || null;
  }

  /**
   * Génère un nouveau token pour `deviceId` (doit être libre — pas de régénération
   * implicite : révoquer d'abord pour réutiliser un id). Le token en clair n'est
   * retourné qu'ici, seule occasion de le copier dans le script/firmware du device.
   * @returns {Promise<{ deviceId: string, token: string, createdAt: string }>}
   */
  async function generate(deviceId, name) {
    const id = String(deviceId || '').trim();
    if (!isValidDeviceId(id)) throw new Error(t('errors.deviceIdInvalid'));
    if (recordsById.has(id)) throw new Error(t('errors.deviceIdAlreadyExists', { deviceId: id }));

    const token = generateTokenValue();
    const tokenHash = hashDeviceToken(token);
    const createdAt = new Date().toISOString();
    const record = { name: String(name || id).trim(), tokenHash, createdAt };

    const nextRecords = new Map(recordsById);
    nextRecords.set(id, record);
    await persistSnapshot(nextRecords);

    recordsById.set(id, record);
    deviceIdByHash.set(tokenHash, id);
    return { deviceId: id, token, createdAt };
  }

  /** @returns {Promise<boolean>} true si un device a bien été révoqué */
  async function revoke(deviceId) {
    const id = String(deviceId || '').trim();
    const record = recordsById.get(id);
    if (!record) return false;

    const nextRecords = new Map(recordsById);
    nextRecords.delete(id);
    await persistSnapshot(nextRecords);

    recordsById.delete(id);
    deviceIdByHash.delete(record.tokenHash);
    return true;
  }

  return { list, resolveDeviceId, generate, revoke, serialize };
}
