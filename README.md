# Klixa Companion

[![Licence Apache 2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

Klixa Companion est un logiciel open source distribué sous licence Apache-2.0.
Le service cloud Klixa auquel il peut se connecter est un produit distinct et
n'est pas inclus dans ce dépôt. La licence du compagnon n'accorde aucun droit
sur les marques, services cloud ou autres produits Klixa.

Agent local (hub) du projet [Klixa Live](../Overlays). Il fait le pont entre les
intégrations **locales** (Hue, OBS, Streamer.bot, appareils LAN
génériques comme la machine à fumée…) et le serveur Klixa, **sans jamais ouvrir de
port accessible depuis Internet** : c'est le compagnon qui initie une connexion
WebSocket **sortante** vers le cloud, qui pousse ses commandes dans ce tuyau. Sur le
LAN du streamer, c'est l'inverse pour les appareils génériques (RPi, ESP...) : c'est
le script/firmware qui se connecte AU compagnon, pas le contraire — même logique
« le nœud le moins stable initie vers le nœud stable », un niveau plus bas.

```
[Klixa cloud]  ◄── WS sortante ───  [Klixa Compagnon]  ◄── WS sortante ───  [RPi, ESP, script perso...]
                                           │
                                           └── [Hue, OBS, Streamer.bot] (natif, sur le LAN)
```

## Composants

- **Compagnon** (`src/`) — Node.js. Liaison cloud sortante + serveur HTTP local
  de test + registre d'intégrations + hub d'appareils LAN génériques
  (`device-hub.js`, path `/devices/ws`). Se déploie en app Windows (Electron).
- **Application desktop** (`desktop/`) — enrobage Electron du compagnon, avec
  écran de configuration et pairing. Voir [desktop/README.md](desktop/README.md).
- **Appareils LAN** — scripts et SDK pour connecter du matériel (Raspberry Pi, ESP, lampes…) au
  compagnon : dépôt séparé [klixa-lan-devices](https://github.com/poncho-dlv/klixa-lan-devices) (SDK Python de référence, machine à fumée
  commandée par un relais, lampes SmallRig).
- **Protocole compagnon ↔ cloud** (`protocol/messages.md`) — contrat des messages
  entre le compagnon et le cloud.
- **Protocole compagnon ↔ appareils LAN** (`protocol/devices-messages.md`) — contrat
  générique pour tout script/firmware tiers (RPi, ESP...) qui se connecte au
  compagnon et s'annonce avec ses éléments pilotables.

## Développement

```bash
npm install
cp .env.example .env   # remplir les valeurs
npm start               # mode local seul si CLOUD_WS_URL est vide
npm test                # node --test
```

## Déploiement

### Application Windows (Electron)

Pensée pour les streamers : icône dans la zone de notification, écran de
configuration, pairing par code à 6 chiffres avec le cloud Klixa, secrets
chiffrés via Windows, démarrage automatique à l'ouverture de session.

```bash
npm install
npm run desktop         # lancer en développement
npm run dist:win         # générer l'installateur NSIS dans release/
```

L'installateur généré est `release/Klixa-Companion-Setup-<version>.exe`. Pour
une diffusion publique sans avertissement SmartScreen, signer l'exécutable et
l'installateur avec un certificat de signature de code avant publication. Voir
[desktop/README.md](desktop/README.md) pour le parcours complet et la publication.

## Lampes SmallRig : parties vers un appareil LAN

Le support des lampes SmallRig RM75 (Bluetooth Mesh, reverse engineering) **n'est plus dans le compagnon
ni dans Klixa** : il vit dans le dépôt [klixa-lan-devices](https://github.com/poncho-dlv/klixa-lan-devices)
(`devices/smallrig`), qui expose chaque lampe comme un appareil LAN de type `light` (voir
[protocol/devices-messages.md](protocol/devices-messages.md)).

Les lampes SmallRig déjà utilisées avec une version ≤ 0.5.x sont à appairer à neuf avec ce script.

## Variables d'environnement

> Ce tableau concerne le mode local headless (`npm start`, `.env` manuel), utile
> en développement. L'app desktop (`desktop/`) peut obtenir
> `CLOUD_WS_URL`/`COMPANION_TOKEN` automatiquement via un pairing par code à 6
> chiffres — voir [desktop/README.md](desktop/README.md).

| Variable | Description |
| -------- | ----------- |
| `CLOUD_WS_URL` | URL WS du serveur Klixa (`wss://<host>/companion/ws`). Vide = mode local seul. |
| `COMPANION_TOKEN` | Token d'auth dédié, généré côté Klixa (Paramètres → Compagnon). Distinct du token overlay. Le serveur en déduit le tenant. |
| `PORT` | Port du serveur local (défaut 8786). |
| `COMPANION_HOST` | Adresse d'écoute (défaut `127.0.0.1`). Utiliser `0.0.0.0` pour un accès LAN. |
| `COMPANION_LOCAL_TOKEN` | Protège `POST /commands/*`. Obligatoire en production si l'écoute n'est pas limitée à loopback. |
| `SMOKE_ENABLED` | Active l'intégration fumée (défaut true). |
| `SMOKE_SERVICE_URL` | URL du service GPIO sur le RPi (ex. `http://192.168.1.50:8787`). |
| `SMOKE_DEFAULT_MS` / `SMOKE_MIN_MS` / `SMOKE_MAX_MS` | Bornes de durée d'impulsion. |
| `HUE_ENABLED` | Active l'intégration Hue native (défaut true). |
| `HUE_BRIDGE_IP` | IP du bridge Philips Hue sur le LAN (ex. `192.168.1.40`). En usage desktop, se configure et s'appaire depuis l'app Klixa Companion — jamais fourni par le cloud. |
| `HUE_APP_KEY` | Clé d'application Hue (`hue-application-key`), obtenue par appairage. Jamais fournie par le cloud. |
| `HUE_LIGHT_IDS` | Lampes Hue utilisées avec Klixa (JSON ou liste séparée par virgules), choisies dans l'assistant Hue de l'app desktop (étape « Lampes »). Vide = jamais choisi : Klixa garde alors sa sélection précédente ; `[]` = choix explicite « aucune ». Klixa ne reçoit que ces lampes (commande `hue.lights`). |
| `HUE_MAX_LIGHTS` / `HUE_CONCURRENCY` | Limite de lampes par commande (50) et de requêtes Hue simultanées (5). |
| `OBS_ENABLED` | Active l'intégration OBS native (défaut true). |
| `OBS_WS_URL` | URL obs-websocket (défaut `ws://127.0.0.1:4455`). |
| `OBS_WS_PASSWORD` | Mot de passe obs-websocket (si activé dans OBS). |
| `SB_ENABLED` | Active le pont Streamer.bot (défaut true). |
| `SB_HOST` / `SB_PORT` / `SB_ENDPOINT` / `SB_PASSWORD` / `SB_SCHEME` | Connexion au WebSocket Streamer.bot sur le LAN (`SB_HOST` = IP du PC SB, pas 127.0.0.1 si le compagnon tourne sur une autre machine). |

Le bridge Hue utilise un certificat local auto-signé : la chaîne TLS n'est pas validée. La cible est donc limitée à une adresse IP privée littérale. Le pont Streamer.bot relaie aussi `Pulsoid.HeartRatePulse` vers Klixa. Pour le mode BPM local, l'intégration Pulsoid doit être active dans Streamer.bot et la source BPM doit être réglée sur `Streamer.bot local` côté Klixa.

## Ajouter une intégration

1. Créer `src/integrations/<nom>.js` exportant
   `{ id, commands: { '<nom>.<action>': async (payload) => result }, commandScopes?, healthcheck? }`.
2. L'enregistrer dans `src/integrations/index.js`.

Les commandes deviennent automatiquement disponibles via la liaison cloud
(`capabilities`) et le serveur local (`POST /commands/<nom>.<action>`). Déclarez
`commandScopes: { '<nom>.appairer': 'local' }` pour toute action physique ou
d'administration qui ne doit jamais être déclenchée par le cloud.

## Contribuer et sécurité

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) avant de proposer une modification.
Les vulnérabilités doivent être signalées de manière privée selon
[SECURITY.md](SECURITY.md), jamais dans une issue publique.
