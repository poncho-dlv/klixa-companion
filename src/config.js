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
  smallrig: {
    // Intégration lampes SmallRig RM75 (Bluetooth Mesh) : nécessite un adaptateur
    // Bluetooth actif sur la machine. L'appairage (scan/provisioning) se fait
    // entièrement depuis l'IHM du compagnon (jamais via le cloud). L'état mesh
    // (clés réseau générées localement + nœuds appairés) est sérialisé en JSON ;
    // `onStateChange` est injecté par desktop/main.js pour la persistance chiffrée
    // (ConfigStore/safeStorage, même principe que HUE_APP_KEY). En mode headless,
    // src/index.js branche obligatoirement un fichier durable avant toute émission.
    enabled: bool(env.SMALLRIG_ENABLED, true),
    meshStateJson: env.SMALLRIG_MESH_STATE || '',
    meshStateFile: env.SMALLRIG_MESH_STATE_FILE || '',
    maxLamps: int(env.SMALLRIG_MAX_LAMPS, 50),
    concurrency: int(env.SMALLRIG_CONCURRENCY, 3),
    seqBlockSize: int(env.SMALLRIG_SEQ_BLOCK_SIZE, 100),
    onStateChange: undefined,
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
  devices: {
    // Appareils LAN génériques (RPi, ESP...) qui se connectent AU compagnon en WS
    // sortant sur /devices/ws et s'annoncent avec leurs éléments pilotables (switch
    // on/off, etc.) — la machine à fumée en est un exemple, pas un cas spécial. Voir
    // docs/local-device-agent-plan.md (repo Klixa) pour le protocole complet.
    // Un token PAR DEVICE (jamais COMPANION_LOCAL_TOKEN) : seul son hash est persisté
    // (device-token-store.js), le JSON de l'état est injecté/sauvegardé comme l'état
    // Mesh SmallRig (tokensJson/tokensFile/onTokensChange, même triple).
    enabled: bool(env.DEVICES_ENABLED, true),
    maxDevices: int(env.DEVICES_MAX, 20),
    commandTimeoutMs: int(env.DEVICES_COMMAND_TIMEOUT_MS, 5000),
    tokensJson: env.DEVICES_TOKENS_JSON || '',
    tokensFile: env.DEVICES_TOKENS_FILE || '',
    onTokensChange: undefined,
  },
};
}

export const config = createConfig();
