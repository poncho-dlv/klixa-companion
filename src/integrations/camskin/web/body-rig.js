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
/** Transition douce de 0 (v <= lo) a 1 (v >= hi). */
function smoothstep(lo, hi, v) {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
// Prediction : vitesse (largeur d'image par seconde) sous laquelle on n'extrapole pas, et a partir de laquelle on extrapole pleinement.
const PREDICT_MIN_SPEED = 0.04;
const PREDICT_FULL_SPEED = 0.15;

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
 * @param {{ minCutoff?: number, beta?: number, dCutoff?: number, vCutoff?: number }} [options] minCutoff (Hz) : lissage au repos ;
 *   beta : reactivite aux mouvements rapides ; dCutoff : lissage de la vitesse ; vCutoff : lissage de la vitesse de prediction
 */
export function createBodyFilter({ minCutoff = 0.6, beta = 8, dCutoff = 1, vCutoff = 4, zMinCutoff = 0.25, zBeta = 1.5, visTau = 0.25 } = {}) {
  let state = null; // [point][axe] -> { x, dx, v } ; dx = vitesse tres lissee (reglage du filtre), v = vitesse pour la prediction
  let vis = null;
  let lastT = null;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return {
    reset() { state = null; vis = null; lastT = null; },
    /** @param {number[][]} body points valides ; @param {number} t horloge en secondes */
    filter(body, t) {
      const dt = lastT === null ? 0 : t - lastT;
      lastT = t;
      // Premiere mesure, horloge qui recule (changement de camera) ou trou trop long : on repart de zero.
      if (!state || dt <= 0 || dt > 0.5 || state.length !== body.length) {
        state = body.map((p) => [0, 1, 2].map((a) => ({ x: p[a], dx: 0, v: 0 })));
        vis = body.map((p) => p[3]);
        return body.map((p) => [...p]);
      }
      // Visibilite lissee : elle oscille d'une image a l'autre autour des seuils, ce qui ferait sauter les membres.
      const kVis = 1 - Math.exp(-dt / visTau);
      return body.map((p, i) => {
        const out = [0, 1, 2].map((a) => {
          const s = state[i][a];
          const before = s.x;
          const dx = (p[a] - s.x) / dt;
          s.dx += alpha(dCutoff, dt) * (dx - s.dx);
          // La profondeur (axe 2) est bien plus bruitee que la position dans l'image : filtre plus ferme.
          const cutoff = a === 2 ? zMinCutoff + zBeta * Math.abs(s.dx) : minCutoff + beta * Math.abs(s.dx);
          s.x += alpha(cutoff, dt) * (p[a] - s.x);
          s.v += alpha(vCutoff, dt) * ((s.x - before) / dt - s.v);
          return s.x;
        });
        vis[i] += (p[3] - vis[i]) * kVis;
        return [...out, vis[i]];
      });
    },
    /**
     * Points extrapoles `lead` secondes apres la derniere mesure (compense le retard de la mesure et
     * donne une position a chaque image affichee, meme si la pose est mesuree moins souvent).
     * Seuls x et y sont extrapoles : la profondeur est trop bruitee pour ca. Sous une petite vitesse
     * (immobile), rien n'est extrapole : la prediction n'ajoute pas de tremblement au repos.
     * @returns {number[][]|null} null sans mesure
     */
    predict(lead) {
      if (!state) return null;
      return state.map((axes, i) => {
        const speed = Math.hypot(axes[0].v, axes[1].v);
        const gain = lead * smoothstep(PREDICT_MIN_SPEED, PREDICT_FULL_SPEED, speed);
        return [axes[0].x + axes[0].v * gain, axes[1].x + axes[1].v * gain, axes[2].x, vis[i]];
      });
    }
  };
}

/** Nombre de points d'une main (MediaPipe Hand Landmarker) et indices utilises. */
export const HAND_POINTS = 21;
const HAND_JOINT = { wrist: 0, thumbTip: 4, indexBase: 5, indexTip: 8, middleBase: 9, middleTip: 12, ringTip: 16, pinkyBase: 17, pinkyTip: 20 };

/**
 * Valide les mains d'une trame : `[main gauche|null, main droite|null]` (gauche/droite de la personne,
 * meme ordre que les bras du squelette). Chaque main : 21 points [x, y, z] ; x/y = image normalisee,
 * z = profondeur relative au poignet (meme echelle que x, negatif = plus pres de la camera).
 * @returns {(number[][]|null)[]|null} copie nettoyee, ou null si invalide
 */
export function sanitizeHands(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const out = [];
  for (const hand of raw) {
    if (hand === null) {
      out.push(null);
      continue;
    }
    if (!Array.isArray(hand) || hand.length !== HAND_POINTS) return null;
    const points = [];
    for (const q of hand) {
      if (!Array.isArray(q) || q.length !== 3 || !q.every(finite)) return null;
      if (q[0] < -2 || q[0] > 3 || q[1] < -2 || q[1] > 3 || Math.abs(q[2]) > 3) return null;
      points.push([q[0], q[1], q[2]]);
    }
    out.push(points);
  }
  return out;
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
  // Confiance d'un point = transition douce entre deux visibilites [debut, pleine]. Pas de seuil sec : un point
  // dont la visibilite oscille ferait sauter le membre entre sa position suivie et sa position de repos.
  // Coude : plage basse, car cache par le corps ou la main il garde une position estimee correcte (coude
  // sorti, main cachee : le bras s'ecarte quand meme).
  elbowVisibility: [0.1, 0.35],
  // Poignet et main : plage basse aussi. Un point cache mais DANS l'image (main passee derriere la tete, le
  // dos...) reste bien estime par le modele ; c'est hors de l'image qu'il invente (voir offFrame).
  limbVisibility: [0.04, 0.2],
  hipVisibility: [0.3, 0.6],
  // Hors de l'image, le modele invente la position : la confiance tombe entre ces deux distances au bord
  // (en fraction de l'image).
  offFrame: [0.1, 0.45],
  // Longueur de la main du squelette. Les points index/auriculaire de la pose sont aux articulations des
  // doigts, pas au bout. Main mesuree : distance poignet -> articulations x knuckleReach (la patte couvre
  // alors la vraie main, quelle que soit sa taille a l'ecran), bornee a [handMin, handMax] x la longueur de
  // repos. Main non mesuree : longueur de repos x handReach.
  handReach: 1.45,
  knuckleReach: 1.85,
  handMin: 0.7,
  handMax: 2.6,
  // Main suivie par le modele des mains (21 points) : longueur = poignet -> base du majeur x palmReach
  // (stable que les doigts soient tendus ou replies) ; handDepthGain dose la profondeur relative des points.
  palmReach: 1.35,
  handDepthGain: 1,
  // Profondeur d'une main suivie, deduite de sa taille a l'ecran : une paume (poignet -> base du majeur)
  // mesure environ palmRatio x l'ecart des articulations d'epaule ; plus elle parait grande, plus elle est
  // pres de la camera. Bien plus fiable que la profondeur du modele du corps. Bornee a
  // [handNear, handFar] x la distance de la tete (une main collee a la camera ferait exploser la perspective).
  palmRatio: 0.27,
  handNear: 0.45,
  handFar: 1.5,
  // Ecartement des epaules autour de leur milieu : la pose donne le centre des articulations, nettement a
  // l'interieur de la silhouette ; > 1 les ramene vers le bord du buste (racine visible des bras).
  // Mesure sur une personne de face : bord des epaules ~1,15 x l'ecart des articulations, buste ~1,38 x.
  // Ce sont des rapports anatomiques, independants de la distance a la camera.
  shoulderSpread: 1,
  restShoulder: 40,
  lengths: { torso: 45, neck: 14, upperArm: 28, forearm: 26, hand: 10 }
};

/**
 * Coude d'un bras dont on connait l'epaule et le poignet (cinematique inverse a deux segments) : sur le
 * cercle des positions possibles, celle qui pointe le plus vers `pole`. Bras trop court pour atteindre
 * le poignet : coude sur la ligne epaule-poignet, au prorata des longueurs.
 */
function bendElbow(shoulder, wrist, upper, lower, pole) {
  const delta = sub(wrist, shoulder);
  const dist = length(delta);
  if (dist < 1e-6) return add(shoulder, mul(pole, upper));
  const dir = mul(delta, 1 / dist);
  if (dist >= upper + lower) return add(shoulder, mul(dir, (dist * upper) / (upper + lower)));
  const along = clamp((upper * upper - lower * lower + dist * dist) / (2 * dist), -upper, upper);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const side = normalize(sub(pole, mul(dir, dot(pole, dir))), [0, -1, 0]);
  return add(add(shoulder, mul(dir, along)), mul(side, height));
}

/**
 * Squelette (cm, repere camera) deduit des points de corps et de la profondeur de la tete.
 * Les membres hors champ ou peu visibles retombent sur une pose de repos le long du corps.
 *
 * @param {number[][]} body points valides (voir sanitizeBody)
 * @param {{ w: number, h: number }} view taille de l'image
 * @param {number} headDepth distance de la tete a la camera (cm), tiree de la pose du visage
 * @param {Partial<typeof DEFAULT_BODY_PARAMS>} [options]
 * @param {(number[][]|null)[]|null} [hands] mains suivies (voir sanitizeHands) : position, taille et rotation reelles de chaque main
 * @returns {{ scale: number, shoulderWidth: number, shoulderMid: number[], hipMid: number[], hipsKnown: boolean,
 *   arms: { outward: number[], shoulder: number[], elbow: number[], wrist: number[], tip: number[], hasElbow: boolean, hasWrist: boolean }[] }|null}
 *   null si les epaules ne sont pas visibles (pas de corps a dessiner)
 */
export function solveBody(body, view, headDepth, options = {}, hands = null) {
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

  const jointL = point(J.shoulderL);
  const jointR = point(J.shoulderR);
  const shoulderMid = mid(jointL, jointR);
  const jointWidth = Math.max(1, length(sub(jointL, jointR)));
  const shL = add(shoulderMid, mul(sub(jointL, shoulderMid), p.shoulderSpread));
  const shR = add(shoulderMid, mul(sub(jointR, shoulderMid), p.shoulderSpread));
  const shoulderWidth = Math.max(1, length(sub(shL, shR)));
  const scale = clamp(shoulderWidth / p.restShoulder, 0.25, 5);
  const down = [0, -1, 0];

  // Confiance (0..1) d'un point : visibilite, reduite quand il sort de l'image.
  const confidence = (i, [lo, hi]) => {
    const [x, y] = body[i];
    const outside = Math.max(0, -x, x - 1, -y, y - 1);
    return smoothstep(lo, hi, vis(i)) * (1 - smoothstep(p.offFrame[0], p.offFrame[1], outside));
  };

  // Hanches : melange progressif entre la position mesuree et une position estimee sous les epaules.
  const hipRest = add(shoulderMid, mul(down, p.lengths.torso * scale));
  let hipWeight = Math.min(confidence(J.hipL, p.hipVisibility), confidence(J.hipR, p.hipVisibility));
  let hipMid = hipRest;
  if (hipWeight > 0) {
    const measured = mid(point(J.hipL), point(J.hipR));
    // Des hanches au-dessus des epaules ou presque : detection aberrante.
    if (shoulderMid[1] - measured[1] < 0.5 * shoulderWidth) hipWeight = 0;
    else hipMid = mix(hipRest, measured, hipWeight);
  }
  const hipsKnown = hipWeight > 0.5;

  const arms = [[J.shoulderL, J.elbowL, J.wristL, J.pinkyL, J.indexL, shL], [J.shoulderR, J.elbowR, J.wristR, J.pinkyR, J.indexR, shR]].map(
    ([, elbowIndex, wristIndex, pinkyIndex, indexIndex, shoulder], side) => {
      const outward = [Math.sign(shoulder[0] - shoulderMid[0]) || 1, 0, 0];
      const upper = p.lengths.upperArm * scale;
      const lower = p.lengths.forearm * scale;
      const handBase = p.lengths.hand * scale;
      // Chaque articulation glisse entre une position deduite et sa position mesuree, selon la confiance.
      // Le poignet est juge seul : main levee dans l'image avec le coude hors champ, c'est le cas courant
      // devant une webcam. Le coude manquant est alors deduit de l'epaule et du poignet (bras plie vers
      // le bas et l'exterieur) ; sans poignet non plus, le bras pend le long du corps.
      const elbowWeight = confidence(elbowIndex, p.elbowVisibility);
      const wristWeight = confidence(wristIndex, p.limbVisibility);
      const handWeight = wristWeight * Math.min(confidence(pinkyIndex, p.limbVisibility), confidence(indexIndex, p.limbVisibility));
      const hanging = add(shoulder, mul(down, upper));
      const wristMeasured = wristWeight > 0 ? point(wristIndex) : null;
      const deduced = wristMeasured
        ? mix(hanging, bendElbow(shoulder, wristMeasured, upper, lower, normalize(add(down, mul(outward, 0.6)))), wristWeight)
        : hanging;
      const elbow = elbowWeight > 0 ? mix(deduced, point(elbowIndex), elbowWeight) : deduced;
      const forearmDir = normalize(sub(elbow, shoulder));
      let wrist = wristMeasured ? mix(add(elbow, mul(forearmDir, lower)), wristMeasured, wristWeight) : add(elbow, mul(forearmDir, lower));
      // Direction de la main : poignet -> milieu index/auriculaire, sinon dans le prolongement de l'avant-bras.
      const alongForearm = normalize(sub(wrist, elbow), forearmDir);
      let handDir = alongForearm;
      let hand = handBase * p.handReach;
      if (handWeight > 0) {
        handDir = normalize(mix(alongForearm, normalize(sub(mid(point(pinkyIndex), point(indexIndex)), wristMeasured), alongForearm), handWeight), alongForearm);
        // Taille mesuree dans le plan du poignet (la profondeur de chaque point est trop bruitee pour une longueur).
        const depth = -wristMeasured[2];
        const flat = (i) => unproject(body[i][0], body[i][1], view.w, view.h, depth, p.fov);
        const knuckles = length(sub(mid(flat(pinkyIndex), flat(indexIndex)), wristMeasured));
        const measured = clamp(knuckles * p.knuckleReach, handBase * p.handMin, handBase * p.handMax);
        hand += (measured - hand) * handWeight;
      }
      // Main suivie point par point : poignet, direction, taille et rotation viennent de la vraie main.
      // `thumb` = direction du cote du pouce (auriculaire -> index), perpendiculaire aux doigts : avec la
      // direction des doigts, elle fixe la rotation de la main (paume ou dos vers la camera).
      let thumb = null;
      let handAhead = null;
      const lm = hands?.[side];
      if (lm) {
        const wide = 2 * Math.tan((p.fov * Math.PI) / 360) * (view.w / view.h); // largeur de l'image (cm) a 1 cm de la camera
        const [w0, w9] = [lm[HAND_JOINT.wrist], lm[HAND_JOINT.middleBase]];
        // Longueur de la paume en fraction de la largeur de l'image, profondeur relative comprise (main inclinee).
        const palm = Math.hypot(w9[0] - w0[0], ((w9[1] - w0[1]) * view.h) / view.w, w9[2] - w0[2]);
        let depth = wristMeasured ? -wristMeasured[2] : headDepth;
        if (palm > 1e-4) {
          depth = Math.max(10, clamp((p.palmRatio * jointWidth) / (palm * wide), headDepth * p.handNear, headDepth * p.handFar));
        }
        // z d'un point de main : fraction de la largeur de l'image ; largeur de l'image a cette profondeur (cm).
        handAhead = headDepth - depth;
        const span = wide * depth;
        const at = (i) => unproject(lm[i][0], lm[i][1], view.w, view.h, Math.max(10, depth + lm[i][2] * span * p.handDepthGain), p.fov);
        const base = at(HAND_JOINT.wrist);
        const middle = at(HAND_JOINT.middleBase);
        const fingers = normalize(sub(middle, base), handDir);
        const across = sub(at(HAND_JOINT.indexBase), at(HAND_JOINT.pinkyBase));
        thumb = normalize(sub(across, mul(fingers, dot(across, fingers))), outward);
        wrist = base;
        handDir = fingers;
        hand = clamp(length(sub(middle, base)) * p.palmReach, handBase * p.handMin, handBase * p.handMax);
      }
      return {
        outward, shoulder, elbow, wrist, tip: add(wrist, mul(handDir, hand)), hasElbow: elbowWeight > 0.5, hasWrist: wristWeight > 0.5 || Boolean(lm),
        // `mirrored` : main gauche de la personne (le maillage, modele sur une main droite, est retourne).
        thumb, mirrored: side === 0,
        // Avance de la main suivie sur le plan du visage (cm, > 0 = devant la tete, < 0 = derriere) ; null sans main suivie.
        handAhead
      };
    }
  );
  return { scale, shoulderWidth, shoulderMid, hipMid, hipsKnown, arms };
}

/**
 * Lisse un squelette vers le suivant (moyenne exponentielle, `k` entre 0 et 1). Sans squelette
 * precedent, ou si les membres changent de mode (visible / hors champ), il est repris tel quel.
 */
const SCALE_SLOWDOWN = 0.15;
// Cote du maillage de la main ou se trouve la paume : 1 = +Z, -1 = -Z (depend du modele 3D).
const PALM_SIGN = 1;
export function blendSkeleton(prev, next, k) {
  if (!prev || !next) return next;
  const blend = (a, b) => mix(a, b, k);
  return {
    ...next,
    // La carrure d'une personne ne change pas d'une image a l'autre : echelle lissee bien plus fort (sinon le corps "respire").
    scale: prev.scale + (next.scale - prev.scale) * k * SCALE_SLOWDOWN,
    shoulderWidth: prev.shoulderWidth + (next.shoulderWidth - prev.shoulderWidth) * k * SCALE_SLOWDOWN,
    shoulderMid: blend(prev.shoulderMid, next.shoulderMid),
    hipMid: blend(prev.hipMid, next.hipMid),
    arms: next.arms.map((arm, i) => {
      const old = prev.arms[i];
      return {
        ...arm,
        shoulder: blend(old.shoulder, arm.shoulder),
        elbow: blend(old.elbow, arm.elbow),
        wrist: blend(old.wrist, arm.wrist),
        tip: blend(old.tip, arm.tip),
        thumb: arm.thumb && old.thumb ? normalize(blend(old.thumb, arm.thumb), arm.thumb) : arm.thumb
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
 * Repere d'un segment de bras, sans retournement : la pose de repos (bras le long du corps, +Y vers le bas,
 * +X vers `outward`) est amenee sur la direction du segment par la plus petite rotation possible. Le bras
 * ne tourne donc pas sur lui-meme quand il passe a l'horizontale (un indice fixe y devient colineaire au
 * segment et ferait basculer le repere d'un quart de tour). Bras pointe droit vers le haut : demi-tour
 * dans le plan de l'image (bras leve par le cote).
 * @returns {{ position: number[], x: number[], y: number[], z: number[], length: number }}
 */
export function limbFrame(from, to, outward) {
  const down = [0, -1, 0];
  const dir = normalize(sub(to, from));
  const axis = cross(down, dir);
  const sin = length(axis);
  const cos = dot(down, dir);
  let x;
  if (sin < 1e-4) {
    x = cos > 0 ? [...outward] : mul(outward, -1);
  } else {
    const k = mul(axis, 1 / sin);
    // Rotation de Rodrigues de `outward` autour de k.
    x = add(add(mul(outward, cos), mul(cross(k, outward), sin)), mul(k, dot(k, outward) * (1 - cos)));
  }
  return segmentFrame(from, to, x, x);
}

/**
 * Repere d'une main suivie (voir `thumb` dans solveBody) : +Y vers les doigts, +X vers le pouce, +Z sortant
 * de la paume. Le maillage est modele sur une main droite ; pour une main gauche le repere est construit
 * avec le pouce a l'oppose et `mirror` vaut -1 (echelle X a appliquer au maillage), ce qui remet le pouce
 * du bon cote sans retourner la paume.
 * @returns {{ position: number[], x: number[], y: number[], z: number[], length: number, mirror: number }}
 */
export function handFrame(arm) {
  const mirror = arm.mirrored ? -1 : 1;
  const hint = mul(arm.thumb, mirror * PALM_SIGN);
  return { ...segmentFrame(arm.wrist, arm.tip, hint, hint), mirror: mirror * PALM_SIGN };
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
