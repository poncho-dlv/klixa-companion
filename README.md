# Klixa Companion

Agent local (hub) du projet [Klixa Live](../Overlays). Il fait le pont entre les
intégrations **locales** (machine à fumée, et à terme Hue, Streamer.bot…) et le
serveur Klixa, **sans jamais ouvrir de port entrant** : c'est le compagnon qui
initie une connexion WebSocket **sortante** vers le cloud, qui pousse ses
commandes dans ce tuyau.

```
[Klixa cloud]  ◄── WS sortante ───  [Compagnon (Node, Docker, NAS)]  ── HTTP LAN ──►  [RPi (GPIO Python)]
                                       hub + registre d'intégrations                     relais → fumée
```

## Composants

- **Compagnon** (`src/`) — Node.js, conteneurisé, tourne sur le NAS Synology.
  Liaison cloud sortante + serveur HTTP local de test + registre d'intégrations.
- **Service GPIO** (`rpi/`) — micro-service Python sur le Raspberry Pi qui pilote
  le relais de la machine à fumée. Voir [rpi/README.md](rpi/README.md).
- **Protocole** (`protocol/messages.md`) — contrat des messages compagnon ↔ cloud.

## Lancer le compagnon (dev local)

```bash
npm install
cp .env.example .env   # remplir les valeurs
npm start              # mode local seul si CLOUD_WS_URL est vide
npm test               # node --test
```

### Tester la fumée sans le cloud

Le serveur local expose le même dispatch que la liaison cloud :

```bash
curl -X POST http://localhost:8786/commands/smoke.trigger \
  -H "content-type: application/json" \
  -d '{"durationMs":300}'

curl http://localhost:8786/live     # processus vivant (liveness)
curl http://localhost:8786/health   # disponibilité des intégrations (503 si dégradé)
```

## Déploiement (NAS)

```bash
cp .env.example .env   # remplir les valeurs
docker compose up -d --build
```

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| `CLOUD_WS_URL` | URL WS du serveur Klixa (`wss://<host>/companion/ws`). Vide = mode local seul. |
| `COMPANION_TOKEN` | Token d'auth dédié, généré côté Klixa (Paramètres → Compagnon). Distinct du token overlay. Le serveur en déduit le tenant. |
| `PORT` | Port du serveur local (défaut 8786). |
| `COMPANION_HOST` | Adresse d’écoute (défaut `127.0.0.1`). Utiliser `0.0.0.0` dans le conteneur pour un accès LAN. |
| `COMPANION_LOCAL_TOKEN` | Protège `POST /commands/*`. Obligatoire en production si l’écoute n’est pas limitée à loopback. |
| `SMOKE_ENABLED` | Active l'intégration fumée (défaut true). |
| `SMOKE_SERVICE_URL` | URL du service GPIO sur le RPi (ex. `http://192.168.1.50:8787`). |
| `SMOKE_SERVICE_TOKEN` | Secret partagé avec le service GPIO. |
| `SMOKE_DEFAULT_MS` / `SMOKE_MIN_MS` / `SMOKE_MAX_MS` | Bornes de durée d'impulsion. |
| `HUE_ENABLED` | Active l'intégration Hue native (défaut true). |
| `HUE_BRIDGE_IP` | IP du bridge Philips Hue sur le LAN (ex. `192.168.1.40`). |
| `HUE_APP_KEY` | Clé d'application Hue (`hue-application-key`). |
| `HUE_ALLOW_PAYLOAD_CREDENTIALS` | Autorise explicitement les credentials Hue venant du cloud (défaut false). La cible reste limitée à une IP privée littérale. |
| `HUE_MAX_LIGHTS` / `HUE_CONCURRENCY` | Limite de lampes par commande (50) et de requêtes Hue simultanées (5). |
| `OBS_ENABLED` | Active l'intégration OBS native (défaut true). |
| `OBS_WS_URL` | URL obs-websocket (défaut `ws://127.0.0.1:4455`). |
| `OBS_WS_PASSWORD` | Mot de passe obs-websocket (si activé dans OBS). |
| `SB_ENABLED` | Active le pont Streamer.bot (défaut true). |
| `SB_HOST` / `SB_PORT` / `SB_ENDPOINT` / `SB_PASSWORD` / `SB_SCHEME` | Connexion au WebSocket Streamer.bot sur le LAN (`SB_HOST` = IP du PC SB, pas 127.0.0.1 si compagnon sur NAS). |

Le bridge Hue utilise un certificat local auto-signé : la chaîne TLS n'est pas validée. La cible est donc limitée à une adresse IP privée littérale. Le pont Streamer.bot relaie aussi `Pulsoid.HeartRatePulse` vers Klixa. Pour le mode BPM local, l'intégration Pulsoid doit être active dans Streamer.bot et la source BPM doit être réglée sur `Streamer.bot local` côté Klixa.

## Ajouter une intégration

1. Créer `src/integrations/<nom>.js` exportant
   `{ id, commands: { '<nom>.<action>': async (payload) => result }, healthcheck? }`.
2. L'enregistrer dans `src/integrations/index.js`.

Les commandes deviennent automatiquement disponibles via la liaison cloud
(`capabilities`) et le serveur local (`POST /commands/<nom>.<action>`).
