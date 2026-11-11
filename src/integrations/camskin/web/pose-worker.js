// Suivi du corps dans un fil separe (Web Worker classique) : l'inference de pose (~10 ms) ne bloque
// plus le suivi du visage ni le rendu. Le fil principal envoie une image reduite (ImageBitmap,
// transferee sans copie) ; ce worker repond avec les points utiles. Une seule image a la fois :
// le fil principal attend la reponse avant d'en envoyer une autre (pas de file d'attente, pas de retard).
/* global importScripts */
self.exports = {};
importScripts('/vendor/vision_bundle.cjs');
const { PoseLandmarker, HandLandmarker, FilesetResolver } = self.exports;

let landmarker = null;
let handLandmarker = null;
let indices = [];
let wrists = [];

// Modele "heavy" (le plus precis) sur GPU : ~10 ms par image ; sur CPU il passe a ~80 ms, on y prefere "full".
async function create() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/wasm');
  const make = (model, delegate) => PoseLandmarker.createFromOptions(fileset, {
    runningMode: 'VIDEO', numPoses: 1, baseOptions: { modelAssetPath: `/models/pose_landmarker_${model}.task`, delegate }
  });
  try {
    return { landmarker: await make('heavy', 'GPU'), model: 'heavy GPU' };
  } catch {
    return { landmarker: await make('full', 'CPU'), model: 'full CPU' };
  }
}

// Mains : 21 points par main (doigts, pouce). Facultatif : sans lui le corps est suivi quand meme.
async function createHands() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/wasm');
  const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
    runningMode: 'VIDEO', numHands: 2, baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate }
  });
  try {
    return await make('GPU');
  } catch {
    return make('CPU');
  }
}

// Mains de l'image : [[x, y, z] x 21, ...]. Lance seulement si un poignet est a peu pres visible (economie).
function detectHands(bitmap, points, timestamp) {
  if (!handLandmarker || !points || !wrists.some((i) => points[i][3] > 0.2)) return null;
  try {
    const res = handLandmarker.detectForVideo(bitmap, timestamp);
    return (res.landmarks ?? []).map((hand) => hand.map((q) => [q.x, q.y, q.z]));
  } catch {
    return null;
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      indices = data.landmarks;
      wrists = data.wrists ?? [];
      const created = await create();
      landmarker = created.landmarker;
      self.postMessage({ type: 'ready', model: created.model });
      createHands().then((created2) => { handLandmarker = created2; }).catch(() => {});
    } else if (data.type === 'frame') {
      const started = performance.now();
      const res = landmarker.detectForVideo(data.bitmap, started);
      const lms = res.landmarks?.[0];
      const world = res.worldLandmarks?.[0];
      const points = lms && world ? indices.map((i) => [lms[i].x, lms[i].y, world[i].z, lms[i].visibility ?? 0]) : null;
      const hands = detectHands(data.bitmap, points, started);
      data.bitmap.close();
      self.postMessage({ type: 'pose', t: data.t, ms: performance.now() - started, points, hands });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
