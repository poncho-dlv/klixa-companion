// Moteur de suivi du visage : independant de toute sortie (apercu, overlay OBS, et plus tard
// camera virtuelle). Il transforme une image video en un "visage" normalise (position,
// taille, inclinaison, ouverture de la bouche...) que les skins savent dessiner.
import { FaceLandmarker, FilesetResolver } from '/vendor/vision_bundle.mjs';

// Index des landmarks MediaPipe utilises (maillage de 478 points).
const L = { eyeA: 33, eyeB: 263, nose: 1, mouthTop: 13, mouthBottom: 14 };
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
  149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

const SMOOTH = 0.55;
const lerp = (a, b, k) => a + (b - a) * k;
const round = (n) => Math.round(n * 10) / 10;

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/wasm');
  const base = { modelAssetPath: '/models/face_landmarker.task' };
  const options = { runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true };
  try {
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, { ...options, baseOptions: { ...base, delegate: 'GPU' } }), delegate: 'GPU' };
  } catch (error) {
    console.warn('GPU indisponible, repli CPU', error?.message);
    return { landmarker: await FaceLandmarker.createFromOptions(fileset, { ...options, baseOptions: { ...base, delegate: 'CPU' } }), delegate: 'CPU' };
  }
}

/**
 * @returns {Promise<{ delegate: string, detect: (video: HTMLVideoElement, landmarks?: boolean) => { face: object|null, landmarks: object[]|null }, reset: () => void }>}
 */
export async function createFaceEngine() {
  const { landmarker, delegate } = await createLandmarker();
  let smooth = null;

  // Repere visage derive des landmarks, lisse par moyenne exponentielle. Coordonnees en
  // pixels de l'image video (w x h) : la sortie met a l'echelle selon sa propre taille.
  function buildFace(lms, blend, w, h) {
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
    return {
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
  }

  return {
    delegate,
    reset() {
      smooth = null;
    },
    detect(video, withLandmarks = false) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const res = landmarker.detectForVideo(video, performance.now());
      const lms = res.faceLandmarks?.[0];
      if (!lms) {
        smooth = null;
        return { face: null, landmarks: null };
      }
      const blend = Object.fromEntries((res.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]));
      return { face: buildFace(lms, blend, w, h), landmarks: withLandmarks ? lms : null };
    }
  };
}
