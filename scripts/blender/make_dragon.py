"""Genere le skin camera "dragon" (masque de tete complet) avec Blender, sans modelisation
manuelle : museau long, cornes recourbees, crete, crocs, ailettes, yeux a pupille fendue,
machoire articulee, cles de forme (clignement, nez, joues), export glTF binaire.

Usage (Blender 4.x / 5.x) :
    blender -b -P scripts/blender/make_dragon.py -- [--render DOSSIER] [--hide PREFIXE]

Meme alignement que la grenouille (cf. make_frog.py) : pointe du nez ~ y=-3,4 cm, bouche ~ y=-6,2 cm,
tete assez grande pour couvrir cheveux, casque et cou de la personne. Outils communs : camskin_lib.py.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camskin_lib as lib  # noqa: E402
from camskin_lib import Vector, add_ellipsoid, add_tube, bezier  # noqa: E402

lib.init_scene({
    "peau": ((0.5, 0.07, 0.06), 0.5),
    "peau_sombre": ((0.2, 0.03, 0.03), 0.55),
    "ventre": ((0.94, 0.76, 0.4), 0.5),
    "bouche": ((0.3, 0.03, 0.06), 0.6),
    "langue": ((0.85, 0.22, 0.3), 0.35),
    "oeil": ((1.0, 0.7, 0.06), 0.25),
    "pupille": ((0.01, 0.01, 0.01), 0.1),
    "corne": ((0.92, 0.86, 0.68), 0.38),
    "membrane": ((0.9, 0.32, 0.12), 0.55),
    "dent": ((0.98, 0.96, 0.88), 0.3),
})

# --- Dimensions (cm) ---------------------------------------------------------------------
MOUTH_Y = -6.2
JAW_PIVOT = (0.0, MOUTH_Y, -6.5)
SMILE = (1.2, 11.0, 5.0, MOUTH_Y)  # commissures a peine relevees : air menacant
NOSE_Y, NOSTRIL_X, NOSTRIL_Z = -1.9, 2.0, 14.1

# Tete (dome) + long museau, coupes au niveau de la bouche : le bas reste ouvert sur l'interieur.
head = add_ellipsoid("Tete", (0, 3.4, -1.2), (14.2, 13.2, 10.6), ["peau", "bouche"],
                     cut=("y", MOUTH_Y, "+"), cap_mat=1, smile=SMILE)
muzzle = add_ellipsoid("Museau", (0, -3.2, 7.0), (6.6, 3.4, 8.4), ["peau", "bouche"],
                       cut=("y", MOUTH_Y, "+"), cap_mat=1, smile=SMILE)
nostrils = [(sx, add_ellipsoid(f"Narine{'G' if sx < 0 else 'D'}", (sx * NOSTRIL_X, NOSE_Y, NOSTRIL_Z),
                               (0.7, 0.45, 0.6), ["peau_sombre"])) for sx in (-1, 1)]

# Yeux : orbite, globe ambre, pupille fendue verticale, paupiere ; arcade sourciliere inclinee
# (le bout interieur plus bas, regard mauvais).
for side in (-1, 1):
    lib.build_eye(side, pos=(6.2, 9.8, 4.6), globe_dz=1.3, globe_r=2.6, globe_mat="oeil",
                  bump=((3.6, 3.3, 3.5), (0, -0.4, -0.2)),
                  pupil=((0.34, 1.55, 0.2), 2.42, "pupille"),
                  lid_radius=3.05, lid_open_cut=0.9)
    add_ellipsoid(f"Arcade{'G' if side < 0 else 'D'}", (side * 6.3, 12.4, 5.4), (3.8, 1.1, 2.8), ["peau"],
                  rot=(0, 0, side * 20))

# Machoire : noeud "Jaw", ventre clair, crocs inferieurs, langue.
jaw = lib.add_empty("Jaw", JAW_PIVOT)
add_ellipsoid("Machoire", (0, MOUTH_Y - 1.8, 1.5), (10.3, 4.6, 9.6), ["peau", "bouche", "ventre"], parent=jaw,
              origin=JAW_PIVOT, cut=("y", MOUTH_Y, "-"), cap_mat=1, smile=SMILE, lower_mat=(MOUTH_Y - 2.4, 2))
add_ellipsoid("Langue", (0, MOUTH_Y - 0.2, 5.0), (2.6, 0.9, 4.8), ["langue"], parent=jaw, origin=JAW_PIVOT)
# Cou : cache la gorge et le haut du cou de la personne (fixe, ne suit pas la bouche).
add_ellipsoid("Cou", (0, -12.4, -3.0), (8.6, 5.4, 7.6), ["peau"])

# Crocs : deux a la machoire superieure (fixes), deux a l'inferieure (suivent la bouche).
for sx in (-1, 1):
    tag = "G" if sx < 0 else "D"
    up = [Vector((sx * 2.3, -5.8, 9.3)), Vector((sx * 2.3, -7.6, 9.5)), Vector((sx * 2.3, -9.4, 9.7))]
    add_tube(f"CrocHaut{tag}", up, [0.55, 0.32, 0.03], ["dent"], segments=10)
    low = [Vector((sx * 1.0, -6.5, 9.4)), Vector((sx * 1.0, -5.0, 9.5)), Vector((sx * 1.0, -3.6, 9.6))]
    add_tube(f"CrocBas{tag}", low, [0.5, 0.3, 0.03], ["dent"], parent=jaw, origin=JAW_PIVOT, segments=10)

# Cornes : une grande paire recourbee vers le haut et l'exterieur, une petite sur les joues.
for sx in (-1, 1):
    tag = "G" if sx < 0 else "D"
    big = bezier((sx * 6.2, 13.6, -1.0), (sx * 12.0, 19.0, -2.0), (sx * 12.8, 27.0, -8.0), 16)
    add_tube(f"Corne{tag}", big, [1.9 * (1 - i / 15) ** 0.85 + 0.04 for i in range(16)], ["corne"], segments=14)
    small = bezier((sx * 12.5, 2.0, -1.5), (sx * 16.5, 1.0, -4.5), (sx * 19.5, -2.5, -10.0), 12)
    add_tube(f"CornePetite{tag}", small, [1.4 * (1 - i / 11) ** 0.85 + 0.04 for i in range(12)], ["corne"], segments=12)
    # Ailette de joue (membrane), inclinee vers l'arriere.
    add_ellipsoid(f"Ailette{tag}", (sx * 13.4, 5.5, -4.8), (0.45, 6.0, 4.4), ["membrane"], rot=(0, sx * -32, sx * 8))

# Crete : piques le long de la ligne mediane, du front vers la nuque.
for z, y, s in ((3.5, 15.2, 0.7), (0.8, 16.4, 1.0), (-2.0, 16.6, 1.15), (-4.8, 15.8, 0.95), (-7.5, 14.0, 0.7)):
    pts = bezier((0, y - 0.6, z), (0, y + 2.6 * s, z - 0.6), (0, y + 4.6 * s, z - 2.4 * s), 8)
    add_tube("Crete", pts, [1.15 * s * (1 - i / 7) ** 0.9 + 0.04 for i in range(8)], ["corne"], segments=10)

lib.add_cheek_key(head)
lib.add_nose_keys(muzzle, nostrils, NOSE_Y, NOSTRIL_X, NOSTRIL_Z, MOUTH_Y)

lib.export_glb(os.path.join(lib.ROOT, "assets", "camskin", "skins", "dragon"), "dragon.glb")
lib.render_previews("dragon", jaw, jaw_deg=26)
