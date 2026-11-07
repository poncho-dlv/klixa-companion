"""Genere le skin camera "grenouille" (masque de tete complet) avec Blender, sans aucune
modelisation manuelle : formes parametriques, matériaux, noeud de machoire, paupieres animees
par shape keys, export glTF binaire.

Usage (Blender 4.x / 5.x) :
    blender -b -P scripts/blender/make_frog.py -- [--render DOSSIER]

Repere de travail = repere "visage canonique" MediaPipe en cm (+Y haut, +Z vers l'avant du
visage). Les coordonnees sont ecrites dans ce repere puis converties pour Blender (Z haut) ;
l'export glTF (+Y up) retombe sur le repere d'origine.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(ROOT, "assets", "camskin", "skins", "frog")
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
RENDER_DIR = argv[argv.index("--render") + 1] if "--render" in argv else None
HIDE = argv[argv.index("--hide") + 1] if "--hide" in argv else None  # debug : masque les objets au prefixe donne


def to_blender(p):
    """glTF (x, y, z) -> Blender (x, -z, y) : rotation pure, aucun retournement de faces."""
    return Vector((p[0], -p[2], p[1]))


# --- Materiaux ---------------------------------------------------------------------------
def material(name, color, rough=0.5, spec=0.35):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = spec
    return mat


bpy.ops.wm.read_factory_settings(use_empty=True)
M = {
    "peau": material("peau", (0.22, 0.62, 0.14), 0.42),
    "peau_sombre": material("peau_sombre", (0.12, 0.42, 0.10), 0.5),
    "ventre": material("ventre", (0.86, 0.9, 0.5), 0.5),
    "bouche": material("bouche", (0.42, 0.06, 0.1), 0.6),
    "langue": material("langue", (0.9, 0.32, 0.4), 0.35),
    "oeil": material("oeil", (0.97, 0.97, 0.88), 0.2),
    "pupille": material("pupille", (0.02, 0.02, 0.03), 0.1),
    "iris": material("iris", (0.95, 0.7, 0.1), 0.25),
}
MAT_ORDER = list(M.keys())


# --- Primitives --------------------------------------------------------------------------
def make_object(name, bm, mats, parent=None, origin=(0, 0, 0)):
    """Convertit un bmesh (coordonnees glTF) en objet Blender, recentre sur `origin`."""
    for v in bm.verts:
        v.co = to_blender((v.co.x - origin[0], v.co.y - origin[1], v.co.z - origin[2]))
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    for key in mats:
        mesh.materials.append(M[key])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent  # sommets deja relatifs au pivot du parent : location locale nulle
    else:
        obj.location = to_blender(origin)
    return obj


SMILE = 2.2  # cm : releve des commissures de la bouche


def ellipsoid_bm(center, radii, segments=40, rings=24, cut=None, mat_index=0, cap_mat=None,
                 smile=False, lower_mat=None):
    """Ellipsoide (repere glTF). `cut=(axe, valeur, garder)` coupe par un plan et rebouche.

    garder = '+' conserve la partie au-dessus de la valeur, '-' celle en dessous.
    """
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    for v in bm.verts:
        # create_uvsphere a +Z pour axe polaire : on le remappe pour que +Y soit le pole.
        x, y, z = v.co.x, v.co.z, -v.co.y
        v.co = Vector((center[0] + x * radii[0], center[1] + y * radii[1], center[2] + z * radii[2]))
    for f in bm.faces:
        f.material_index = mat_index
    if cut:
        axis, value, keep = cut
        normal = Vector((1 if axis == "x" else 0, 1 if axis == "y" else 0, 1 if axis == "z" else 0))
        co = normal * value
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(
            bm, geom=geom, plane_co=co, plane_no=normal,
            clear_inner=(keep == "+"), clear_outer=(keep == "-"),
        )
        # Les sommets restes sur le plan forment la boucle a reboucher.
        boundary = [e for e in bm.edges if e.is_boundary]
        if boundary:
            res = bmesh.ops.edgeloop_fill(bm, edges=boundary)
            for f in res["faces"]:
                f.material_index = cap_mat if cap_mat is not None else mat_index
    if lower_mat:
        threshold, index = lower_mat
        for f in bm.faces:
            if f.material_index == mat_index and f.calc_center_median().y < threshold:
                f.material_index = index
    if smile:
        # Meme deformation pour la tete, le museau et la machoire : la couture reste fermee.
        for v in bm.verts:
            v.co.y += SMILE * (v.co.x / 11.0) ** 2 * math.exp(-(((v.co.y - MOUTH_Y) / 5.0) ** 2))
    return bm


def add_ellipsoid(name, center, radii, mats, parent=None, origin=None, **kw):
    bm = ellipsoid_bm(center, radii, **kw)
    return make_object(name, bm, mats, parent, origin if origin is not None else (0, 0, 0))


# --- Dimensions (cm) ---------------------------------------------------------------------
# Hauteurs alignees sur le visage canonique MediaPipe : pointe du nez ~ y=-3,4 cm, bouche ~ y=-6,2 cm.
MOUTH_Y = -6.2
JAW_PIVOT = (0.0, MOUTH_Y, -6.5)
EYE_X, EYE_Y, EYE_Z = 6.0, 12.4, 4.0

# Tete (dome) + museau large, coupes au niveau de la bouche : le bas reste ouvert sur l'interieur.
add_ellipsoid("Tete", (0, 3.4, -1.2), (14.4, 13.2, 10.6), ["peau", "bouche"], cut=("y", MOUTH_Y, "+"), cap_mat=1, smile=True)
MUSEAU = add_ellipsoid("Museau", (0, -3.0, 5.6), (8.6, 3.8, 6.6), ["peau", "bouche"], cut=("y", MOUTH_Y, "+"), cap_mat=1, smile=True)

# Narines (a la hauteur du nez humain). Chacune a une shape key de froncement de nez.
NOSE_Y = -1.8
NARINES = []
for sx in (-1, 1):
    NARINES.append((sx, add_ellipsoid(f"Narine{'G' if sx < 0 else 'D'}", (sx * 2.6, NOSE_Y, 11.3), (0.75, 0.45, 0.65), ["peau_sombre"])))

# Yeux : bosse de peau, globe, iris, pupille, paupiere (shape key de clignement).
def build_eye(sx):
    tag = "G" if sx < 0 else "D"
    cx, cy, cz = sx * EYE_X, EYE_Y, EYE_Z
    add_ellipsoid(f"Bosse{tag}", (cx, cy - 0.6, cz - 0.5), (4.1, 3.7, 4.1), ["peau"])
    # Noeud d'oeil (pivot au centre du globe) : le suivi du regard le fait tourner, ce qui
    # deplace l'iris et la pupille. +X = oeil "Left" de MediaPipe (comme les shape keys).
    gc = (cx, cy, cz + 1.3)
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=to_blender(gc))
    eye = bpy.context.active_object
    eye.name = "EyeLeft" if sx > 0 else "EyeRight"
    add_ellipsoid(f"Globe{tag}", gc, (3.05, 3.05, 3.05), ["oeil"], parent=eye, origin=gc)
    d = Vector((sx * 0.12, 0.1, 1.0)).normalized()
    c = Vector(gc)
    iris_c = c + d * 2.7
    add_ellipsoid(f"Iris{tag}", tuple(iris_c), (1.6, 1.6, 0.42), ["iris"], parent=eye, origin=gc)
    pup_c = c + d * 3.0
    add_ellipsoid(f"Pupille{tag}", tuple(pup_c), (0.8, 1.2, 0.3), ["pupille"], parent=eye, origin=gc)

    # Paupiere : sphere ecrasee sous un seuil (etat ouvert = mesh de base) ; la cle de clignement
    # redonne la sphere complete. Construite a l'etat ouvert pour ne pas editer la cle "Basis".
    ec = (cx, cy, cz + 1.3)
    radius = 3.6
    open_cut = 1.4  # la paupiere ne couvre que le haut du globe
    full = []
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=20, radius=1.0)
    for v in bm.verts:
        x, y, z = v.co.x, v.co.z, -v.co.y
        p = Vector((x * radius, y * radius, z * radius))
        full.append(p.y)
        v.co = Vector((ec[0] + p.x, ec[1] + max(p.y, open_cut), ec[2] + p.z))
    for f in bm.faces:
        f.material_index = 0
    obj = make_object(f"Paupiere{tag}", bm, ["peau"], origin=ec)
    obj.shape_key_add(name="Basis")
    closed = obj.shape_key_add(name="eyeBlinkLeft" if sx > 0 else "eyeBlinkRight")
    for i, v in enumerate(obj.data.vertices):
        closed.data[i].co = Vector((v.co.x, v.co.y, full[i]))  # Blender local : z = hauteur glTF
    closed.value = 0.0  # repos = oeil ouvert (Blender cree les cles a 1.0)
    return obj


for side in (-1, 1):
    build_eye(side)

# --- Machoire : noeud "Jaw" (charniere pres des oreilles) ---------------------------------
bpy.ops.object.empty_add(type="PLAIN_AXES", location=to_blender(JAW_PIVOT))
jaw = bpy.context.active_object
jaw.name = "Jaw"
add_ellipsoid("Machoire", (0, MOUTH_Y - 1.8, 0.1), (10.6, 5.0, 8.7), ["peau", "bouche", "ventre"], parent=jaw,
              origin=JAW_PIVOT, cut=("y", MOUTH_Y, "-"), cap_mat=1, smile=True, lower_mat=(MOUTH_Y - 2.6, 2))
# Cou : cache la gorge et le haut du cou de la personne sous la machoire (fixe, ne suit pas la bouche).
add_ellipsoid("Cou", (0, -12.4, -3.0), (8.6, 5.4, 7.6), ["peau"])
add_ellipsoid("Langue", (0, MOUTH_Y - 0.2, 4.2), (3.2, 1.0, 4.4), ["langue"], parent=jaw, origin=JAW_PIVOT)

# Joues : cle cheekPuff sur la tete (les cotes gonflent).
head = bpy.data.objects["Tete"]
head.shape_key_add(name="Basis")
puff = head.shape_key_add(name="cheekPuff")
for i, v in enumerate(head.data.vertices):
    gx, gy, gz = v.co.x, v.co.z, -v.co.y  # retour au repere glTF local
    side = abs(gx)
    if side > 4.5 and gy < 6.0:
        k = min(1.0, (side - 4.5) / 5.0) * max(0.0, 1.0 - abs(gy - (-2.0)) / 8.0)
        puff.data[i].co.x = v.co.x * (1 + 0.14 * k)
puff.value = 0.0


# Froncement de nez (noseSneerLeft = +X, comme eyeBlinkLeft) : narine qui s'evase et se releve,
# peau du museau tiree vers le haut autour de la narine.
def gltf_co(co):
    return Vector((co.x, co.z, -co.y))


def blender_co(p):
    return Vector((p.x, -p.z, p.y))


for sx, nostril in NARINES:
    name = "noseSneerLeft" if sx > 0 else "noseSneerRight"
    center = Vector((sx * 2.6, NOSE_Y, 11.3))
    nostril.shape_key_add(name="Basis")
    key = nostril.shape_key_add(name=name)
    for i, v in enumerate(nostril.data.vertices):
        p = gltf_co(v.co)
        key.data[i].co = blender_co(center + (p - center) * 1.5 + Vector((0, 0.35, 0.1)))
    key.value = 0.0
    muzzle_key = None
    if MUSEAU.data.shape_keys is None:
        MUSEAU.shape_key_add(name="Basis")
    muzzle_key = MUSEAU.shape_key_add(name=name)
    for i, v in enumerate(MUSEAU.data.vertices):
        p = gltf_co(v.co)
        w = max(0.0, 1.0 - (p - center).length / 6.5) ** 2
        muzzle_key.data[i].co = blender_co(p + Vector((0, 0.9 * w, 0.15 * w)))
    muzzle_key.value = 0.0


# Respiration (cle non-ARKit "nostrilBreath", pilotee dans le temps par le moteur : voir `breath`
# du manifeste) : les narines gonflent doucement, le dessus du museau se souleve a peine.
for sx, nostril in NARINES:
    center = Vector((sx * 2.6, NOSE_Y, 11.3))
    breath = nostril.shape_key_add(name="nostrilBreath")
    for i, v in enumerate(nostril.data.vertices):
        p = gltf_co(v.co)
        breath.data[i].co = blender_co(center + (p - center) * 1.3 + Vector((0, 0.12, 0.05)))
    breath.value = 0.0

museau_breath = MUSEAU.shape_key_add(name="nostrilBreath")
for i, v in enumerate(MUSEAU.data.vertices):
    p = gltf_co(v.co)
    w = 0.0
    for sx in (-1, 1):
        w = max(w, max(0.0, 1.0 - (p - Vector((sx * 2.6, NOSE_Y, 11.3))).length / 7.0) ** 2)
    museau_breath.data[i].co = blender_co(p + Vector((0, 0.3 * w, 0.1 * w)))
museau_breath.value = 0.0

# Levre superieure : le bas du museau se releve avec mouthUpperUpLeft/Right (+X = Left).
for sx, name in ((1, "mouthUpperUpLeft"), (-1, "mouthUpperUpRight")):
    key = MUSEAU.shape_key_add(name=name)
    for i, v in enumerate(MUSEAU.data.vertices):
        p = gltf_co(v.co)
        side = max(0.0, min(1.0, 0.5 + 0.5 * (p.x * sx) / 4.0))
        low = max(0.0, min(1.0, (MOUTH_Y + 3.4 - p.y) / 3.4))
        front = max(0.0, min(1.0, (p.z - 3.0) / 6.0))
        key.data[i].co = blender_co(p + Vector((0, 0.9 * side * low * front, 0.2 * side * low * front)))
    key.value = 0.0

# --- Export ------------------------------------------------------------------------------
os.makedirs(OUT_DIR, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
glb = os.path.join(OUT_DIR, "frog.glb")
bpy.ops.export_scene.gltf(
    filepath=glb, export_format="GLB", export_apply=False, export_morph=True,
    export_morph_normal=True, export_yup=True, use_selection=False,
)
print("EXPORT", glb, os.path.getsize(glb), "octets")

# --- Apercu Blender (facultatif) ----------------------------------------------------------
if RENDER_DIR:
    os.makedirs(RENDER_DIR, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("w")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.33, 0.38, 0.45, 1)
    for name, loc, energy in (("key", (14, -16, 18), 2500), ("fill", (-16, -8, 6), 900)):
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, "POINT"))
        light.data.energy = energy
        light.location = loc
        scene.collection.objects.link(light)
    if HIDE:
        for o in bpy.data.objects:
            if o.name.startswith(HIDE):
                o.hide_render = True
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.lens = 70
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0, 0, 0))
    for label, yaw, pitch, jaw_deg in (("face", 0, 0, 0), ("trois-quarts", 35, 8, 0), ("bouche", 0, 0, 22), ("profil", 85, 0, 0)):
        dist = 52
        yr, pr = math.radians(yaw), math.radians(pitch)
        # Repere Blender : la face regarde -Y ; la camera est devant (-Y), tournee de `yaw` autour de Z.
        pos = Vector((math.sin(yr) * math.cos(pr), -math.cos(yr) * math.cos(pr), math.sin(pr))) * dist
        cam.location = pos
        direction = target - pos
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        jaw.rotation_euler = (math.radians(jaw_deg), 0, 0)
        scene.render.filepath = os.path.join(RENDER_DIR, f"frog-{label}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDER", scene.render.filepath)

if "--debug" in argv:
    for o in bpy.data.objects:
        if o.name.startswith("Paupiere"):
            zs = [v.co.z for v in o.data.vertices]
            ks = o.data.shape_keys.key_blocks
            kz = [d.co.z for d in ks[1].data]
            print("DBG", o.name, "mesh z", round(min(zs), 2), round(max(zs), 2), "basis z", round(min(d.co.z for d in ks[0].data), 2),
                  "key z", round(min(kz), 2), round(max(kz), 2), "values", [k.value for k in ks])
