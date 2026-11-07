"""Genere le skin camera "dragon" (masque de tete complet) avec Blender, sans modelisation
manuelle. Style inspire de Smaug (Le Hobbit) : tete anguleuse et reptilienne, long museau en coin
avec arete nasale, arcades sourcilieres massives sur des yeux enfonces a pupille fendue, couronne
de cornes rabattues vers l'arriere, piques de machoire, rangees de dents, ecailles. Machoire
articulee, cles de forme (clignement, nez, joues), export glTF binaire.

Usage (Blender 4.x / 5.x) :
    blender -b -P scripts/blender/make_dragon.py -- [--render DOSSIER] [--hide PREFIXE]

Meme alignement que la grenouille (cf. make_frog.py) : pointe du nez ~ y=-3,4 cm, bouche ~ y=-6,2 cm,
tete assez grande pour couvrir cheveux, casque et cou de la personne. Outils communs : camskin_lib.py.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camskin_lib as lib  # noqa: E402
from camskin_lib import Vector, add_ellipsoid, add_tube, bezier  # noqa: E402

lib.init_scene({
    "peau": ((0.44, 0.075, 0.035), 0.5),
    "peau_sombre": ((0.12, 0.02, 0.02), 0.55),
    "ventre": ((0.9, 0.74, 0.42), 0.5),
    "bouche": ((0.28, 0.03, 0.05), 0.6),
    "langue": ((0.8, 0.2, 0.24), 0.35),
    "oeil": ((1.0, 0.58, 0.04), 0.25),
    "pupille": ((0.01, 0.01, 0.01), 0.1),
    "corne": ((0.3, 0.22, 0.16), 0.4),
    "dent": ((0.93, 0.89, 0.78), 0.3),
})

# --- Dimensions (cm) ---------------------------------------------------------------------
MOUTH_Y = -6.2
JAW_PIVOT = (0.0, MOUTH_Y, -6.5)
SMILE = (0.4, 11.0, 5.0, MOUTH_Y)  # bouche presque droite, menacante

# Museau long : ellipsoide carre (squash). Tous les reperes qui en dependent (bout, bord de la
# bouche, narines, arete nasale, dents, machoire) sont deduits de ces parametres : pour allonger
# ou raccourcir le museau, ne changer que MRZ / MZC.
MZC, MRX, MRY, MRZ, MY = 9.0, 6.0, 3.5, 13.5, -3.0  # centre z, rayons, centre y
SQUASH_M = (0.85, 0.8, 0.9)


def muzzle_front(x, y):
    """z de la surface avant du museau au point (x, y), en tenant compte de l'exposant `squash`."""
    a, b = abs(x) / MRX, abs(y - MY) / MRY
    val = max(0.0, 1 - a ** (2 / SQUASH_M[0]) - b ** (2 / SQUASH_M[1]))
    return MZC + MRZ * val ** (SQUASH_M[2] / 2)


NOSE_Y, NOSTRIL_X = -1.4, 1.9
NOSTRIL_Z = muzzle_front(NOSTRIL_X, NOSE_Y) - 0.15
PLANE_FRONT = muzzle_front(0, MOUTH_Y)  # bout du museau au niveau de la bouche
RIM = math.sqrt(1 - ((MOUTH_Y - MY) / MRY) ** 2)  # le museau se resserre a la hauteur de la bouche
# Machoire : meme longueur que le museau (avant = bout du museau, arriere = arriere du crane).
JAW_BACK, JAW_TOP = -7.5, math.sqrt(1 - (1.8 / 4.6) ** 2)
JAW_ZC = (PLANE_FRONT + JAW_BACK) / 2
JAW_RZ = (PLANE_FRONT - JAW_BACK) / (2 * JAW_TOP)
BRIDGE = ((0, 11.0, 7.0), (0, 4.2, (7.0 + muzzle_front(0, -1.0)) / 2 + 1.2), (0, -1.0, muzzle_front(0, -1.0) - 0.5))

# Cranes et museau : dome large (couvre cheveux et casque), museau long en coin.
head = add_ellipsoid("Tete", (0, 3.4, -1.2), (12.6, 12.4, 10.4), ["peau", "bouche"],
                     cut=("y", MOUTH_Y, "+"), cap_mat=1, smile=SMILE, squash=(0.68, 0.78, 0.7))
muzzle = add_ellipsoid("Museau", (0, MY, MZC), (MRX, MRY, MRZ), ["peau", "bouche"],
                       cut=("y", MOUTH_Y, "+"), cap_mat=1, smile=SMILE, squash=SQUASH_M)
# Arete nasale : crete osseuse du front jusqu'au bout du museau.
add_tube("AreteNasale", bezier(*BRIDGE, 12),
         [0.2, 0.55, 0.85, 1.0, 1.0, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45], ["peau"], segments=12)
