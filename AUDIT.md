# Audit technique et feuille de route

Audit réalisé le 10 juillet 2026, sans modification fonctionnelle du projet.

## État initial

- 21 tests Node passent (`npm.cmd test`).
- Les vérifications syntaxiques Node et Python passent.
- Architecture générale claire : transport cloud, serveur local, registre et intégrations sont correctement séparés.
- Les tests actuels couvrent surtout les fonctions pures ; les flux réseau et le cycle de vie sont peu testés.

## Ordre de correction

### 1. Sécuriser la correspondance des URL OBS — priorité élevée

- [x] Remplacer la comparaison par préfixe de `urlMatchesBase()` par une comparaison d’URL structurée.
- [x] Comparer exactement le protocole, le nom d’hôte et le port.
- [x] Vérifier le chemin séparément si `overlayBase` contient un chemin.
- [x] Ajouter des tests contre les domaines trompeurs comme `overlays.klixa.live.attacker.example`.

Fichier principal : `src/integrations/obs.js`

Critère de validation : aucune URL d’une autre origine ne peut recevoir le token overlay.

### 2. Limiter les corps HTTP — priorité élevée

- [x] Fixer une taille maximale côté serveur Node, par exemple 64 Ko.
- [x] Interrompre la lecture et répondre `413 Payload Too Large` lorsque la limite est dépassée.
- [x] Valider et borner `Content-Length` dans le service Python.
- [x] Ajouter des délais de lecture raisonnables.
- [x] Tester les corps trop grands et les longueurs invalides.
- [ ] Tester les corps tronqués sur les serveurs HTTP complets.

Fichiers principaux : `src/local-server.js`, `rpi/smoke_service.py`

Critère de validation : un client LAN ne peut pas provoquer une croissance mémoire non bornée ni monopoliser un thread avec une requête invalide.

### 3. Dédupliquer les commandes cloud — priorité élevée

- [x] Conserver temporairement les commandes traitées, indexées par leur `id`.
- [x] Renvoyer le même ACK lorsqu’un identifiant est reçu une seconde fois.
- [x] Borner le cache à 1 000 entrées et cinq minutes.
- [x] Rejeter les commandes sans identifiant valide avec `INVALID_COMMAND_ID`.
- [x] Tester les doublons simultanés et l’expiration correspondant à une reconnexion tardive.

Fichier principal : `src/cloud-link.js`

Critère de validation : une même commande physique, notamment `smoke.trigger`, ne s’exécute jamais deux fois pour le même identifiant.

### 4. Ajouter un cycle de vie propre aux intégrations — priorité moyenne

- [x] Faire conserver les intégrations par le registre et ajouter `registry.stop()`.
- [x] Appeler les méthodes `stop()` d’OBS et Streamer.bot.
- [x] Attendre la fermeture du serveur HTTP, du WebSocket cloud et des intégrations.
- [x] Prévoir une échéance maximale d’arrêt de cinq secondes.
- [x] Retirer l’appel immédiat à `process.exit(0)`.
- [x] Tester qu’un échec d’arrêt n’empêche pas les autres intégrations de se fermer.
- [ ] Ajouter un test de processus complet pendant une reconnexion et une commande en cours.

Fichiers principaux : `src/index.js`, `src/integration-registry.js`, `src/integrations/obs.js`, `src/integrations/streamerbot.js`

Critère de validation : SIGINT/SIGTERM ferme toutes les ressources sans reconnexion tardive ni interruption brutale inutile.

### 5. Implémenter le heartbeat WebSocket — priorité moyenne

- [x] Envoyer périodiquement un ping vers le cloud.
- [x] Suivre la réception des pong.
- [x] Fermer une connexion considérée comme semi-ouverte après expiration.
- [x] Nettoyer les timers lors d’une fermeture ou d’un arrêt.
- [x] Ajouter des tests avec une socket simulée pour les cycles ping/pong et l’expiration.

Fichier principal : `src/cloud-link.js`

Critère de validation : une connexion devenue inutilisable est détectée et reconnectée automatiquement dans un délai borné.

### 6. Corriger le healthcheck — priorité moyenne

