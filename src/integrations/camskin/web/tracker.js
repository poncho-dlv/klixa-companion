// Suivi du visage + apercu. Tourne dans une fenetre du compagnon (cachee ou visible) : c'est
// elle qui ouvre la camera (webcam, ou "OBS Virtual Camera" pour partager la vraie webcam
// avec OBS) et envoie les donnees de visage a l'overlay OBS via le serveur local.
import { createFaceEngine } from './engine.js';
import { SKINS, is3D, hasBody } from './skins.js';
import { BODY_JOINT } from './body-rig.js';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('stage');
const ctx = canvas.getContext('2d');
// Points de suivi : couche au-dessus du rendu 3D (sinon le corps du skin les cache).
const debugCanvas = $('stagedebug');
const dctx = debugCanvas.getContext('2d');
const CAMERA_KEY = 'camskin.camera';

const state = {
  override: '',
  serverSkin: null,
  overlays: 0,
  mirror: true,
  body: true,
  debug: false,
  info3d: '',
  error: ''
};

$('skin').add(new Option('Auto (Klixa)', ''));
for (const [id, skin] of Object.entries(SKINS)) $('skin').add(new Option(skin.label, id));
$('skin').onchange = (e) => { state.override = e.target.value; };
$('mirror').onchange = (e) => { state.mirror = e.target.checked; };
$('body').onchange = (e) => { state.body = e.target.checked; };
$('debug').onchange = (e) => { state.debug = e.target.checked; };

// --- Rendu 3D (a la demande) et calibrage ----------------------------------------------
// La sortie 3D est dessinee dans un canvas WebGL cache, puis recopiee dans l'apercu.
const CALIB_KEY = 'camskin.calib.';
let renderer3d = null;
let renderer3dLoading = false;
function ensureRenderer3d() {
  if (renderer3d || renderer3dLoading) return renderer3d;
  renderer3dLoading = true;
  import('./skin3d.js')
    .then((module) => { renderer3d = module.createSkin3DRenderer({ canvas: $('stage3d') }); })
    .catch((error) => { console.error('Rendu 3D indisponible', error); });
  return null;
}

const CALIB_FIELDS = [
  ['px', 'Position X', 'position', 0, -15, 15, 0.1], ['py', 'Position Y', 'position', 1, -15, 15, 0.1], ['pz', 'Position Z', 'position', 2, -15, 15, 0.1],
  ['rx', 'Rotation X', 'rotation', 0, -180, 180, 1], ['ry', 'Rotation Y', 'rotation', 1, -180, 180, 1], ['rz', 'Rotation Z', 'rotation', 2, -180, 180, 1]
];
let calibSkin = null;

// Reapplique les reglages de calibrage memorises (par navigateur) des que le modele est charge.
function restoreCalibration(skinId) {
  try {
    const saved = JSON.parse(localStorage.getItem(CALIB_KEY + skinId) ?? 'null');
    if (saved) renderer3d.patchManifest(skinId, saved);
  } catch { /* reglage memorise illisible : ignore */ }
}

function saveCalibration(skinId) {
  const m = renderer3d.getManifest(skinId);
  localStorage.setItem(CALIB_KEY + skinId, JSON.stringify({
    transform: { position: m.position, rotation: m.rotation, scale: m.scale },
    occluder: m.occluder,
    ...(m.jaw ? { jaw: m.jaw } : {}),
    ...(m.eyes ? { eyes: m.eyes } : {}),
    ...(m.texture ? { texture: m.texture } : {}),
    ...(m.stabilize ? { stabilize: m.stabilize } : {}),
    ...(m.body ? { body: m.body } : {})
  }));
}