for t, width in ((0.28, 2.3), (0.46, 2.1), (0.62, 1.9), (0.76, 1.7), (0.9, 1.5)):
    p = bezier(*BRIDGE, 40)[int(t * 39)]
    add_ellipsoid(f"PlaqueNez{int(t * 100)}", (0, p.y + 0.35, p.z + 0.1), (width, 0.55, 1.25), ["peau"], rot=(-28 + 38 * t, 0, 0))

# Narines en fentes, de part et d'autre du bout du museau.
nostrils = [(sx, add_ellipsoid(f"Narine{'G' if sx < 0 else 'D'}", (sx * NOSTRIL_X, NOSE_Y, NOSTRIL_Z),
                               (0.95, 0.35, 0.55), ["peau_sombre"], rot=(0, 0, sx * -18))) for sx in (-1, 1)]

# Yeux enfonces sous des arcades massives et anguleuses (bout interieur plus bas : regard mauvais).
for side in (-1, 1):
    tag = "G" if side < 0 else "D"
    lib.build_eye(side, pos=(6.3, 9.2, 4.4), globe_dz=1.5, globe_r=2.6, globe_mat="oeil",
                  bump=((3.7, 3.3, 3.6), (0, -0.2, 0.0)),
                  pupil=((0.3, 1.5, 0.2), 2.42, "pupille"),
                  lid_radius=2.95, lid_open_cut=1.4)
    add_ellipsoid(f"Arcade{tag}", (side * 6.6, 11.6, 5.4), (4.4, 1.3, 2.9), ["peau"], rot=(-12, 0, side * 30))
    add_ellipsoid(f"ArcadeCoin{tag}", (side * 9.6, 10.6, 3.2), (2.2, 1.0, 2.0), ["peau"], rot=(-8, 0, side * 40))
    # Arete de pommette : de l'angle de l'oeil vers l'angle de la machoire.
    add_tube(f"Pommette{tag}", bezier((side * 9.6, 8.2, 3.8), (side * 12.4, 2.5, 3.0), (side * 11.4, -4.6, 0.4), 12),
             [0.5, 0.8, 1.0, 1.1, 1.1, 1.0, 1.0, 0.95, 0.85, 0.75, 0.6, 0.45], ["peau"], segments=10)
    # Petites cornes de sourcil dressees.
    add_tube(f"CorneSourcil{tag}", bezier((side * 8.6, 12.6, 5.0), (side * 9.6, 14.6, 4.0), (side * 9.9, 16.4, 1.6), 8),
             [0.75 * (1 - i / 7) ** 0.9 + 0.03 for i in range(8)], ["corne"], segments=10)

# Machoire : noeud "Jaw", ventre ocre, langue, dents inferieures, piques de machoire.
jaw = lib.add_empty("Jaw", JAW_PIVOT)
add_ellipsoid("Machoire", (0, MOUTH_Y - 1.8, JAW_ZC), (10.3, 4.6, JAW_RZ), ["peau", "bouche", "ventre"], parent=jaw,
              origin=JAW_PIVOT, cut=("y", MOUTH_Y, "-"), cap_mat=1, smile=SMILE, lower_mat=(MOUTH_Y - 2.4, 2))
add_ellipsoid("Langue", (0, MOUTH_Y - 0.2, JAW_ZC + 4.2), (2.4, 0.9, JAW_RZ * 0.6), ["langue"], parent=jaw, origin=JAW_PIVOT)
# Cou : cache la gorge et le haut du cou de la personne (fixe, ne suit pas la bouche).
add_ellipsoid("Cou", (0, -12.4, -3.0), (8.6, 5.4, 7.6), ["peau"])

