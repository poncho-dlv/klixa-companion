import { createLogger } from '../logger.js';

const log = createLogger('smoke');

// Pur + testé : borne la durée demandée dans [minMs, maxMs], défaut si invalide.
export function clampDuration(value, { defaultMs, minMs, maxMs }) {
  let ms = Number.parseInt(value, 10);
  if (!Number.isFinite(ms)) ms = defaultMs;
  return Math.max(minMs, Math.min(maxMs, ms));
}

/**
 * Intégration machine à fumée. Relaie une commande de déclenchement vers le
 * micro-service GPIO Python qui tourne sur le Raspberry Pi (HTTP sur le LAN).
 */
export function createSmokeIntegration(smokeConfig) {
  if (!smokeConfig.serviceUrl) {
    throw new Error('SMOKE_SERVICE_URL manquant (URL du service GPIO sur le Raspberry Pi)');
  }
  const base = smokeConfig.serviceUrl.replace(/\/+$/, '');
  // Secret partagé attendu par le service GPIO (cf. SMOKE_TOKEN sur le RPi). Absent =
  // service supposé en loopback sur le RPi, qui n'exige alors aucun token.
  const token = String(smokeConfig.token || '').trim();
  const authHeaders = token ? { 'x-smoke-token': token } : {};

  async function trigger(payload) {
    const durationMs = clampDuration(payload?.durationMs, smokeConfig);
    log.info('Déclenchement fumée', { durationMs });
    const res = await fetch(`${base}/smoke/trigger`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({ durationMs }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Service fumée HTTP ${res.status}: ${text}`);
    }
    return { durationMs };
  }

  async function healthcheck() {
    const res = await fetch(`${base}/health`, {
      method: 'GET',
      headers: authHeaders,
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 401) throw new Error('Token du service fumée invalide (SMOKE_SERVICE_TOKEN)');
    if (!res.ok) throw new Error(`Service fumée injoignable (HTTP ${res.status})`);
    return { serviceUrl: base };
  }

  return {
    id: 'smoke',
    commands: { 'smoke.trigger': trigger },
    healthcheck,
  };
}