function buildCalibration(skinId) {
  const panel = $('calib-body');
  const manifest = renderer3d.getManifest(skinId);
  panel.replaceChildren();
  const addRow = (label, min, max, step, value, onInput) => {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value });
    const out = document.createElement('output');
    out.textContent = String(value);
    input.oninput = () => {
      out.textContent = input.value;
      onInput(Number(input.value));
      saveCalibration(skinId);
    };
    row.append(name, input, out);
    panel.append(row);
  };
  for (const [, label, key, index, min, max, step] of CALIB_FIELDS) {
    addRow(label, min, max, step, manifest[key][index], (value) => {
      const next = [...renderer3d.getManifest(skinId)[key]];
      next[index] = value;
      renderer3d.patchManifest(skinId, { transform: { [key]: next } });
    });
  }
  addRow('Echelle', 0.2, 5, 0.01, manifest.scale, (value) => renderer3d.patchManifest(skinId, { transform: { scale: value } }));
  if (manifest.jaw) {
    addRow('Machoire : gain', 0.5, 6, 0.1, manifest.jaw.gain, (value) => {
      renderer3d.patchManifest(skinId, { jaw: { ...renderer3d.getManifest(skinId).jaw, gain: value } });
    });
    addRow('Machoire : gain levres', 0, 12, 0.1, manifest.jaw.lipGain, (value) => {
      renderer3d.patchManifest(skinId, { jaw: { ...renderer3d.getManifest(skinId).jaw, lipGain: value } });
    });
    addRow('Machoire : courbe', 0.3, 1.5, 0.05, manifest.jaw.curve, (value) => {
      renderer3d.patchManifest(skinId, { jaw: { ...renderer3d.getManifest(skinId).jaw, curve: value } });
    });
    addRow('Machoire : angle max', 5, 60, 1, manifest.jaw.maxAngleDeg, (value) => {
      renderer3d.patchManifest(skinId, { jaw: { ...renderer3d.getManifest(skinId).jaw, maxAngleDeg: value } });
    });
  }
  if (manifest.eyes) {
    addRow('Regard : gain', 0.5, 4, 0.1, manifest.eyes.gain, (value) => {
      renderer3d.patchManifest(skinId, { eyes: { ...renderer3d.getManifest(skinId).eyes, gain: value } });
    });
  }
  if (manifest.body) {
    addRow('Corps : epaisseur', 0.4, 2, 0.05, manifest.body.thickness, (value) => {
      renderer3d.patchManifest(skinId, { body: { ...renderer3d.getManifest(skinId).body, thickness: value } });
    });
    addRow('Bras : epaisseur', 0.4, 2.5, 0.05, manifest.body.armThickness, (value) => {
      renderer3d.patchManifest(skinId, { body: { ...renderer3d.getManifest(skinId).body, armThickness: value } });
    });
    addRow('Corps : profondeur', -1, 1.5, 0.05, manifest.body.depthGain, (value) => {
      renderer3d.patchManifest(skinId, { body: { ...renderer3d.getManifest(skinId).body, depthGain: value } });
    });
    addRow('Cou : accroche', 0, 0.5, 0.01, manifest.body.neckBase, (value) => {
      renderer3d.patchManifest(skinId, { body: { ...renderer3d.getManifest(skinId).body, neckBase: value } });
    });
  }
  if (manifest.stabilize) {
    addRow('Nez : maintien tete', 0, 1, 0.05, manifest.stabilize.noseHold, (value) => {
      renderer3d.patchManifest(skinId, { stabilize: { noseHold: value } });
    });
  }
  if (manifest.texture) {
    for (const [label, key, min, max, step] of [['Peau : relief', 'bump', 0, 1.5, 0.05], ['Peau : taches', 'blotch', 0, 1, 0.05], ['Peau : ecailles', 'scales', 0, 1, 0.05], ['Peau : echelle', 'scale', 0.3, 3, 0.05]]) {
      addRow(label, min, max, step, manifest.texture[key], (value) => {
        renderer3d.patchManifest(skinId, { texture: { ...renderer3d.getManifest(skinId).texture, [key]: value } });
      });
    }
  }
  const occ = manifest.occluder;
  for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
    addRow(`Cache tete ${axis}`, 1, 20, 0.1, occ.radii[i], (value) => {
      const radii = [...renderer3d.getManifest(skinId).occluder.radii];
      radii[i] = value;
      renderer3d.patchManifest(skinId, { occluder: { radii } });
    });
  }
  for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
    addRow(`Cache tete pos ${axis}`, -15, 15, 0.1, occ.position[i], (value) => {
      const position = [...renderer3d.getManifest(skinId).occluder.position];
      position[i] = value;
      renderer3d.patchManifest(skinId, { occluder: { position } });
    });
  }
}

