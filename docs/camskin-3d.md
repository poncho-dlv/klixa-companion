# Skins caméra 3D

Un skin 3D est un modèle **glTF binaire (`.glb`)** ancré sur le visage grâce à la matrice de
transformation faciale de MediaPipe, plus un petit **manifeste JSON**. Rendu par three.js
(`src/integrations/camskin/web/skin3d.js`), dans l'overlay OBS et dans l'aperçu du suivi.

## Ajouter un skin

1. Déposer `assets/camskin/skins/<id>/<modele>.glb` et `manifest.json`.
2. Déclarer le skin dans `web/skins.js` : `{ label, model: '/models/skins/<id>/manifest.json' }`.
3. Côté Klixa : ajouter l'id à `shared/js/cam-skins-catalog.js` et la clé `automations.camSkin_<id>`
   dans les deux fichiers i18n de l'admin.

## Repère du modèle

- Unités : **centimètres**. Origine : centre de la tête (repère « visage canonique » MediaPipe).
- `+Y` vers le haut, `+Z` vers l'avant du visage (à confirmer sur un vrai visage pour `X` : droite/gauche).
- Un visage fait environ 14 cm de large (X), 20 cm de haut (Y). Le front est vers `y ≈ +8`.
- Export Blender : glTF binaire, **+Y up** coché, appliquer les transformations (`Ctrl+A`).

## Manifeste

```json
{
  "model": "dragon.glb",
  "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1 },
  "occluder": { "enabled": true, "position": [0, 0, -3], "radii": [7, 9.5, 8] },
  "jaw": { "node": "Jaw", "axis": [1, 0, 0], "maxAngleDeg": 22 },
  "morphGain": 1,
  "light": { "ambient": 1.1, "key": 1.6 }
}
```

- `model` : chemin relatif, doit rester sous `/models/`.
- `occluder` : ellipsoïde invisible qui masque ce qui passe derrière la tête (oreilles, arrière
  des cornes). À ajuster pour que les accessoires collés au visage ne soient pas coupés.
- `jaw` (facultatif) : un nœud du modèle qui pivote selon `jawOpen`. Origine du nœud = charnière.
- `morphGain` : multiplicateur des morph targets.

## Animation

- **Morph targets** : tout morph target dont le nom est un blendshape MediaPipe (`jawOpen`,
  `eyeBlinkLeft`, `mouthSmileRight`, `cheekPuff`…, liste dans `web/skin-manifest.js`) est piloté
  automatiquement, sans configuration.
- **Os / nœud de mâchoire** : alternative simple si le modèle n'a pas de morph targets.

## Calibrage

Fenêtre de suivi (`tracker.html`), skin 3D actif : panneau « Calibrage 3D » (position, rotation,
échelle, cache de tête, bouton « Voir le cache de tête »). Les réglages sont mémorisés par
navigateur pour l'aperçu ; **« Copier le manifeste »** produit le JSON à coller dans
`manifest.json` pour que l'overlay OBS les utilise aussi.

## Budget de performance (Source navigateur OBS)

~10 à 30 k triangles, textures ≤ 1024 px, un seul matériau si possible.

## Générer un modèle avec Blender (sans modéliser à la main)

`scripts/blender/make_frog.py` et `make_dragon.py` construisent les skins par code et exportent le
`.glb` ; les outils communs (primitives, yeux, clés de forme, export, aperçus) sont dans
`scripts/blender/camskin_lib.py`.

```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b -P scripts/blender/make_dragon.py -- --render <dossier>
```

`--render` produit des aperçus PNG (face, trois-quarts, bouche ouverte, profil) ; `--hide <prefixe>`
masque des objets dans ces aperçus (debug). Conventions à respecter pour qu'un skin soit animé
sans code : nœud `Jaw` (mâchoire), nœuds `EyeLeft`/`EyeRight` (globes, +X = œil « Left »), shape
keys nommées comme les blendshapes MediaPipe (`eyeBlinkLeft/Right`, `cheekPuff`, `noseSneer*`,
`mouthUpperUp*`) et `nostrilBreath`. Pièges : Blender crée les shape keys à la valeur **1.0** (le
repos doit être à 0 : `add_shape_key` s'en charge), ne jamais éditer la clé `Basis`, et l'export
n'est pas identique au bit près d'une exécution à l'autre.

Les hauteurs du visage sont alignées sur le modèle canonique MediaPipe (pointe du nez y≈-3,4 cm,
bouche y≈-6,2 cm) et la tête est assez grande pour couvrir cheveux, casque et cou.

## Champs avancés du manifeste

- `jaw.gain` / `jaw.lipGain` / `jaw.curve` : ouverture de la mâchoire. Le plus grand de `jawOpen x gain`
  et de l'écart réel des lèvres `x lipGain` l'emporte ; `curve` < 1 amplifie les faibles ouvertures.
- `eyes` : `{ left, right, maxYawDeg, maxPitchDeg, gain }` — nœuds de globes pilotés par `eyeLook*`.
- `breath` : `{ morph, periodSec, amount }` — morph target animé par le temps (narines).
- `texture` : `{ materials[], scale, blotch, bump }` — peau procédurale (taches, grain, verrues) injectée
  dans les matériaux nommés, sans UV ni image.
- `stabilize.noseHold` : MediaPipe calcule la pose avec des points du nez, un froncement fait glisser
  toute la tête ; la pose reste proche de la dernière pose saine pendant `noseSneer*`.
- `morphGains` : gain par blendshape (ex. `eyeBlinkLeft: 1.6`, car `eyeBlink` dépasse rarement 0,8).
