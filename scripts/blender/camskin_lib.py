"""Outils communs aux generateurs de skins camera (Blender, sans modelisation manuelle).

Utilise par make_frog.py et make_dragon.py. Repere de travail = repere "visage canonique"
MediaPipe en cm (+Y haut, +Z vers l'avant du visage) ; les coordonnees sont ecrites dans ce
repere puis converties pour Blender (Z haut). L'export glTF (+Y up) retombe sur le repere
d'origine.

Convention des noeuds et cles de forme exportes (lus par le moteur 3D, cf. docs/camskin-3d.md) :
- noeud `Jaw` (machoire), `EyeLeft` / `EyeRight` (globes oculaires, +X = oeil "Left") ;
- shape keys nommees comme les blendshapes MediaPipe (eyeBlink*, cheekPuff, noseSneer*,
  mouthUpperUp*) et `nostrilBreath` (respiration, pilotee par le temps).
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
RENDER_DIR = ARGV[ARGV.index("--render") + 1] if "--render" in ARGV else None
HIDE = ARGV[ARGV.index("--hide") + 1] if "--hide" in ARGV else None  # debug : masque les objets au prefixe donne

M = {}  # materiaux de la scene courante, par nom


def to_blender(p):
    """glTF (x, y, z) -> Blender (x, -z, y) : rotation pure, aucun retournement de faces."""
    return Vector((p[0], -p[2], p[1]))


def gltf_co(co):
    return Vector((co.x, co.z, -co.y))


def blender_co(p):
    return Vector((p.x, -p.z, p.y))


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


def init_scene(palette):
    """Scene vide + materiaux. `palette` : nom -> (couleur RGB, rugosite)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M.clear()
    for name, (color, rough) in palette.items():
        M[name] = material(name, color, rough)


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


