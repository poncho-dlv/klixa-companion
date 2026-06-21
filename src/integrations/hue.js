import https from 'node:https';
import { createLogger } from '../logger.js';

const log = createLogger('hue');

// Défauts repris de l'ancienne action Streamer.bot HueAlert.cs (comportement identique).
const DEFAULTS = {
  brightness: 85,
  transitionMs: 350,
  durationMs: 1200
};

// ── Conversion couleur (pure + testée) ───────────────────────────────────────
function gammaCorrect(value) {
  return value > 0.04045 ? Math.pow((value + 0.055) / 1.055, 2.4) : value / 12.92;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// Hex #RRGGBB → coordonnées CIE xy (gamma sRGB), identique à HueAlert.cs.
export function hexToXy(hex) {
  const r = gammaCorrect(parseInt(hex.slice(1, 3), 16) / 255);
  const g = gammaCorrect(parseInt(hex.slice(3, 5), 16) / 255);
  const b = gammaCorrect(parseInt(hex.slice(5, 7), 16) / 255);

  const x = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const z = r * 0.000088 + g * 0.072310 + b * 0.986039;
  const total = x + y + z;

  if (total <= 0) return { x: 0.3127, y: 0.3290 };
  return { x: round4(x / total), y: round4(y / total) };
}

export function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLightIds(raw) {
  if (Array.isArray(raw)) return raw.map((id) => String(id).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const text = raw.trim();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((id) => String(id).trim()).filter(Boolean);
    } catch {
      // pas du JSON → liste séparée par virgules/retours ligne
    }
    return text.split(/[,\n\r]/).map((id) => id.trim()).filter(Boolean);
  }
  return [];
}