$('calib-debug').onchange = (e) => renderer3d?.setDebug(e.target.checked);
$('calib-copy').onclick = async () => {
  if (!calibSkin || !renderer3d) return;
  const m = renderer3d.getManifest(calibSkin);
  const out = { model: m.model, transform: { position: m.position, rotation: m.rotation, scale: m.scale }, occluder: m.occluder, morphGain: m.morphGain, light: m.light };
  if (m.jaw) out.jaw = m.jaw;
  if (m.eyes) out.eyes = m.eyes;
  if (m.breath) out.breath = m.breath;
  if (m.texture) out.texture = m.texture;
  if (m.stabilize) out.stabilize = m.stabilize;
  if (m.body) out.body = m.body;
  if (Object.keys(m.morphGains).length) out.morphGains = m.morphGains;
  await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
  $('calib-copy').textContent = 'Copie !';
  setTimeout(() => { $('calib-copy').textContent = 'Copier le manifeste'; }, 1500);
};
$('calib-reset').onclick = () => {
  if (!calibSkin) return;
  localStorage.removeItem(CALIB_KEY + calibSkin);
  location.reload();
};

// Panneau visible uniquement pour un skin 3D charge ; reconstruit quand le skin change.
function syncCalibration(skinId) {
  const wanted = skinId && is3D(SKINS[skinId]) && renderer3d?.isReady(skinId) ? skinId : null;
  if (wanted === calibSkin) return;
  calibSkin = wanted;
  $('calib').hidden = !wanted;
  if (wanted) {
    restoreCalibration(wanted);
    buildCalibration(wanted);
  }
}

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
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, resizeMode: 'none' },
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

// Squelette du corps (points filtres envoyes au rendu) : vert = visible, rouge = peu fiable.
const BODY_BONES = [['shoulderL', 'shoulderR'], ['shoulderL', 'elbowL'], ['elbowL', 'wristL'], ['shoulderR', 'elbowR'],
  ['elbowR', 'wristR'], ['wristL', 'pinkyL'], ['wristL', 'indexL'], ['wristR', 'pinkyR'], ['wristR', 'indexR'],
  ['shoulderL', 'hipL'], ['shoulderR', 'hipR'], ['hipL', 'hipR']];

