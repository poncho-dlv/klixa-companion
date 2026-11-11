"""Genere le corps du skin camera "dragon" (torse, cou, bras) avec Blender, sans modelisation manuelle.

Le corps est fait de PIECES RIGIDES (un noeud glTF par piece, pas d'armature) : au rendu, le moteur
3D (skin3d.js + body-rig.js) place chaque piece entre deux points de la pose MediaPipe. Un noeud
est donc modelise dans son propre repere, origine sur l'articulation de depart :

- `Torso`  : de la mi-epaules (y=0) vers la mi-hanches (+Y, 45 cm) ; +X vers la gauche de l'image,
             +Z = ventre (plaques ocre), dos et piques vers -Z.
- `Neck`   : de la base du cou vers la tete (+Y, 14 cm) ; +Z = gorge (plaques), -Z = nuque.
- `UpperArm` / `Forearm` : de l'articulation vers la suivante (+Y, 28 / 26 cm) ; +X = EXTERIEUR du
             bras (le moteur l'oriente vers l'exterieur de l'image), piques de ce cote.
- `Hand`   : du poignet vers les doigts (+Y), main griffue ; +X = exterieur (pouce).
- `Wing`   : aile (repere du torse, attache sur le dos, +X exterieur, -Y haut) ; une seule, dupliquee/retournee par le moteur.
- `Shoulder` / `Elbow` / `Wrist` : articulations (spheres + piques) qui masquent les raccords.

Les longueurs et la largeur d'epaules de repos (40 cm) sont celles du manifeste (`body.lengths`,
`body.restShoulder`) : le moteur etire chaque piece selon l'ecart reel des points suivis.
Memes materiaux que la tete (make_dragon.py) pour que la peau procedurale du moteur s'applique.

Usage (Blender 4.x / 5.x) :
    blender -b -P scripts/blender/make_dragon_body.py -- [--render DOSSIER]
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camskin_lib as lib  # noqa: E402
from camskin_lib import Vector, add_ellipsoid, add_tube, bezier  # noqa: E402

lib.init_scene({
    "peau": ((0.44, 0.075, 0.035), 0.5),
    "peau_sombre": ((0.12, 0.02, 0.02), 0.55),
    "ventre": ((0.9, 0.74, 0.42), 0.5),
    "corne": ((0.3, 0.22, 0.16), 0.4),
    "dent": ((0.93, 0.89, 0.78), 0.3),
    "membrane": ((0.32, 0.045, 0.03), 0.6),
})
lib.M["membrane"].use_backface_culling = False  # membrane visible des deux faces

TORSO_LEN, NECK_LEN, UPPER_LEN, FORE_LEN = 45.0, 14.0, 28.0, 26.0


def join(objs, name):
    """Assemble des objets en un seul noeud (sans remaillage : les plaques restent nettes)."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    return obj


def spike(name, base, tip, radius, bend=(0, 0, 0), steps=7):
    """Pique effile de `base` a `tip`, courbee par `bend` (decalage du point milieu)."""
    base, tip = Vector(base), Vector(tip)
    mid = (base + tip) / 2 + Vector(bend)
    return add_tube(name, bezier(base, mid, tip, steps), [radius * (1 - i / (steps - 1)) ** 0.9 + 0.03 for i in range(steps)], ["corne"], segments=8)


def surface_z(y, cy, ry, rz, ky=1.0, kz=1.0):
    """z de la surface avant d'un ellipsoide (x=0), exposants d'ecrasement `ky`/`kz` (cf. ellipsoid_bm)."""
    inner = max(0.0, 1 - (abs(y - cy) / ry) ** (2 / ky))
    return rz * inner ** (kz / 2)


# --- Torse -------------------------------------------------------------------------------
CHEST = (0.0, 12.0, 0.0), (20.5, 17.0, 12.5), (0.85, 1.0, 0.9)
BELLY = (0.0, 33.0, 0.0), (15.0, 20.0, 9.5), (1.0, 1.0, 1.0)
mass = [
    add_ellipsoid("TorsoPoitrine", CHEST[0], CHEST[1], ["peau"], squash=CHEST[2]),
    add_ellipsoid("TorsoVentre", BELLY[0], BELLY[1], ["peau"]),
    add_ellipsoid("TorsoBaseCou", (0, -3.5, -1.0), (10.5, 7.0, 8.5), ["peau"]),
]
torso_mass = lib.merge_blend(mass, "TorsoMasse", voxel=0.7, iterations=8)