// ── Client HTTP du bridge (API CLIP v2, HTTPS auto-signé) ────────────────────
function hueRequest(bridgeIp, appKey, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: String(bridgeIp).trim().replace(/\/+$/, ''),
        path,
        method,
        // Le bridge Hue présente un certificat auto-signé → on ne valide pas la chaîne
        // (équivalent du ServerCertificateValidationCallback => true du C#).
        rejectUnauthorized: false,
        headers: {
          'hue-application-key': appKey,
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
        },
        timeout: 4000
      },
      (res) => {
        let content = '';
        res.on('data', (chunk) => { content += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(content ? JSON.parse(content) : {}); } catch { resolve(content); }
          } else {
            reject(new Error(`Hue HTTP ${res.statusCode}: ${content}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Hue timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Intégration Philips Hue NATIVE : le compagnon parle directement au bridge sur le
 * LAN (plus de passage par Streamer.bot/HueAlert.cs/HueDiscover.cs). Les credentials
 * (IP du bridge, clé d'application) viennent du .env, surchargeables par le payload
 * (le cloud peut encore les fournir depuis la config Mongo du tenant).
 */
export function createHueIntegration(hueConfig = {}) {
  function resolveCredentials(payload = {}) {
    const bridgeIp = String(payload.bridgeIp || payload.hueBridgeIp || hueConfig.bridgeIp || '').trim();
    const appKey = String(payload.appKey || payload.hueAppKey || hueConfig.appKey || '').trim();
    if (!bridgeIp || !appKey) {
      throw new Error('Bridge Hue non configuré (HUE_BRIDGE_IP / HUE_APP_KEY manquants)');
    }
    return { bridgeIp, appKey };
  }

  async function setLightColor(creds, lightId, xy, brightness, transitionMs) {
    return hueRequest(creds.bridgeIp, creds.appKey, 'PUT', `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, {
      on: { on: true },
      dimming: { brightness },
      color: { xy },
      dynamics: { duration: transitionMs }
    });
  }

  async function setLightOn(creds, lightId, on, transitionMs) {
    return hueRequest(creds.bridgeIp, creds.appKey, 'PUT', `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, {
      on: { on },
      dynamics: { duration: transitionMs }
    });
  }

  async function readLightState(creds, lightId) {
    const res = await hueRequest(creds.bridgeIp, creds.appKey, 'GET', `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, null);
    const d = res?.data?.[0];
    if (!d) return null;
    return {
      on: d.on?.on,
      brightness: d.dimming?.brightness,
      xy: d.color?.xy,
      mirek: d.color_temperature?.mirek,
      effect: d.effects?.status
    };
  }

  async function restoreLightState(creds, lightId, state, transitionMs) {
    if (!state) return;
    const body = { dynamics: { duration: transitionMs } };
    if (typeof state.on === 'boolean') body.on = { on: state.on };
    if (Number.isFinite(state.brightness)) body.dimming = { brightness: state.brightness };
    if (state.xy) body.color = { xy: state.xy };
    if (Number.isFinite(state.mirek)) body.color_temperature = { mirek: state.mirek };
    if (state.effect && state.effect !== 'no_effect') body.effects = { effect: state.effect };
    await hueRequest(creds.bridgeIp, creds.appKey, 'PUT', `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, body);
  }

  // Clignotement coloré puis restauration de l'état initial (mode alerte « simple »).
  async function blinkLights(creds, lightIds, xy, brightness, transitionMs, durationMs) {
    const previous = {};
    for (const id of lightIds) {
      try { previous[id] = await readLightState(creds, id); }
      catch (err) { log.warn(`Snapshot impossible pour ${id}`, err.message); }
    }

    const endAt = Date.now() + durationMs;
    const pulseMs = Math.max(180, Math.min(450, Math.floor(durationMs / 4)));

    while (Date.now() < endAt) {
      await Promise.all(lightIds.map((id) => setLightColor(creds, id, xy, brightness, transitionMs)));
      await sleep(Math.min(pulseMs, Math.max(0, endAt - Date.now())));
      await Promise.all(lightIds.map((id) => setLightOn(creds, id, false, transitionMs)));
      await sleep(Math.min(pulseMs, Math.max(0, endAt - Date.now())));
    }

    await Promise.all(lightIds.map((id) => setLightColor(creds, id, xy, brightness, transitionMs)));

    for (const id of lightIds) {
      try { await restoreLightState(creds, id, previous[id], transitionMs); }
      catch (err) { log.warn(`Restauration impossible pour ${id}`, err.message); }
    }
  }

  // hue.color — couleur/scène. Payload : { lightIds, color, brightness, transitionMs,
  // durationMs, mode ('simple' = clignotement), sceneId }.
  async function color(payload = {}) {
    const creds = resolveCredentials(payload);

    const sceneId = String(payload.sceneId || payload.hueSceneId || '').trim();
    if (sceneId) {
      await hueRequest(creds.bridgeIp, creds.appKey, 'PUT', `/clip/v2/resource/scene/${encodeURIComponent(sceneId)}`, {
        recall: { action: 'active' }
      });
      log.info('Scène activée', { sceneId });
      return { sceneId };
    }

    const lightIds = normalizeLightIds(payload.lightIds ?? payload.hueLightIds);
    if (lightIds.length === 0) throw new Error('Aucune lampe cible (lightIds vide)');

    const hex = String(payload.color || payload.hueColor || '').trim().toUpperCase();
    if (!isHexColor(hex)) throw new Error(`Couleur invalide: ${hex}`);

    const xy = hexToXy(hex);
    const brightness = clamp(payload.brightness ?? payload.hueBrightness, 1, 100, DEFAULTS.brightness);
    const transitionMs = clamp(payload.transitionMs ?? payload.hueTransitionMs, 0, 10000, DEFAULTS.transitionMs);
    const durationMs = clamp(payload.durationMs ?? payload.hueDurationMs, 100, 60000, DEFAULTS.durationMs);
    const mode = String(payload.mode || payload.hueMode || '').trim().toLowerCase();

    if (mode === 'simple') {
      await blinkLights(creds, lightIds, xy, brightness, transitionMs, durationMs);
    } else {
      await Promise.all(lightIds.map((id) => setLightColor(creds, id, xy, brightness, transitionMs)));
    }

    log.info('Commande couleur envoyée', { lights: lightIds.length, color: hex, mode: mode || 'steady' });
    return { lights: lightIds.length, color: hex };
  }

  // hue.discover — liste lampes + scènes (résultat renvoyé dans l'ack au cloud).
  async function discover(payload = {}) {
    const creds = resolveCredentials(payload);

    const [lightsRes, scenesRes, roomsRes] = await Promise.all([
      hueRequest(creds.bridgeIp, creds.appKey, 'GET', '/clip/v2/resource/light', null),
      hueRequest(creds.bridgeIp, creds.appKey, 'GET', '/clip/v2/resource/scene', null),
      hueRequest(creds.bridgeIp, creds.appKey, 'GET', '/clip/v2/resource/room', null)
    ]);

    const roomNames = new Map();
    for (const room of roomsRes?.data || []) {
      if (room?.id) roomNames.set(room.id, room.metadata?.name || room.id);
    }

    const lights = (lightsRes?.data || [])
      .filter((l) => l?.id)
      .map((l) => ({ id: l.id, name: l.metadata?.name || l.id }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const scenes = (scenesRes?.data || [])
      .filter((s) => s?.id)
      .map((s) => {
        const groupId = s.group?.rid || '';
        return { id: s.id, name: s.metadata?.name || s.id, groupId, groupName: roomNames.get(groupId) || '' };
      })
      .sort((a, b) => (a.groupName + a.name).localeCompare(b.groupName + b.name));

    log.info('Découverte terminée', { lights: lights.length, scenes: scenes.length });
    return { lights, scenes };
  }

  async function healthcheck() {
    const creds = resolveCredentials();
    await hueRequest(creds.bridgeIp, creds.appKey, 'GET', '/clip/v2/resource/bridge', null);
    return { bridgeIp: creds.bridgeIp };
  }

  return {
    id: 'hue',
    commands: {
      'hue.color': color,
      'hue.discover': discover
    },
    healthcheck
  };
}