# Dents superieures le long du bord du museau (fixes) ; inferieures le long du bord de la machoire.
for sx in (-1, 1):
    tag = "G" if sx < 0 else "D"
    for k, (deg, length) in enumerate(((15, 2.6), (35, 2.3), (55, 2.0), (80, 1.7), (105, 1.3))):
        a = math.radians(deg)
        x, z = MRX * RIM * math.sin(a), MZC + MRZ * RIM * math.cos(a)
        base = Vector((sx * x, -5.9, z))
        add_tube(f"DentHaut{tag}{k}", [base, base + Vector((0, -length * 0.55, 0.1)), base + Vector((0, -length, 0.15))],
                 [0.5, 0.3, 0.03], ["dent"], segments=8)
    for k, (deg, length) in enumerate(((8, 2.5), (16, 2.2), (24, 1.9), (32, 1.6), (40, 1.3))):
        a = math.radians(deg)
        x, z = 9.6 * math.sin(a), JAW_ZC + JAW_TOP * JAW_RZ * math.cos(a)
        base = Vector((sx * x, -6.4, z))
        add_tube(f"DentBas{tag}{k}", [base, base + Vector((0, length * 0.55, 0.1)), base + Vector((0, length, 0.15))],
                 [0.5, 0.3, 0.03], ["dent"], parent=jaw, origin=JAW_PIVOT, segments=8)
    # Piques de machoire : ils partent du flanc vers l'exterieur et l'arriere (suivent la bouche).
    for k, deg in enumerate((55, 75, 95, 115, 135)):
        a = math.radians(deg)
        base = Vector((sx * 10.0 * math.sin(a), MOUTH_Y - 1.7, JAW_ZC + 0.98 * JAW_RZ * math.cos(a)))
        size = 1.0 - 0.1 * k
        tip = base + Vector((sx * 3.8 * size, -1.6 * size, -3.4 * size))
        mid = (base + tip) / 2 + Vector((0, 0.5, 0))
        add_tube(f"PiqueMachoire{tag}{k}", bezier(base, mid, tip, 7), [0.9 * size * (1 - i / 6) ** 0.9 + 0.03 for i in range(7)],
                 ["corne"], parent=jaw, origin=JAW_PIVOT, segments=8)

for k, (z, s) in enumerate(((PLANE_FRONT - 1.0, 0.7), (PLANE_FRONT - 4.0, 0.85), (PLANE_FRONT - 7.5, 0.95),
                           (PLANE_FRONT - 11.0, 1.05), (PLANE_FRONT - 14.5, 1.0), (PLANE_FRONT - 18.0, 0.85))):
    for x in (0.0,) if z > PLANE_FRONT - 5 else (-3.0, 3.0):
        local_y = (MOUTH_Y - 1.8) - 4.6 * math.sqrt(max(0.0, 1 - (x / 10.3) ** 2 - ((z - JAW_ZC) / JAW_RZ) ** 2))
        base = Vector((x, local_y + 0.5, z))
        tip = base + Vector((x * 0.15, -3.3 * s, -1.4 * s))
        add_tube(f"PiqueMenton{k}{'' if x == 0 else ('G' if x < 0 else 'D')}", bezier(base, (base + tip) / 2 + Vector((0, 0, 0.5)), tip, 7),
                 [0.8 * s * (1 - i / 6) ** 0.9 + 0.03 for i in range(7)], ["corne"], parent=jaw, origin=JAW_PIVOT, segments=8)

# Couronne de cornes rabattues vers l'arriere : une grande paire, une paire moyenne sur les tempes,
# une paire de joue.
for sx in (-1, 1):
    tag = "G" if sx < 0 else "D"
    big = bezier((sx * 5.6, 13.8, -1.5), (sx * 10.2, 20.5, -6.0), (sx * 12.6, 26.0, -17.0), 18)
    add_tube(f"Corne{tag}", big, [2.0 * (1 - i / 17) ** 0.85 + 0.04 for i in range(18)], ["corne"], segments=14)
    mid = bezier((sx * 11.6, 9.0, -2.5), (sx * 16.0, 11.5, -6.5), (sx * 19.0, 15.5, -15.0), 14)
    add_tube(f"CorneTempe{tag}", mid, [1.6 * (1 - i / 13) ** 0.85 + 0.04 for i in range(14)], ["corne"], segments=12)
    cheek = bezier((sx * 12.8, 1.0, -1.0), (sx * 16.8, 0.0, -4.0), (sx * 20.0, -3.4, -10.0), 12)
    add_tube(f"CornePetite{tag}", cheek, [1.4 * (1 - i / 11) ** 0.85 + 0.04 for i in range(12)], ["corne"], segments=12)

# Crete de piques le long de la ligne mediane, du front vers la nuque.
for z, y, s in ((2.5, 15.6, 0.7), (0.0, 16.6, 0.95), (-2.6, 16.5, 1.15), (-5.2, 15.4, 1.0), (-7.8, 13.6, 0.8)):
    pts = bezier((0, y - 0.6, z), (0, y + 2.4 * s, z - 1.0), (0, y + 4.2 * s, z - 3.4 * s), 8)
    add_tube("Crete", pts, [1.2 * s * (1 - i / 7) ** 0.9 + 0.04 for i in range(8)], ["corne"], segments=10)

lib.add_cheek_key(head)
lib.add_nose_keys(muzzle, nostrils, NOSE_Y, NOSTRIL_X, NOSTRIL_Z, MOUTH_Y)

lib.export_glb(os.path.join(lib.ROOT, "assets", "camskin", "skins", "dragon"), "dragon.glb")
lib.render_previews("dragon", jaw, jaw_deg=26)
