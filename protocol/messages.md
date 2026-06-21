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
| `hue.discover` | `{}` | Liste lampes + scènes du bridge. **Le résultat revient dans l'`ack`** (`{ lights[], scenes[] }`) — le cloud le persiste (plus de POST direct du C# vers `/api/hue/discovered`). |

## Heartbeat

Ping/pong WebSocket natif. À la coupure, le compagnon se reconnecte
(backoff exponentiel borné). Les commandes émises pendant une coupure ne sont
pas mises en file (déclenchement physique → on ne rejoue pas une fumée tardive).