- [x] Exécuter les healthchecks en parallèle.
- [x] Calculer `ok` depuis l’état réel des intégrations.
- [x] Séparer liveness (`/live`) et readiness (`/health`).
- [x] Retourner HTTP 503 dès qu’une intégration activée est indisponible.
- [x] Ajouter un délai individuel de cinq secondes aux healthchecks.
- [x] Tester les états sain, dégradé, parallèle et bloqué.

Fichiers principaux : `src/integration-registry.js`, `src/local-server.js`

Critère de validation : les outils de supervision ne reçoivent plus un faux état sain et le temps de réponse ne correspond plus à la somme des timeouts.

### 7. Durcir l’accès HTTP sur le LAN — priorité moyenne

- [x] Rendre `COMPANION_LOCAL_TOKEN` obligatoire en production si le serveur écoute hors loopback.
- [x] Comparer les secrets de façon résistante au timing via SHA-256 et `timingSafeEqual`.
- [x] Écouter sur `127.0.0.1` par défaut ou sur `COMPANION_HOST` explicitement configuré.
- [x] Documenter les modes local uniquement et LAN authentifié.
- [x] Ajouter des tests de validation du token et de la configuration de production.

Fichiers principaux : `src/local-server.js`, `src/config.js`, `docker-compose.yml`, `.env.example`

Critère de validation : aucune commande locale ne peut être déclenchée anonymement sur une installation de production.

### 8. Encadrer les cibles Hue — priorité moyenne

- [x] Désactiver par défaut la surcharge de `bridgeIp` et `appKey` par le cloud.
- [x] Ajouter l’option explicite `HUE_ALLOW_PAYLOAD_CREDENTIALS` et limiter toute cible à une IP privée.
- [x] Refuser les noms d’hôte, IP publiques et formats inattendus.
- [x] Documenter explicitement la désactivation de la validation TLS du bridge Hue.
- [x] Ajouter des tests de validation IPv4, IPv6, publique et nom d’hôte.

Fichier principal : `src/integrations/hue.js`

Critère de validation : une commande cloud ne peut pas transformer le compagnon en relais vers une cible interne arbitraire.

### 9. Borner le parallélisme Hue — priorité faible

- [x] Limiter le nombre de lampes accepté par commande (50 par défaut, 200 maximum configurable).
- [x] Dédupliquer et normaliser les identifiants de lampes.
- [x] Limiter le nombre de requêtes simultanées (5 par défaut, 20 maximum configurable).
- [x] Toujours tenter la restauration de chaque lampe après une erreur de clignotement.
- [x] Tester la normalisation et le plafond de concurrence.
- [ ] Ajouter un test HTTP Hue simulant des erreurs partielles de restauration.

Fichier principal : `src/integrations/hue.js`

Critère de validation : une commande ne peut pas produire une rafale réseau non bornée et les échecs partiels sont rapportés proprement.

### 10. Durcir et rendre reproductible l’image Docker — priorité faible

- [x] Copier `package-lock.json` dans l’image.
- [x] Utiliser `npm ci --omit=dev`.
- [x] Exécuter le service sous l’utilisateur non privilégié `node`.
- [x] Ajouter un `HEALTHCHECK` basé sur `/live`.
- [x] Configurer le conteneur en lecture seule avec `/tmp` en tmpfs et `no-new-privileges`.

Fichiers principaux : `Dockerfile`, `docker-compose.yml`

Critère de validation : deux builds basés sur le même lockfile installent les mêmes versions et le processus Node ne tourne pas en root.

## Améliorations transversales

- [ ] Centraliser la validation des payloads et les erreurs typées.
- [ ] Éviter de démarrer les connexions réseau directement dans les constructeurs d’intégration.
- [ ] Ajouter des tests d’intégration pour le serveur HTTP, le cloud WebSocket et le service GPIO.
- [ ] Structurer les logs en JSON en production.
- [ ] Ne pas exposer directement aux clients les erreurs internes sensibles.
- [ ] Valider les bornes de configuration, notamment les délais de reconnexion et les durées min/max.

## Commandes de vérification

```powershell
npm.cmd test
node --check src/index.js
node --check src/cloud-link.js
node --check src/local-server.js
python -m py_compile rpi/smoke_service.py
```

Après chaque correction, cocher les tâches correspondantes et ajouter les nouveaux tests avant de passer à l’étape suivante.
