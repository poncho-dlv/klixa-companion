import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createLogger } from '../logger.js';
import { t } from '../i18n/core.js';
import { isAllowedOrigin, isAllowedRequestHost } from '../local-server.js';
import { SKINS } from './camskin/web/skins.js';
import { sanitizePoseAndBlend } from './camskin/web/skin-manifest.js';
import { sanitizeBody } from './camskin/web/body-rig.js';

const log = createLogger('camskin');
const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const MAX_DURATION_MS = 3600000;
const WS_PATH = '/ws';
const MAX_WS_PAYLOAD = 16 * 1024;
const MAX_OVAL_POINTS = 64;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp'
};

// Pages servies a elles-memes : aucun reseau exterieur. `wasm-unsafe-eval` est requis par
// MediaPipe (WebAssembly) ; la WebSocket ne vise que ce meme serveur local.
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:"
].join('; ');

function resolveVendorDir() {
  try {
    return path.dirname(require.resolve('@mediapipe/tasks-vision/package.json'));
  } catch {
    return path.resolve(directory, '..', '..', 'node_modules', '@mediapipe', 'tasks-vision');
  }
}

function resolveThreeDir(...parts) {
  try {
    // `three` n'expose pas son package.json : on remonte depuis l'entree CommonJS (build/three.cjs).
    return path.join(path.dirname(require.resolve('three')), '..', ...parts);
  } catch {
    return path.resolve(directory, '..', '..', '..', 'node_modules', 'three', ...parts);
  }
}

// Dans l'application installee, electron-builder exclut le dossier `examples` des node_modules :
// les addons utiles sont donc copies dans `resources/three-addons` (extraResources).
function resolveThreeAddonsDir() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'three-addons');
    if (fs.existsSync(path.join(packaged, 'loaders', 'GLTFLoader.js'))) return packaged;
  }
  return resolveThreeDir('examples', 'jsm');
}