def ellipsoid_bm(center, radii, segments=40, rings=24, cut=None, mat_index=0, cap_mat=None,
                 smile=None, lower_mat=None, rot=None, squash=None):
    """Ellipsoide (repere glTF).

    - `cut=(axe, valeur, garder)` coupe par un plan et rebouche ('+' garde le dessus, '-' le dessous) ;
    - `rot=(rx, ry, rz)` en degres : rotation autour du centre, avant la coupe ;
    - `squash=(kx, ky, kz)` : exposants < 1 qui carrent l'ellipsoide (boite arrondie, formes plus anguleuses) ;
    - `lower_mat=(seuil, index)` : faces dont le centre est sous `seuil` (en Y) prennent ce materiau ;
    - `smile=(amplitude, largeur, etendue, y_bouche)` releve les commissures de la bouche. Meme
      deformation pour la tete, le museau et la machoire : la couture reste fermee.
    """
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    rotation = Euler([math.radians(a) for a in rot], "XYZ").to_matrix() if rot else None
    for v in bm.verts:
        # create_uvsphere a +Z pour axe polaire : on le remappe pour que +Y soit le pole.
        unit = Vector((v.co.x, v.co.z, -v.co.y))
        if squash:
            unit = Vector([math.copysign(abs(u) ** k, u) for u, k in zip(unit, squash)])
        local = Vector((unit.x * radii[0], unit.y * radii[1], unit.z * radii[2]))
        if rotation is not None:
            local = rotation @ local
        v.co = Vector(center) + local
    for f in bm.faces:
        f.material_index = mat_index
    if cut:
        axis, value, keep = cut
        normal = Vector((1 if axis == "x" else 0, 1 if axis == "y" else 0, 1 if axis == "z" else 0))
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(
            bm, geom=geom, plane_co=normal * value, plane_no=normal,
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
        amplitude, width, spread, mouth_y = smile
        for v in bm.verts:
            v.co.y += amplitude * (v.co.x / width) ** 2 * math.exp(-(((v.co.y - mouth_y) / spread) ** 2))
    return bm


def add_ellipsoid(name, center, radii, mats, parent=None, origin=None, **kw):
    bm = ellipsoid_bm(center, radii, **kw)
    return make_object(name, bm, mats, parent, origin if origin is not None else (0, 0, 0))


def bezier(p0, p1, p2, steps=14):
    """Points d'une courbe de Bezier quadratique (listes de Vector)."""
    p0, p1, p2 = Vector(p0), Vector(p1), Vector(p2)
    return [(1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2 for t in (i / (steps - 1) for i in range(steps))]


def tube_bm(points, radii, segments=14, mat_index=0):
    """Tube effile le long d'une polyligne (corne, pique, croc), ferme aux deux bouts."""
    bm = bmesh.new()
    rings = []
    previous_normal = None
    for i, (p, r) in enumerate(zip(points, radii)):
        tangent = ((points[i + 1] - p) if i < len(points) - 1 else (p - points[i - 1])).normalized()
        if previous_normal is None:
            ref = Vector((0, 0, 1)) if abs(tangent.z) < 0.9 else Vector((1, 0, 0))
            normal = tangent.cross(ref).normalized()
        else:  # transport parallele : evite que le tube se torde
            normal = (previous_normal - tangent * previous_normal.dot(tangent)).normalized()
        binormal = tangent.cross(normal)
        previous_normal = normal
        angles = [2 * math.pi * j / segments for j in range(segments)]
        rings.append([bm.verts.new(p + (normal * math.cos(a) + binormal * math.sin(a)) * r) for a in angles])
    for a, b in zip(rings, rings[1:]):
        for j in range(segments):
            k = (j + 1) % segments
            bm.faces.new((a[j], a[k], b[k], b[j]))
    bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        f.material_index = mat_index
    return bm


def add_tube(name, points, radii, mats, parent=None, origin=None, **kw):
    bm = tube_bm(points, radii, **kw)
    return make_object(name, bm, mats, parent, origin if origin is not None else (0, 0, 0))


def add_empty(name, location):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=to_blender(location))
    obj = bpy.context.active_object
    obj.name = name
    return obj


def add_shape_key(obj, name, transform):
    """Cle de forme : `transform(p)` recoit un sommet (repere glTF local) et rend sa nouvelle position."""
    if obj.data.shape_keys is None:
        obj.shape_key_add(name="Basis")
    key = obj.shape_key_add(name=name)
    for i, v in enumerate(obj.data.vertices):
        key.data[i].co = blender_co(transform(gltf_co(v.co)))
    key.value = 0.0  # Blender cree les cles a 1.0 : le repos doit etre a 0
    return key


def merge_blend(objs, name, voxel=0.3, iterations=7, keep_y=None):
    """Fusionne des volumes en un seul (union par remaillage voxel) et adoucit les raccords.

    Les pieces qui se croisent (crane + museau, arcades, pommettes...) forment sinon des aretes
    vives a leur intersection. Apres l'union, un lissage de Taubin (sans retrecissement) arrondit
    ces raccords ; les sommets a la hauteur `keep_y` (bord de la bouche, qui doit rester net pour
    la couture avec la machoire) ne bougent pas.
    """
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    mod = obj.modifiers.new("union", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = voxel
    mod.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=mod.name)

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    fixed = {v.index for v in bm.verts if keep_y is not None and abs(v.co.z - keep_y) < 0.08}
    for _ in range(iterations):
        for lam in (0.5, -0.53):
            moved = {}
            for v in bm.verts:
                if v.index in fixed or not v.link_edges:
                    continue
                avg = sum((e.other_vert(v).co for e in v.link_edges), Vector()) / len(v.link_edges)
                moved[v.index] = v.co + lam * (avg - v.co)
            for i, co in moved.items():
                bm.verts[i].co = co
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.polygons.foreach_set("use_smooth", [True] * len(obj.data.polygons))
    obj.data.update()
    return obj


# --- Yeux --------------------------------------------------------------------------------
def build_eye(sx, pos, globe_dz, globe_r, globe_mat, pupil, lid_radius, lid_open_cut,
              bump=None, iris=None, gaze=(0.12, 0.1, 1.0)):
    """Oeil complet du cote `sx` (+1 = oeil "Left" de MediaPipe).

    Noeud `EyeLeft`/`EyeRight` (pivot au centre du globe : le suivi du regard le fait tourner),
    bosse de peau facultative, globe, iris facultatif, pupille, paupiere. La paupiere est une
    sphere ecrasee sous un seuil (etat ouvert = mesh de base) ; sa cle de clignement redonne la
    sphere complete. `pupil` / `iris` = (rayons, distance au centre, materiau).
    """
    tag = "G" if sx < 0 else "D"
    cx, cy, cz = sx * pos[0], pos[1], pos[2]
    if bump:
        radii, offset = bump
        add_ellipsoid(f"Bosse{tag}", (cx + offset[0], cy + offset[1], cz + offset[2]), radii, ["peau"])
    gc = (cx, cy, cz + globe_dz)
    eye = add_empty("EyeLeft" if sx > 0 else "EyeRight", gc)
    add_ellipsoid(f"Globe{tag}", gc, (globe_r,) * 3, [globe_mat], parent=eye, origin=gc)
    d = Vector((sx * gaze[0], gaze[1], gaze[2])).normalized()
    c = Vector(gc)
    if iris:
        radii, dist, mat = iris
        add_ellipsoid(f"Iris{tag}", tuple(c + d * dist), radii, [mat], parent=eye, origin=gc)
    radii, dist, mat = pupil
    add_ellipsoid(f"Pupille{tag}", tuple(c + d * dist), radii, [mat], parent=eye, origin=gc)

    full = []
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=20, radius=1.0)
    for v in bm.verts:
        p = Vector((v.co.x * lid_radius, v.co.z * lid_radius, -v.co.y * lid_radius))
        full.append(p.y)
        v.co = Vector((gc[0] + p.x, gc[1] + max(p.y, lid_open_cut), gc[2] + p.z))
    for f in bm.faces:
        f.material_index = 0
    obj = make_object(f"Paupiere{tag}", bm, ["peau"], origin=gc)
    obj.shape_key_add(name="Basis")
    closed = obj.shape_key_add(name="eyeBlinkLeft" if sx > 0 else "eyeBlinkRight")
    for i, v in enumerate(obj.data.vertices):
        closed.data[i].co = Vector((v.co.x, v.co.y, full[i]))  # Blender local : z = hauteur glTF
    closed.value = 0.0  # repos = oeil ouvert
    return obj