def torso_front(y):
    return max(surface_z(y, CHEST[0][1], CHEST[1][1], CHEST[1][2], CHEST[2][1], CHEST[2][2]),
               surface_z(y, BELLY[0][1], BELLY[1][1], BELLY[1][2]))


def torso_half_width(y):
    best = 0.0
    for (cx, cy, cz), (rx, ry, rz), (kx, ky, kz) in (CHEST, BELLY):
        inner = 1 - (abs(y - cy) / ry) ** (2 / ky)
        if inner > 0:
            best = max(best, rx * inner ** (kx / 2))
    return best


torso_parts = [torso_mass]
# Plaques du ventre : bandes ocre posees sur la face avant, de la poitrine au bas du ventre.
for i, y in enumerate((4.0, 10.0, 16.0, 22.0, 28.0, 34.0, 40.0, 46.0)):
    z = torso_front(y)
    width = min(torso_half_width(y) * 0.42, 9.0 - 0.25 * i)
    torso_parts.append(add_ellipsoid(f"PlaqueVentre{i}", (0, y, z - 1.0), (width, 2.5, 1.7), ["ventre"], rot=(10, 0, 0)))
# Piques dorsales le long de la colonne, de la nuque vers le bas du dos.
for i, y in enumerate((-2.0, 5.0, 12.0, 19.0, 26.0, 33.0, 40.0)):
    size = 1.1 - 0.06 * i
    back = -torso_front(y) + 0.8
    torso_parts.append(spike(f"PiqueDos{i}", (0, y, back), (0, y - 3.4 * size, back - 4.2 * size), 1.3 * size))
torso = join(torso_parts, "Torso")

# --- Cou ---------------------------------------------------------------------------------
neck_parts = [add_tube("CouTube", bezier((0, -1.5, 0.3), (0, 7, 0.6), (0, NECK_LEN + 3, 0.2), 8), [9.6, 8.4, 7.6, 7.2, 7.0, 6.9, 6.9, 7.0],
                       ["peau"], segments=20)]
for i, y in enumerate((1.5, 5.0, 8.5, 12.0)):
    neck_parts.append(add_ellipsoid(f"PlaqueCou{i}", (0, y, 7.6 - 0.15 * i), (4.4 - 0.2 * i, 1.7, 1.5), ["ventre"], rot=(8, 0, 0)))
for i, y in enumerate((1.0, 5.0, 9.0, 13.0)):
    neck_parts.append(spike(f"PiqueCou{i}", (0, y, -6.8), (0, y - 2.6, -10.4 + 0.5 * i), 1.0))
neck = join(neck_parts, "Neck")

# --- Bras --------------------------------------------------------------------------------
# +X = exterieur : les piques sont de ce cote.
upper_parts = [
    add_tube("BrasTube", bezier((0, 0, 0), (0, 12, 0), (0, UPPER_LEN, 0), 10), [6.5, 7.1, 7.3, 7.0, 6.6, 6.2, 5.9, 5.6, 5.4, 5.3],
             ["peau"], segments=18),
    add_ellipsoid("Biceps", (0, 11, 1.0), (7.4, 8.5, 6.6), ["peau"]),
]
for i, y in enumerate((7.0, 13.0, 19.0, 24.0)):
    size = 1.0 - 0.12 * i
    upper_parts.append(spike(f"PiqueBras{i}", (6.0 - 0.2 * i, y, 0), (10.6 * size + 2, y - 1.6 * size, 0), 1.1 * size))
upper = join(upper_parts, "UpperArm")

