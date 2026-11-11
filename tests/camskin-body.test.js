import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BODY_LANDMARKS, BODY_JOINT, HAND_POINTS, sanitizeBody, sanitizeHands, handFrame, clearTorso, solveHands, solveArms, isPlausibleBody, unproject, solveBody, blendSkeleton, segmentFrame, limbFrame, torsoFrame
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

test('solveBody : une epaule nettement hors de l image = pas de corps (sortie du champ)', () => {
  assert.equal(solveBody(standingBody({ shoulderL: [1.2, 0.62, 0, 0.99] }), VIEW, 60), null);
  assert.equal(solveBody(standingBody({ shoulderR: [-0.15, 0.62, 0, 0.99] }), VIEW, 60), null);
  // Un leger depassement (personne large, pres de la camera) reste accepte.
  assert.ok(solveBody(standingBody({ shoulderL: [1.05, 0.62, 0, 0.99] }), VIEW, 60));
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
  const sk = solveBody(standingBody({ elbowL: [0.7, 1.5, 0, 0.1], wristL: [0.7, 1.8, 0, 0.02], pinkyL: [0.7, 1.9, 0, 0.02], indexL: [0.7, 1.9, 0, 0.02] }), VIEW, 60);
  const arm = sk.arms[0];
  assert.equal(arm.hasElbow, false);
  assert.equal(arm.hasWrist, false);
  near(arm.elbow[0], arm.shoulder[0]);
  assert.ok(arm.elbow[1] < arm.shoulder[1]);
  near(arm.wrist[0], arm.shoulder[0]);
});

