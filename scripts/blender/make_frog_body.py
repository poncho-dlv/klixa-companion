"""Genere le corps du skin camera "grenouille" (torse, cou, bras) avec Blender.

Meme convention de noeuds et de reperes que make_dragon_body.py (voir son en-tete) : Torso, Neck,
UpperArm, Forearm, Hand, Shoulder, Elbow, Wrist, pieces rigides placees par le moteur 3D. Meme
palette que la tete (make_frog.py). Tronc rond et ventre pale, bras fins, mains palmees aux bouts
de doigts en ventouse.

Usage (Blender 4.x / 5.x) :
    blender -b -P scripts/blender/make_frog_body.py -- [--render DOSSIER]
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camskin_lib as lib  # noqa: E402
from camskin_lib import Vector, add_ellipsoid, add_tube, bezier  # noqa: E402

lib.init_scene({
    "peau": ((0.22, 0.62, 0.14), 0.42),
    "peau_sombre": ((0.12, 0.42, 0.10), 0.5),
    "ventre": ((0.86, 0.9, 0.5), 0.5),
})

UPPER_LEN, FORE_LEN, NECK_LEN = 28.0, 26.0, 14.0


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    return obj


# --- Torse : rond, ventre pale a l'avant (+Z), taches sombres sur le dos (-Z) -------------------
CHEST = (0.0, 12.0, 0.0), (21.5, 17.0, 13.0)
BELLY = (0.0, 33.0, 0.0), (17.5, 21.0, 11.5)
mass = [
    add_ellipsoid("TorsoPoitrine", CHEST[0], CHEST[1], ["peau"]),
    add_ellipsoid("TorsoVentre", BELLY[0], BELLY[1], ["peau"]),
    add_ellipsoid("TorsoBaseCou", (0, -3.5, -1.0), (11.0, 7.0, 9.0), ["peau"]),
]
torso_mass = lib.merge_blend(mass, "TorsoMasse", voxel=0.7, iterations=8)
torso_parts = [torso_mass]
# Ventre et gorge pales : grande plaque ovale sur la face avant.
torso_parts.append(add_ellipsoid("VentrePale", (0, 17, 6.5), (12.5, 24.0, 8.0), ["ventre"]))
for i, (x, y, r) in enumerate(((-9, 14, 3.4), (8, 26, 3.0), (-6, 38, 3.6), (10, 8, 2.6), (3, 42, 2.8))):
    torso_parts.append(add_ellipsoid(f"TacheDos{i}", (x, y, -12.0 + abs(x) * -0.08), (r, r, 1.2), ["peau_sombre"]))
torso = join(torso_parts, "Torso")

# --- Cou : court et large (la grenouille n'en a presque pas) -----------------------------------
neck = join([
    add_tube("CouTube", bezier((0, -1.5, 0.3), (0, 7, 0.6), (0, NECK_LEN + 3, 0.2), 8), [10.0, 9.4, 9.0, 8.8, 8.7, 8.7, 8.8, 9.0], ["peau"], segments=20),
    add_ellipsoid("GorgePale", (0, 6.0, 5.5), (6.0, 6.5, 4.0), ["ventre"]),
], "Neck")

# --- Bras : fins, pattes avant de grenouille ---------------------------------------------------
upper = join([
    add_tube("BrasTube", bezier((0, 0, 0), (0, 12, 0), (0, UPPER_LEN, 0), 10), [5.0, 5.4, 5.4, 5.2, 4.9, 4.6, 4.4, 4.2, 4.0, 3.9], ["peau"], segments=16),
    add_ellipsoid("BrasTache", (3.5, 12.0, 0.5), (1.6, 3.0, 2.2), ["peau_sombre"]),
], "UpperArm")
fore = join([
    add_tube("AvantBrasTube", bezier((0, 0, 0), (0, 9, 0), (0, FORE_LEN, 0), 10), [3.9, 4.2, 4.3, 4.2, 4.0, 3.7, 3.5, 3.3, 3.2, 3.1], ["peau"], segments=16),
    add_ellipsoid("AvantBrasBande", (0, 8.0, 0), (4.6, 1.3, 4.6), ["peau_sombre"]),
], "Forearm")

# Main palmee : paume, quatre doigts a bout en ventouse, palmure entre les doigts.
hand_parts = [add_ellipsoid("Paume", (0, 3.2, 0), (4.6, 3.8, 2.0), ["peau"])]
for i, x in enumerate((-3.6, -1.2, 1.2, 3.6)):
    base = Vector((x, 5.5, 0))
    tip = Vector((x * 1.9, 14.5, 0.3))
    hand_parts.append(add_tube(f"Doigt{i}", bezier(base, (x * 1.4, 10.0, 0.2), tip, 7), [1.1, 1.0, 0.9, 0.82, 0.75, 0.7, 0.66], ["peau"], segments=8))
    hand_parts.append(add_ellipsoid(f"Ventouse{i}", tuple(tip + Vector((0, 0.5, 0))), (1.5, 1.3, 1.1), ["ventre"]))
hand_parts.append(add_ellipsoid("Palmure", (0, 10.0, 0.1), (7.6, 4.2, 0.35), ["peau_sombre"]))
hand = join(hand_parts, "Hand")

# --- Articulations : simples boules (peau lisse) -----------------------------------------------
shoulder = join([add_ellipsoid("EpauleBoule", (0, 0, 0), (6.4, 6.2, 6.3), ["peau"])], "Shoulder")
elbow = join([add_ellipsoid("CoudeBoule", (0, 0, 0), (4.8, 4.6, 4.7), ["peau"])], "Elbow")
wrist = join([add_ellipsoid("PoignetBoule", (0, 0, 0), (3.8, 3.0, 3.7), ["peau_sombre"])], "Wrist")

LAYOUT = {"Torso": (-70, 0, 0), "Neck": (-30, 0, 0), "UpperArm": (0, 0, 0), "Forearm": (22, 0, 0), "Hand": (44, 0, 0),
          "Shoulder": (62, 0, 0), "Elbow": (80, 0, 0), "Wrist": (96, 0, 0)}
for part in (torso, neck, upper, fore, hand, shoulder, elbow, wrist):
    part.location = lib.to_blender(LAYOUT[part.name])

lib.export_glb(os.path.join(lib.ROOT, "assets", "camskin", "skins", "frog"), "frog-body.glb")

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
    cam.location = centre + Vector((0, -200, 0))
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(lib.RENDER_DIR, "frog-body-face.png")
    bpy.ops.render.render(write_still=True)
    print("RENDER", scene.render.filepath, math.pi)
