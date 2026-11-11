// Corps d'un skin 3D : conversion des points de pose MediaPipe (epaules, coudes, poignets, mains,
// hanches) en squelette dans le repere de la camera virtuelle du rendu (cm), puis en reperes de
// segments. Module pur (aucune dependance) : testable sous Node et partage par le rendu et le serveur.
//
// Repere camera : +X vers la droite de l'image, +Y vers le haut, la camera regarde vers -Z (un
// point devant la camera a Z < 0). Les coordonnees de pose sont celles de l'image NON retournee.

/** Indices MediaPipe Pose conserves dans la trame, dans l'ordre : voir BODY_JOINT. */
export const BODY_LANDMARKS = [0, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24];

/** Position de chaque point dans le tableau de la trame (`body[BODY_JOINT.nose]`). */
export const BODY_JOINT = {
  nose: 0, earL: 1, earR: 2, shoulderL: 3, shoulderR: 4, elbowL: 5, elbowR: 6, wristL: 7, wristR: 8,
  pinkyL: 9, pinkyR: 10, indexL: 11, indexR: 12, hipL: 13, hipR: 14
};

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/**
 * Valide les points de corps d'une trame (le serveur local ne relaie rien de mal forme).
 * Chaque point : [x, y, z, visibilite] ; x/y = image normalisee (0..1, peut deborder un peu),
 * z = profondeur monde en metres relative aux hanches, visibilite 0..1.
 * @returns {number[][]|null} copie nettoyee, ou null si invalide
 */
export function sanitizeBody(raw) {
  if (!Array.isArray(raw) || raw.length !== BODY_LANDMARKS.length) return null;
  const out = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 4 || !p.every(finite)) return null;
    const [x, y, z, v] = p;
    if (x < -2 || x > 3 || y < -2 || y > 3 || Math.abs(z) > 5 || v < 0 || v > 1) return null;
    out.push([x, y, z, v]);
  }
  return out;
}

/**
 * Filtre anti-tremblement "One Euro" sur les points du corps : tres lisse quand on ne bouge pas
 * (le bruit du modele disparait), quasi sans retard quand on bouge vite. Un filtre par coordonnee
 * (x, y, z) de chaque point ; la visibilite est reprise telle quelle.
 * @param {{ minCutoff?: number, beta?: number, dCutoff?: number }} [options] minCutoff (Hz) : lissage au repos ;
 *   beta : reactivite aux mouvements rapides ; dCutoff : lissage de la vitesse
 */
export function createBodyFilter({ minCutoff = 0.6, beta = 3, dCutoff = 1 } = {}) {
  let state = null; // [point][axe] -> { x, dx }
  let lastT = null;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return {
    reset() { state = null; lastT = null; },
    /** @param {number[][]} body points valides ; @param {number} t horloge en secondes */
    filter(body, t) {
      const dt = lastT === null ? 0 : t - lastT;
      lastT = t;
      if (!state || dt <= 0 || state.length !== body.length) {
        state = body.map((p) => [0, 1, 2].map((a) => ({ x: p[a], dx: 0 })));
        return body.map((p) => [...p]);
      }
      return body.map((p, i) => {
        const out = [0, 1, 2].map((a) => {
          const s = state[i][a];
          const dx = (p[a] - s.x) / dt;
          s.dx += alpha(dCutoff, dt) * (dx - s.dx);
          s.x += alpha(minCutoff + beta * Math.abs(s.dx), dt) * (p[a] - s.x);
          return s.x;
        });
        return [...out, p[3]];
      });
    }
  };
}

// --- Petits outils vectoriels (tableaux [x, y, z]) ---------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const mid = (a, b) => mix(a, b, 0.5);
function normalize(a, fallback = [0, -1, 0]) {
  const l = length(a);
  return l > 1e-6 ? mul(a, 1 / l) : [...fallback];
}

