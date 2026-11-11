import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BODY_LANDMARKS, BODY_JOINT, sanitizeBody, unproject, solveBody, blendSkeleton, segmentFrame, torsoFrame
} from '../src/integrations/camskin/web/body-rig.js';
import { normalizeSkinManifest } from '../src/integrations/camskin/web/skin-manifest.js';
import { sanitizeFace } from '../src/integrations/camskin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = { w: 1280, h: 720 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearVec = (a, b, eps = 1e-6) => a.forEach((c, i) => near(c, b[i], eps));

/** Corps de face, bras le long du corps, hanches hors champ. */
function standingBody(overrides = {}) {
  const body = BODY_LANDMARKS.map(() => [0.5, 0.3, 0, 0.99]);
  const set = (name, x, y, v = 0.99, z = 0) => { body[BODY_JOINT[name]] = [x, y, z, v]; };
  set('shoulderL', 0.65, 0.62);
  set('shoulderR', 0.35, 0.62);
  set('elbowL', 0.69, 0.84);
  set('elbowR', 0.31, 0.84);
  set('wristL', 0.7, 0.99);
  set('wristR', 0.3, 0.99);
  set('pinkyL', 0.7, 1.02);
  set('pinkyR', 0.3, 1.02);
  set('indexL', 0.71, 1.03);
  set('indexR', 0.29, 1.03);
  set('hipL', 0.58, 1.2, 0.05);
  set('hipR', 0.42, 1.2, 0.05);
  for (const [name, args] of Object.entries(overrides)) body[BODY_JOINT[name]] = args;
  return body;
}

test('sanitizeBody : forme et bornes strictes', () => {
  assert.equal(sanitizeBody(standingBody()).length, BODY_LANDMARKS.length);
  assert.equal(sanitizeBody(null), null);
  assert.equal(sanitizeBody([]), null);
  assert.equal(sanitizeBody(standingBody().slice(1)), null);
  const bad = standingBody();
  bad[3] = [0.5, 0.5, 0, 1.5];
  assert.equal(sanitizeBody(bad), null, 'visibilite > 1');
  bad[3] = [0.5, 0.5, 99, 1];
  assert.equal(sanitizeBody(bad), null, 'profondeur aberrante');
  bad[3] = [0.5, 0.5, 0, NaN];
  assert.equal(sanitizeBody(bad), null);
  bad[3] = [0.5, 0.5, 0];
  assert.equal(sanitizeBody(bad), null);
});

test('unproject : le centre de l image est sur l axe, la profondeur est devant la camera', () => {
  nearVec(unproject(0.5, 0.5, 1280, 720, 60, 63), [0, 0, -60]);
  const [x, y, z] = unproject(1, 0, 1280, 720, 100, 63);
  assert.ok(x > 0 && y > 0 && z === -100, 'haut-droit : X et Y positifs');
  // Le meme pixel a deux profondeurs reste sur le meme rayon (alignement independant de la profondeur).
  const a = unproject(0.8, 0.3, 1280, 720, 50, 63);
  const b = unproject(0.8, 0.3, 1280, 720, 100, 63);
  near(a[0] / -a[2], b[0] / -b[2]);
  near(a[1] / -a[2], b[1] / -b[2]);
});

test('solveBody : epaules invisibles = pas de corps', () => {
  assert.equal(solveBody(standingBody({ shoulderL: [0.65, 0.62, 0.2, 0] }), VIEW, 60), null);
});

test('solveBody : echelle, hanches estimees et bras de face', () => {
  const sk = solveBody(standingBody(), VIEW, 60);
  assert.ok(sk);
  // 0,30 de la largeur a 60 cm de profondeur ~ 39 cm : echelle ~ 1 par rapport a 40 cm de repos.
  assert.ok(sk.scale > 0.9 && sk.scale < 1.1, `echelle ${sk.scale}`);
  assert.equal(sk.hipsKnown, false);
  assert.ok(sk.hipMid[1] < sk.shoulderMid[1], 'hanches estimees sous les epaules');
  assert.equal(sk.arms.length, 2);
  for (const arm of sk.arms) {
    assert.ok(arm.hasElbow && arm.hasWrist);
    assert.ok(arm.wrist[1] < arm.elbow[1] && arm.elbow[1] < arm.shoulder[1], 'le bras descend');
  }
  // Le premier bras est celui du cote +X de l image (point 11 a droite) : sa direction exterieure est +X.
  assert.equal(sk.arms[0].outward[0], 1);
  assert.equal(sk.arms[1].outward[0], -1);
});

