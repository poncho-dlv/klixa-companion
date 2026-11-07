"""Genere le skin camera "grenouille" (masque de tete complet) avec Blender, sans aucune
modelisation manuelle : formes parametriques, materiaux, noeud de machoire, paupieres animees
par shape keys, export glTF binaire.

Usage (Blender 4.x / 5.x) :
    blender -b -P scripts/blender/make_frog.py -- [--render DOSSIER] [--hide PREFIXE]

Les outils communs (primitives, yeux, cles de forme, export) sont dans camskin_lib.py.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camskin_lib as lib  # noqa: E402
from camskin_lib import add_ellipsoid  # noqa: E402

lib.init_scene({
    "peau": ((0.22, 0.62, 0.14), 0.42),
    "peau_sombre": ((0.12, 0.42, 0.10), 0.5),
    "ventre": ((0.86, 0.9, 0.5), 0.5),
    "bouche": ((0.42, 0.06, 0.1), 0.6),
    "langue": ((0.9, 0.32, 0.4), 0.35),
    "oeil": ((0.97, 0.97, 0.88), 0.2),
    "pupille": ((0.02, 0.02, 0.03), 0.1),
    "iris": ((0.95, 0.7, 0.1), 0.25),
})

# --- Dimensions (cm) ---------------------------------------------------------------------
# Hauteurs alignees sur le visage canonique MediaPipe : pointe du nez ~ y=-3,4 cm, bouche ~ y=-6,2 cm.
MOUTH_Y = -6.2
JAW_PIVOT = (0.0, MOUTH_Y, -6.5)
SMILE = (2.2, 11.0, 5.0, MOUTH_Y)  # releve des commissures de la bouche
NOSE_Y, NOSTRIL_X, NOSTRIL_Z = -1.8, 2.6, 11.3

# Tete (dome) + museau large, coupes au niveau de la bouche : le bas reste ouvert sur l'interieur.
head = add_ellipsoid("Tete", (0, 3.4, -1.2), (14.4, 13.2, 10.6), ["peau", "bouche"],
                     cut=("y", MOUTH_Y, "+"), cap_mat=1, smile=SMILE)
muzzle = add_ellipsoid("Museau", (0, -3.0, 5.6), (8.6, 3.8, 6.6), ["peau", "bouche"],
                       cut=("y", MOUTH_Y, "+"), cap_mat=1, smile=SMILE)

# Narines (a la hauteur du nez humain).
nostrils = [(sx, add_ellipsoid(f"Narine{'G' if sx < 0 else 'D'}", (sx * NOSTRIL_X, NOSE_Y, NOSTRIL_Z),
                               (0.75, 0.45, 0.65), ["peau_sombre"])) for sx in (-1, 1)]

# Yeux : bosse de peau, globe, iris, pupille, paupiere (shape key de clignement).
for side in (-1, 1):
    lib.build_eye(side, pos=(6.0, 12.4, 4.0), globe_dz=1.3, globe_r=3.05, globe_mat="oeil",
                  bump=((4.1, 3.7, 4.1), (0, -0.6, -0.5)),
                  iris=((1.6, 1.6, 0.42), 2.7, "iris"), pupil=((0.8, 1.2, 0.3), 3.0, "pupille"),
                  lid_radius=3.6, lid_open_cut=1.4)

# Machoire : noeud "Jaw" (charniere pres des oreilles).
jaw = lib.add_empty("Jaw", JAW_PIVOT)
add_ellipsoid("Machoire", (0, MOUTH_Y - 1.8, 0.1), (10.6, 5.0, 8.7), ["peau", "bouche", "ventre"], parent=jaw,
              origin=JAW_PIVOT, cut=("y", MOUTH_Y, "-"), cap_mat=1, smile=SMILE, lower_mat=(MOUTH_Y - 2.6, 2))
add_ellipsoid("Langue", (0, MOUTH_Y - 0.2, 4.2), (3.2, 1.0, 4.4), ["langue"], parent=jaw, origin=JAW_PIVOT)
# Cou : cache la gorge et le haut du cou de la personne sous la machoire (fixe, ne suit pas la bouche).
add_ellipsoid("Cou", (0, -12.4, -3.0), (8.6, 5.4, 7.6), ["peau"])

lib.add_cheek_key(head)
lib.add_nose_keys(muzzle, nostrils, NOSE_Y, NOSTRIL_X, NOSTRIL_Z, MOUTH_Y)

lib.export_glb(os.path.join(lib.ROOT, "assets", "camskin", "skins", "frog"), "frog.glb")
lib.render_previews("frog", jaw)