/**
 * Point image (x, y normalises) place a la profondeur `depth` (cm devant la camera) dans le
 * repere camera du rendu. Un point garde le meme pixel quelle que soit sa profondeur : la
 * profondeur n'influence que la taille et l'orientation des segments, jamais l'alignement.
 */
export function unproject(x, y, w, h, depth, fovDeg) {
  const k = Math.tan((fovDeg * Math.PI) / 360);
  return [(2 * x - 1) * k * (w / h) * depth, (1 - 2 * y) * k * depth, -depth];
}

const DEFAULT_BODY_PARAMS = {
  fov: 63,
  depthGain: 0.6,
  maxDepthOffset: 40,
  minVisibility: 0.5,
  limbVisibility: 0.4,
  // Les points index/auriculaire de la pose sont aux articulations des doigts, pas au bout : la main
  // reelle depasse d'autant. Facteur applique a la longueur de la main du squelette.
  handReach: 1.45,
  restShoulder: 40,
  lengths: { torso: 45, neck: 14, upperArm: 28, forearm: 26, hand: 10 }
};

/**
 * Squelette (cm, repere camera) deduit des points de corps et de la profondeur de la tete.
 * Les membres hors champ ou peu visibles retombent sur une pose de repos le long du corps.
 *
 * @param {number[][]} body points valides (voir sanitizeBody)
 * @param {{ w: number, h: number }} view taille de l'image
 * @param {number} headDepth distance de la tete a la camera (cm), tiree de la pose du visage
 * @param {Partial<typeof DEFAULT_BODY_PARAMS>} [options]
 * @returns {{ scale: number, shoulderWidth: number, shoulderMid: number[], hipMid: number[], hipsKnown: boolean,
 *   arms: { outward: number[], shoulder: number[], elbow: number[], wrist: number[], tip: number[], hasElbow: boolean, hasWrist: boolean }[] }|null}
 *   null si les epaules ne sont pas visibles (pas de corps a dessiner)
 */
export function solveBody(body, view, headDepth, options = {}) {
  const p = { ...DEFAULT_BODY_PARAMS, ...options, lengths: { ...DEFAULT_BODY_PARAMS.lengths, ...options.lengths } };
  const J = BODY_JOINT;
  const vis = (i) => body[i][3];
  if (vis(J.shoulderL) < p.minVisibility || vis(J.shoulderR) < p.minVisibility) return null;

  // Profondeur relative a la tete : moyenne nez/oreilles comme reference (monde en m -> cm).
  const ref = (body[J.nose][2] + body[J.earL][2] + body[J.earR][2]) / 3;
  const point = (i) => {
    const offset = clamp((body[i][2] - ref) * 100 * p.depthGain, -p.maxDepthOffset, p.maxDepthOffset);
    return unproject(body[i][0], body[i][1], view.w, view.h, Math.max(10, headDepth + offset), p.fov);
  };

  const shL = point(J.shoulderL);
  const shR = point(J.shoulderR);
  const shoulderMid = mid(shL, shR);
  const shoulderWidth = Math.max(1, length(sub(shL, shR)));
  const scale = clamp(shoulderWidth / p.restShoulder, 0.25, 5);
  const down = [0, -1, 0];

  let hipMid = null;
  const hipsSeen = vis(J.hipL) >= p.minVisibility && vis(J.hipR) >= p.minVisibility;
  if (hipsSeen) {
    hipMid = mid(point(J.hipL), point(J.hipR));
    // Des hanches au-dessus des epaules ou presque : detection aberrante.
    if (shoulderMid[1] - hipMid[1] < 0.5 * shoulderWidth) hipMid = null;
  }
  const hipsKnown = hipMid !== null;
  if (!hipsKnown) hipMid = add(shoulderMid, mul(down, p.lengths.torso * scale));

  const arms = [[J.shoulderL, J.elbowL, J.wristL, J.pinkyL, J.indexL, shL], [J.shoulderR, J.elbowR, J.wristR, J.pinkyR, J.indexR, shR]].map(
    ([, elbowIndex, wristIndex, pinkyIndex, indexIndex, shoulder]) => {
      const outward = [Math.sign(shoulder[0] - shoulderMid[0]) || 1, 0, 0];
      const upper = p.lengths.upperArm * scale;
      const lower = p.lengths.forearm * scale;
      const hand = p.lengths.hand * scale * p.handReach;
      const hasElbow = vis(elbowIndex) >= p.limbVisibility;
      const hasWrist = hasElbow && vis(wristIndex) >= p.limbVisibility;
      const elbow = hasElbow ? point(elbowIndex) : add(shoulder, mul(down, upper));
      const forearmDir = normalize(sub(elbow, shoulder));
      const wrist = hasWrist ? point(wristIndex) : add(elbow, mul(forearmDir, lower));
      // Direction de la main : poignet -> milieu index/auriculaire, sinon dans le prolongement de l'avant-bras.
      const handsSeen = hasWrist && vis(pinkyIndex) >= p.limbVisibility && vis(indexIndex) >= p.limbVisibility;
      const handDir = handsSeen
        ? normalize(sub(mid(point(pinkyIndex), point(indexIndex)), wrist), forearmDir)
        : normalize(sub(wrist, elbow), forearmDir);
      return { outward, shoulder, elbow, wrist, tip: add(wrist, mul(handDir, hand)), hasElbow, hasWrist };
    }
  );
  return { scale, shoulderWidth, shoulderMid, hipMid, hipsKnown, arms };
}

