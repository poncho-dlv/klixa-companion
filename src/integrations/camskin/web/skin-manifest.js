// Partie PURE des skins 3D (aucune dependance DOM ni three.js) : partagee entre le navigateur
// (moteur de rendu) et Node (validation des trames, tests).

/** Les 51 blendshapes de MediaPipe (convention ARKit, 52 categories avec `_neutral`, exclue ici). */
export const BLEND_NAMES = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight'
];

const BLEND_SET = new Set(BLEND_NAMES);
export const isBlendName = (name) => BLEND_SET.has(name);

/** Repertoire (URL) sous lequel le serveur local sert les modeles. */
const MODELS_PREFIX = '/models/';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function vec3(value, fallback, limit) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) {
    throw new Error('vecteur a 3 nombres attendu');
  }
  return value.map((n) => clamp(n, -limit, limit));
}

function optionalNumber(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!finite(value)) throw new Error('nombre attendu');
  return clamp(value, min, max);
}

/**
 * Section `body` du manifeste : corps (torse, cou, bras) fait de pieces rigides pilotees par la pose
 * du corps. Longueurs en cm (celles du modele au repos), `restShoulder` = largeur d'epaules du modele.
 * @returns {object|null} la section normalisee, ou null si le skin n'a pas de corps
 */
function normalizeBody(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw.model !== 'string' || !/^[\w./-]{1,120}\.(glb|gltf)$/i.test(raw.model) || raw.model.includes('..')) {
    throw new Error('body.model invalide (chemin relatif vers un .glb/.gltf attendu)');
  }
  const lengths = raw.lengths ?? {};
  return {
    model: raw.model,
    thickness: optionalNumber(raw.thickness, 1, 0.3, 3),
    armThickness: optionalNumber(raw.armThickness, 1, 0.3, 3),
    depthGain: optionalNumber(raw.depthGain, 0.6, -1.5, 1.5),
    restShoulder: optionalNumber(raw.restShoulder, 40, 10, 100),
    neckAnchor: vec3(raw.neckAnchor, [0, -13, -3], 60),
    neckBase: optionalNumber(raw.neckBase, 0.12, -0.5, 0.5),
    wings: {
      restDeg: optionalNumber(raw.wings?.restDeg, 0, -30, 60),
      flapDeg: optionalNumber(raw.wings?.flapDeg, 8, 0, 40),
      periodSec: optionalNumber(raw.wings?.periodSec, 2.6, 0.5, 10)
    },
    lengths: {
      torso: optionalNumber(lengths.torso, 45, 5, 150),
      neck: optionalNumber(lengths.neck, 14, 2, 80),
      upperArm: optionalNumber(lengths.upperArm, 28, 5, 100),
      forearm: optionalNumber(lengths.forearm, 26, 5, 100),
      hand: optionalNumber(lengths.hand, 10, 2, 50)
    }
  };
}

/**
 * Valide et complete le manifeste d'un skin 3D (`manifest.json`). Unites : centimetres, dans le
 * repere "visage canonique" de MediaPipe (origine au centre de la tete, +Y vers le haut, +Z
 * vers l'avant du visage). Les angles sont en degres.
 *
 * @param {object} raw contenu du manifeste
 * @returns {{ model: string, position: number[], rotation: number[], scale: number,
 *   occluder: { enabled: boolean, position: number[], radii: number[] },
 *   jaw: { node: string, axis: number[], maxAngleDeg: number, gain: number, lipGain: number, curve: number }|null,
 *   stabilize: { noseHold: number }|null,
 *   body: { model: string, thickness: number, armThickness: number, depthGain: number, restShoulder: number, neckAnchor: number[], neckBase: number,
 *     lengths: { torso: number, neck: number, upperArm: number, forearm: number, hand: number } }|null,
 *   morphGains: Record<string, number>,
 *   eyes: { left: string|null, right: string|null, maxYawDeg: number, maxPitchDeg: number, gain: number }|null,
 *   breath: { morph: string, periodSec: number, amount: number }|null,
 *   texture: { materials: string[], scale: number, blotch: number, bump: number, scales: number }|null,
 *   morphGain: number, light: { ambient: number, key: number } }}
 * @throws {Error} manifeste invalide
 */
