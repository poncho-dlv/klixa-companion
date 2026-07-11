# Klixa Companion Desktop

## Parcours utilisateur

1. Installer `Klixa-Companion-Setup-<version>.exe`.
2. Renseigner l'URL WebSocket Klixa et le token genere dans le dashboard.
3. Verifier les reglages OBS et Streamer.bot, puis enregistrer.
4. Fermer la fenetre : le compagnon continue dans la zone de notification.

Le menu de l'icone permet de rouvrir ou quitter l'application. L'option de
demarrage Windows est configuree pour l'utilisateur courant, sans droits admin.

## Developpement et publication

Utiliser `npm run desktop` en developpement et `npm run dist:win` pour produire
l'installateur dans `release/`. Incrementer la version de `package.json` et signer
les artefacts avant publication. Les secrets de signature doivent rester dans le
coffre du pipeline, jamais dans ce depot.

Les mises a jour automatiques utilisent un flux HTTP generique electron-builder.
Definir `KLIXA_UPDATE_URL` au lancement, ou `UPDATE_URL` dans la configuration
deployee, puis publier l'EXE, son `.blockmap` et `latest.yml` a cette URL.
