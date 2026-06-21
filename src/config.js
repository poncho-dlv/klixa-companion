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

export const config = {
  port: int(process.env.PORT, 8786),
  localToken: process.env.COMPANION_LOCAL_TOKEN || '',
  cloud: {
    url: process.env.CLOUD_WS_URL || '',
    token: process.env.COMPANION_TOKEN || '',
    tenantId: process.env.TENANT_ID || '',
    reconnect: {
      minDelayMs: int(process.env.CLOUD_RECONNECT_MIN_MS, 1000),
      maxDelayMs: int(process.env.CLOUD_RECONNECT_MAX_MS, 30000),
    },
  },
  smoke: {
    enabled: bool(process.env.SMOKE_ENABLED, true),
    serviceUrl: process.env.SMOKE_SERVICE_URL || '',
    serviceToken: process.env.SMOKE_SERVICE_TOKEN || '',
    defaultMs: int(process.env.SMOKE_DEFAULT_MS, 300),
    minMs: int(process.env.SMOKE_MIN_MS, 50),
    maxMs: int(process.env.SMOKE_MAX_MS, 1500),
  },
  hue: {
    // Intégration Hue NATIVE : le compagnon parle directement au bridge sur le LAN.
    enabled: bool(process.env.HUE_ENABLED, true),
    bridgeIp: process.env.HUE_BRIDGE_IP || '',
    appKey: process.env.HUE_APP_KEY || '',
  },
  obs: {
    // Intégration OBS NATIVE (obs-websocket) : le compagnon parle directement à OBS sur le LAN.
    // `overlayBase` n'est PAS configuré ici : il est toujours fourni par le serveur dans la commande.
    enabled: bool(process.env.OBS_ENABLED, true),
    url: process.env.OBS_WS_URL || 'ws://127.0.0.1:4455',
    password: process.env.OBS_WS_PASSWORD || '',
  },
};
