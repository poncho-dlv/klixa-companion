import { StreamerbotClient } from '@streamerbot/client';
import { createLogger } from '../logger.js';

const log = createLogger('streamerbot');

// Events SB encore servis par le pont. Les compteurs sont geres nativement cote Klixa.
export const DEFAULT_EVENTS = [
  'Pulsoid.HeartRatePulse'
];

// Args d'action SB : les valeurs objet sont serialisees en JSON (comportement repris du
// client SB cloud ; Streamer.bot attend des arguments scalaires/strings).
function serializeArgs(args = {}) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  }
  return out;
}

/**
 * Pont Streamer.bot : le compagnon (sur le LAN, la ou tourne SB) heberge la connexion
 * et fait transiter dans les deux sens ; le cloud ne parle plus jamais a SB directement.
 *  - Events SB -> cloud : Pulsoid.HeartRatePulse pour le mode BPM local.
 *  - Commande `streamerbot.action` (cloud -> SB) : execute une action SB par id
 *    (raccourcis moderation, actions declenchees par overlay).
 */
export function createStreamerbotIntegration(sbConfig = {}, { emitEvent } = {}) {
  let client = null;
  let connected = false;
  let stopped = false;
  let loggedOffline = false;

  function noteOffline(msg, detail) {
    if (stopped || loggedOffline) return;
    loggedOffline = true;
    log.warn(msg, detail);
  }

  const events = Array.isArray(sbConfig.events) && sbConfig.events.length
    ? sbConfig.events
    : DEFAULT_EVENTS;

  function forward(eventName, payload) {
    const [source = '', type = ''] = String(eventName).split('.');
    const event = {
      source: payload?.event?.source || source,
      type: payload?.event?.type || type
    };
    emitEvent?.({ event, data: payload?.data ?? payload });
  }

  function connect() {
    if (stopped) return;

    client = new StreamerbotClient({
      host: sbConfig.host,
      port: sbConfig.port,
      endpoint: sbConfig.endpoint,
      password: sbConfig.password || undefined,
      scheme: sbConfig.scheme,
      immediate: false,
      autoReconnect: true,
      retries: -1,
      logLevel: 'none',
      onConnect: () => { connected = true; loggedOffline = false; log.info('Connecte a Streamer.bot'); },
      onDisconnect: () => {
        connected = false;
        noteOffline('Connexion Streamer.bot perdue (reconnexion auto en cours)');
      },
      onError: (err) => { noteOffline('Connexion Streamer.bot indisponible (reconnexion auto en cours)', err?.message || String(err)); }
    });

    for (const name of events) {
      client.on(name, (payload) => forward(name, payload));
    }

    client.connect().catch((err) => {
      noteOffline('Connexion initiale Streamer.bot echouee (reconnexion auto)', err?.message || String(err));
    });
  }

  connect();

  async function action(payload = {}) {
    const actionId = String(payload.actionId || payload.id || '').trim();
    if (!actionId) throw new Error('actionId manquant');
    if (!connected || !client) throw new Error('Streamer.bot non connecte');

    const args = serializeArgs(payload.args && typeof payload.args === 'object' ? payload.args : {});
    const requestId = await client.doAction({ id: actionId }, args);
    return { requestId };
  }

  return {
    id: 'streamerbot',
    commands: { 'streamerbot.action': action },
    healthcheck: async () => {
      if (!connected) throw new Error('Streamer.bot non connecte');
      return { connected };
    },
    stop() {
      stopped = true;
      client?.disconnect?.().catch(() => {});
    }
  };
}