test('solveBody : hanches visibles et plausibles utilisees, aberrantes ignorees', () => {
  const seen = solveBody(standingBody({ hipL: [0.58, 0.95, 0, 0.9], hipR: [0.42, 0.95, 0, 0.9] }), VIEW, 60);
  assert.equal(seen.hipsKnown, true);
  const absurd = solveBody(standingBody({ hipL: [0.58, 0.6, 0, 0.9], hipR: [0.42, 0.6, 0, 0.9] }), VIEW, 60);
  assert.equal(absurd.hipsKnown, false, 'hanches a hauteur des epaules : detection aberrante');
});

test('solveBody : un bras hors champ pend le long du corps', () => {
  const sk = solveBody(standingBody({ elbowL: [0.7, 0.9, 0, 0.1], wristL: [0.7, 1.2, 0, 0.05], pinkyL: [0.7, 1.3, 0, 0.05], indexL: [0.7, 1.3, 0, 0.05] }), VIEW, 60);
  const arm = sk.arms[0];
  assert.equal(arm.hasElbow, false);
  assert.equal(arm.hasWrist, false);
  near(arm.elbow[0], arm.shoulder[0]);
  assert.ok(arm.elbow[1] < arm.shoulder[1]);
  near(arm.wrist[0], arm.shoulder[0]);
});

test('solveBody : coude sorti, main cachee : le coude suit meme avec une visibilite basse', () => {
  const sk = solveBody(standingBody({ elbowL: [0.85, 0.6, 0, 0.25], wristL: [0.9, 0.9, 0, 0.05] }), VIEW, 60);
  const arm = sk.arms[0];
  assert.equal(arm.hasElbow, true);
  assert.equal(arm.hasWrist, false);
  assert.ok(Math.abs(arm.elbow[0] - arm.shoulder[0]) > 5, 'le coude est ecarte du corps');
});

test('solveBody : main levee visible, coude hors champ : la patte suit la main, le coude est deduit', () => {
  const sk = solveBody(standingBody({ elbowL: [0.8, 1.3, 0, 0.05], wristL: [0.85, 0.45, 0, 0.98], pinkyL: [0.87, 0.38, 0, 0.98], indexL: [0.84, 0.37, 0, 0.98] }), VIEW, 60);
  const arm = sk.arms[0];
  assert.equal(arm.hasWrist, true);
  assert.equal(arm.hasElbow, false);
  const expected = unproject(0.85, 0.45, VIEW.w, VIEW.h, 60, 63);
  near(arm.wrist[0], expected[0]);
  near(arm.wrist[1], expected[1]);
  assert.ok(arm.elbow[1] < arm.wrist[1], 'le coude deduit est sous la main levee');
  assert.ok(arm.tip[1] > arm.wrist[1], 'les doigts pointent vers le haut');
});

test('solveBody : la profondeur du corps suit la pose monde, bornee', () => {
  const closer = solveBody(standingBody({ shoulderL: [0.65, 0.62, -5, 0.99] }), VIEW, 60);
  const flat = solveBody(standingBody(), VIEW, 60);
  assert.ok(closer.arms[0].shoulder[2] > flat.arms[0].shoulder[2], 'plus pres de la camera = Z moins negatif');
  assert.ok(Math.abs(closer.arms[0].shoulder[2] - -60) <= 40.0001, 'decalage borne');
});