// Les modules d'exemples de three.js (GLTFLoader...) importent `'three'` par son nom nu, que le
// navigateur ne sait pas resoudre sans import map (un import map en ligne serait bloque par la
// CSP). On reecrit donc cet unique specificateur vers le fichier servi localement.
const THREE_BARE_IMPORT = /(from\s*)(['"])three\2/g;
function rewriteThreeImports(source) {
  return source.replace(THREE_BARE_IMPORT, '$1$2/vendor-three/three.module.js$2');
}

/** Skins disponibles (id + libelle), dans l'ordre de la page. */
export function listSkins() {
  return Object.entries(SKINS).map(([id, skin]) => ({ id, label: skin.label }));
}

/**
 * Valide `skin` : '' / 'none' / null = retirer le skin, sinon un id connu.
 * @returns {string|null} id du skin, ou null pour "aucun"
 */
export function normalizeSkin(value) {
  if (value === undefined || value === null) return null;
  const skin = String(value).trim().toLowerCase();
  if (skin === '' || skin === 'none') return null;
  if (!Object.hasOwn(SKINS, skin)) {
    const error = new Error(t('errors.camskinUnknownSkin', { skin }));
    error.code = 'INVALID_SKIN';
    throw error;
  }
  return skin;
}

/** Valide `durationMs` : absent / 0 = permanent, sinon entier entre 1 et MAX_DURATION_MS. */
export function normalizeDuration(value) {
  if (value === undefined || value === null || value === '') return 0;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_DURATION_MS) {
    const error = new Error(t('errors.camskinInvalidDuration', { max: MAX_DURATION_MS }));
    error.code = 'INVALID_DURATION';
    throw error;
  }
  return ms;
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const point = (p) => p && finite(p.x) && finite(p.y) ? { x: p.x, y: p.y } : null;

/**
 * Valide un visage recu du suivi avant de le relayer aux overlays : forme et bornes strictes
 * (un client local ne doit pas pouvoir faire planter ou saturer la page OBS).
 * @returns {object|null} le visage nettoye, ou null s'il est invalide
 */
export function sanitizeFace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { w, h, cx, cy, u, angle, jaw } = raw;
  if (![w, h, cx, cy, u, angle, jaw].every(finite)) return null;
  if (w < 16 || h < 16 || w > 8192 || h > 8192) return null;
  const nose = point(raw.nose);
  const mouth = point(raw.mouth);
  const look = point(raw.look);
  if (!nose || !mouth || !look) return null;
  if (!Array.isArray(raw.oval) || raw.oval.length > MAX_OVAL_POINTS) return null;
  const oval = raw.oval.map(point);
  if (oval.includes(null)) return null;
  const face = { w, h, cx, cy, u, angle, jaw, nose, mouth, look, oval };
  // Visage perdu mais corps suivi : le rendu garde la derniere pose de tete.
  if (raw.lost === true) face.lost = true;
  // Pose 3D et blendshapes : facultatifs (skins 3D), refuses s'ils sont mal formes.
  const extra = sanitizePoseAndBlend(raw);
  if (!extra) return null;
  // Points du corps (skins avec corps) : facultatifs, refuses s'ils sont mal formes.
  if (raw.body !== undefined && raw.body !== null) {
    const body = sanitizeBody(raw.body);
    if (!body) return null;
    return { ...face, ...extra, body };
  }
  return { ...face, ...extra };
}

/**
 * Skins camera. Deux pages locales, un moteur commun :
 *  - `tracker.html` (fenetre du compagnon) ouvre la camera (webcam ou OBS Virtual Camera),
 *    fait le suivi du visage, affiche l'apercu et envoie les donnees de visage ;
 *  - `/` (overlay.html, Source navigateur OBS, fond transparent) dessine le skin a partir de
 *    ces donnees, par-dessus la source camera d'OBS. Elle n'ouvre jamais la camera.
 * Les commandes `camskin.*` choisissent le skin ; `onTrackingDemand(bool)` previent l'hote
 * (fenetre Electron) qu'il faut lancer ou arreter le suivi.
 * Serveur DEDIE, loopback uniquement, separe du serveur de commandes (actions sensibles).
 */
export function createCamskinIntegration(cfg = {}, { emitEvent } = {}) {
  const webDir = path.join(directory, 'camskin', 'web');
  const mounts = [
    ['/vendor/', resolveVendorDir()],
    ['/vendor-three/', resolveThreeDir('build')],
    ['/vendor-three-addons/', resolveThreeAddonsDir()],
    ['/models/', cfg.modelsDir || path.resolve(directory, '..', '..', 'assets', 'camskin')],
    ['/', webDir]
  ];

  const threeAddonsDir = mounts.find(([prefix]) => prefix === '/vendor-three-addons/')[1];
  const state = { skin: null, expiresAt: null };
  let timer = null;
  let demand = false;
  const overlays = new Set();
  const trackers = new Set();

  function publicState() {
    return { skin: state.skin, expiresAt: state.expiresAt };
  }

  function statusSnapshot() {
    return { ...publicState(), overlays: overlays.size, trackers: trackers.size };
  }

  function sendAll(message) {
    const frame = JSON.stringify(message);
    for (const ws of [...overlays, ...trackers]) if (ws.readyState === 1) ws.send(frame);
  }

  function broadcastState() {
    sendAll({ type: 'state', ...statusSnapshot() });
  }

  function syncDemand() {
    const next = state.skin !== null;
    if (next === demand) return;
    demand = next;
    try {
      cfg.onTrackingDemand?.(demand);
    } catch (err) {
      log.error('Erreur onTrackingDemand', err.message);
    }
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function applySkin(skin, durationMs) {
    clearTimer();
    state.skin = skin;
    state.expiresAt = skin && durationMs > 0 ? Date.now() + durationMs : null;
    if (skin && durationMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        state.skin = null;
        state.expiresAt = null;
        broadcastState();
        syncDemand();
        emitEvent?.({ event: { source: 'CamSkin', type: 'Expired' }, data: {} });
      }, durationMs);
      timer.unref?.();
    }
    broadcastState();
    syncDemand();
  }

  function resolveFile(urlPath) {
    let clean;
    try {
      clean = decodeURIComponent(urlPath.split('?')[0]);
    } catch {
      return null;
    }
    // La racine est l'overlay OBS (c'est l'URL a coller dans la Source navigateur).
    if (clean === '/') clean = '/overlay.html';
    for (const [prefix, dir] of mounts) {
      if (!clean.startsWith(prefix)) continue;
      const file = path.resolve(dir, clean.slice(prefix.length));
      if (file.startsWith(dir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
    return null;
  }

  const server = http.createServer((req, res) => {
    if (!isAllowedOrigin(req.headers.origin) || !isAllowedRequestHost(req.headers.host, '127.0.0.1')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(statusSnapshot()));
      return;
    }

    const file = resolveFile(req.url);
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    };
    if (path.extname(file) === '.html') headers['Content-Security-Policy'] = PAGE_CSP;
    res.writeHead(200, headers);
    if (file.startsWith(threeAddonsDir + path.sep) && path.extname(file) === '.js') {
      res.end(rewriteThreeImports(fs.readFileSync(file, 'utf8')));
      return;
    }
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // Meme garde que les routes HTTP : Origin et Host loopback uniquement (anti-CSRF et
    // anti-DNS-rebinding), puis chemin et role connus.
    const role = url.searchParams.get('role');
    if (!isAllowedOrigin(req.headers.origin) || !isAllowedRequestHost(req.headers.host, '127.0.0.1')
      || url.pathname !== WS_PATH || !['overlay', 'tracker'].includes(role)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const group = role === 'tracker' ? trackers : overlays;
      group.add(ws);
      ws.send(JSON.stringify({ type: 'state', ...statusSnapshot() }));
      broadcastState();
      ws.on('message', (data) => {
        // Seul le suivi envoie des donnees ; elles sont relayees aux overlays uniquement.
        if (role !== 'tracker') return;
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message?.type !== 'face') return;
        const face = message.face === null ? null : sanitizeFace(message.face);
        if (message.face !== null && !face) return;
        const frame = JSON.stringify({ type: 'face', face });
        for (const overlay of overlays) if (overlay.readyState === 1) overlay.send(frame);
      });
      ws.on('close', () => {
        group.delete(ws);
        broadcastState();
      });
    });
  });

  const port = Number.isInteger(cfg.port) ? cfg.port : 4777;
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      log.info(`Skins camera : overlay OBS sur http://127.0.0.1:${server.address().port}/`);
      resolve();
    });
  });
  // Un echec de bind (port pris) ne doit pas faire tomber le compagnon : il est remonte
  // par le healthcheck, l'integration reste enregistree mais inactive.
  ready.catch((err) => log.error('Serveur skins camera non demarre', err.message));

  function currentPort() {
    return server.listening ? server.address().port : port;
  }

  return {
    id: 'camskin',
    ready,
    get port() {
      return currentPort();
    },
    commands: {
      'camskin.set-skin': async (payload = {}) => {
        const skin = normalizeSkin(payload.skin);
        const durationMs = skin ? normalizeDuration(payload.durationMs) : 0;
        applySkin(skin, durationMs);
        return publicState();
      },
      'camskin.status': async () => ({
        ...statusSnapshot(),
        port: currentPort(),
        url: `http://127.0.0.1:${currentPort()}/`,
        trackerUrl: `http://127.0.0.1:${currentPort()}/tracker.html`
      }),
      'camskin.list-skins': async () => ({ skins: listSkins() })
    },
    healthcheck: async () => {
      await ready;
      return { port: currentPort(), overlays: overlays.size, trackers: trackers.size, skin: state.skin };
    },
    async stop() {
      clearTimer();
      for (const ws of [...overlays, ...trackers]) ws.terminate();
      overlays.clear();
      trackers.clear();
      wss.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
