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

curl http://localhost:8786/health   # état + healthcheck des intégrations
```

## Déploiement (NAS)

```bash
cp .env.example .env   # remplir les valeurs
docker compose up -d --build
```

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| `CLOUD_WS_URL` | URL WS du serveur Klixa. Vide = mode local seul. |
| `COMPANION_TOKEN` | Token d'authentification de la liaison cloud. |
| `TENANT_ID` | Tenant Klixa rattaché au compagnon. |
| `PORT` | Port du serveur local (défaut 8786). |
| `COMPANION_LOCAL_TOKEN` | Optionnel : protège `POST /commands/*` sur le LAN. |
| `SMOKE_ENABLED` | Active l'intégration fumée (défaut true). |
| `SMOKE_SERVICE_URL` | URL du service GPIO sur le RPi (ex. `http://192.168.1.50:8787`). |
| `SMOKE_SERVICE_TOKEN` | Secret partagé avec le service GPIO. |
| `SMOKE_DEFAULT_MS` / `SMOKE_MIN_MS` / `SMOKE_MAX_MS` | Bornes de durée d'impulsion. |

## Ajouter une intégration

1. Créer `src/integrations/<nom>.js` exportant
   `{ id, commands: { '<nom>.<action>': async (payload) => result }, healthcheck? }`.
2. L'enregistrer dans `src/integrations/index.js`.

Les commandes deviennent automatiquement disponibles via la liaison cloud
(`capabilities`) et le serveur local (`POST /commands/<nom>.<action>`).
