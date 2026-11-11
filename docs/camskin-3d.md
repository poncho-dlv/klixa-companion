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

Des volumes qui se croisent (crâne + museau, arcades, pommettes) laissent des arêtes vives à leur intersection : `camskin_lib.merge_blend` les fusionne en un seul maillage (union par remaillage voxel) puis les adoucit (lissage de Taubin) en gardant net le bord de la bouche, qui doit coller à la mâchoire. Les clés de forme sont ajoutées après la fusion. Attention : chaque shape key duplique les sommets, un voxel trop fin (0,3 cm) fait passer le `.glb` à plus de 5 Mo.

Les hauteurs du visage sont alignées sur le modèle canonique MediaPipe (pointe du nez y≈-3,4 cm,
bouche y≈-6,2 cm) et la tête est assez grande pour couvrir cheveux, casque et cou.

## Champs avancés du manifeste

- `jaw.gain` / `jaw.lipGain` / `jaw.curve` : ouverture de la mâchoire. Le plus grand de `jawOpen x gain`
  et de l'écart réel des lèvres `x lipGain` l'emporte ; `curve` < 1 amplifie les faibles ouvertures.
- `eyes` : `{ left, right, maxYawDeg, maxPitchDeg, gain }` — nœuds de globes pilotés par `eyeLook*`.
- `breath` : `{ morph, periodSec, amount }` — morph target animé par le temps (narines).
- `texture` : `{ materials[], scale, blotch, bump, scales }` — peau procédurale (taches, grain, verrues, et
  écailles cellulaires avec `scales` > 0) injectée dans les matériaux nommés, sans UV ni image.
- `stabilize.noseHold` : MediaPipe calcule la pose avec des points du nez, un froncement fait glisser
  toute la tête ; la pose reste proche de la dernière pose saine pendant `noseSneer*`.
- `morphGains` : gain par blendshape (ex. `eyeBlinkLeft: 1.6`, car `eyeBlink` dépasse rarement 0,8).

## Corps (torse, cou, bras)

Un skin peut avoir un corps : le moteur suit alors aussi le corps de la personne (MediaPipe
**Pose Landmarker**, `assets/camskin/pose_landmarker_full.task`, lance en plus du visage, une image
sur deux, seulement si le skin l'a demande : `body: true` dans `skins.js`, case « Corps » de la
fenetre de suivi). Les points utiles (nez, oreilles, epaules, coudes, poignets, mains, hanches ;
`BODY_LANDMARKS`) voyagent dans la trame `face.body`, valides cote serveur par `sanitizeBody`.

Le corps est fait de **pieces rigides** (un noeud glTF par piece, sans armature), dans un second
`.glb` declare par la section `body` du manifeste :

```json
"body": {
  "model": "dragon-body.glb",
  "thickness": 1.1, "depthGain": 0.6, "restShoulder": 40,
  "neckAnchor": [0, -13, -3], "neckBase": 0.12,
  "lengths": { "torso": 45, "neck": 14, "upperArm": 28, "forearm": 26, "hand": 10 }
}
```

Noeuds attendus (nommes) et repere de chacun, origine sur l'articulation de depart, `+Y` vers la
suivante (le moteur oriente, etire et place chaque piece, cf. `body-rig.js` et `skin3d.js`) :
`Torso` (mi-epaules -> mi-hanches, `+Z` = ventre), `Neck` (base du cou -> sous la tete, `+Z` = gorge),
`UpperArm`, `Forearm`, `Hand` (`+X` = exterieur du bras, duplique gauche/droite), `Shoulder`, `Elbow`,
`Wrist` (articulations, echelle uniforme, masquent les raccords). Memes noms de materiaux que la tete :
la peau procedurale du manifeste s'applique aussi au corps.

- `lengths` / `restShoulder` : dimensions du modele AU REPOS (cm) ; chaque piece est etiree selon
  l'ecart reel des points suivis, l'epaisseur suit la largeur d'epaules mesuree (x `thickness`).
- `depthGain` : part de la profondeur monde de la pose (m -> cm) ajoutee a la profondeur de la tete
  (0 = tout dans le plan de la tete ; negatif = sens inverse si le buste se tourne a l'envers).
  L'alignement dans l'image ne depend jamais de la profondeur, seulement l'echelle et l'orientation.
- `neckAnchor` : point du repere de la tete ou le cou vient se raccorder ; `neckBase` : hauteur de
  la base du cou au-dessus des epaules (fraction de leur largeur).
- Membres hors champ ou peu visibles (< 0,4) : le bras pend le long du corps ; hanches non
  visibles : torse estime vers le bas. Epaules non visibles : pas de corps du tout.
- Generer le modele : `blender -b -P scripts/blender/make_dragon_body.py` (`--render DOSSIER` pour
  un apercu des pieces). Le panneau de calibrage a les reglages « Corps » (epaisseur, profondeur,
  accroche du cou) ; « Copier le manifeste » les inclut.
