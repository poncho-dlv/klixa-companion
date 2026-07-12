import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function createConfig(env = process.env) {
return {
  port: int(env.PORT, 8786),
  host: env.COMPANION_HOST || '127.0.0.1',
  localToken: env.COMPANION_LOCAL_TOKEN || '',
  production: env.NODE_ENV === 'production',
  cloud: {
    url: env.CLOUD_WS_URL || '',
    token: env.COMPANION_TOKEN || '',
    tenantId: env.TENANT_ID || '',
    heartbeatMs: int(env.CLOUD_HEARTBEAT_MS, 30000),
    reconnect: {
      minDelayMs: int(env.CLOUD_RECONNECT_MIN_MS, 1000),
      maxDelayMs: int(env.CLOUD_RECONNECT_MAX_MS, 30000),
    },
  },
  smoke: {
    enabled: bool(env.SMOKE_ENABLED, true),
    serviceUrl: env.SMOKE_SERVICE_URL || '',
    defaultMs: int(env.SMOKE_DEFAULT_MS, 300),
    minMs: int(env.SMOKE_MIN_MS, 50),
    maxMs: int(env.SMOKE_MAX_MS, 1500),
  },
  hue: {
    // Intégration Hue NATIVE : le compagnon parle directement au bridge sur le LAN.
    // bridgeIp/appKey viennent EXCLUSIVEMENT d'ici (jamais du cloud, cf. hue.js).
    enabled: bool(env.HUE_ENABLED, true),
    bridgeIp: env.HUE_BRIDGE_IP || '',
    bridgePort: int(env.HUE_BRIDGE_PORT, 443),
    appKey: env.HUE_APP_KEY || '',
    maxLights: int(env.HUE_MAX_LIGHTS, 50),
    concurrency: int(env.HUE_CONCURRENCY, 5),
  },
  obs: {
    // Intégration OBS NATIVE (obs-websocket) : le compagnon parle directement à OBS sur le LAN.
    // `overlayBase` n'est PAS configuré ici : il est toujours fourni par le serveur dans la commande.
    enabled: bool(env.OBS_ENABLED, true),
    url: env.OBS_WS_URL || 'ws://127.0.0.1:4455',
    password: env.OBS_WS_PASSWORD || '',
  },
  streamerbot: {
    // Pont Streamer.bot : le compagnon héberge la connexion SB (sur le LAN avec SB).
    enabled: bool(env.SB_ENABLED, true),
    host: env.SB_HOST || '127.0.0.1',
    port: int(env.SB_PORT, 8080),
    endpoint: env.SB_ENDPOINT || '/',
    password: env.SB_PASSWORD || '',
    scheme: env.SB_SCHEME || 'ws',
  },
};
}

export const config = createConfig();
