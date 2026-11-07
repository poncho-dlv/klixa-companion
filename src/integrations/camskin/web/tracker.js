// Suivi du visage + apercu. Tourne dans une fenetre du compagnon (cachee ou visible) : c'est
// elle qui ouvre la camera (webcam, ou "OBS Virtual Camera" pour partager la vraie webcam
// avec OBS) et envoie les donnees de visage a l'overlay OBS via le serveur local.
import { createFaceEngine } from './engine.js';
import { SKINS } from './skins.js';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const CAMERA_KEY = 'camskin.camera';

const state = {
  override: '',
  serverSkin: null,
  overlays: 0,
  mirror: true,
  debug: false,
  error: ''
};

$('skin').add(new Option('Auto (Klixa)', ''));
for (const [id, skin] of Object.entries(SKINS)) $('skin').add(new Option(skin.label, id));
$('skin').onchange = (e) => { state.override = e.target.value; };
$('mirror').onchange = (e) => { state.mirror = e.target.checked; };
$('debug').onchange = (e) => { state.debug = e.target.checked; };

// --- Liaison avec le serveur local (etat du skin, envoi des visages) -------------------
let socket = null;
function connect() {
  socket = new WebSocket(`ws://${location.host}/ws?role=tracker`);
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type !== 'state') return;
      state.serverSkin = Object.hasOwn(SKINS, message.skin) ? message.skin : null;
      state.overlays = message.overlays ?? 0;
    } catch { /* trame invalide ignoree */ }
  };
  socket.onclose = () => setTimeout(connect, 1000);
}
connect();
const send = (face) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'face', face }));
};

// --- Camera -----------------------------------------------------------------------------
async function listCameras(selectedId) {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  $('device').replaceChildren(...devices.map((d) => new Option(d.label || d.deviceId.slice(0, 8), d.deviceId, false, d.deviceId === selectedId)));
  return devices;
}

async function openCamera(deviceId) {
  video.srcObject?.getTracks().forEach((t) => t.stop());
  // resizeMode 'none' : sans ca Chrome recadre/etire l'image vers le ratio demande (16:9) au lieu
  // de garder le format natif de la camera (4:3...), d'ou un ratio different de celui d'OBS.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, resizeMode: 'none' },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
  return stream.getVideoTracks()[0].getSettings().deviceId;
}

async function startCamera() {
  let currentId = await openCamera();
  const devices = await listCameras(currentId);
  // La camera choisie la derniere fois (retrouvee par son libelle : l'id change d'une session a l'autre).
  const saved = localStorage.getItem(CAMERA_KEY);
  const wanted = saved && devices.find((d) => d.label === saved);
  if (wanted && wanted.deviceId !== currentId) {
    currentId = await openCamera(wanted.deviceId);
    await listCameras(currentId);
  }
}

$('device').onchange = async (e) => {
  try {
    const id = await openCamera(e.target.value);
    const label = (await listCameras(id)).find((d) => d.deviceId === id)?.label;
    if (label) localStorage.setItem(CAMERA_KEY, label);
    state.error = '';
  } catch (error) {
    state.error = `${error.name} - ${error.message}`;
  }
};

// --- Boucle : suivi + apercu ------------------------------------------------------------
const stats = { frames: 0, lastLog: performance.now(), inferMs: [], text: '' };

function render(face, landmarks) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  if (state.mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  const skin = state.override || state.serverSkin;
  if (face && skin) SKINS[skin].draw(ctx, face);
  if (landmarks) {
    ctx.fillStyle = 'rgba(0,255,255,.8)';
    for (const p of landmarks) ctx.fillRect(p.x * w - 1, p.y * h - 1, 2, 2);
  }
  ctx.restore();
}

async function main() {
  await startCamera();
  const engine = await createFaceEngine();
  let lastVideoTime = -1;

  const loop = () => {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      stats.frames++;
      let result = { face: null, landmarks: null };
      // Sans skin a afficher, on ne lance pas l'inference (la fenetre reste une simple camera).
      if (state.override || state.serverSkin || state.debug) {
        const t = performance.now();
        result = engine.detect(video, state.debug);
        stats.inferMs.push(performance.now() - t);
        if (state.serverSkin) send(result.face);
      } else {
        engine.reset();
      }
      render(result.face, result.landmarks);
    }
    const now = performance.now();
    if (now - stats.lastLog >= 1000) {
      const avg = stats.inferMs.reduce((s, v) => s + v, 0) / (stats.inferMs.length || 1);
      stats.text = `${engine.delegate} - ${(stats.frames / ((now - stats.lastLog) / 1000)).toFixed(0)} fps - suivi ${avg.toFixed(1)} ms - ${video.videoWidth}x${video.videoHeight} - OBS : ${state.overlays} overlay`;
      stats.frames = 0;
      stats.inferMs = [];
      stats.lastLog = now;
    }
    $('status').textContent = state.error ? `Erreur camera : ${state.error}` : stats.text;
    // Minuteur et non requestAnimationFrame : dans une fenetre cachee, rAF est ralenti a ~1 image/s.
    setTimeout(loop, 8);
  };
  loop();
}

main().catch((error) => {
  state.error = `${error.name} - ${error.message}`;
  $('status').textContent = `Erreur camera : ${state.error}`;
  console.error(error);
});
