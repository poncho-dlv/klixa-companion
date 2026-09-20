# Protocole — Compagnon et Cloud Klixa

Connexion **WebSocket sortante** initiée par le compagnon. Le cloud ne se
connecte jamais au compagnon. Tous les messages sont du JSON (un objet par trame).

## Authentification

À la connexion (sur le path `/companion/ws`), le compagnon présente un header HTTP
`Authorization: Bearer <COMPANION_TOKEN>` puis envoie un message `hello`. **Le serveur
résout le tenant à partir du token** (cache `token → tenantId`) ; le `tenantId` annoncé
dans le `hello` est purement informatif et n'est jamais une source de confiance. Token
invalide/manquant → handshake fermé avec le code `4401`.

## Compagnon → Cloud

### `hello` (à la connexion)
```json
{
  "type": "hello",
  "tenantId": "<tenant>",
  "token": "<COMPANION_TOKEN>",
  "capabilities": ["devices.list", "devices.trigger"]
}
```
`capabilities` = liste des commandes que le compagnon sait exécuter (dérivée du
registre d'intégrations). Le cloud n'enverra que des commandes connues.

### `ack` (réponse à une commande)
```json
{ "type": "ack", "id": "<id-commande>", "ok": true, "result": { "durationMs": 300 } }
```
```json
{ "type": "ack", "id": "<id-commande>", "ok": false, "error": "...", "code": "UNKNOWN_COMMAND" }
```

### `event` (remontée d'un event local)
```json
{ "type": "event", "payload": { "event": { "source": "Obs", "type": "SceneChanged" }, "data": { "scene": { "sceneName": "Ingame" } } } }
```
Le compagnon REMONTE un event vers le cloud (ex. OBS scènes/stream). `payload` est un
event « brut » `{ event:{source,type}, data }` directement injecté dans `processRawEvent`
côté cloud, dans le contexte du tenant résolu depuis le token. Pas de file : un event
émis pendant une coupure n'est pas rejoué.

## Cloud → Compagnon

### `command`
```json
{ "type": "command", "id": "<uuid>", "name": "devices.trigger", "payload": { "deviceId": "smoke-machine", "elementId": "relay", "action": "trigger", "payload": { "durationMs": 300 } } }
```
- `id` : identifiant opaque, renvoyé tel quel dans l'`ack`.
- `name` : nom canonique `<integration>.<action>`.
- `payload` : paramètres de la commande.

## Commandes disponibles

| Commande | Payload | Effet |
|----------|---------|-------|
| `devices.list` | `{}` | Catalogue des appareils LAN génériques connectés (RPi, ESP...) — cf. `devices-messages.md` |
| `devices.trigger` | `{ deviceId, elementId, action, payload?, data? }` | Relaie une commande à un appareil LAN connecté — cf. `devices-messages.md` |
| `hue.color` | `{ lightIds[], color, brightness?, transitionMs?, durationMs?, mode?, sceneId? }` | Couleur/scène Hue en direct sur le bridge (LAN). `mode:'simple'` = clignotement puis restauration. `sceneId` = rappel de scène. Credentials TOUJOURS lues en local (`.env`/config desktop) — plus aucune surcharge possible par le payload cloud. |
| `hue.discover` | `{}` | Liste TOUTES les lampes du bridge (credentials locales), chacune avec son `kind` (`color`/`tunable_white`/`dimmable`/`onoff`, déduit des capacités) et, pour un blanc réglable, `minKelvin`/`maxKelvin`. **Le résultat revient dans l'`ack`** (`{ lights[] }` — aucune IP). Sert à l'assistant Hue de l'IHM desktop (IPC `hue:discover`) ; Klixa lit désormais `hue.lights`. |
| `hue.lights` | `{}` | Uniquement les lampes **choisies dans l'assistant Hue du compagnon** (`HUE_LIGHT_IDS`) : `{ selectionConfigured, lights[] }` (même forme de lampe que `hue.discover`). `selectionConfigured: false` = rien choisi encore, Klixa garde alors sa sélection précédente. Lève si le bridge est injoignable. |
| `hue.status` | `{}` | Statut d'appairage : `{ bridgeConfigured, paired, selectionConfigured }` (booléens, aucune IP/clé dans la réponse). |
| `hue.register` | `{ bridgeIp?, devicetype? }` | Crée une clé d'application (appuyer sur le bouton du bridge avant l'appel), persiste `bridgeIp`/`appKey` en config locale. **N'est plus déclenchée par le cloud** — Klixa ne connaît jamais l'IP du bridge, même transitoirement. L'appairage se fait exclusivement depuis l'UI desktop du compagnon (IPC → `registerHueBridge`, hors du protocole cloud) ; la commande reste dans le registre pour un déclenchement local via `local-server.js` (`POST /commands/hue.register`). |
| `obs.sync-overlay-token` | `{ overlayToken, overlayBase }` | Réécrit le token overlay dans les sources navigateur OBS dont l'URL commence par `overlayBase`. Renvoie `{ updated, alreadyOk, sources }`. (OBS natif via obs-websocket — remplace ObsSyncOverlayToken.cs.) |
| `streamerbot.action` | `{ actionId, args? }` | Exécute une action Streamer.bot par id (raccourcis modération, actions déclenchées par overlay). Renvoie `{ requestId }`. |

> Remontent aussi via le message `event` : Hue (`{ event:{ source:'Hue', type:'LightsChanged' }, data:{} }` — notification interne « la sélection de lampes a peut-être changé », émise ~1 s après le démarrage/la reconfiguration de l'intégration si une sélection est configurée ; Klixa relit alors `hue.lights`, rien de sensible n'y transite), OBS (`Obs.SceneChanged`/`StreamingStarted`/`StreamingStopped`) et Streamer.bot (`Pulsoid.HeartRatePulse` — forwardé brut pour le mode BPM local).

## Heartbeat

Ping/pong WebSocket natif. À la coupure, le compagnon se reconnecte
(backoff exponentiel borné). Les commandes émises pendant une coupure ne sont
pas mises en file (déclenchement physique → on ne rejoue pas une fumée tardive).
