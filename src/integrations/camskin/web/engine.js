// Moteur de suivi du visage : independant de toute sortie (apercu, overlay OBS, et plus tard
// camera virtuelle). Il transforme une image video en un "visage" normalise (position,
// taille, inclinaison, ouverture de la bouche...) que les skins savent dessiner.
import { FaceLandmarker, PoseLandmarker, FilesetResolver } from '/vendor/vision_bundle.mjs';
import { BODY_LANDMARKS, createBodyFilter } from './body-rig.js';

// Index des landmarks MediaPipe utilises (maillage de 478 points).
const L = { eyeA: 33, eyeB: 263, nose: 1, mouthTop: 13, mouthBottom: 14 };
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
  149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

const SMOOTH = 0.55;
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

// Modele "heavy" (le plus precis) sur GPU : ~10 ms par image ; sur CPU il passe a ~80 ms, on y prefere
// "full" (~24 ms). Mesures sur webcam 1280x720.
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

// Le corps bouge moins vite que le visage et le suivi du corps coute cher : une image sur deux.
const POSE_EVERY = 2;

/**
 * @returns {Promise<{ delegate: string, detect: (video: HTMLVideoElement, landmarks?: boolean, body?: boolean) => { face: object|null, landmarks: object[]|null }, reset: () => void }>}
 */
export async function createFaceEngine() {
  const { landmarker, delegate } = await createLandmarker();
  let smooth = null;
  // Suivi du corps : charge a la premiere demande (inutile pour un skin sans corps).
  let poseLandmarker = null;
  let poseLoading = false;
  let lastBody = null;
  let poseFrame = 0;
  // Derniere trame de visage valide : sert de base quand le visage sort du champ mais que le corps reste visible.
  let lastFace = null;
  const bodyFilter = createBodyFilter();

  function ensurePose() {
    if (poseLandmarker || poseLoading) return;
    poseLoading = true;
    createPoseLandmarker()
      .then((landmarker) => { poseLandmarker = landmarker; })
      .catch((error) => { console.error('Suivi du corps indisponible', error); });
  }

  // Points utiles du corps : [x, y, z monde (m), visibilite], dans l'ordre de BODY_LANDMARKS.
  function detectBody(video) {
    const res = poseLandmarker.detectForVideo(video, performance.now());
    const lms = res.landmarks?.[0];
    const world = res.worldLandmarks?.[0];
    if (!lms || !world) return null;
    const raw = BODY_LANDMARKS.map((i) => [lms[i].x, lms[i].y, world[i].z, lms[i].visibility ?? 0]);
    return bodyFilter.filter(raw, performance.now() / 1000).map(([x, y, z, v]) => [round4(x), round4(y), round4(z), Math.round(v * 100) / 100]);
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
    const face = prev
      ? {
          cx: lerp(prev.cx, raw.cx, SMOOTH),
          cy: lerp(prev.cy, raw.cy, SMOOTH),
          u: lerp(prev.u, raw.u, SMOOTH),
          angle: prev.angle + Math.atan2(Math.sin(raw.angle - prev.angle), Math.cos(raw.angle - prev.angle)) * SMOOTH,
          jaw: lerp(prev.jaw, raw.jaw, 0.5),
          nose: { x: lerp(prev.nose.x, raw.nose.x, SMOOTH), y: lerp(prev.nose.y, raw.nose.y, SMOOTH) },
          mouth: { x: lerp(prev.mouth.x, raw.mouth.x, SMOOTH), y: lerp(prev.mouth.y, raw.mouth.y, SMOOTH) },
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

  return {
    delegate,
    reset() {
      smooth = null;
      lastFace = null;
      lastBody = null;
      bodyFilter.reset();
    },
    detect(video, withLandmarks = false, withBody = false) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const res = landmarker.detectForVideo(video, performance.now());
      const lms = res.faceLandmarks?.[0];
      if (!lms) {
        smooth = null;
        // Visage perdu (hors champ, tete baissee...) : si le corps est encore la, on garde le skin
        // en place (tete figee, expressions neutres) au lieu de tout faire disparaitre.
        if (withBody && lastFace) {
          ensurePose();
          if (poseLandmarker && poseFrame++ % POSE_EVERY === 0) lastBody = detectBody(video);
          if (lastBody) {
            const { pose: _pose, ...rest } = lastFace;
            const face = { ...rest, blend: {}, lip: 0, lost: true, body: lastBody };
            return { face, landmarks: null, body: withLandmarks ? lastBody : null };
          }
        }
        lastFace = null;
        return { face: null, landmarks: null };
      }
      const blend = Object.fromEntries((res.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]));
      const face = buildFace(lms, blend, w, h, res.facialTransformationMatrixes?.[0]?.data);
      if (withBody) {
        ensurePose();
        if (poseLandmarker && poseFrame++ % POSE_EVERY === 0) lastBody = detectBody(video);
        if (lastBody) face.body = lastBody;
      } else {
        lastBody = null;
        bodyFilter.reset();
      }
      lastFace = { ...face, body: undefined };
      return { face, landmarks: withLandmarks ? lms : null, body: withLandmarks ? lastBody : null };
    }
  };
}