/**
 * Lisse un squelette vers le suivant (moyenne exponentielle, `k` entre 0 et 1). Sans squelette
 * precedent, ou si les membres changent de mode (visible / hors champ), il est repris tel quel.
 */
export function blendSkeleton(prev, next, k) {
  if (!prev || !next) return next;
  const blend = (a, b) => mix(a, b, k);
  return {
    ...next,
    scale: prev.scale + (next.scale - prev.scale) * k,
    shoulderWidth: prev.shoulderWidth + (next.shoulderWidth - prev.shoulderWidth) * k,
    shoulderMid: blend(prev.shoulderMid, next.shoulderMid),
    hipMid: blend(prev.hipMid, next.hipMid),
    arms: next.arms.map((arm, i) => {
      const old = prev.arms[i];
      return {
        ...arm,
        shoulder: blend(old.shoulder, arm.shoulder),
        elbow: blend(old.elbow, arm.elbow),
        wrist: blend(old.wrist, arm.wrist),
        tip: blend(old.tip, arm.tip)
      };
    })
  };
}

/**
 * Repere d'un segment : origine en `from`, +Y vers `to`, +X aussi proche que possible de `hint`
 * (la direction "exterieure" du segment), +Z = X x Y.
 * @returns {{ position: number[], x: number[], y: number[], z: number[], length: number }}
 */
export function segmentFrame(from, to, hint, fallbackHint = [0, 0, 1]) {
  const delta = sub(to, from);
  const y = normalize(delta);
  const project = (v) => sub(v, mul(y, dot(v, y)));
  let x = project(hint);
  // Segment presque colineaire a l'indice : on se rabat sur une autre direction.
  if (length(x) < 0.25) x = project(fallbackHint);
  x = normalize(x, [1, 0, 0]);
  return { position: [...from], x, y, z: cross(x, y), length: length(delta) };
}

/**
 * Repere du torse : de la mi-epaules vers la mi-hanches ; +X vers la gauche de l'image (donc le
 * ventre, +Z, regarde la camera quand la personne est debout et de face).
 */
export function torsoFrame(skeleton) {
  const [left, right] = [skeleton.arms[0].shoulder, skeleton.arms[1].shoulder];
  const toImageLeft = sub(left[0] <= right[0] ? left : right, left[0] <= right[0] ? right : left);
  return segmentFrame(skeleton.shoulderMid, skeleton.hipMid, toImageLeft);
}