fore_parts = [
    add_tube("AvantBrasTube", bezier((0, 0, 0), (0, 9, 0), (0, FORE_LEN, 0), 10), [5.3, 5.8, 6.0, 5.9, 5.5, 5.1, 4.8, 4.6, 4.5, 4.4],
             ["peau"], segments=18),
    add_ellipsoid("BracerBande", (0, 17.0, 0), (6.4, 1.8, 6.4), ["peau_sombre"]),
    add_ellipsoid("BracerBande2", (0, 21.0, 0), (5.8, 1.5, 5.8), ["peau_sombre"]),
]
for i, y in enumerate((5.0, 10.0, 15.0, 20.0)):
    size = 1.0 - 0.14 * i
    fore_parts.append(spike(f"PiqueAvantBras{i}", (5.2, y, 0), (9.6 * size + 1.5, y + 1.4 * size, 0), 1.0 * size))
fore = join(fore_parts, "Forearm")

# Main griffue, pleine : elle doit RECOUVRIR une main humaine suivie point par point (poignet a l'origine,
# base des doigts vers y=7,4, bout des doigts vers y=14,5 ; voir body-rig.js, palmReach). Paume large et
# longue, dos de main bombe jusqu'a la base des doigts, trois gros doigts serres (pas de jour entre eux)
# + pouce epais sur le cote exterieur, griffes recourbees vers la paume (+Z).
hand_parts = [
    add_ellipsoid("Paume", (0, 4.4, 0), (5.4, 5.2, 2.7), ["peau"]),
    add_ellipsoid("DosMain", (0, 7.2, -0.2), (5.0, 3.4, 2.3), ["peau"]),
]
for i, (x, tilt) in enumerate(((-3.1, -0.07), (0.0, 0.0), (3.1, 0.07))):
    base = Vector((x, 7.0, 0))
    knuckle = Vector((x * 1.08 + tilt * 6, 11.2, 0.4))
    tip = Vector((x * 1.16 + tilt * 11, 14.6, 1.3))
    hand_parts.append(add_tube(f"Doigt{i}", bezier(base, knuckle, tip, 7), [2.0, 1.95, 1.85, 1.7, 1.5, 1.3, 1.1], ["peau"], segments=10))
    hand_parts.append(add_ellipsoid(f"Phalange{i}", tuple(knuckle), (2.0, 1.5, 1.8), ["peau"]))
    claw_tip = tip + Vector((tilt * 3, 3.4, 1.9))
    hand_parts.append(spike(f"Griffe{i}", tip, claw_tip, 1.05, bend=(0, 0, 1.1)))
thumb_base = Vector((4.0, 3.0, 0))
thumb_tip = Vector((8.8, 8.6, 0.8))
hand_parts.append(add_tube("Pouce", bezier(thumb_base, (6.8, 5.0, 0.4), thumb_tip, 6), [2.1, 1.9, 1.7, 1.5, 1.3, 1.1], ["peau"], segments=10))
hand_parts.append(spike("GriffePouce", thumb_tip, thumb_tip + Vector((2.0, 2.8, 1.3)), 0.95, bend=(0, 0, 0.8)))
hand = join(hand_parts, "Hand")

# --- Articulations -----------------------------------------------------------------------
shoulder = join([
    add_ellipsoid("EpauleBoule", (0, 0, 0), (7.6, 7.2, 7.4), ["peau"]),
    spike("EpaulePique0", (5.5, -1.0, 0), (12.4, -4.6, 0), 1.7, bend=(0, -1.2, 0)),
    spike("EpaulePique1", (4.2, -3.8, 1.0), (7.6, -11.4, 1.0), 1.4, bend=(0.6, 0, 0)),
    spike("EpaulePique2", (4.8, 1.4, -1.0), (11.0, 3.6, -1.0), 1.2),
], "Shoulder")
elbow = join([
    add_ellipsoid("CoudeBoule", (0, 0, 0), (5.9, 5.6, 5.8), ["peau"]),
    spike("CoudePique", (3.6, -1.6, 0), (11.4, -6.4, 0), 1.6, bend=(0.8, -1.4, 0)),
], "Elbow")
wrist = join([
    add_ellipsoid("PoignetBoule", (0, 0, 0), (4.7, 3.4, 4.6), ["peau_sombre"]),
    spike("PoignetPique", (3.4, 0.4, 0), (7.2, -2.4, 0), 0.9),
], "Wrist")