function drawBodyDebug(ctx, body, w, h) {
  const at = (name) => body[BODY_JOINT[name]];
  ctx.lineCap = 'round';
  const bones = BODY_BONES.map(([a, b]) => [at(a), at(b)]);
  // Deux passes : un contour sombre, puis la couleur (lisible sur n'importe quel fond / skin).
  for (const [width, colored] of [[8, false], [4, true]]) {
    ctx.lineWidth = width;
    for (const [p, q] of bones) {
      ctx.strokeStyle = colored ? (Math.min(p[3], q[3]) >= 0.5 ? '#3f3' : '#f55') : 'rgba(0,0,0,.75)';
      ctx.beginPath();
      ctx.moveTo(p[0] * w, p[1] * h);
      ctx.lineTo(q[0] * w, q[1] * h);
      ctx.stroke();
    }
  }
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  for (const p of body) {
    ctx.fillStyle = p[3] >= 0.5 ? '#3f3' : '#f55';
    ctx.beginPath();
    ctx.arc(p[0] * w, p[1] * h, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function render(face, landmarks, body) {
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
  let drew3d = false;
  if (face && skin) {
    const def = SKINS[skin];
    if (is3D(def)) {
      const renderer = ensureRenderer3d();
      drew3d = Boolean(renderer?.render(face, skin, def.model));
      state.info3d = renderer ? `3D ${renderer.status(skin)}${face.pose ? ` z=${face.pose[14]}` : ' sans pose'}` : '3D chargement du moteur';
    } else {
      if (!face.lost) def.draw(ctx, face);
    }
  }
  // Le canvas WebGL est superpose a l'apercu (comme dans l'overlay OBS), pas recopie dedans.
  $('stage3d').classList.toggle('mirror', state.mirror);
  if (!drew3d) renderer3d?.clear();
  syncCalibration(skin && is3D(SKINS[skin]) ? skin : null);
  ctx.restore();
  if (debugCanvas.width !== w || debugCanvas.height !== h) {
    debugCanvas.width = w;
    debugCanvas.height = h;
  }
  debugCanvas.classList.toggle('mirror', state.mirror);
  dctx.clearRect(0, 0, w, h);
  if (landmarks) {
    dctx.fillStyle = 'rgba(0,255,255,.8)';
    for (const p of landmarks) dctx.fillRect(p.x * w - 1, p.y * h - 1, 2, 2);
  }
  if (body) drawBodyDebug(dctx, body, w, h);
}

async function main() {
  await startCamera();
  const engine = await createFaceEngine();
  let lastVideoTime = -1;

  let lastStatus = '';
  const loop = () => {
    // Image prete (pas pendant un changement de camera) et nouvelle depuis le dernier passage.
    if (video.readyState >= 2 && video.videoWidth > 0 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      stats.frames++;
      // Une erreur ponctuelle (image invalide, contexte graphique perdu...) ne doit pas arreter le suivi.
      try {
        let result = { face: null, landmarks: null };
        // Sans skin a afficher, on ne lance pas l'inference (la fenetre reste une simple camera).
        if (state.override || state.serverSkin || state.debug) {
          const t = performance.now();
          const skinId = state.override || state.serverSkin;
          result = engine.detect(video, state.debug, state.body && hasBody(SKINS[skinId]));
          stats.inferMs.push(performance.now() - t);
          if (state.serverSkin) send(result.face);
        } else {
          engine.reset();
        }
        // Fenetre cachee (suivi pour OBS seulement) : l'apercu n'est vu par personne, on economise le rendu.
        if (!document.hidden) render(result.face, result.landmarks, result.body);
      } catch (error) {
        console.error('Suivi : image ignoree', error);
      }
    }
    const now = performance.now();
    if (now - stats.lastLog >= 1000) {
      const avg = stats.inferMs.reduce((s, v) => s + v, 0) / (stats.inferMs.length || 1);
      const pose = engine.poseInfo();
      const poseText = ['worker', 'inline'].includes(pose.mode) ? ` - corps ${pose.mode} ${pose.rate.toFixed(0)}/s ${pose.ms.toFixed(0)} ms` : '';
      stats.text = `${engine.delegate} - ${(stats.frames / ((now - stats.lastLog) / 1000)).toFixed(0)} fps - suivi ${avg.toFixed(1)} ms - ${video.videoWidth}x${video.videoHeight} ${poseText} - OBS : ${state.overlays} overlay${state.info3d ? ` - ${state.info3d}` : ''}`;
      stats.frames = 0;
      stats.inferMs = [];
      stats.lastLog = now;
    }
    const status = state.error ? `Erreur camera : ${state.error}` : stats.text;
    if (status !== lastStatus) {
      lastStatus = status;
      $('status').textContent = status;
    }
    // Minuteur et non requestAnimationFrame : dans une fenetre cachee, rAF est ralenti a ~1 image/s.
    // 1 ms : une attente plus longue fait rater des images a 60 fps.
    setTimeout(loop, 1);
  };
  loop();
}

main().catch((error) => {
  state.error = `${error.name} - ${error.message}`;
  $('status').textContent = `Erreur camera : ${state.error}`;
  console.error(error);
});
