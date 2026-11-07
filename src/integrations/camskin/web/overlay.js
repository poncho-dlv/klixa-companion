// Overlay OBS : dessine le skin sur fond TRANSPARENT a partir des donnees de visage envoyees
// par le suivi (fenetre du compagnon). Cette page n'ouvre jamais la camera : une Source
// navigateur OBS n'a pas de fenetre pour demander la permission. On la superpose a la
// source camera d'OBS (dont la qualite native est donc conservee).
import { SKINS } from './skins.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
if (params.get('mirror') === '1') canvas.classList.add('mirror');

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
  if (state.skin && face && performance.now() - state.faceAt < STALE_MS) {
    SKINS[state.skin].draw(ctx, face);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
