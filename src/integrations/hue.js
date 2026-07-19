import https from 'node:https';
import net from 'node:net';
import { createLogger } from '../logger.js';
import { clamp, isHexColor, mapWithConcurrency, normalizeLightIds } from './light-utils.js';

const log = createLogger('hue');

// Défauts repris de l'ancienne action Streamer.bot HueAlert.cs (comportement identique).
const DEFAULTS = {
  brightness: 85,
  transitionMs: 350,
  durationMs: 1200
};

// Conversion couleur (pure + testée)
function gammaCorrect(value) {
  return value > 0.04045 ? Math.pow((value + 0.055) / 1.055, 2.4) : value / 12.92;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// Réexportés pour compatibilité (utilisés par tests/hue.test.js et par du code qui
// importait ces utilitaires génériques depuis hue.js) — la définition canonique vit
// désormais dans light-utils.js, partagée avec les autres intégrations de lumières.
export { clamp, isHexColor, mapWithConcurrency, normalizeLightIds };

// Conversion Hex #RRGGBB vers coordonnées CIE xy (gamma sRGB), identique à HueAlert.cs.
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

export function isPrivateBridgeIp(value) {
  const ip = String(value || '').trim();
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized);
  }
  return false;
}

function assertPrivateBridgeIp(bridgeIp) {
  if (!isPrivateBridgeIp(bridgeIp)) {
    throw new Error('HUE_BRIDGE_IP doit être une adresse IP privée littérale');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Client HTTP du bridge (API CLIP v2, HTTPS auto-signé)
function hueRequest(bridgeIp, bridgePort, appKey, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: String(bridgeIp).trim().replace(/\/+$/, ''),
        port: bridgePort || 443,
        path,
        method,
        // Le bridge Hue présente un certificat auto-signé, donc on ne valide pas la chaîne
        // (équivalent du ServerCertificateValidationCallback => true du C#).
        rejectUnauthorized: false,
        headers: {
          ...(appKey ? { 'hue-application-key': appKey } : {}),
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

// hue.register — création d'une clé d'application (appuyer sur le bouton du bridge
// dans les ~30 s avant l'appel). API v1 sans auth. Fonction indépendante de
// createHueIntegration : appelée aussi bien par la commande `hue.register` (via
// local-server.js) que directement par le process Electron `main` (IPC `hue:register`,
// appairage déclenché depuis l'UI desktop — l'appKey résultante n'est JAMAIS envoyée
// au cloud, uniquement persistée localement par l'appelant).
export async function registerHueBridge(bridgeIp, bridgePort = 443, devicetype = 'Klixa#companion') {
  const ip = String(bridgeIp || '').trim();
  if (!ip) throw new Error('bridgeIp manquant');
  assertPrivateBridgeIp(ip);

  const res = await hueRequest(ip, bridgePort, '', 'POST', '/api', { devicetype: String(devicetype || 'Klixa#companion').trim() });
  const entries = Array.isArray(res) ? res : [];

  const success = entries.find((e) => e?.success?.username);
  if (success) {
    log.info('Clé d\'application Hue créée');
    return { appKey: success.success.username };
  }

  const failure = entries.find((e) => e?.error);
  if (failure?.error?.type === 101) {
    throw new Error('Appuyez sur le bouton du bridge Hue puis réessayez');
  }
  throw new Error('Réponse inattendue du bridge Hue');
}

/**
 * Intégration Philips Hue NATIVE : le compagnon parle directement au bridge sur le
 * LAN (plus de passage par Streamer.bot/HueAlert.cs/HueDiscover.cs). Les credentials
 * (IP du bridge, clé d'application) viennent EXCLUSIVEMENT de la config locale
 * (`.env` ou config desktop chiffrée) — plus aucune surcharge par le payload cloud
 * (retiré avec `allowPayloadCredentials` : le cloud ne doit structurellement plus
 * jamais pouvoir fournir une IP/clé de bridge).
 */
export function createHueIntegration(hueConfig = {}) {
  const maxLights = Math.max(1, Math.min(200, Math.trunc(hueConfig.maxLights) || 50));
  const requestConcurrency = Math.max(1, Math.min(20, Math.trunc(hueConfig.concurrency) || 5));

  function forEachLight(lightIds, operation) {
    return mapWithConcurrency(lightIds, requestConcurrency, operation);
  }

  function resolveCredentials() {
    const bridgeIp = String(hueConfig.bridgeIp || '').trim();
    const bridgePort = Number.parseInt(hueConfig.bridgePort, 10) || 443;
    const appKey = String(hueConfig.appKey || '').trim();
    if (!bridgeIp || !appKey) {
      throw new Error('Bridge Hue non configuré (à faire depuis l\'app Klixa Companion, section Philips Hue)');
    }
    assertPrivateBridgeIp(bridgeIp);
    return { bridgeIp, bridgePort, appKey };
  }

  async function setLightColor(creds, lightId, xy, brightness, transitionMs) {
    return hueRequest(creds.bridgeIp, creds.bridgePort, creds.appKey, 'PUT', `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, {
      on: { on: true },
      dimming: { brightness },
      color: { xy },
      dynamics: { duration: transitionMs }
    });
  }

  async function setLightOn(creds, lightId, on, transitionMs) {
    return hueRequest(creds.bridgeIp, creds.bridgePort, creds.appKey, 'PUT', `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, {
      on: { on },
      dynamics: { duration: transitionMs }
    });
  }

  async function readLightState(creds, lightId) {
    const res = await hueRequest(creds.bridgeIp, creds.bridgePort, creds.appKey, 'GET', `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, null);
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
    await hueRequest(creds.bridgeIp, creds.bridgePort, creds.appKey, 'PUT', `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, body);
  }

  // Clignotement coloré puis restauration de l'état initial (mode alerte « simple »).
  async function blinkLights(creds, lightIds, xy, brightness, transitionMs, durationMs) {
    const previous = {};
    await forEachLight(lightIds, async (id) => {
      try { previous[id] = await readLightState(creds, id); }
      catch (err) { log.warn(`Snapshot impossible pour ${id}`, err.message); }
    });

    const endAt = Date.now() + durationMs;
    const pulseMs = Math.max(180, Math.min(450, Math.floor(durationMs / 4)));

    try {
      while (Date.now() < endAt) {
        await forEachLight(lightIds, (id) => setLightColor(creds, id, xy, brightness, transitionMs));
        await sleep(Math.min(pulseMs, Math.max(0, endAt - Date.now())));
        await forEachLight(lightIds, (id) => setLightOn(creds, id, false, transitionMs));
        await sleep(Math.min(pulseMs, Math.max(0, endAt - Date.now())));
      }
    } finally {
      await forEachLight(lightIds, async (id) => {
        try { await restoreLightState(creds, id, previous[id], transitionMs); }
        catch (err) { log.warn(`Restauration impossible pour ${id}`, err.message); }
      });
    }
  }

  // hue.color — couleur sur les lampes ciblées. Payload : { lightIds, color, brightness,
  // transitionMs, durationMs, mode ('simple' = clignotement + restauration) }.
  // (La gestion des scènes Hue a été retirée : recall permanent, incompatible avec des
  // alertes ponctuelles qui doivent restaurer l'état initial.)
  async function color(payload = {}) {
    const creds = resolveCredentials();

    const lightIds = normalizeLightIds(payload.lightIds ?? payload.hueLightIds);
    if (lightIds.length === 0) throw new Error('Aucune lampe cible (lightIds vide)');
    if (lightIds.length > maxLights) throw new Error(`Trop de lampes ciblées (${lightIds.length}, maximum ${maxLights})`);

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
      await forEachLight(lightIds, (id) => setLightColor(creds, id, xy, brightness, transitionMs));
    }

    log.info('Commande couleur envoyée', { lights: lightIds.length, color: hex, mode: mode || 'steady' });
    return { lights: lightIds.length, color: hex };
  }

  // hue.discover — liste des lampes (résultat renvoyé dans l'ack au cloud).
  async function discover() {
    const creds = resolveCredentials();

    const lightsRes = await hueRequest(creds.bridgeIp, creds.bridgePort, creds.appKey, 'GET', '/clip/v2/resource/light', null);

    const lights = (lightsRes?.data || [])
      .filter((l) => l?.id)
      .map((l) => ({ id: l.id, name: l.metadata?.name || l.id }))
      .sort((a, b) => a.name.localeCompare(b.name));

    log.info('Découverte terminée', { lights: lights.length });
    return { lights };
  }

  // hue.register — conservée dans le registre de commandes pour local-server.js
  // (déclenchement manuel/scripté sur le LAN) ; le cloud ne l'appelle plus (l'IP du
  // bridge n'est jamais annoncée par Klixa). Utilise l'IP déjà en config locale si le
  // payload n'en fournit pas.
  async function register(payload = {}) {
    return registerHueBridge(payload.bridgeIp || hueConfig.bridgeIp, hueConfig.bridgePort, payload.devicetype);
  }

  // hue.status — statut d'appairage, AUCUNE IP/clé dans la réponse (consommé par
  // Klixa pour afficher « Appairé » dans le wizard, sans jamais voir le secret).
  async function status() {
    const bridgeIp = String(hueConfig.bridgeIp || '').trim();
    const appKey = String(hueConfig.appKey || '').trim();
    return { bridgeConfigured: Boolean(bridgeIp), paired: Boolean(bridgeIp && appKey) };
  }

  async function healthcheck() {
    const creds = resolveCredentials();
    await hueRequest(creds.bridgeIp, creds.bridgePort, creds.appKey, 'GET', '/clip/v2/resource/bridge', null);
    return { bridgeIp: creds.bridgeIp };
  }

  return {
    id: 'hue',
    commands: {
      'hue.color': color,
      'hue.discover': discover,
      'hue.register': register,
      'hue.status': status
    },
    healthcheck
  };
}
