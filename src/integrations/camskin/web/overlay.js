// Overlay OBS : dessine le skin sur fond TRANSPARENT a partir des donnees de visage envoyees
// par le suivi (fenetre du compagnon). Cette page n'ouvre jamais la camera : une Source
// navigateur OBS n'a pas de fenetre pour demander la permission. On la superpose a la
// source camera d'OBS (dont la qualite native est donc conservee).
import { SKINS, is3D } from './skins.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const canvas3d = document.getElementById('stage3d');
if (params.get('mirror') === '1') {
  canvas.classList.add('mirror');
  canvas3d.classList.add('mirror');
}

// Rendu 3D charge a la demande : three.js n'est telecharge que si un skin 3D est utilise.
let renderer3d = null;
let renderer3dLoading = false;
function ensureRenderer3d() {
  if (renderer3d || renderer3dLoading) return renderer3d;
  renderer3dLoading = true;
  import('./skin3d.js')
    .then((module) => { renderer3d = module.createSkin3DRenderer({ canvas: canvas3d }); })
    .catch((error) => { console.error('Rendu 3D indisponible', error); });
  return null;
}

// Sans nouvelles du suivi depuis ce delai, le skin disparait plutot que de rester fige.
const STALE_MS = 400;
const state = { skin: null, face: null, faceAt: 0 };

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws?role=overlay`);
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'state') {
        state.skin = Object.hasOwn(SKINS, message.skin) ? message.skin : null;
        if (!state.skin) state.face = null;
      } else if (message.type === 'face') {
        state.face = message.face;
        state.faceAt = performance.now();
      }
    } catch { /* trame invalide ignoree */ }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();

function frame() {
  const face = state.face;
  if (face && (canvas.width !== face.w || canvas.height !== face.h)) {
    canvas.width = face.w;
    canvas.height = face.h;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const skin = state.skin && SKINS[state.skin];
  const live = Boolean(skin && face && performance.now() - state.faceAt < STALE_MS);
  let drawn3d = false;
  if (live && is3D(skin)) {
    const renderer = ensureRenderer3d();
    drawn3d = Boolean(renderer?.render(face, state.skin, skin.model));
  } else if (live) {
    skin.draw(ctx, face);
  }
  if (!drawn3d) renderer3d?.clear();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
