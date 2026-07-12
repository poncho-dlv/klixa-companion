# Klixa Companion Desktop

## Parcours utilisateur

1. Installer `Klixa-Companion-Setup-<version>.exe`. Au premier lancement, seule la
   section « Connexion Klixa » est visible (aucune config exposee tant que le
   compagnon n'est lie a aucun tenant).
2. Cliquer « Lier ce compagnon » : un code a 6 chiffres s'affiche. Le saisir dans la
   console Klixa, Parametres puis Compagnon, pendant qu'il est valide (10 minutes).
   L'URL WebSocket et le token sont recuperes automatiquement, sans copier-coller
   (device-code flow, cf. `server/companion-pairing-service.js` cote Klixa ; instance
   ciblee = `https://klixa.live`, en dur cote client desktop — pas de champ pour la
   surcharger, cf. `desktop/config-store.js`).
3. Une fois connecte, les sections d'integration (OBS, Streamer.bot, Philips Hue)
   apparaissent ; verifier les reglages puis enregistrer. La section « Machine a
   fumee » ne s'affiche que si la feature tenant correspondante est activee cote
   Klixa (Instance Admin, desactivee par defaut — materiel physique, opt-in
   explicite) : le serveur pousse les features au compagnon a chaque connexion, cf.
   `server/companion-hub.js`.
4. Fermer la fenetre : le compagnon continue dans la zone de notification.

Le menu de l'icone permet de rouvrir l'application, ouvrir les logs, consulter
« À propos » (version courante + bouton « Vérifier les mises à jour » qui court-circuite
le check périodique de 4h, cf. section suivante) ou quitter. L'option de demarrage
Windows est configuree pour l'utilisateur courant, sans droits admin.

## Developpement et publication

Utiliser `npm run desktop` en developpement et `npm run dist:win` pour produire
l'installateur dans `release/`. Incrementer la version de `package.json` et signer
les artefacts avant publication. Les secrets de signature doivent rester dans le
coffre du pipeline, jamais dans ce depot.

Les mises a jour automatiques utilisent le provider `github` d'electron-builder
(`build.publish` dans `package.json`, deduit du depot `poncho-dlv/klixa-companion`) :
electron-builder ecrit `app-update.yml` dans les ressources au build, aucune URL a
gerer a la main. Le compagnon verifie une mise a jour au demarrage puis toutes les
`UPDATE_CHECK_INTERVAL_MS` (4h, `desktop/main.js`) — il tourne en tray potentiellement
plusieurs jours, un seul check au lancement ne suffit pas. Telechargement automatique
en arriere-plan ; une fois prete, un dialogue natif ET une banniere dans l'UI
("Redemarrer et installer") declenchent `autoUpdater.quitAndInstall()` — le dialogue
fonctionne meme fenetre fermee (l'app vit en tray). `KLIXA_UPDATE_URL` reste une
surcharge pour pointer vers un flux HTTP generique auto-heberge (tests uniquement).

Le menu tray « À propos » affiche la version courante et propose « Vérifier les mises
à jour » : declenche un check immediat (`autoUpdater.checkForUpdates()`) sans attendre
le prochain tick de `UPDATE_CHECK_INTERVAL_MS`, avec retour via dialogues natifs (a jour
/ telechargement en cours / erreur).

**Attention : une release `draft` (creee par `Publish release`) est invisible pour
l'auto-updater** : il faut explicitement la publier sur GitHub (bouton "Publish
release") pour que les clients installes la detectent — c'est le garde-fou de
rollout avant diffusion large.

Publier une nouvelle version : incrementer `version` dans `package.json`, pousser un
tag `vX.Y.Z` : le workflow `Publish release` construit et attache l'EXE, le blockmap
et `latest.yml` a une release (brouillon si elle n'existe pas). Verifier le build puis
publier la release. Si l'upload echoue, relancer le workflow depuis l'onglet Actions
avec le tag concerne.