export function normalizeSkinManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifeste invalide');
  if (typeof raw.model !== 'string' || !/^[\w./-]{1,120}\.(glb|gltf)$/i.test(raw.model) || raw.model.includes('..')) {
    throw new Error('champ "model" invalide (chemin relatif vers un .glb/.gltf attendu)');
  }
  const transform = raw.transform ?? {};
  const occ = raw.occluder ?? {};
  let jaw = null;
  if (raw.jaw !== undefined && raw.jaw !== null) {
    if (typeof raw.jaw.node !== 'string' || !raw.jaw.node) throw new Error('jaw.node requis');
    const axis = vec3(raw.jaw.axis, [1, 0, 0], 1);
    if (axis.every((n) => n === 0)) throw new Error('jaw.axis nul');
    jaw = {
      node: raw.jaw.node,
      axis,
      maxAngleDeg: optionalNumber(raw.jaw.maxAngleDeg, 20, -90, 90),
      gain: optionalNumber(raw.jaw.gain, 1, 0.1, 8),
      lipGain: optionalNumber(raw.jaw.lipGain, 4, 0, 20),
      curve: optionalNumber(raw.jaw.curve, 0.7, 0.3, 2)
    };
  }
  let eyes = null;
  if (raw.eyes !== undefined && raw.eyes !== null) {
    const name = (v) => (typeof v === 'string' && v ? v : null);
    const left = name(raw.eyes.left);
    const right = name(raw.eyes.right);
    if (!left && !right) throw new Error('eyes.left ou eyes.right requis');
    eyes = {
      left,
      right,
      maxYawDeg: optionalNumber(raw.eyes.maxYawDeg, 28, 0, 60),
      maxPitchDeg: optionalNumber(raw.eyes.maxPitchDeg, 20, 0, 60),
      gain: optionalNumber(raw.eyes.gain, 1.3, 0.1, 6)
    };
  }
  let breath = null;
  if (raw.breath !== undefined && raw.breath !== null) {
    if (typeof raw.breath.morph !== 'string' || !raw.breath.morph) throw new Error('breath.morph requis');
    breath = {
      morph: raw.breath.morph,
      periodSec: optionalNumber(raw.breath.periodSec, 3.6, 1, 12),
      amount: optionalNumber(raw.breath.amount, 0.6, 0, 1)
    };
  }
  let texture = null;
  if (raw.texture !== undefined && raw.texture !== null) {
    const list = Array.isArray(raw.texture.materials) ? raw.texture.materials : [];
    if (!list.length || !list.every((n) => typeof n === 'string' && n)) throw new Error('texture.materials : liste de noms de materiaux requise');
    texture = {
      materials: list.slice(0, 8),
      scale: optionalNumber(raw.texture.scale, 1, 0.2, 5),
      blotch: optionalNumber(raw.texture.blotch, 0.45, 0, 1),
      bump: optionalNumber(raw.texture.bump, 0.35, 0, 2),
      scales: optionalNumber(raw.texture.scales, 0, 0, 1)
    };
  }
  let stabilize = null;
  if (raw.stabilize !== undefined && raw.stabilize !== null) {
    stabilize = { noseHold: optionalNumber(raw.stabilize.noseHold, 0.85, 0, 1) };
  }
  const morphGains = {};
  if (raw.morphGains !== undefined && raw.morphGains !== null) {
    const entries = Object.entries(raw.morphGains);
    if (typeof raw.morphGains !== 'object' || Array.isArray(raw.morphGains) || entries.length > 24) throw new Error('morphGains invalide');
    for (const [name, value] of entries) {
      if (!isBlendName(name)) throw new Error(`morphGains : blendshape inconnu "${name}"`);
      morphGains[name] = optionalNumber(value, 1, 0, 6);
    }
  }
  const body = normalizeBody(raw.body);
  const light = raw.light ?? {};
  return {
    model: raw.model,
    position: vec3(transform.position, [0, 0, 0], 100),
    rotation: vec3(transform.rotation, [0, 0, 0], 360),
    scale: optionalNumber(transform.scale, 1, 0.01, 100),
    occluder: {
      enabled: occ.enabled !== false,
      position: vec3(occ.position, [0, 0, -3], 50),
      radii: vec3(occ.radii, [7, 9.5, 8], 50).map((n) => Math.max(0.5, Math.abs(n)))
    },
    jaw,
    eyes,
    breath,
    texture,
    stabilize,
    body,
    morphGains,
    morphGain: optionalNumber(raw.morphGain, 1, 0, 4),
    light: { ambient: optionalNumber(light.ambient, 1.1, 0, 10), key: optionalNumber(light.key, 1.6, 0, 10) }
  };
}

/**
 * Resout l'URL du modele depuis celle du manifeste. Le resultat doit rester sous `/models/` :
 * un manifeste ne peut pas pointer ailleurs sur le serveur local.
 * @returns {string} chemin absolu (ex. /models/skins/dragon/dragon.glb)
 * @throws {Error} chemin hors de /models/
 */