test('solveBody : coude sorti, main cachee : le coude suit meme avec une visibilite basse', () => {
  const sk = solveBody(standingBody({ elbowL: [0.85, 0.6, 0, 0.25], wristL: [0.9, 1.6, 0, 0.05], pinkyL: [0.9, 1.7, 0, 0.05], indexL: [0.9, 1.7, 0, 0.05] }), VIEW, 60);
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

test('solveBody : la longueur de la patte suit la taille mesuree de la main, bornee', () => {
  const hand = (spread) => solveBody(standingBody({
    wristL: [0.85, 0.5, 0, 0.98], pinkyL: [0.87, 0.5 - spread, 0, 0.98], indexL: [0.83, 0.5 - spread, 0, 0.98]
  }), VIEW, 60).arms[0];
  const size = (arm) => Math.hypot(arm.tip[0] - arm.wrist[0], arm.tip[1] - arm.wrist[1], arm.tip[2] - arm.wrist[2]);
  const small = size(hand(0.08));
  const big = size(hand(0.16));
  assert.ok(big > small * 1.6, `main deux fois plus grande a l ecran : ${small} -> ${big}`);
  assert.ok(size(hand(0.9)) <= size(hand(0.5)) + 1e-6, 'borne haute');
  assert.ok(size(hand(0.001)) > 0, 'borne basse');
});

test('solveBody : shoulderSpread ecarte les epaules autour de leur milieu et grossit l echelle', () => {
  const base = solveBody(standingBody(), VIEW, 60);
  const wide = solveBody(standingBody(), VIEW, 60, { shoulderSpread: 1.25 });
  nearVec(wide.shoulderMid, base.shoulderMid);
  near(wide.shoulderWidth, base.shoulderWidth * 1.25);
  near(wide.scale, base.scale * 1.25);
  near(wide.arms[0].shoulder[0] - wide.shoulderMid[0], (base.arms[0].shoulder[0] - base.shoulderMid[0]) * 1.25);
});

test('solveBody : poignet cache mais dans l image (main derriere la tete) : l avant-bras le rejoint', () => {
  const sk = solveBody(standingBody({ elbowL: [0.8, 0.45, 0, 0.2], wristL: [0.55, 0.3, 0.2, 0.01], pinkyL: [0.53, 0.28, 0.2, 0.01], indexL: [0.53, 0.3, 0.2, 0.01] }), VIEW, 60);
  const arm = sk.arms[0];
  assert.ok(arm.wrist[0] < arm.elbow[0], 'le poignet revient vers la tete, il ne prolonge pas le haut du bras');
  assert.ok(arm.wrist[2] < arm.elbow[2], 'et il est plus loin de la camera que le coude');
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
  assert.equal(body.torsoWidth, 1);
  assert.equal(body.shoulderSpread, 1.15);
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
  assert.ok(fs.existsSync(path.join(root, 'assets', 'camskin', 'hand_landmarker.task')));
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

test('limbFrame : pas de retournement quand le bras passe a l horizontale', () => {
  const out = [1, 0, 0];
  // Au repos (bras vers le bas) : meme repere que la pose de repos.
  const rest = limbFrame([0, 0, 0], [0, -10, 0], out);
  nearVec(rest.x, [1, 0, 0]);
  nearVec(rest.z, [0, 0, -1]);
  // Du bas vers l horizontale exterieure, par petits pas : la face arriere (+Z) ne bascule jamais brutalement.
  let prev = rest;
  for (let deg = 5; deg <= 175; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const f = limbFrame([0, 0, 0], [10 * Math.sin(a), -10 * Math.cos(a), 0], out);
    const turn = f.z[0] * prev.z[0] + f.z[1] * prev.z[1] + f.z[2] * prev.z[2];
    assert.ok(turn > 0.95, `saut du repere a ${deg} degres (${turn})`);
    nearVec(f.z, [0, 0, -1]);
    prev = f;
  }
  // Bras tendu vers la camera : toujours continu.
  const forward = limbFrame([0, 0, 0], [0, -1, 10], out);
  nearVec(forward.x, [1, 0, 0]);
});

// Main a plat face a la camera, doigts vers le haut de l'image, poignet en (x, y). `thumbSide` : +1 = pouce
// vers la droite de l'image, -1 = vers la gauche.
function flatHand(x, y, thumbSide, size = 0.1) {
  const hand = Array.from({ length: HAND_POINTS }, () => [x, y - size, 0]);
  hand[0] = [x, y, 0];
  hand[5] = [x + thumbSide * size * 0.3, y - size, 0]; // base de l'index
  hand[9] = [x, y - size, 0]; // base du majeur
  hand[17] = [x - thumbSide * size * 0.3, y - size, 0]; // base de l'auriculaire
  return hand;
}

test('sanitizeHands : forme et bornes strictes', () => {
  const hand = flatHand(0.5, 0.5, 1);
  assert.deepEqual(sanitizeHands([hand, null]), [hand, null]);
  assert.equal(sanitizeHands([hand]), null);
  assert.equal(sanitizeHands([hand.slice(1), null]), null);
  assert.equal(sanitizeHands([[...hand.slice(1), [0.5, 0.5, Number.NaN]], null]), null);
  assert.equal(sanitizeHands([[...hand.slice(1), [9, 0.5, 0]], null]), null);
  assert.equal(sanitizeHands('x'), null);
});

test('solveBody : une main suivie donne le poignet, la taille et la direction du pouce', () => {
  const hand = flatHand(0.8, 0.5, -1);
  const sk = solveBody(standingBody({ wristL: [0.8, 0.5, 0, 0.98] }), VIEW, 60, {}, [hand, null]);
  const arm = sk.arms[0];
  // Le poignet reste sur le meme pixel que la main, quelle que soit la profondeur deduite de sa taille.
  const expected = unproject(0.8, 0.5, VIEW.w, VIEW.h, 60, 63);
  near(arm.wrist[0] / arm.wrist[2], expected[0] / expected[2]);
  near(arm.wrist[1] / arm.wrist[2], expected[1] / expected[2]);
  assert.ok(arm.tip[1] > arm.wrist[1], 'doigts vers le haut');
  nearVec(arm.thumb, [-1, 0, 0]);
  assert.equal(arm.mirrored, true);
  assert.equal(sk.arms[1].thumb, null, 'pas de main suivie de l autre cote');
  // Main deux fois plus grande a l'ecran : elle est plus pres de la camera, sa taille reelle (cm) ne change pas.
  const big = solveBody(standingBody({ wristL: [0.8, 0.5, 0, 0.98] }), VIEW, 60, {}, [flatHand(0.8, 0.5, -1, 0.2), null]).arms[0];
  const size = (a) => Math.hypot(a.tip[0] - a.wrist[0], a.tip[1] - a.wrist[1], a.tip[2] - a.wrist[2]);
  assert.ok(big.wrist[2] > arm.wrist[2], 'plus pres de la camera');
  assert.ok(size(big) > 0 && size(arm) > 0);
});

test('handFrame : le pouce fixe la rotation, la main gauche est en miroir sans retourner la paume', () => {
  const up = { wrist: [0, 0, -60], tip: [0, 10, -60] };
  // Main droite, paume vers la camera : pouce vers +X de l'image.
  const right = handFrame({ ...up, thumb: [1, 0, 0], mirrored: false });
  nearVec(right.y, [0, 1, 0]);
  nearVec(right.x, [1, 0, 0]);
  assert.equal(right.mirror, 1);
  // Main gauche, paume vers la camera : pouce vers -X ; meme face du maillage vers la camera, maillage en miroir.
  const left = handFrame({ ...up, thumb: [-1, 0, 0], mirrored: true });
  nearVec(left.z, right.z);
  assert.equal(left.mirror, -1);
  // Main droite retournee (dos vers la camera) : le pouce passe de l'autre cote, la face visible change.
  const flipped = handFrame({ ...up, thumb: [-1, 0, 0], mirrored: false });
  nearVec(flipped.z, right.z.map((c) => -c));
});

test('sanitizeFace : mains validees, avec ou sans corps', () => {
  const base = {
    w: 640, h: 480, cx: 300, cy: 200, u: 60, angle: 0, jaw: 0, nose: { x: 1, y: 1 }, mouth: { x: 1, y: 1 }, look: { x: 0, y: 0 }, oval: [],
    body: Array.from({ length: 15 }, () => [0.5, 0.5, 0, 0.9])
  };
  const hands = [flatHand(0.5, 0.5, 1), null];
  assert.deepEqual(sanitizeFace({ ...base, hands }).hands, hands);
  assert.equal(sanitizeFace({ ...base, hands: [[1, 2, 3], null] }), null);
  // Mains sans corps (main seule dans le champ) : acceptees, avec le drapeau handsOnly.
  const alone = sanitizeFace({ ...base, body: undefined, hands, handsOnly: true, lost: true });
  assert.deepEqual(alone.hands, hands);
  assert.equal(alone.handsOnly, true);
  assert.equal(alone.body, undefined);
});

test('solveBody : une main qui parait plus grande est plus pres de la camera, sans jamais s y coller', () => {
  const wristZ = (size) => solveBody(standingBody({ wristL: [0.6, 0.3, 0.9, 0.98] }), VIEW, 60, {}, [flatHand(0.6, 0.3, -1, size), null]).arms[0].wrist[2];
  assert.ok(wristZ(0.12) > wristZ(0.05), 'Z moins negatif = plus pres');
  assert.ok(wristZ(0.6) <= -60 * 0.45 + 1e-6, 'borne proche : 45 % de la distance de la tete');
  assert.ok(wristZ(0.001) >= -60 * 1.5 - 1e-6, 'borne lointaine');
  const ahead = (size) => solveBody(standingBody({ wristL: [0.6, 0.3, 0.9, 0.98] }), VIEW, 60, {}, [flatHand(0.6, 0.3, -1, size), null]).arms[0].handAhead;
  assert.ok(ahead(0.25) > 0, 'grande main : devant le visage');
  assert.ok(ahead(0.03) < 0, 'petite main : derriere le plan du visage');
  assert.equal(solveBody(standingBody(), VIEW, 60).arms[0].handAhead, null);
});

test('clearTorso : un point enfoui dans le torse est avance vers la camera sur le meme pixel', () => {
  // Torse a 60 cm, face a la camera : +Y vers le bas, +Z (ventre) vers la camera.
  const torso = { position: [0, 10, -60], x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, 1] };
  const shape = { halfWidth: 20, front: 15, top: -5, bottom: 45 };
  const buried = [5, -10, -58];
  const out = clearTorso(buried, torso, shape, 6);
  assert.ok(out[2] > buried[2] + 5, 'plus pres de la camera');
  near(out[0] / out[2], buried[0] / buried[2]);
  near(out[1] / out[2], buried[1] / buried[2]);
  assert.ok(out[2] - torso.position[2] >= 15, 'devant la surface du ventre');
  // Deja devant, a cote du torse, ou franchement derriere (main dans le dos) : inchange.
  assert.deepEqual(clearTorso([5, -10, -30], torso, shape, 6), [5, -10, -30]);
  assert.deepEqual(clearTorso([40, -10, -58], torso, shape, 6), [40, -10, -58]);
  assert.deepEqual(clearTorso([5, -10, -85], torso, shape, 6), [5, -10, -85]);
});

test('solveBody : avec l ecart des yeux, une paume aussi grande que cet ecart est a la profondeur de la tete', () => {
  // flatHand : paume = `size` en hauteur d'image ; en largeur d'image : size * h / w.
  const palm = (0.1 * VIEW.h) / VIEW.w;
  const arm = (eyeSpan) => solveBody(standingBody({ wristL: [0.6, 0.3, 0.9, 0.98] }), VIEW, 60, { eyeSpan }, [flatHand(0.6, 0.3, -1, 0.1), null]).arms[0];
  near(arm(palm).handAhead, 0);
  assert.ok(arm(palm * 1.5).handAhead < 0, 'main plus petite que prevu : derriere');
  assert.ok(arm(palm * 0.7).handAhead > 0, 'main plus grande que prevu : devant');
});

test('solveBody : une main n est derriere la tete que si la taille ET le modele du corps le disent', () => {
  const small = flatHand(0.6, 0.3, -1, 0.03); // parait petite : la taille seule la dirait loin derriere
  const ahead = (wristZ) => solveBody(standingBody({ wristL: [0.6, 0.3, wristZ, 0.98] }), VIEW, 60, {}, [small, null]).arms[0];
  // Le modele du corps la voit au niveau de la tete (main vue par la tranche, collee a la joue) : pas derriere.
  near(ahead(0).handAhead, 0);
  assert.ok(ahead(0).handAheadSize < -10);
  // Les deux la voient derriere : elle l'est.
  assert.ok(ahead(0.3).handAhead < -10);
});

test('solveHands : main seule placee sur son pixel, profondeur deduite de sa taille', () => {
  const [left, right] = solveHands([flatHand(0.3, 0.6, 1, 0.1), null], VIEW);
  assert.equal(right, null);
  assert.equal(left.mirrored, true);
  nearVec(left.thumb, [1, 0, 0]);
  assert.ok(left.tip[1] > left.wrist[1], 'doigts vers le haut');
  const expected = unproject(0.3, 0.6, VIEW.w, VIEW.h, 60, 63);
  near(left.wrist[0] / left.wrist[2], expected[0] / expected[2]);
  near(left.wrist[1] / left.wrist[2], expected[1] / expected[2]);
  // Une main deux fois plus grande a l'ecran est deux fois plus pres ; sa taille en cm ne change pas.
  const [big] = solveHands([flatHand(0.3, 0.6, 1, 0.2), null], VIEW);
  near(big.wrist[2] / left.wrist[2], 0.5, 0.02);
  const size = (a) => Math.hypot(a.tip[0] - a.wrist[0], a.tip[1] - a.wrist[1], a.tip[2] - a.wrist[2]);
  near(size(big), size(left), 0.05);
  assert.deepEqual(solveHands(null, VIEW), [null, null]);
});

test('solveArms : seul ce qui est reellement vu du bras est rendu', () => {
  const hand = flatHand(0.3, 0.6, 1, 0.1);
  // Main suivie, coude et epaule bien vus : bras complet, rattache au poignet de la main.
  const full = solveArms(standingBody({ shoulderL: [0.7, 0.2, 0, 0.99], elbowL: [0.5, 0.4, 0, 0.95], wristL: [0.3, 0.6, 0, 0.95] }), [hand, null], VIEW)[0];
  assert.ok(full.shoulder && full.elbow && full.thumb);
  near(full.elbow[2], full.wrist[2], 1e-6);
  // Epaule hors de l'image : pas de haut du bras, l'avant-bras reste.
  const noShoulder = solveArms(standingBody({ shoulderL: [1.2, 0.2, 0, 0.99], elbowL: [0.5, 0.4, 0, 0.95], wristL: [0.3, 0.6, 0, 0.95] }), [hand, null], VIEW)[0];
  assert.equal(noShoulder.shoulder, null);
  assert.ok(noShoulder.elbow);
  // Coude peu visible : pas de haut du bras (meme si l'epaule est vue) ; l'avant-bras prolonge la main.
  const handOnly = solveArms(standingBody({ shoulderL: [0.7, 0.2, 0, 0.99], elbowL: [0.5, 0.4, 0, 0.2], wristL: [0.3, 0.6, 0, 0.95] }), [hand, null], VIEW)[0];
  assert.equal(handOnly.shoulder, null);
  assert.ok(handOnly.elbow[1] < handOnly.wrist[1], 'avant-bras suppose a l oppose des doigts (doigts vers le haut)');
  // Sans main suivie : le poignet et le coude du modele du corps suffisent, la patte prolonge l'avant-bras.
  const poseOnly = solveArms(standingBody({ elbowL: [0.5, 0.4, 0, 0.95], wristL: [0.3, 0.6, 0, 0.95] }), null, VIEW, { defaultDepth: 80 })[0];
  near(poseOnly.wrist[2], -80);
  assert.equal(poseOnly.thumb, null);
  assert.ok(poseOnly.tip[0] < poseOnly.wrist[0], 'la patte prolonge le bras');
  // Rien de vu de ce cote, ou aucun corps : pas de bras ; une main sans corps garde sa patte.
  assert.equal(solveArms(standingBody({ wristR: [0.3, 1.4, 0, 0.9] }), null, VIEW)[1], null);
  assert.ok(solveArms(null, [hand, null], VIEW)[0].thumb);
  assert.deepEqual(solveArms(null, null, VIEW), [null, null]);
});

test('isPlausibleBody : rejette un corps fantome (buste ecrase ou epaules minuscules)', () => {
  const aspect = VIEW.w / VIEW.h;
  assert.equal(isPlausibleBody(standingBody(), aspect), true);
  // Fantome vu sur un avant-bras : epaules larges, hanches bien "visibles" juste dessous.
  const ghost = standingBody({ shoulderL: [0.64, 0.3, 0, 0.9], shoulderR: [0.49, 0.28, 0, 0.9], hipL: [0.66, 0.37, 0, 0.9], hipR: [0.5, 0.4, 0, 0.9] });
  assert.equal(isPlausibleBody(ghost, aspect), false);
  // Meme buste court mais hanches non visibles (hors champ, cas normal assis) : accepte.
  const seated = standingBody({ hipL: [0.6, 0.7, 0, 0.1], hipR: [0.4, 0.7, 0, 0.1] });
  assert.equal(isPlausibleBody(seated, aspect), true);
  assert.equal(isPlausibleBody(standingBody({ shoulderL: [0.51, 0.62, 0, 0.99], shoulderR: [0.49, 0.62, 0, 0.99] }), aspect), false);
});

test('manifeste : le bloc de la patte (hand, armRadius, front) a des defauts neutres et des bornes', () => {
  const body = normalizeSkinManifest({ model: 'a.glb', body: { model: 'b.glb' } }).body;
  assert.deepEqual(body.hand, { palmReach: 1.35, knuckleReach: 1.85, reach: 1.45, min: 0.7, max: 2.6, palmCm: 9.5, bracelet: 0.8, palmSide: 1 });
  assert.equal(body.armRadius, 6);
  assert.deepEqual(body.front, { onCm: 10, offCm: 16 });
  const custom = normalizeSkinManifest({ model: 'a.glb', body: { model: 'b.glb', armRadius: 99, front: { onCm: -5 }, hand: { palmReach: 2, palmSide: -1, bracelet: 50, max: 0 } } }).body;
  assert.equal(custom.hand.palmReach, 2);
  assert.equal(custom.hand.palmSide, -1);
  assert.equal(custom.hand.bracelet, 2, 'borne haute');
  assert.equal(custom.hand.max, 1, 'borne basse');
  assert.equal(custom.armRadius, 40);
  assert.equal(custom.front.onCm, 0);
  assert.equal(normalizeSkinManifest({ model: 'a.glb', body: { model: 'b.glb', hand: { palmSide: 7 } } }).body.hand.palmSide, 1, 'seul -1 inverse');
});

test('handFrame : palmSide inverse la face montree a la camera', () => {
  const arm = { wrist: [0, 0, -60], tip: [0, 10, -60], thumb: [1, 0, 0], mirrored: false };
  const normal = handFrame(arm);
  const flipped = handFrame(arm, -1);
  assert.equal(normal.mirror, 1);
  assert.equal(flipped.mirror, -1);
  nearVec(flipped.z, normal.z.map((c) => -c));
});