# --- Aile ----------------------------------------------------------------------------------
# Repere du torse (cf. Torso) : origine a l'attache sur le dos, +X vers l'exterieur, -Y vers le haut,
# -Z vers l'arriere. Un seul noeud `Wing` : le moteur le duplique et le retourne (echelle X negative)
# pour l'autre cote, et le fait battre autour de l'axe Z du torse.
import bmesh  # noqa: E402

WRIST = Vector((32, -44, -5))
TIPS = [Vector((64, -50, -9)), Vector((60, -26, -9)), Vector((46, -3, -7))]
BODY_LOW = Vector((3, 14, -1))
wing_parts = [add_tube("AileBras", bezier((0, 0, 0), (12, -24, -2), WRIST, 10), [2.6, 2.4, 2.1, 1.9, 1.7, 1.6, 1.5, 1.4, 1.3, 1.2],
                       ["peau"], segments=10)]
for i, tip in enumerate(TIPS):
    wing_parts.append(add_tube(f"AileDoigt{i}", bezier(WRIST, (WRIST + tip) / 2 + Vector((0, 0, -1.5)), tip, 8),
                               [1.4 - 0.1 * i, 1.2, 1.05, 0.9, 0.75, 0.6, 0.45, 0.3], ["peau"], segments=8))
    wing_parts.append(spike(f"AileGriffe{i}", tip, tip + (tip - WRIST).normalized() * 4.0, 0.6))
wing_parts.append(spike("AileGriffePoignet", WRIST, WRIST + Vector((3, -7, 0)), 1.0))
# Membrane : eventail depuis le poignet, bords festonnes entre les extremites.
outline = [Vector((0, 0, 0)), WRIST]
ring = TIPS + [BODY_LOW]
for a, b in zip(ring, ring[1:]):
    outline.extend([a, (a + b) / 2 + (WRIST - (a + b) / 2) * 0.14 + Vector((0, 0, -0.5))])
outline.append(BODY_LOW)
bm = bmesh.new()
verts = [bm.verts.new(p) for p in outline]
hub = bm.verts.new(WRIST + Vector((0, 4, -1.5)))
for a, b in zip(verts[1:], verts[2:] + [verts[0]]):
    bm.faces.new((hub, a, b))
bm.faces.new((hub, verts[0], verts[1]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
for f in bm.faces:
    f.material_index = 0
wing_parts.append(lib.make_object("AileMembrane", bm, ["membrane"]))
wing = join(wing_parts, "Wing")

# --- Mise en page des pieces (decor seulement : le moteur positionne chaque noeud) ------------
LAYOUT = {"Torso": (-70, 0, 0), "Neck": (-30, 0, 0), "UpperArm": (0, 0, 0), "Forearm": (22, 0, 0), "Hand": (44, 0, 0),
          "Wing": (-30, 60, 0), "Shoulder": (62, 0, 0), "Elbow": (80, 0, 0), "Wrist": (96, 0, 0)}
for part in (torso, neck, upper, fore, hand, wing, shoulder, elbow, wrist):
    part.location = lib.to_blender(LAYOUT[part.name])

lib.export_glb(os.path.join(lib.ROOT, "assets", "camskin", "skins", "dragon"), "dragon-body.glb")

# --- Apercu : les pieces cote a cote, vues de face (+Y du modele vers le haut) et de profil ---------
if lib.RENDER_DIR:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 700
    scene.world = bpy.data.worlds.new("w")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.33, 0.38, 0.45, 1)
    for name, loc, energy in (("key", (20, -60, 60), 9000), ("fill", (-60, -30, 20), 3500)):
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, "POINT"))
        light.data.energy = energy
        light.location = loc
        scene.collection.objects.link(light)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 190
    scene.collection.objects.link(cam)
    scene.camera = cam
    os.makedirs(lib.RENDER_DIR, exist_ok=True)
    centre = Vector((10, 0, 22))
    for label, yaw in (("face", 0), ("profil", 90), ("dos", 180)):
        yr = math.radians(yaw)
        cam.location = centre + Vector((math.sin(yr), -math.cos(yr), 0)) * 200
        cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(lib.RENDER_DIR, f"dragon-body-{label}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDER", scene.render.filepath)
