// Moteur de suivi du visage : independant de toute sortie (apercu, overlay OBS, et plus tard
// camera virtuelle). Il transforme une image video en un "visage" normalise (position,
// taille, inclinaison, ouverture de la bouche...) que les skins savent dessiner.
import { FaceLandmarker, PoseLandmarker, FilesetResolver } from '/vendor/vision_bundle.mjs';
import { BODY_LANDMARKS, BODY_JOINT, createBodyFilter } from './body-rig.js';

// Index des landmarks MediaPipe utilises (maillage de 478 points).
const L = { eyeA: 33, eyeB: 263, nose: 1, mouthTop: 13, mouthBottom: 14 };
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
  149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

const lerp = (a, b, k) => a + (b - a) * k;
const round = (n) => Math.round(n * 10) / 10;
const round4 = (n) => Math.round(n * 10000) / 10000;

// Blendshapes sous ce seuil omis de la trame (l'overlay les traite comme 0) : allege le flux.
const BLEND_MIN = 0.01;

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/wasm');
  const base = { modelAssetPath: '/models/face_landmarker.task' };
  const options = { runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true };
  try {
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, { ...options, baseOptions: { ...base, delegate: 'GPU' } }), delegate: 'GPU' };
  } catch (error) {
    console.warn('GPU indisponible, repli CPU', error?.message);
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, { ...options, baseOptions: { ...base, delegate: 'CPU' } }), delegate: 'CPU' };
  }
}

// Repli quand le worker de pose est indisponible : pose dans le fil principal. Modele "heavy" (le plus
// precis) sur GPU : ~10 ms par image ; sur CPU il passe a ~80 ms, on y prefere "full" (~24 ms).
async function createPoseLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/wasm');
  const options = { runningMode: 'VIDEO', numPoses: 1 };
  const make = (model, delegate) => PoseLandmarker.createFromOptions(fileset, { ...options, baseOptions: { modelAssetPath: `/models/pose_landmarker_${model}.task`, delegate } });
  try {
    return await make('heavy', 'GPU');
  } catch (error) {
    console.warn('Pose : GPU indisponible, repli CPU (modele full)', error?.message);
    return make('full', 'CPU');
  }
}

// Largeur de l'image envoyee au worker de pose : le modele travaille en 256x256 sur la zone du corps,
// une image plus grande ne lui apporte rien et coute a copier.
const POSE_WIDTH = 640;
// Prediction du corps : retard maximal compense (s) et part de ce retard rattrapee (1 = tout, moins = plus prudent
// a l'arret d'un geste).
const MAX_LEAD = 0.08;
// Une main detectee est rattachee au poignet du corps le plus proche, a moins de cette distance (fraction de l'image).
const HAND_MATCH = 0.15;
const LEAD_GAIN = 0.85;
// Repli (pose dans le fil principal) : marge par image pour le rendu 3D et l'envoi de la trame.
const RENDER_MS = 4;
const clampInt = (n, min, max) => Math.min(max, Math.max(min, n));
// Lissage du repere 2D du visage : constante de temps (s), independante du nombre d'images par seconde.
const FACE_TAU = 0.042;
const JAW_TAU = 0.048;

/**
 * @returns {Promise<{ delegate: string, detect: (video: HTMLVideoElement, landmarks?: boolean, body?: boolean) => { face: object|null, landmarks: object[]|null }, reset: () => void }>}
 */
