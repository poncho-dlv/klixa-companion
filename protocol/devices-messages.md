# Protocole — Compagnon et appareils LAN génériques (RPi, ESP...)

Connexion **WebSocket sortante**, initiée par le script/firmware du device vers le
compagnon. Le compagnon ne se connecte jamais au device (même logique que
compagnon → cloud, cf. `messages.md`, un niveau plus bas). Tous les messages sont du
JSON (un objet par trame). Voir `docs/local-device-agent-plan.md` (repo Klixa) pour le
contexte produit complet.

Cette fonctionnalité généralise la machine à fumée (`rpi/`) : un device n'est plus câblé
en dur dans le compagnon, il s'annonce lui-même avec ses éléments pilotables.

## Authentification

À la connexion (sur le path `/devices/ws`), le script présente un header HTTP
`Authorization: Bearer <token-device>`. **Le compagnon résout le `deviceId` à partir du
token** (hash SHA-256 comparé au registre local, cf. `device-token-store.js`) — le
`deviceId` annoncé ensuite dans le `hello` doit correspondre, il n'est jamais une source
de confiance à lui seul. Token invalide/manquant → handshake accepté puis fermé avec le
code `4401`. Un token est généré **par device**, jamais un secret partagé : il n'autorise
à se faire passer que pour CE device précis, jamais à déclencher une autre commande du
compagnon (contrairement à `COMPANION_LOCAL_TOKEN`).

Nombre de devices connectés borné (`DEVICES_MAX`, défaut 20) : au-delà, une nouvelle
connexion est refusée avec le code `4409`.

Un token révoqué (`devices.revokeToken`) coupe **immédiatement** la connexion live du
device concerné (code `4403`), pas seulement sa prochaine tentative de reconnexion.

## Device → Compagnon

### `hello` (à la connexion)

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "deviceId": "smoke-machine",
  "name": "Machine à fumée",
  "elements": [
    {
      "id": "relay",
      "type": "switch",
      "name": "Relais fumée",
      "actions": ["trigger"],
      "params": { "trigger": { "durationMs": { "min": 50, "max": 1500, "default": 300 } } }
    }
  ]
}
```

`elements` = tout ce que ce device sait piloter, déclaré par le script lui-même — le
compagnon ne connaît AUCUNE commande métier en dur pour cette intégration (contrairement
à Hue/OBS/SmallRig). Bornes appliquées côté compagnon : 20 éléments max, 20 actions max
par élément. `params`, s'il est fourni, sert uniquement à construire un input typé côté
admin Klixa (min/max/default) — le compagnon ne le valide pas plus loin, c'est indicatif.

Une reconnexion avec le même `deviceId` (même token) ferme proprement l'ancienne
connexion (`4409`, `re-registered`) — jamais de doublon.

### `ack` (réponse à une commande)

```json
{ "type": "ack", "id": "<id-commande>", "ok": true, "result": { "durationMs": 300 } }
```

```json
{ "type": "ack", "id": "<id-commande>", "ok": false, "error": "...", "code": "..." }
```

### `event` (remontée libre, réservé — non exploité côté Klixa pour l'instant)

```json
{ "type": "event", "elementId": "button1", "data": { "pressed": true } }
```

Le compagnon relaie l'event à `onEvent` (câblage applicatif, ex. un futur pont vers le
cloud) mais rien ne le consomme encore aujourd'hui — le type de message existe dès la v1
pour ne jamais avoir à casser le protocole quand un premier usage apparaîtra (bouton
physique → événement Klixa).

## Compagnon → Device

### `registered` (réponse au `hello`)

```json
{ "type": "registered", "ok": true }
```

```json
{ "type": "registered", "ok": false, "error": "Version de protocole non supportée" }
```

Une version de protocole non supportée (`protocolVersion` ≠ 1) ou un token invalide
ferment la connexion respectivement avec les codes `4400` et `4401`.

### `command`

```json
{
  "type": "command",
  "id": "<uuid>",
  "elementId": "relay",
  "action": "trigger",
  "payload": { "durationMs": 300 },
  "data": {}
}
```

- `id` : identifiant opaque (UUID), renvoyé tel quel dans l'`ack`.
- `elementId`/`action` : doivent correspondre à un élément/action déclarés dans le
  `hello` — sinon la commande n'est même pas envoyée (`DEVICE_UNKNOWN_ACTION` renvoyé à
  l'appelant côté compagnon, avant tout aller-retour réseau).
- `payload` : paramètres structurés (construits par Klixa depuis le schéma `params`).
- `data` : JSON libre, **opaque** — ni le compagnon ni Klixa n'interprètent son contenu,
  c'est un pur passe-plat jusqu'au script. Toujours présent (`{}` par défaut).

Sans réponse dans les 5 s (`DEVICES_COMMAND_TIMEOUT_MS`), la commande échoue avec
`DEVICE_TIMEOUT` côté appelant — le script reste libre de répondre en retard, cet ack
tardif sera simplement ignoré (id déjà purgé).

## Commandes compagnon exposées au registre (`devices.*`)

| Commande | Portée | Payload | Effet |
| --- | --- | --- | --- |
| `devices.list` | cloud + local | `{}` | Catalogue des devices connectés (id, nom, éléments, date de connexion) |
| `devices.trigger` | cloud + local | `{ deviceId, elementId, action, payload?, data? }` | Relaie la commande au device concerné, résout avec le résultat de son `ack` |
| `devices.listTokens` | local uniquement | `{}` | Liste des devices connus (id, nom, date de création) — jamais le hash |
| `devices.generateToken` | local uniquement | `{ deviceId, name }` | Génère un nouveau token (retourné en clair une seule fois) |
| `devices.revokeToken` | local uniquement | `{ deviceId }` | Révoque un device (son token cesse de fonctionner immédiatement) |

`listTokens`/`generateToken`/`revokeToken` sont **portée `local`** : jamais déclenchables
depuis le cloud, uniquement depuis l'IHM desktop du compagnon (IPC `devices:*`,
`desktop/main.js`) — seul le streamer décide quels devices existent.

## Heartbeat

Ping/pong WebSocket natif (30 s). À la coupure, la connexion est retirée du registre —
**pas de reconnexion côté compagnon** (c'est au script de se reconnecter avec son propre
backoff, comme le compagnon le fait déjà vers le cloud). Les commandes émises pendant une
coupure ne sont pas mises en file (déclenchement physique → pas de rejeu tardif).

## Implémentations client

Le protocole n'est que WS + JSON : n'importe quel runtime capable d'ouvrir une connexion
WebSocket sortante peut y participer.

- **Référence** : `rpi/klixa_device_agent.py` (Python, à venir — cf.
  `docs/local-device-agent-plan.md` §7).
- **Alternative** : firmware ESP32/ESP8266 (Arduino `WebSocketsClient` + `ArduinoJson`,
  ou MicroPython) — même `hello`/`registered`/`command`/`ack`, sans changement côté
  compagnon.
