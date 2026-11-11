// Suivi du corps dans un fil separe (Web Worker classique) : l'inference de pose (~10 ms) ne bloque
// plus le suivi du visage ni le rendu. Le fil principal envoie une image reduite (ImageBitmap,
// transferee sans copie) ; ce worker repond avec les points utiles. Une seule image a la fois :
// le fil principal attend la reponse avant d'en envoyer une autre (pas de file d'attente, pas de retard).
/* global importScripts */
self.exports = {};
importScripts('/vendor/vision_bundle.cjs');
const { PoseLandmarker, FilesetResolver } = self.exports;

let landmarker = null;
let indices = [];

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

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      indices = data.landmarks;
      const created = await create();
      landmarker = created.landmarker;
      self.postMessage({ type: 'ready', model: created.model });
    } else if (data.type === 'frame') {
      const started = performance.now();
      const res = landmarker.detectForVideo(data.bitmap, started);
      data.bitmap.close();
      const lms = res.landmarks?.[0];
      const world = res.worldLandmarks?.[0];
      const points = lms && world ? indices.map((i) => [lms[i].x, lms[i].y, world[i].z, lms[i].visibility ?? 0]) : null;
      self.postMessage({ type: 'pose', t: data.t, ms: performance.now() - started, points });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