export function resolveModelUrl(manifestUrl, model) {
  const base = new URL(manifestUrl, 'http://localhost');
  const target = new URL(model, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(MODELS_PREFIX)) {
    throw new Error('modele hors de /models/');
  }
  return target.pathname;
}

// Sous ce rapport (ecart des levres / ecart des yeux), les levres sont considerees fermees.
const LIP_DEADZONE = 0.02;

/**
 * Angle (radians) de la machoire. L'ouverture est la plus grande de deux mesures : le blendshape
 * `jawOpen` (x `jaw.gain`, peu sensible aux petites ouvertures : en parole il depasse rarement
 * 0,3-0,4) et l'ecart reel des levres `lip` (x `jaw.lipGain`, plus lineaire). `jaw.curve` < 1
 * amplifie les faibles ouvertures.
 */
export function jawAngle(jawOpen, jaw, lip = 0) {
  if (!jaw) return 0;
  const fromBlend = (jawOpen ?? 0) * (jaw.gain ?? 1);
  const fromLip = Math.max(0, (lip ?? 0) - LIP_DEADZONE) * (jaw.lipGain ?? 0);
  const open = clamp(Math.max(fromBlend, fromLip), 0, 1);
  return (open ** (jaw.curve ?? 1) * jaw.maxAngleDeg * Math.PI) / 180;
}

/**
 * Poids (0..1) du maintien de la pose quand le nez bouge. La pose de MediaPipe est calculee avec
 * des points du nez : un froncement la fait glisser et deplace toute la tete. Tant que
 * `noseSneer*` est eleve, on se rapproche de la derniere pose "propre".
 */
export function poseHoldWeight(blend, stabilize) {
  if (!stabilize) return 0;
  const sneer = Math.max(blend?.noseSneerLeft ?? 0, blend?.noseSneerRight ?? 0);
  return clamp((sneer - 0.06) / 0.3, 0, 1) * stabilize.noseHold;
}

/**
 * Rotation du globe oculaire (radians) pour les blendshapes de regard. `side` : 'left' (oeil
 * gauche de la personne, +X du modele) ou 'right'. Yaw autour de Y (+ = vers +X), pitch autour
 * de X (negatif = vers le haut).
 * @returns {{ yaw: number, pitch: number }}
 */
export function gazeAngles(blend, side, eyes) {
  if (!eyes) return { yaw: 0, pitch: 0 };
  const suffix = side === 'left' ? 'Left' : 'Right';
  const get = (name) => blend[name + suffix] ?? 0;
  const horizontal = (get('eyeLookOut') - get('eyeLookIn')) * (side === 'left' ? 1 : -1);
  const vertical = get('eyeLookUp') - get('eyeLookDown');
  const limit = (value, max) => clamp(value * eyes.gain, -1, 1) * max;
  const rad = Math.PI / 180;
  return { yaw: limit(horizontal, eyes.maxYawDeg) * rad, pitch: -limit(vertical, eyes.maxPitchDeg) * rad };
}

/** Intensite (0..1) de la respiration a l'instant `timeSec` : oscillation douce entre 0 et `amount`. */
export function breathValue(timeSec, breath) {
  if (!breath) return 0;
  return breath.amount * (0.5 + 0.5 * Math.sin((2 * Math.PI * timeSec) / breath.periodSec));
}

/** Facteur de lissage independant du nombre d'images par seconde (constante de temps `tau` en s). */
export function smoothingFactor(dt, tau) {
  if (!(dt > 0) || !(tau > 0)) return 1;
  return 1 - Math.exp(-dt / tau);
}

/**
 * Valide la pose faciale (matrice 4x4 colonne-major) et les blendshapes d'une trame recue.
 * @returns {{ pose?: number[], blend?: Record<string, number>, lip?: number }|null} champs nettoyes, ou null si invalides
 */
export function sanitizePoseAndBlend(raw) {
  const out = {};
  if (raw.lip !== undefined) {
    if (!finite(raw.lip) || raw.lip < 0 || raw.lip > 5) return null;
    out.lip = raw.lip;
  }
  if (raw.pose !== undefined) {
    if (!Array.isArray(raw.pose) || raw.pose.length !== 16 || !raw.pose.every((n) => finite(n) && Math.abs(n) <= 1e5)) return null;
    out.pose = [...raw.pose];
  }
  if (raw.blend !== undefined) {
    const blend = raw.blend;
    if (!blend || typeof blend !== 'object' || Array.isArray(blend)) return null;
    const entries = Object.entries(blend);
    if (entries.length > BLEND_NAMES.length) return null;
    out.blend = {};
    for (const [name, value] of entries) {
      if (!isBlendName(name) || !finite(value) || value < 0 || value > 1) return null;
      out.blend[name] = value;
    }
  }
  return out;
}