test('segmentFrame : repere orthonormal, +Y vers l extremite, +X proche de l indice', () => {
  const f = segmentFrame([0, 0, 0], [0, -10, 0], [1, 0, 0]);
  nearVec(f.y, [0, -1, 0]);
  nearVec(f.x, [1, 0, 0]);
  nearVec(f.z, [0, 0, -1]);
  near(f.length, 10);
  // Segment colineaire a l indice : repli sur l indice de secours, toujours orthonormal.
  const g = segmentFrame([0, 0, 0], [5, 0, 0], [1, 0, 0], [0, 0, 1]);
  near(Math.hypot(...g.x), 1);
  near(g.x[0] * g.y[0] + g.x[1] * g.y[1] + g.x[2] * g.y[2], 0);
});

test('torsoFrame : debout et de face, le ventre (+Z) regarde la camera', () => {
  const frame = torsoFrame(solveBody(standingBody(), VIEW, 60));
  assert.ok(frame.y[1] < -0.9, 'vers le bas');
  assert.ok(frame.z[2] > 0.9, 'ventre vers la camera');
  assert.ok(frame.x[0] < -0.9, '+X vers la gauche de l image');
});

test('blendSkeleton : lissage et reprise sans etat precedent', () => {
  const a = solveBody(standingBody(), VIEW, 60);
  const b = solveBody(standingBody({ shoulderL: [0.7, 0.62, 0, 0.99] }), VIEW, 60);
  assert.equal(blendSkeleton(null, b, 0.5), b);
  const half = blendSkeleton(a, b, 0.5);
  near(half.arms[0].shoulder[0], (a.arms[0].shoulder[0] + b.arms[0].shoulder[0]) / 2);
  assert.equal(blendSkeleton(a, b, 1).arms[0].shoulder[0], b.arms[0].shoulder[0]);
});

test('manifeste : section body (valeurs par defaut, bornes, rejets, idempotence)', () => {
  assert.equal(normalizeSkinManifest({ model: 'a.glb' }).body, null);
  const body = normalizeSkinManifest({ model: 'a.glb', body: { model: 'b.glb' } }).body;
  assert.equal(body.thickness, 1);
  assert.equal(body.armThickness, 1);
  assert.equal(body.depthGain, 0.6);
  assert.deepEqual(body.lengths, { torso: 45, neck: 14, upperArm: 28, forearm: 26, hand: 10 });
  assert.equal(normalizeSkinManifest({ model: 'a.glb', body: { model: 'b.glb', thickness: 99 } }).body.thickness, 3);
  for (const bad of [{ model: '../b.glb' }, { model: 5 }, {}, { model: 'b.png' }, { model: 'b.glb', neckAnchor: [1, 2] }]) {
    assert.throws(() => normalizeSkinManifest({ model: 'a.glb', body: bad }), undefined, JSON.stringify(bad));
  }
  const once = normalizeSkinManifest({ model: 'a.glb', body: { model: 'b.glb', depthGain: -0.5 } });
  const again = normalizeSkinManifest({ ...once, transform: { position: once.position, rotation: once.rotation, scale: once.scale } });
  assert.deepEqual(again, once);
});

test('le dragon declare un corps dont le modele existe avec les noeuds attendus', () => {
  const dir = path.join(root, 'assets', 'camskin', 'skins', 'dragon');
  const manifest = normalizeSkinManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
  assert.ok(manifest.body);
  const glb = fs.readFileSync(path.join(dir, manifest.body.model));
  assert.equal(glb.toString('ascii', 0, 4), 'glTF');
  const jsonLength = glb.readUInt32LE(12);
  const names = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength)).nodes.map((n) => n.name);
  for (const name of ['Torso', 'Neck', 'Wing', 'UpperArm', 'Forearm', 'Hand', 'Shoulder', 'Elbow', 'Wrist']) {
    assert.ok(names.includes(name), `noeud ${name} absent du modele`);
  }
  for (const model of ['full', 'heavy']) assert.ok(fs.existsSync(path.join(root, 'assets', 'camskin', `pose_landmarker_${model}.task`)));
});