# --- Museau : cles de nez ----------------------------------------------------------------
def add_nose_keys(muzzle, nostrils, nose_y, nostril_x, nostril_z, mouth_y):
    """Froncement de nez (noseSneer*), respiration (nostrilBreath) et levre superieure
    (mouthUpperUp*). `nostrils` : liste de (cote, objet narine). +X = cote "Left"."""
    def centre(sx):
        return Vector((sx * nostril_x, nose_y, nostril_z))

    for sx, nostril in nostrils:
        name = "noseSneerLeft" if sx > 0 else "noseSneerRight"
        c = centre(sx)
        add_shape_key(nostril, name, lambda p, c=c: c + (p - c) * 1.5 + Vector((0, 0.35, 0.1)))

        def lift(p, c=c):
            w = max(0.0, 1.0 - (p - c).length / 6.5) ** 2
            return p + Vector((0, 0.9 * w, 0.15 * w))
        add_shape_key(muzzle, name, lift)

    for sx, nostril in nostrils:
        c = centre(sx)
        add_shape_key(nostril, "nostrilBreath", lambda p, c=c: c + (p - c) * 1.3 + Vector((0, 0.12, 0.05)))

    def breath(p):
        w = max(max(0.0, 1.0 - (p - centre(sx)).length / 7.0) ** 2 for sx in (-1, 1))
        return p + Vector((0, 0.3 * w, 0.1 * w))
    add_shape_key(muzzle, "nostrilBreath", breath)

    for sx, name in ((1, "mouthUpperUpLeft"), (-1, "mouthUpperUpRight")):
        def upper(p, sx=sx):
            side = max(0.0, min(1.0, 0.5 + 0.5 * (p.x * sx) / 4.0))
            low = max(0.0, min(1.0, (mouth_y + 3.4 - p.y) / 3.4))
            front = max(0.0, min(1.0, (p.z - 3.0) / 6.0))
            k = side * low * front
            return p + Vector((0, 0.9 * k, 0.2 * k))
        add_shape_key(muzzle, name, upper)


def add_cheek_key(head, centre_y=-2.0, limit_y=6.0):
    """cheekPuff : les cotes de la tete gonflent."""
    def puff(p):
        side = abs(p.x)
        if side > 4.5 and p.y < limit_y:
            k = min(1.0, (side - 4.5) / 5.0) * max(0.0, 1.0 - abs(p.y - centre_y) / 8.0)
            return Vector((p.x * (1 + 0.14 * k), p.y, p.z))
        return p
    add_shape_key(head, "cheekPuff", puff)


# --- Export et apercus -------------------------------------------------------------------
def export_glb(out_dir, filename):
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    path = os.path.join(out_dir, filename)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", export_apply=False, export_morph=True,
        export_morph_normal=True, export_yup=True, use_selection=False,
    )
    print("EXPORT", path, os.path.getsize(path), "octets")


def render_previews(prefix, jaw, jaw_deg=22, views=None, dist=62):
    """Rend des apercus PNG (Eevee) dans --render DOSSIER ; `--hide prefixe` masque des objets."""
    if not RENDER_DIR:
        return
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
    target = Vector((0, 0, 4))
    for label, yaw, pitch, open_deg in views or (("face", 0, 0, 0), ("trois-quarts", 35, 8, 0), ("bouche", 0, 0, jaw_deg), ("profil", 85, 0, 0)):
        yr, pr = math.radians(yaw), math.radians(pitch)
        # Repere Blender : la face regarde -Y ; la camera est devant (-Y), tournee de `yaw` autour de Z.
        pos = target + Vector((math.sin(yr) * math.cos(pr), -math.cos(yr) * math.cos(pr), math.sin(pr))) * dist
        cam.location = pos
        cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
        jaw.rotation_euler = (math.radians(open_deg), 0, 0)
        scene.render.filepath = os.path.join(RENDER_DIR, f"{prefix}-{label}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDER", scene.render.filepath)
