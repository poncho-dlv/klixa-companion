# Preparation SignPath Foundation

Le depot est prepare pour demander la signature gratuite reservee aux projets
open source. SignPath doit accepter le projet avant que l'etape de signature
puisse etre ajoutee au workflow.

## Avant la candidature

- rendre le depot GitHub public ;
- activer GitHub Private vulnerability reporting ;
- fusionner le workflow `Build` sur la branche par defaut et verifier son succes ;
- publier une premiere release non signee et documentee ;
- verifier que le nom, la description et la licence Apache-2.0 sont visibles ;
- ne jamais ajouter de composant proprietaire au contenu de l'installateur.

## Candidature

Demander l'inscription sur https://signpath.org/ et fournir :

- depot : `https://github.com/poncho-dlv/klixa-companion` ;
- artefact : installateur Windows NSIS x64 ;
- workflow reproductible : `.github/workflows/build.yml` ;
- licence : Apache-2.0 ;
- description du projet et lien vers la premiere release.

Apres acceptation, SignPath fournit les identifiants d'organisation, de projet,
de politique et de configuration d'artefact. Ajouter alors leur action officielle
au job Windows et stocker le jeton API uniquement dans GitHub Actions Secrets.

Ne pas inventer ou preconfigurer ces identifiants : ils sont propres au projet
cree par SignPath. Le binaire signe doit provenir exclusivement du workflow lie
au commit public correspondant.