export async function createFaceEngine() {
  const { landmarker, delegate } = await createLandmarker();
  let smooth = null;
  // Suivi du corps : charge a la premiere demande (inutile pour un skin sans corps). Il tourne dans un
  // worker (fil separe) ; si le worker echoue, repli dans le fil principal a cadence reduite.
  let poseMode = 'idle'; // idle | loading | worker | inline | failed
  let poseWorker = null;
  let poseBusy = false;
  let poseLandmarker = null;
  let lastBody = null;
  let bodyAt = 0; // horloge video (s) de la derniere mesure de pose
  let poseFrame = 0;
  let poseRate = 0; // mesures de pose par seconde (moyenne mobile)
  let lastPoseAt = 0;
  const perf = { frame: 33, face: 7, pose: 10 }; // ms, moyennes mobiles
  const track = (key, value) => { perf[key] += (value - perf[key]) * 0.1; };
  let lastMediaTime = -1;
  // Derniere trame de visage valide : sert de base quand le visage sort du champ mais que le corps reste visible.
  let lastFace = null;
  const bodyFilter = createBodyFilter();
  // Mains : [gauche, droite] de la personne, 21 points filtres chacune (profondeur relative moins bruitee que celle du corps).
  const handFilters = [0, 1].map(() => createBodyFilter({ zMinCutoff: 1, zBeta: 8 }));
  let lastHands = null;

  function fallbackInline(reason) {
    console.warn('Pose : worker indisponible, repli dans le fil principal', reason);
    poseWorker?.terminate();
    poseWorker = null;
    poseBusy = false;
    poseMode = 'loading';
    createPoseLandmarker()
      .then((created) => { poseLandmarker = created; poseMode = 'inline'; })
      .catch((error) => { poseMode = 'failed'; console.error('Suivi du corps indisponible', error); });
  }

  // Points utiles du corps : [x, y, z monde (m), visibilite], dans l'ordre de BODY_LANDMARKS, filtres
  // (One Euro) a l'horloge de la video : l'intervalle reel entre deux images, sans la gigue du traitement.
  function applyBody(points, mediaTime, hands = null) {
    const now = performance.now();
    if (lastPoseAt) poseRate += (1000 / Math.max(1, now - lastPoseAt) - poseRate) * 0.1;
    lastPoseAt = now;
    if (!points) {
      lastBody = null;
      lastHands = null;
      bodyFilter.reset();
      handFilters.forEach((f) => f.reset());
      return;
    }
    bodyFilter.filter(points, mediaTime);
    matchHands(points, hands, mediaTime);
    bodyAt = mediaTime;
    lastBody = bodyNow(mediaTime);
  }

  // Rattache chaque main detectee au bras dont le poignet est le plus proche, puis filtre ses points.
  function matchHands(points, hands, mediaTime) {
    const slots = [null, null];
    for (const hand of hands ?? []) {
      let best = -1;
      let bestDistance = HAND_MATCH;
      [BODY_JOINT.wristL, BODY_JOINT.wristR].forEach((joint, slot) => {
        const distance = Math.hypot(points[joint][0] - hand[0][0], points[joint][1] - hand[0][1]);
        if (!slots[slot] && distance < bestDistance) {
          bestDistance = distance;
          best = slot;
        }
      });
      if (best >= 0) slots[best] = hand;
    }
    slots.forEach((hand, slot) => {
      if (hand) handFilters[slot].filter(hand.map(([x, y, z]) => [x, y, z, 1]), mediaTime);
      else handFilters[slot].reset();
    });
  }

  // Corps a l'instant de l'image courante : la derniere mesure, extrapolee de son retard (borne).
  function bodyNow(mediaTime) {
    const lead = Math.min(MAX_LEAD, Math.max(0, mediaTime - bodyAt)) * LEAD_GAIN;
    const hands = handFilters.map((f) => f.predict(lead)?.map(([x, y, z]) => [round4(x), round4(y), round4(z)]) ?? null);
    lastHands = hands.some(Boolean) ? hands : null;
    const points = bodyFilter.predict(lead);
    return points ? points.map(([x, y, z, v]) => [round4(x), round4(y), round4(z), Math.round(v * 100) / 100]) : null;
  }

  function ensurePose() {
    if (poseMode !== 'idle') return;
    poseMode = 'loading';
    try {
      poseWorker = new Worker('/pose-worker.js');
      poseWorker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          poseMode = 'worker';
        } else if (data.type === 'pose') {
          poseBusy = false;
          track('pose', data.ms);
          applyBody(data.points, data.t, data.hands);
        } else if (data.type === 'error') {
          fallbackInline(data.message);
        }
      };
      poseWorker.onerror = (event) => fallbackInline(event.message);
      poseWorker.postMessage({ type: 'init', landmarks: BODY_LANDMARKS, wrists: [BODY_JOINT.wristL, BODY_JOINT.wristR] });
    } catch (error) {
      fallbackInline(error?.message);
    }
  }

  function detectInline(video) {
    const started = performance.now();
    const res = poseLandmarker.detectForVideo(video, started);
    track('pose', performance.now() - started);
    const lms = res.landmarks?.[0];
    const world = res.worldLandmarks?.[0];
    return lms && world ? BODY_LANDMARKS.map((i) => [lms[i].x, lms[i].y, world[i].z, lms[i].visibility ?? 0]) : null;
  }

  // Lance une mesure de pose si c'est possible ; le resultat met `lastBody` a jour (plus tard si worker).
  function pumpPose(video) {
    ensurePose();
    if (poseMode === 'worker') {
      if (poseBusy) return;
      poseBusy = true;
      const t = video.currentTime;
      const scale = Math.min(1, POSE_WIDTH / video.videoWidth);
      createImageBitmap(video, {
        resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale), resizeQuality: 'low'
      })
        .then((bitmap) => {
          if (poseWorker) poseWorker.postMessage({ type: 'frame', bitmap, t }, [bitmap]);
          else bitmap.close();
        })
        .catch(() => { poseBusy = false; });
    } else if (poseMode === 'inline') {
      // Fil principal : la pose n'est ajoutee que si visage + pose tiennent entre deux images.
      const every = clampInt(Math.ceil((perf.face + perf.pose + RENDER_MS) / Math.max(8, perf.frame)), 1, 4);
      if (poseFrame++ % every === 0) applyBody(detectInline(video), video.currentTime);
    }
  }

  // Repere visage derive des landmarks, lisse par moyenne exponentielle. Coordonnees en
  // pixels de l'image video (w x h) : la sortie met a l'echelle selon sa propre taille.
  function buildFace(lms, blend, w, h, matrix) {
    const px = (i) => ({ x: lms[i].x * w, y: lms[i].y * h });
    const a = px(L.eyeA);
    const b = px(L.eyeB);
    const top = px(L.mouthTop);
    const bottom = px(L.mouthBottom);
    const raw = {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      u: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      jaw: blend.jawOpen ?? 0,
      nose: px(L.nose),
      mouth: { x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 },
      look: { x: (blend.eyeLookOutRight ?? 0) - (blend.eyeLookInRight ?? 0), y: (blend.eyeLookDownRight ?? 0) - (blend.eyeLookUpRight ?? 0) }
    };
    const prev = smooth;
    const k = 1 - Math.exp(-perf.frame / 1000 / FACE_TAU);
    const kJaw = 1 - Math.exp(-perf.frame / 1000 / JAW_TAU);
    const face = prev
      ? {
          cx: lerp(prev.cx, raw.cx, k),
          cy: lerp(prev.cy, raw.cy, k),
          u: lerp(prev.u, raw.u, k),
          angle: prev.angle + Math.atan2(Math.sin(raw.angle - prev.angle), Math.cos(raw.angle - prev.angle)) * k,
          jaw: lerp(prev.jaw, raw.jaw, kJaw),
          nose: { x: lerp(prev.nose.x, raw.nose.x, k), y: lerp(prev.nose.y, raw.nose.y, k) },
          mouth: { x: lerp(prev.mouth.x, raw.mouth.x, k), y: lerp(prev.mouth.y, raw.mouth.y, k) },
          look: raw.look
        }
      : raw;
    smooth = { ...face };
    const out = {
      w: w,
      h: h,
      cx: round(face.cx),
      cy: round(face.cy),
      u: round(face.u),
      angle: Math.round(face.angle * 1000) / 1000,
      jaw: Math.round(face.jaw * 100) / 100,
      nose: { x: round(face.nose.x), y: round(face.nose.y) },
      mouth: { x: round(face.mouth.x), y: round(face.mouth.y) },
      look: { x: Math.round(face.look.x * 100) / 100, y: Math.round(face.look.y * 100) / 100 },
      oval: OVAL.map((i) => ({ x: round(lms[i].x * w), y: round(lms[i].y * h) }))
    };
    // Pose 3D (matrice 4x4 colonne-major, repere "visage canonique" en cm) et blendshapes : pour
    // les skins 3D. Le lissage est fait par le rendu 3D, a la cadence d'affichage.
    if (matrix) out.pose = Array.from(matrix, round4);
    // Ecart reel des levres (points interieurs 13/14) rapporte a l'ecart des yeux : mesure plus fine
    // des petites ouvertures que le blendshape jawOpen.
    out.lip = Math.round((Math.hypot(top.x - bottom.x, top.y - bottom.y) / Math.max(1, raw.u)) * 1000) / 1000;
    out.blend = Object.fromEntries(
      Object.entries(blend).filter(([name, score]) => name !== '_neutral' && score >= BLEND_MIN).map(([name, score]) => [name, Math.round(score * 1000) / 1000])
    );
    return out;
  }

  // Met a jour `lastBody` / `lastHands` pour l'image courante (ou les oublie si le corps n'est pas demande).
  function refreshBody(video, withBody) {
    if (withBody) {
      pumpPose(video);
      if (lastBody) lastBody = bodyNow(video.currentTime);
      return;
    }
    lastBody = null;
    lastHands = null;
    bodyFilter.reset();
    handFilters.forEach((f) => f.reset());
  }

  // Ajoute le corps et les mains a une trame de visage.
  function withBodyData(face) {
    if (lastBody) {
      face.body = lastBody;
      if (lastHands) face.hands = lastHands;
    }
    return face;
  }

  return {
    delegate,
    /** Etat du suivi du corps pour le diagnostic : mode (worker, inline...) et duree moyenne d'une mesure (ms). */
    poseInfo() {
      return { mode: poseMode, ms: perf.pose, rate: poseRate };
    },
    reset() {
      smooth = null;
      lastFace = null;
      lastBody = null;
      lastHands = null;
      bodyFilter.reset();
      handFilters.forEach((f) => f.reset());
    },
    detect(video, withLandmarks = false, withBody = false) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (lastMediaTime >= 0 && video.currentTime > lastMediaTime) track('frame', (video.currentTime - lastMediaTime) * 1000);
      lastMediaTime = video.currentTime;
      const faceStart = performance.now();
      const res = landmarker.detectForVideo(video, faceStart);
      track('face', performance.now() - faceStart);
      const lms = res.faceLandmarks?.[0];
      refreshBody(video, withBody);
      const debug = withLandmarks ? { body: lastBody, hands: lastBody ? lastHands : null } : { body: null, hands: null };
      if (!lms) {
        smooth = null;
        // Visage perdu (hors champ, tete baissee...) : si le corps est encore la, on garde le skin
        // en place (tete figee, expressions neutres) au lieu de tout faire disparaitre.
        if (lastFace && lastBody) {
          const { pose: _pose, ...rest } = lastFace;
          return { face: withBodyData({ ...rest, blend: {}, lip: 0, lost: true }), landmarks: null, ...debug };
        }
        lastFace = null;
        return { face: null, landmarks: null };
      }
      const blend = Object.fromEntries((res.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]));
      const face = buildFace(lms, blend, w, h, res.facialTransformationMatrixes?.[0]?.data);
      lastFace = face;
      return { face: withBodyData({ ...face }), landmarks: withLandmarks ? lms : null, ...debug };
    }
  };
}
