// Rendu 3D des skins (three.js, WebGL) : un modele glTF est ancre sur le visage grace a la
// matrice de transformation faciale de MediaPipe, et anime par les blendshapes (morph targets
// du modele portant le meme nom, ou os de machoire pilote par `jawOpen`).
//
// Repere : la matrice donne la pose du visage canonique (cm) dans l'espace d'une camera
// virtuelle de 63 degres de champ vertical, regardant vers -Z. On rend donc avec la meme
// camera : le skin s'aligne sur l'image quel que soit le vrai champ de la webcam.
import * as THREE from '/vendor-three/three.module.js';
import { GLTFLoader } from '/vendor-three-addons/loaders/GLTFLoader.js';
import { solveBody, blendSkeleton, segmentFrame, torsoFrame } from './body-rig.js';
import { BLEND_NAMES, normalizeSkinManifest, resolveModelUrl, jawAngle, gazeAngles, breathValue, poseHoldWeight, smoothingFactor, isBlendName } from './skin-manifest.js';

const FOV = 63;
const POSE_TAU = 0.04; // s : lissage de la pose (suivi ~30 images/s, affichage 60)
const BLEND_TAU = 0.03; // s : lissage des blendshapes
const FAST_TAU = 0.012; // s : machoire et clignements, tres brefs (quelques images de suivi)
const FAST_BLENDS = new Set(['jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight']);
const BODY_TAU = 0.03; // s : lissage du squelette (le filtre One Euro fait deja l'essentiel ; plus haut = retard sur les gestes)
const RETRY_MS = 10000;
// Pieces du corps attendues dans le modele (noeuds nommes) ; les membres sont dupliques gauche/droite.
const BODY_SINGLE = ['Torso', 'Neck'];
const BODY_PAIRED = ['Wing', 'UpperArm', 'Forearm', 'Hand', 'Shoulder', 'Elbow', 'Wrist'];
const DEG = Math.PI / 180;

const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// Texture de peau procedurale : coordonnees d'objet (cm, repere du modele) -> aucun UV, aucune
// image. Taches sombres larges, grain fin et verrues (couleur + relief par derivees d'ecran).
const SKIN_NOISE = `
float skinHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float skinNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skinHash(i), skinHash(i + vec3(1, 0, 0)), f.x), mix(skinHash(i + vec3(0, 1, 0)), skinHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(skinHash(i + vec3(0, 0, 1)), skinHash(i + vec3(1, 0, 1)), f.x), mix(skinHash(i + vec3(0, 1, 1)), skinHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// Bruit cellulaire 3D : (distance au centre le plus proche, au second, identifiant de la cellule).
vec3 skinCell(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); float d1 = 8.0; float d2 = 8.0; float id = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = vec3(skinHash(i + g), skinHash(i + g + 7.1), skinHash(i + g + 13.3));
    vec3 r = g + o - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = o.x; } else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}`;

function patchSkinMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkinPos;\nuniform vec3 uSkinOffset;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinPos = position + uSkinOffset;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSkinPos;\nuniform float uSkinScale;\nuniform float uSkinBlotch;\nuniform float uSkinBump;\nuniform float uSkinScales;\n${SKIN_NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float sBig = skinNoise(vSkinPos * 0.38 * uSkinScale + 3.1);
        float sMid = skinNoise(vSkinPos * 1.7 * uSkinScale);
        vec3 sQ = vSkinPos * 1.5 * uSkinScale + 11.0;
        vec3 sCell = floor(sQ);
        vec3 sCenter = vec3(skinHash(sCell), skinHash(sCell + 7.1), skinHash(sCell + 13.3)) * 0.6 + 0.2;
        float sWart = (1.0 - smoothstep(0.1, 0.26, length(fract(sQ) - sCenter))) * step(0.55, skinHash(sCell + 3.7));
        float sBlotch = smoothstep(0.42, 0.72, sBig) * uSkinBlotch;
        diffuseColor.rgb *= mix(1.0, 0.58, sBlotch);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.18, 1.12, 0.7), sWart * 0.55);
        diffuseColor.rgb *= 0.92 + 0.16 * sMid;
        float sScale = 1.0;
        if (uSkinScales > 0.001) {
          vec3 sCellInfo = skinCell(vSkinPos * 0.6 * uSkinScale);
          sScale = smoothstep(0.0, 0.24, sCellInfo.y - sCellInfo.x);
          diffuseColor.rgb *= mix(1.0, mix(0.45, 1.0, sScale) * (0.8 + 0.4 * sCellInfo.z), uSkinScales);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float sH = skinNoise(vSkinPos * 4.2 * uSkinScale) * 0.16 + sMid * 0.1 + sWart + uSkinScales * sScale * 1.4;
        vec3 sSx = dFdx(-vViewPosition);
        vec3 sSy = dFdy(-vViewPosition);
        vec3 sR1 = cross(sSy, normal);
        vec3 sR2 = cross(normal, sSx);
        float sDet = dot(sSx, sR1);
        vec3 sGrad = sign(sDet) * (dFdx(sH) * sR1 + dFdy(sH) * sR2);
        normal = normalize(abs(sDet) * normal - uSkinBump * sGrad);`);
  };
  material.customProgramCacheKey = () => 'klixa-skin-texture';
  material.needsUpdate = true;
}

/**
 * @param {{ canvas?: HTMLCanvasElement }} [options]
 * @returns {{ canvas: HTMLCanvasElement, render: Function, clear: () => void, getManifest: Function,
 *   patchManifest: Function, setDebug: (on: boolean) => void }}
 */
export function createSkin3DRenderer({ canvas } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10000);
  const ambient = new THREE.AmbientLight(0xffffff, 1);
  const key = new THREE.DirectionalLight(0xffffff, 1);
  key.position.set(0.4, 0.8, 1);
  scene.add(ambient, key);

  // Tete : groupe pilote par la matrice de pose (lissee). Les skins y sont accroches.
  const head = new THREE.Group();
  head.matrixAutoUpdate = false;
  scene.add(head);

  // Occluder : ellipsoide invisible qui n'ecrit que dans le tampon de profondeur, pour cacher
  // ce qui passe derriere la tete (oreilles, arriere des cornes). Rendu avant les skins.
  const occluder = new THREE.Mesh(
    new THREE.SphereGeometry(1, 28, 20),
    new THREE.MeshBasicMaterial({ colorWrite: false })
  );
  occluder.renderOrder = -1;
  head.add(occluder);

  const loader = new GLTFLoader();
  const skins = new Map(); // id -> { status, manifest, root, morphs, jawNode, jawRest, failedAt }
  let active = null;
  let debug = false;

  const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
  const target = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
  const targetMatrix = new THREE.Matrix4();
  let hasPose = false;
  let lastTime = performance.now();
  const blendNow = {};
  let lipNow = 0;
  const clean = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), valid: false };

  function applyManifest(entry) {
    const m = entry.manifest;
    entry.root.position.copy(v(m.position));
    entry.root.rotation.set(m.rotation[0] * DEG, m.rotation[1] * DEG, m.rotation[2] * DEG);
    entry.root.scale.setScalar(m.scale);
  }

  function applyTexture(entry) {
    const t = entry.manifest.texture;
    entry.textureUniforms.uSkinScale.value = t?.scale ?? 1;
    entry.textureUniforms.uSkinBlotch.value = t?.blotch ?? 0;
    entry.textureUniforms.uSkinBump.value = t?.bump ?? 0;
    entry.textureUniforms.uSkinScales.value = t?.scales ?? 0;
  }

  function applyOccluder(entry) {
    const o = entry.manifest.occluder;
    occluder.visible = o.enabled;
    occluder.position.copy(v(o.position));
    occluder.scale.copy(v(o.radii));
    occluder.material.colorWrite = debug;
    occluder.material.wireframe = debug;
    occluder.material.needsUpdate = true;
  }

  // --- Corps : pieces rigides pilotees par le squelette (pose MediaPipe) -----------------------
  let skeleton = null;
  const basis = new THREE.Matrix4();
  const bx = new THREE.Vector3();
  const by = new THREE.Vector3();
  const bz = new THREE.Vector3();
  const neckPoint = new THREE.Vector3();
  const flapQuat = new THREE.Quaternion();
  const AXIS_Z = new THREE.Vector3(0, 0, 1);

  async function loadBody(entry, manifestUrl) {
    const spec = entry.manifest.body;
    const body = { status: 'loading', group: new THREE.Group(), parts: {} };
    entry.body = body;
    try {
      const gltf = await loader.loadAsync(resolveModelUrl(manifestUrl, spec.model));
      gltf.scene.updateMatrixWorld(true);
      const sceneInverse = gltf.scene.matrixWorld.clone().invert();
      const templates = {};
      gltf.scene.traverse((node) => {
        if (BODY_SINGLE.includes(node.name) || BODY_PAIRED.includes(node.name)) templates[node.name] = node;
        const texture = entry.manifest.texture;
        if (texture && node.isMesh && texture.materials.includes(node.material?.name)) {
          const offset = new THREE.Vector3().setFromMatrixPosition(sceneInverse.clone().multiply(node.matrixWorld));
          node.material = node.material.clone();
          patchSkinMaterial(node.material, { ...entry.textureUniforms, uSkinOffset: { value: offset } });
        }
      });
      for (const name of [...BODY_SINGLE, ...BODY_PAIRED]) {
        if (!templates[name] && name !== 'Wing') console.warn(`Skin corps : noeud "${name}" introuvable`);
      }
      const spawn = (name) => {
        const node = templates[name]?.clone(true);
        if (!node) return null;
        node.visible = false;
        body.group.add(node);
        return node;
      };
      for (const name of BODY_SINGLE) body.parts[name] = spawn(name);
      for (const name of BODY_PAIRED) body.parts[name] = [spawn(name), spawn(name)];
      body.group.visible = false;
      body.status = 'ready';
      if (active === entry) scene.add(body.group);
    } catch (error) {
      console.error('Corps du skin : chargement impossible', error);
      body.status = 'failed';
    }
  }

  function hideBody(entry) {
    skeleton = null;
    if (entry?.body?.group) entry.body.group.visible = false;
  }

  /** Oriente et dimensionne un noeud selon le repere d'un segment (+Y du modele vers l'extremite). */
  function placePart(node, frame, restLength, thick) {
    if (!node) return;
    basis.makeBasis(bx.fromArray(frame.x), by.fromArray(frame.y), bz.fromArray(frame.z));
    node.quaternion.setFromRotationMatrix(basis);
    node.position.fromArray(frame.position);
    node.scale.set(thick, Math.min(3, Math.max(0.3, frame.length / restLength)), thick);
    node.visible = true;
  }

  /** Noeud ponctuel (articulation) : meme orientation que le segment, echelle uniforme. */
  function placeJoint(node, frame, position, thick) {
    if (!node) return;
    basis.makeBasis(bx.fromArray(frame.x), by.fromArray(frame.y), bz.fromArray(frame.z));
    node.quaternion.setFromRotationMatrix(basis);
    node.position.fromArray(position);
    node.scale.setScalar(thick);
    node.visible = true;
  }

  function updateBody(entry, face, dt) {
    const body = entry.body;
    const spec = entry.manifest.body;
    if (!body || body.status !== 'ready' || !face.body) {
      hideBody(entry);
      return;
    }
    const raw = solveBody(face.body, { w: face.w, h: face.h }, -pose.position.z, {
      fov: FOV, depthGain: spec.depthGain, restShoulder: spec.restShoulder, lengths: spec.lengths
    });
    if (!raw) {
      hideBody(entry);
      return;
    }
    skeleton = blendSkeleton(skeleton, raw, smoothingFactor(dt, BODY_TAU));
    const thick = skeleton.scale * spec.thickness;
    const rest = spec.lengths;
    const torso = torsoFrame(skeleton);
    placePart(body.parts.Torso, torso, rest.torso, thick);

    // Ailes (facultatives) : attachees au dos, dans le repere du torse, battement autour de son axe avant.
    if (body.parts.Wing?.[0]) {
      const { restDeg, flapDeg, periodSec } = spec.wings;
      const wave = Math.sin((2 * Math.PI * performance.now()) / 1000 / periodSec);
      const scale = skeleton.scale;
      [1, -1].forEach((side, i) => {
        const node = body.parts.Wing[i];
        basis.makeBasis(bx.fromArray(torso.x), by.fromArray(torso.y), bz.fromArray(torso.z));
        node.quaternion.setFromRotationMatrix(basis);
        node.quaternion.multiply(flapQuat.setFromAxisAngle(AXIS_Z, -(restDeg + wave * flapDeg) * DEG * side));
        node.position.fromArray(skeleton.shoulderMid.map((c, k) => c + (torso.x[k] * side * 9 + torso.y[k] * 3 - torso.z[k] * 11) * scale));
        node.scale.set(side * thick, thick, thick);
        node.visible = true;
      });
    }

    // Cou : de la base du cou (au-dessus des epaules) jusque sous la tete, qui suit la pose du visage.
    const up = [-torso.y[0], -torso.y[1], -torso.y[2]];
    const base = skeleton.shoulderMid.map((c, i) => c + up[i] * spec.neckBase * skeleton.shoulderWidth);
    neckPoint.fromArray(spec.neckAnchor).applyMatrix4(head.matrix);
    placePart(body.parts.Neck, segmentFrame(base, neckPoint.toArray(), torso.x.map((c) => -c)), rest.neck, thick);

    skeleton.arms.forEach((arm, i) => {
      const upper = segmentFrame(arm.shoulder, arm.elbow, arm.outward);
      const fore = segmentFrame(arm.elbow, arm.wrist, arm.outward);
      const hand = segmentFrame(arm.wrist, arm.tip, arm.outward);
      placePart(body.parts.UpperArm[i], upper, rest.upperArm, thick);
      placePart(body.parts.Forearm[i], fore, rest.forearm, thick);
      placePart(body.parts.Hand[i], hand, rest.hand, thick);
      placeJoint(body.parts.Shoulder[i], upper, arm.shoulder, thick);
      placeJoint(body.parts.Elbow[i], fore, arm.elbow, thick);
      placeJoint(body.parts.Wrist[i], hand, arm.wrist, thick);
    });
    body.group.visible = true;
  }

  async function load(id, manifestUrl) {
    const entry = { status: 'loading', manifestUrl };
    skins.set(id, entry);
    try {
      const response = await fetch(manifestUrl, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`manifeste HTTP ${response.status}`);
      entry.manifest = normalizeSkinManifest(await response.json());
      const gltf = await loader.loadAsync(resolveModelUrl(manifestUrl, entry.manifest.model));
      entry.root = new THREE.Group();
      entry.root.add(gltf.scene);
      entry.morphs = [];
      entry.textureUniforms = { uSkinScale: { value: 1 }, uSkinBlotch: { value: 0 }, uSkinBump: { value: 0 }, uSkinScales: { value: 0 } };
      gltf.scene.updateMatrixWorld(true);
      const sceneInverse = gltf.scene.matrixWorld.clone().invert();
      entry.jawNode = null;
      entry.eyes = [];
      const eyeNodes = entry.manifest.eyes ? [['left', entry.manifest.eyes.left], ['right', entry.manifest.eyes.right]] : [];
      gltf.scene.traverse((node) => {
        if (node.name === entry.manifest.jaw?.node) entry.jawNode = node;
        for (const [side, name] of eyeNodes) {
          if (name && node.name === name) entry.eyes.push({ side, node, rest: node.quaternion.clone() });
        }
        const texture = entry.manifest.texture;
        if (texture && node.isMesh && texture.materials.includes(node.material?.name)) {
          // Un materiau par maillage : le decalage d'origine garde la texture continue entre pieces.
          const offset = new THREE.Vector3().setFromMatrixPosition(sceneInverse.clone().multiply(node.matrixWorld));
          node.material = node.material.clone();
          patchSkinMaterial(node.material, { ...entry.textureUniforms, uSkinOffset: { value: offset } });
        }
        const dict = node.morphTargetDictionary;
        if (!dict || !node.morphTargetInfluences) return;
        for (const [name, index] of Object.entries(dict)) {
          if (isBlendName(name) || name === entry.manifest.breath?.morph) entry.morphs.push({ mesh: node, name, index });
        }
      });
      for (const [side, name] of eyeNodes) {
        if (name && !entry.eyes.some((e) => e.side === side)) console.warn(`Skin ${id} : noeud d'oeil "${name}" introuvable`);
      }
      if (entry.manifest.jaw && !entry.jawNode) console.warn(`Skin ${id} : noeud de machoire "${entry.manifest.jaw.node}" introuvable`);
      entry.jawRest = entry.jawNode?.quaternion.clone() ?? null;
      applyManifest(entry);
      applyTexture(entry);
      entry.status = 'ready';
      if (entry.manifest.body) loadBody(entry, manifestUrl);
    } catch (error) {
      console.error(`Skin 3D ${id} : chargement impossible`, error);
      entry.status = 'failed';
      entry.failedAt = performance.now();
    }
  }

  /** Retourne l'entree prete du skin, lance son chargement au besoin (sinon null). */
  function ensure(id, manifestUrl) {
    const entry = skins.get(id);
    if (!entry) {
      load(id, manifestUrl);
      return null;
    }
    if (entry.status === 'failed' && performance.now() - entry.failedAt > RETRY_MS) {
      load(id, manifestUrl);
      return null;
    }
    return entry.status === 'ready' ? entry : null;
  }

  function activate(entry) {
    if (active === entry) return;
    if (active) head.remove(active.root);
    if (active?.body?.group) scene.remove(active.body.group);
    active = entry;
    head.add(entry.root);
    if (entry.body?.status === 'ready') scene.add(entry.body.group);
    applyOccluder(entry);
    ambient.intensity = entry.manifest.light.ambient;
    key.intensity = entry.manifest.light.key;
  }

  function resize(w, h) {
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function smoothPose(matrixArray, k, hold) {
    targetMatrix.fromArray(matrixArray);
    targetMatrix.decompose(target.position, target.quaternion, target.scale);
    if (hold > 0.001 && clean.valid) {
      // Le nez bouge : la pose mesuree est faussee, on reste proche de la derniere pose saine.
      target.position.lerp(clean.position, hold);
      target.quaternion.slerp(clean.quaternion, hold);
      target.scale.lerp(clean.scale, hold);
    } else {
      clean.position.copy(target.position);
      clean.quaternion.copy(target.quaternion);
      clean.scale.copy(target.scale);
      clean.valid = true;
    }
    if (!hasPose) {
      pose.position.copy(target.position);
      pose.quaternion.copy(target.quaternion);
      pose.scale.copy(target.scale);
      hasPose = true;
    } else {
      pose.position.lerp(target.position, k);
      pose.quaternion.slerp(target.quaternion, k);
      pose.scale.lerp(target.scale, k);
    }
    head.matrix.compose(pose.position, pose.quaternion, pose.scale);
    head.matrixWorldNeedsUpdate = true;
  }

  const axisQuat = new THREE.Quaternion();
  const gazeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const gazeQuat = new THREE.Quaternion();
  function animate(entry, blend, k, kFast, lip) {
    // Lissage de tous les blendshapes une seule fois par image (morph targets, machoire, regard).
    for (const name of BLEND_NAMES) {
      const factor = FAST_BLENDS.has(name) ? kFast : k;
      blendNow[name] = (blendNow[name] ?? 0) + ((blend[name] ?? 0) - (blendNow[name] ?? 0)) * factor;
    }
    lipNow += ((lip ?? 0) - lipNow) * kFast;
    const gains = entry.manifest.morphGains;
    const gain = entry.manifest.morphGain;
    const breathMorph = entry.manifest.breath?.morph;
    const breath = breathValue(performance.now() / 1000, entry.manifest.breath);
    for (const { mesh, name, index } of entry.morphs) {
      mesh.morphTargetInfluences[index] = name === breathMorph ? breath : Math.min(1, (blendNow[name] ?? 0) * gain * (gains[name] ?? 1));
    }
    const jaw = entry.manifest.jaw;
    if (jaw && entry.jawNode) {
      axisQuat.setFromAxisAngle(v(jaw.axis).normalize(), jawAngle(blendNow.jawOpen, jaw, lipNow));
      entry.jawNode.quaternion.copy(entry.jawRest).multiply(axisQuat);
    }
    for (const eye of entry.eyes) {
      const { yaw, pitch } = gazeAngles(blendNow, eye.side, entry.manifest.eyes);
      gazeEuler.set(pitch, yaw, 0);
      eye.node.quaternion.copy(eye.rest).multiply(gazeQuat.setFromEuler(gazeEuler));
    }
  }

  return {
    canvas: renderer.domElement,
    /**
     * Dessine le skin pour ce visage. Retourne false tant que le modele n'est pas pret ou si la
     * trame n'a pas de pose (rien n'est alors dessine).
     */
    render(face, id, manifestUrl) {
      const entry = ensure(id, manifestUrl);
      // `face.lost` : visage hors champ mais corps suivi. On garde la derniere pose de tete.
      if (!entry || !face || (!face.pose && !(face.lost && hasPose))) return false;
      activate(entry);
      const now = performance.now();
      const dt = Math.min(0.2, (now - lastTime) / 1000);
      lastTime = now;
      resize(face.w, face.h);
      if (!face.lost) smoothPose(face.pose, smoothingFactor(dt, POSE_TAU), poseHoldWeight(face.blend, entry.manifest.stabilize));
      updateBody(entry, face, dt);
      animate(entry, face.blend ?? {}, smoothingFactor(dt, BLEND_TAU), smoothingFactor(dt, FAST_TAU), face.lip);
      renderer.render(scene, camera);
      return true;
    },
    /** Efface l'image et oublie la pose (le prochain visage repart sans lissage). */
    clear() {
      hasPose = false;
      clean.valid = false;
      hideBody(active);
      renderer.clear();
    },
    /** Etat du chargement du skin : idle, loading, ready ou failed (diagnostic). */
    status(id) {
      return skins.get(id)?.status ?? 'idle';
    },
    /** Vrai si le modele du skin est charge et pret a etre dessine. */
    isReady(id) {
      return skins.get(id)?.status === 'ready';
    },
    /** Manifeste courant d'un skin charge (pour l'outil de calibrage), ou null. */
    getManifest(id) {
      const entry = skins.get(id);
      return entry?.status === 'ready' ? structuredClone(entry.manifest) : null;
    },
    /** Applique a chaud des champs du manifeste (position, rotation, scale, occluder...). */
    patchManifest(id, patch) {
      const entry = skins.get(id);
      if (entry?.status !== 'ready') return;
      entry.manifest = normalizeSkinManifest({ ...entry.manifest, transform: { ...entry.manifest, ...patch.transform }, occluder: { ...entry.manifest.occluder, ...patch.occluder }, jaw: patch.jaw ?? entry.manifest.jaw ?? undefined, eyes: patch.eyes ?? entry.manifest.eyes ?? undefined, breath: patch.breath ?? entry.manifest.breath ?? undefined, texture: patch.texture ?? entry.manifest.texture ?? undefined, stabilize: patch.stabilize ?? entry.manifest.stabilize ?? undefined, body: patch.body ?? entry.manifest.body ?? undefined, morphGains: patch.morphGains ?? entry.manifest.morphGains, morphGain: patch.morphGain ?? entry.manifest.morphGain, light: { ...entry.manifest.light, ...patch.light } });
      applyManifest(entry);
      applyTexture(entry);
      if (active === entry) applyOccluder(entry);
    },
    /** Affiche l'occluder en fil de fer (calibrage). */
    setDebug(on) {
      debug = on;
      if (active) applyOccluder(active);
    }
  };
}
