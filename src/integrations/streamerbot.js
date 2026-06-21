import { StreamerbotClient } from '@streamerbot/client';
import { createLogger } from '../logger.js';

const log = createLogger('streamerbot');

// Events SB encore servis par le pont (le reste est natif côté cloud : EventSub Twitch,
// API YouTube, WebCast TikTok, etc.). Pulsoid n'est PAS ici : il reste sur la connexion
// SB du cloud (sera migré en natif plus tard, sans intermédiaire).
const DEFAULT_EVENTS = [
  'General.Custom',
  // AutomaticRewardRedemption migré en EventSub natif côté cloud
  // (channel.channel_points_automatic_reward_redemption.add) → plus relayé ici.
  'Twitch.Announcement'
];

// Args d'action SB : les valeurs objet sont sérialisées en JSON (comportement repris du
// client SB cloud — Streamer.bot attend des arguments scalaires/strings).
function serializeArgs(args = {}) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  }
  return out;
}

/**
 * Pont Streamer.bot : le compagnon (sur le LAN, là où tourne SB) héberge la connexion
 * et fait transiter dans les deux sens — le cloud ne parle plus jamais à SB directement.
 *  - Events SB → cloud : forwardés BRUTS via `emitEvent` ({event:{source,type}, data}),
 *    le cloud les ingère comme avant (counter.add, alertes, activité…). Tuyau bête.
 *  - Commande `streamerbot.action` (cloud → SB) : exécute une action SB par id
 *    (raccourcis modération, actions déclenchées par overlay).
 */
export function createStreamerbotIntegration(sbConfig = {}, { emitEvent } = {}) {
  let client = null;
  let connected = false;
  let stopped = false;

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

  // Broadcasts BRUTS (CPH.WebsocketBroadcastJson, ex. CounterAdd.cs pour `!add`) : ce ne
  // sont PAS des events SB standard (pas captés par .on()). On les forwarde comme un
  // General.Custom synthétique — le cloud les ingère (counter.add). Calqué sur le
  // handleRawBroadcast de l'ancien client SB cloud.
  function forwardRaw(payload) {
    if (!payload || typeof payload !== 'object') return;
    // Event SB standard (event = {source,type}) → déjà géré par les listeners .on().
    if (payload.event && typeof payload.event === 'object' && payload.event.source && payload.event.type) return;
    if (!String(payload.type || '').trim()) return;
    emitEvent?.({ event: { source: 'General', type: 'Custom' }, data: payload });
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
      onData: (payload) => forwardRaw(payload),
      onConnect: () => { connected = true; log.info('Connecté à Streamer.bot'); },
      onDisconnect: () => {
        connected = false;
        if (!stopped) log.warn('Connexion Streamer.bot perdue (reconnexion auto)');
      },
      onError: (err) => { log.error('Erreur Streamer.bot', err?.message || String(err)); }
    });

    for (const name of events) {
      client.on(name, (payload) => forward(name, payload));
    }

    client.connect().catch((err) => {
      log.warn('Connexion initiale Streamer.bot échouée (reconnexion auto)', err?.message || String(err));
    });
  }

  connect();

  async function action(payload = {}) {
    const actionId = String(payload.actionId || payload.id || '').trim();
    if (!actionId) throw new Error('actionId manquant');
    if (!connected || !client) throw new Error('Streamer.bot non connecté');

    const args = serializeArgs(payload.args && typeof payload.args === 'object' ? payload.args : {});
    const requestId = await client.doAction({ id: actionId }, args);
    return { requestId };
  }

  return {
    id: 'streamerbot',
    commands: { 'streamerbot.action': action },
    healthcheck: async () => {
      if (!connected) throw new Error('Streamer.bot non connecté');
      return { connected };
    },
    stop() {
      stopped = true;
      client?.disconnect?.().catch(() => {});
    }
  };
}
