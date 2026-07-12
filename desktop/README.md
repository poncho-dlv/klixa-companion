# Klixa Companion Desktop

## Parcours utilisateur

1. Installer `Klixa-Companion-Setup-<version>.exe`.
2. Cliquer « Lier ce compagnon » : un code a 6 chiffres s'affiche. Le saisir dans la
   console Klixa, Parametres puis Compagnon, pendant qu'il est valide (10 minutes).
   L'URL WebSocket et le token sont recuperes automatiquement, sans copier-coller
   (device-code flow, cf. `server/companion-pairing-service.js` cote Klixa). L'URL de
   l'instance ciblee par ce pairing est `https://klixa.live` par defaut, modifiable dans
   « Configuration manuelle / autre instance » pour un self-host.
3. Verifier les reglages OBS et Streamer.bot, puis enregistrer. Le lien manuel (URL
   WebSocket + token colles a la main) reste disponible dans ce meme panneau si besoin.
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

Si l'upload web GitHub echoue, lancer le workflow `Publish release` depuis
l'onglet Actions avec le tag concerne. Il construit puis attache automatiquement
l'EXE, le blockmap et `latest.yml` a la release existante. Si elle n'existe pas,
il cree un brouillon de release.
