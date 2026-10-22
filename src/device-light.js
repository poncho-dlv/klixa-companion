import { clamp, createHoldRegistry, isHexColor } from './integrations/light-utils.js';
import { t } from './i18n/core.js';

// Contrat des éléments de type `light` d'un appareil LAN (protocole v2, cf.
// protocol/devices-messages.md) : le script déclare ses capacités, Klixa n'envoie que ce
// que la lampe sait porter, et le compagnon gère le maintien temporaire + la restauration
// (snapshot via l'action optionnelle `getState`) pour que le script reste trivial.

const LIGHT_CAPABILITIES = Object.freeze(['onoff', 'dimming', 'color', 'color_temperature']);
const LIGHT_SET_ACTION = 'set';
const LIGHT_GET_STATE_ACTION = 'getState';

const KELVIN_LIMITS = Object.freeze({ min: 1000, max: 10000 });
const MAX_FX_MODES = 24;
const MAX_FX_LABEL_LENGTH = 64;

function toKelvin(value) {
  const kelvin = Math.round(Number(value));
  return Number.isFinite(kelvin) && kelvin >= KELVIN_LIMITS.min && kelvin <= KELVIN_LIMITS.max ? kelvin : null;
}

/**
 * Champs propres à un élément `light`, tels que déclarés par le script (jamais de confiance
 * aveugle : capacités filtrées, plage Kelvin cohérente, effets bornés).
 * @param {object} raw élément brut du `hello`
 */
export function sanitizeLightFields(raw) {
  const capabilities = Array.isArray(raw?.capabilities)
    ? [...new Set(raw.capabilities.map(String).filter((cap) => LIGHT_CAPABILITIES.includes(cap)))]
    : [];

  const fields = { capabilities: capabilities.length > 0 ? capabilities : ['onoff'] };

  const min = toKelvin(raw?.kelvin?.min);
  const max = toKelvin(raw?.kelvin?.max);
  if (min !== null && max !== null && min < max) fields.kelvin = { min, max };

  const fxModes = [];
  const seen = new Set();
  for (const mode of Array.isArray(raw?.fxModes) ? raw.fxModes : []) {
    const id = String(mode?.id ?? '').trim().slice(0, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    fxModes.push({ id, label: String(mode?.label || id).trim().slice(0, MAX_FX_LABEL_LENGTH) });
    if (fxModes.length >= MAX_FX_MODES) break;
  }
  if (fxModes.length > 0) fields.fxModes = fxModes;

  return fields;
}

/**
 * Charge utile `set` envoyée au script : uniquement ce que la lampe supporte. Éteindre
 * n'emporte aucun autre champ. Pur.
 * @param {object} state `{ on?, color?, brightness?, kelvin?, fx? }`
 * @param {object} element élément `light` annoncé (capabilities, kelvin, fxModes)
 */
export function buildLightPayload(state, element) {
  const input = state && typeof state === 'object' ? state : {};
  const caps = new Set(element?.capabilities || ['onoff']);

  if (input.on === false) return { on: false };

  const payload = { on: true };

  if (typeof input.fx === 'string' && (element?.fxModes || []).some((mode) => mode.id === input.fx)) {
    payload.fx = input.fx;
    return payload;
  }

  if (caps.has('color') && isHexColor(input.color)) payload.color = input.color.toUpperCase();

  if (caps.has('dimming') && input.brightness !== undefined && input.brightness !== null) {
    const brightness = clamp(input.brightness, 1, 100, null);
    if (brightness !== null) payload.brightness = Math.round(brightness);
  }

  if (caps.has('color_temperature') && !payload.color && input.kelvin !== undefined && input.kelvin !== null) {
    const range = element?.kelvin || KELVIN_LIMITS;
    const kelvin = clamp(input.kelvin, range.min, range.max, null);
    if (kelvin !== null) payload.kelvin = Math.round(kelvin);
  }

  return payload;
}

function keyOf(deviceId, elementId) {
  return `${deviceId}::${elementId}`;
}

/**
 * @param {{ getElement: (deviceId: string, elementId: string) => object | null,
 *           trigger: (deviceId: string, elementId: string, action: string, opts?: object) => Promise<any> }} hub
 */
export function createDeviceLightController(hub, { registry = createHoldRegistry() } = {}) {
  function requireLight(deviceId, elementId) {
    const element = hub.getElement(deviceId, elementId);
    if (!element || element.type !== 'light' || !element.actions.includes(LIGHT_SET_ACTION)) {
      const error = new Error(t('errors.deviceNotALight', { deviceId, elementId }));
      error.code = 'DEVICE_NOT_A_LIGHT';
      throw error;
    }
    return element;
  }

  const apply = (deviceId, elementId, payload) => hub.trigger(deviceId, elementId, LIGHT_SET_ACTION, { payload });

  async function readSnapshot(deviceId, elementId, element) {
    try {
      const state = await hub.trigger(deviceId, elementId, LIGHT_GET_STATE_ACTION);
      return state && typeof state === 'object' && Object.keys(state).length > 0
        ? buildLightPayload(state, element)
        : null;
    } catch {
      return null;
    }
  }

  return {
    /**
     * Applique un état à une lampe d'appareil. `holdMs > 0` : l'état dure ce temps puis la
     * lampe retrouve celui d'avant (snapshot `getState`), si l'élément sait le restituer ;
     * sinon l'état reste appliqué (`restorable: false`).
     */
    async setLight({ deviceId, elementId, state, holdMs = 0 } = {}) {
      const element = requireLight(deviceId, elementId);
      const payload = buildLightPayload(state, element);
      const key = keyOf(deviceId, elementId);
      const hold = Number(holdMs) > 0;

      if (!hold) {
        registry.cancel([key]);
        await apply(deviceId, elementId, payload);
        return { applied: true };
      }

      if (!element.actions.includes(LIGHT_GET_STATE_ACTION)) {
        registry.cancel([key]);
        await apply(deviceId, elementId, payload);
        return { applied: true, restorable: false };
      }

      // Un second maintien garde le snapshot d'origine (cf. createHoldRegistry).
      const snapshot = registry.has(key) ? registry.snapshotOf(key) : await readSnapshot(deviceId, elementId, element);
      await apply(deviceId, elementId, payload);

      if (!snapshot) return { applied: true, restorable: false };

      registry.arm(key, snapshot, holdMs, (origin) => apply(deviceId, elementId, origin));
      return { applied: true, restorable: true };
    },

    stop() {
      registry.clear();
    }
  };
}
