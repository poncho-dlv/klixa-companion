# Protocole — Compagnon ↔ Cloud Klixa

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
  "capabilities": ["smoke.trigger"]
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
{ "type": "command", "id": "<uuid>", "name": "smoke.trigger", "payload": { "durationMs": 300 } }
```
- `id` : identifiant opaque, renvoyé tel quel dans l'`ack`.
- `name` : nom canonique `<integration>.<action>`.
- `payload` : paramètres de la commande.

## Commandes disponibles

| Commande | Payload | Effet |
|----------|---------|-------|
| `smoke.trigger` | `{ durationMs }` | Impulsion relais machine à fumée (durée bornée côté compagnon ET RPi) |
| `hue.color` | `{ lightIds[], color, brightness?, transitionMs?, durationMs?, mode?, sceneId? }` | Couleur/scène Hue en direct sur le bridge (LAN). `mode:'simple'` = clignotement puis restauration. `sceneId` = rappel de scène. Credentials du `.env`, surchargeables par `bridgeIp`/`appKey` dans le payload. |
| `hue.discover` | `{ bridgeIp?, appKey? }` | Liste lampes + scènes du bridge. **Le résultat revient dans l'`ack`** (`{ lights[], scenes[] }`) — le cloud le persiste (plus de POST direct du C# vers `/api/hue/discovered`). |
| `hue.register` | `{ bridgeIp?, devicetype? }` | Crée une clé d'application (appuyer sur le bouton du bridge avant l'appel). Renvoie `{ appKey }` dans l'`ack`, ou erreur « appuyez sur le bouton » si non pressé. |
| `obs.sync-overlay-token` | `{ overlayToken, overlayBase }` | Réécrit le token overlay dans les sources navigateur OBS dont l'URL commence par `overlayBase`. Renvoie `{ updated, alreadyOk, sources }`. (OBS natif via obs-websocket — remplace ObsSyncOverlayToken.cs.) |
| `streamerbot.action` | `{ actionId, args? }` | Exécute une action Streamer.bot par id (raccourcis modération, actions déclenchées par overlay). Renvoie `{ requestId }`. |

> Remontent aussi via le message `event` : OBS (`Obs.SceneChanged`/`StreamingStarted`/`StreamingStopped`) et Streamer.bot (`General.Custom`, `Twitch.Announcement`, `Pulsoid.HeartRatePulse` — forwardés bruts).

## Heartbeat

Ping/pong WebSocket natif. À la coupure, le compagnon se reconnecte
(backoff exponentiel borné). Les commandes émises pendant une coupure ne sont
pas mises en file (déclenchement physique → on ne rejoue pas une fumée tardive).