test('sanitizeFace : le corps est facultatif mais refuse s il est mal forme', () => {
  const face = {
    w: 1280, h: 720, cx: 640, cy: 240, u: 100, angle: 0, jaw: 0, nose: { x: 1, y: 1 }, mouth: { x: 1, y: 1 }, look: { x: 0, y: 0 }, oval: []
  };
  assert.equal(sanitizeFace(face).body, undefined);
  assert.equal(sanitizeFace({ ...face, body: standingBody() }).body.length, BODY_LANDMARKS.length);
  assert.equal(sanitizeFace({ ...face, body: [[0, 0, 0, 1]] }), null);
});

test('la grenouille declare aussi un corps (sans ailes)', () => {
  const dir = path.join(root, 'assets', 'camskin', 'skins', 'frog');
  const manifest = normalizeSkinManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
  assert.ok(manifest.body);
  const glb = fs.readFileSync(path.join(dir, manifest.body.model));
  const names = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12))).nodes.map((n) => n.name);
  for (const name of ['Torso', 'Neck', 'UpperArm', 'Forearm', 'Hand', 'Shoulder', 'Elbow', 'Wrist']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('Wing'));
});

test('manifeste : ailes (defauts et bornes)', () => {
  const { wings } = normalizeSkinManifest({ model: 'a.glb', body: { model: 'b.glb', wings: { flapDeg: 999 } } }).body;
  assert.deepEqual(wings, { restDeg: 0, flapDeg: 40, periodSec: 2.6 });
});

test('createBodyFilter : le bruit au repos est ecrase, un vrai mouvement est suivi', async () => {
  const { createBodyFilter } = await import('../src/integrations/camskin/web/body-rig.js');
  const f = createBodyFilter();
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
  let last;
  let maxDev = 0;
  for (let i = 0; i < 120; i++) {
    last = f.filter([[0.5 + noise(), 0.5 + noise(), 0.1 + noise(), 0.9]], i / 15);
    if (i > 30) maxDev = Math.max(maxDev, Math.abs(last[0][0] - 0.5));
  }
  assert.ok(maxDev < 0.006, `tremblement residuel ${maxDev}`);
  assert.equal(last[0][3], 0.9);
  for (let i = 120; i < 150; i++) last = f.filter([[0.8, 0.5, 0.1, 0.9]], i / 15);
  assert.ok(Math.abs(last[0][0] - 0.8) < 0.02);
});

test('sanitizeFace : un visage perdu (corps seul) est relaye sans pose, avec le drapeau lost', () => {
  const face = {
    w: 640, h: 480, cx: 300, cy: 200, u: 60, angle: 0, jaw: 0, nose: { x: 1, y: 1 }, mouth: { x: 1, y: 1 }, look: { x: 0, y: 0 },
    oval: [], blend: {}, lip: 0, lost: true,
    body: Array.from({ length: 15 }, () => [0.5, 0.5, 0, 0.9])
  };
  const out = sanitizeFace(face);
  assert.equal(out.lost, true);
  assert.equal(out.pose, undefined);
  assert.equal(out.body.length, 15);
  assert.equal(sanitizeFace({ ...face, lost: undefined }).lost, undefined);
});

test('createBodyFilter.predict : extrapole un mouvement regulier, immobile = pas de derive', async () => {
  const { createBodyFilter } = await import('../src/integrations/camskin/web/body-rig.js');
  const f = createBodyFilter();
  assert.equal(f.predict(0.05), null);
  // Main qui avance a 1 unite/s, mesuree a 30 Hz.
  for (let i = 0; i < 60; i++) f.filter([[i / 30, 0.5, 0.1, 0.9]], i / 30);
  const now = f.predict(0)[0];
  const ahead = f.predict(0.05)[0];
  assert.ok(ahead[0] - now[0] > 0.035 && ahead[0] - now[0] < 0.06, `avance de ${ahead[0] - now[0]}`);
  assert.equal(ahead[1], now[1]);
  assert.equal(ahead[2], now[2], 'la profondeur n est pas extrapolee');
  assert.equal(ahead[3], 0.9);
  const still = createBodyFilter();
  for (let i = 0; i < 60; i++) still.filter([[0.4, 0.5, 0.1, 0.9]], i / 30);
  assert.ok(Math.abs(still.predict(0.08)[0][0] - 0.4) < 1e-6);
});
