import { t } from '../i18n/core.js';

// Portée locale pour la gestion des tokens (génération/révocation/liste) : seul le
// streamer via l'IHM du compagnon décide quels devices existent — jamais le cloud.
// devices.list/trigger restent 'all' : c'est tout l'intérêt de la fonctionnalité,
// piloter les appareils depuis la console Klixa.
const DEVICES_COMMAND_SCOPES = {
  'devices.list': 'all',
  'devices.trigger': 'all',
  'devices.listTokens': 'local',
  'devices.generateToken': 'local',
  'devices.revokeToken': 'local'
};

/**
 * Intégration GÉNÉRIQUE : ne connaît aucune commande métier câblée en dur (contrairement
 * à hue/obs/smallrig). Elle se contente de brancher le DeviceHub — déjà instancié par
 * runtime.js et partagé avec le serveur local pour l'upgrade WS — dans le registre de
 * commandes. Tout ce qui est pilotable vient de ce que les scripts connectés déclarent
 * eux-mêmes à l'enregistrement (cf. device-hub.js).
 * @param {ReturnType<import('../device-hub.js').createDeviceHub>} hub
 * @param {ReturnType<import('../device-token-store.js').createDeviceTokenStore>} tokenStore
 */
export function createDevicesIntegration(hub, tokenStore) {
  return {
    id: 'devices',
    commands: {
      'devices.list': async () => ({ devices: hub.list() }),
      'devices.trigger': async ({ deviceId, elementId, action, payload, data } = {}) => {
        if (!deviceId || !elementId || !action) throw new Error(t('errors.deviceTriggerMissingFields'));
        return hub.trigger(deviceId, elementId, action, { payload, data });
      },
      'devices.listTokens': async () => ({ tokens: tokenStore.list() }),
      'devices.generateToken': async ({ deviceId, name } = {}) => tokenStore.generate(deviceId, name),
      // Coupe aussi la connexion live éventuelle : un token révoqué doit arrêter le
      // device MAINTENANT, pas seulement bloquer sa prochaine reconnexion.
      'devices.revokeToken': async ({ deviceId } = {}) => {
        const revoked = await tokenStore.revoke(deviceId);
        if (revoked) hub.disconnect(deviceId);
        return { revoked };
      }
    },
    commandScopes: DEVICES_COMMAND_SCOPES,
    healthcheck: async () => ({ devices: hub.list().length }),
    stop: async () => hub.stop()
  };
}
