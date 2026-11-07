import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLEND_NAMES, isBlendName, normalizeSkinManifest, resolveModelUrl, jawAngle, gazeAngles, breathValue, poseHoldWeight, smoothingFactor, sanitizePoseAndBlend
} from '../src/integrations/camskin/web/skin-manifest.js';

const skinDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'camskin', 'skins', 'dragon');

test('BLEND_NAMES : 51 blendshapes MediaPipe uniques, sans _neutral', () => {
  assert.equal(BLEND_NAMES.length, 51);
  assert.equal(new Set(BLEND_NAMES).size, 51);
  assert.ok(isBlendName('jawOpen'));
  assert.ok(!isBlendName('_neutral'));
});

test('normalizeSkinManifest : valeurs par defaut', () => {
  const m = normalizeSkinManifest({ model: 'x.glb' });
  assert.deepEqual(m.position, [0, 0, 0]);
  assert.equal(m.scale, 1);
  assert.equal(m.occluder.enabled, true);
  assert.equal(m.jaw, null);
  assert.equal(m.morphGain, 1);
});

test('normalizeSkinManifest : bornes et rejets', () => {
  assert.equal(normalizeSkinManifest({ model: 'a.glb', transform: { scale: 9999 } }).scale, 100);
  assert.deepEqual(normalizeSkinManifest({ model: 'a.glb', transform: { position: [500, 0, -500] } }).position, [100, 0, -100]);
  assert.equal(normalizeSkinManifest({ model: 'a.glb', occluder: { enabled: false } }).occluder.enabled, false);
  assert.deepEqual(normalizeSkinManifest({ model: 'a.glb', occluder: { radii: [-3, 0, 4] } }).occluder.radii, [3, 0.5, 4]);
  for (const bad of [null, [], {}, { model: 5 }, { model: '../x.glb' }, { model: 'x.png' }, { model: 'a/../b.glb' },
    { model: 'a.glb', transform: { position: [1, 2] } }, { model: 'a.glb', transform: { scale: 'x' } },
    { model: 'a.glb', jaw: {} }, { model: 'a.glb', jaw: { node: 'J', axis: [0, 0, 0] } }]) {
    assert.throws(() => normalizeSkinManifest(bad), undefined, JSON.stringify(bad));
  }
});

test('normalizeSkinManifest : machoire et idempotence', () => {
  const once = normalizeSkinManifest({ model: 'a.glb', jaw: { node: 'Jaw', maxAngleDeg: 500 } });
  assert.deepEqual(once.jaw, { node: 'Jaw', axis: [1, 0, 0], maxAngleDeg: 90, gain: 1, lipGain: 4, curve: 0.7 });
  assert.equal(normalizeSkinManifest({ model: 'a.glb', jaw: { node: 'Jaw', gain: 99 } }).jaw.gain, 8);
  assert.equal(normalizeSkinManifest({ model: 'a.glb', jaw: { node: 'Jaw', gain: 0 } }).jaw.gain, 0.1);
  // Le manifeste normalise (position/rotation/scale a plat) est rejoue par patchManifest.
  const again = normalizeSkinManifest({ ...once, transform: { position: once.position, rotation: once.rotation, scale: once.scale } });
  assert.deepEqual(again, once);
});

test('resolveModelUrl : reste sous /models/', () => {
  assert.equal(resolveModelUrl('/models/skins/dragon/manifest.json', 'dragon.glb'), '/models/skins/dragon/dragon.glb');
  assert.equal(resolveModelUrl('/models/skins/dragon/manifest.json', '/models/shared/x.glb'), '/models/shared/x.glb');
  assert.throws(() => resolveModelUrl('/models/skins/dragon/manifest.json', '/vendor/x.glb'));
  assert.throws(() => resolveModelUrl('/models/skins/dragon/manifest.json', '../../../vendor/x.glb'));
  assert.throws(() => resolveModelUrl('/models/skins/dragon/manifest.json', 'http://evil.example/models/x.glb'));
});

test('jawAngle et smoothingFactor', () => {
  const jaw = { node: 'J', axis: [1, 0, 0], maxAngleDeg: 20 };
  assert.equal(jawAngle(0, jaw), 0);
  assert.ok(Math.abs(jawAngle(1, jaw) - (20 * Math.PI) / 180) < 1e-9);
  assert.equal(jawAngle(5, jaw), jawAngle(1, jaw));
  assert.equal(jawAngle(1, null), 0);
  // Le gain amplifie l'ouverture mesuree (plafonnee a 1).
  const boosted = { ...jaw, gain: 3 };
  assert.ok(Math.abs(jawAngle(0.2, boosted) - jawAngle(0.6, jaw)) < 1e-9);
  assert.equal(jawAngle(0.9, boosted), jawAngle(1, jaw));
  assert.equal(smoothingFactor(0, 0.04), 1);
  const slow = smoothingFactor(0.016, 0.04);
  const fast = smoothingFactor(0.1, 0.04);
  assert.ok(slow > 0 && slow < fast && fast < 1);
});

test('sanitizePoseAndBlend : absents acceptes, mal formes refuses', () => {
  assert.deepEqual(sanitizePoseAndBlend({}), {});
  assert.equal(sanitizePoseAndBlend({ pose: [1] }), null);
  assert.equal(sanitizePoseAndBlend({ blend: { jawOpen: -0.1 } }), null);
  const tooMany = Object.fromEntries([...BLEND_NAMES, 'jawOpen2'].map((n) => [n, 0]));
  assert.equal(sanitizePoseAndBlend({ blend: tooMany }), null);
});

test('skin dragon : manifeste valide et modele glTF binaire coherent', () => {
  const manifest = normalizeSkinManifest(JSON.parse(fs.readFileSync(path.join(skinDir, 'manifest.json'), 'utf8')));
  const glb = fs.readFileSync(path.join(skinDir, manifest.model));
  assert.equal(glb.toString('ascii', 0, 4), 'glTF');
  assert.equal(glb.readUInt32LE(8), glb.length, 'longueur declaree = taille reelle');
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
  assert.ok(json.nodes.some((n) => n.name === manifest.jaw.node), 'le noeud de machoire du manifeste existe dans le modele');
});

test('normalizeSkinManifest : suivi du regard (eyes)', () => {
  const m = normalizeSkinManifest({ model: 'a.glb', eyes: { left: 'EyeL', right: 'EyeR' } });
  assert.deepEqual(m.eyes, { left: 'EyeL', right: 'EyeR', maxYawDeg: 28, maxPitchDeg: 20, gain: 1.3 });
  assert.equal(normalizeSkinManifest({ model: 'a.glb', eyes: { left: 'EyeL' } }).eyes.right, null);
  assert.throws(() => normalizeSkinManifest({ model: 'a.glb', eyes: {} }));
  assert.equal(normalizeSkinManifest({ model: 'a.glb' }).eyes, null);
  const again = normalizeSkinManifest({ ...m, transform: { position: m.position, rotation: m.rotation, scale: m.scale } });
  assert.deepEqual(again.eyes, m.eyes);
});

test('gazeAngles : yaw vers +X pour "Out" a gauche et "In" a droite, pitch negatif vers le haut', () => {
  const eyes = { left: 'L', right: 'R', maxYawDeg: 30, maxPitchDeg: 20, gain: 1 };
  assert.deepEqual(gazeAngles({}, 'left', eyes), { yaw: 0, pitch: -0 });
  const toLeft = { eyeLookOutLeft: 1, eyeLookInRight: 1 };
  assert.ok(gazeAngles(toLeft, 'left', eyes).yaw > 0, 'oeil gauche, regard a gauche : +X');
  assert.ok(gazeAngles(toLeft, 'right', eyes).yaw > 0, 'oeil droit, regard a gauche : +X aussi');
  assert.ok(Math.abs(gazeAngles(toLeft, 'left', eyes).yaw - (30 * Math.PI) / 180) < 1e-9);
  const up = { eyeLookUpLeft: 1 };
  assert.ok(gazeAngles(up, 'left', eyes).pitch < 0);
  assert.ok(gazeAngles({ eyeLookDownLeft: 1 }, 'left', eyes).pitch > 0);
  // Le gain amplifie mais le resultat reste borne a l'angle maximal.
  assert.ok(Math.abs(gazeAngles({ eyeLookOutLeft: 1 }, 'left', { ...eyes, gain: 5 }).yaw - (30 * Math.PI) / 180) < 1e-9);
  assert.deepEqual(gazeAngles({ eyeLookOutLeft: 1 }, 'left', null), { yaw: 0, pitch: 0 });
});

test('normalizeSkinManifest : respiration (breath) et texture de peau', () => {
  const m = normalizeSkinManifest({ model: 'a.glb', breath: { morph: 'nostrilBreath' }, texture: { materials: ['peau'] } });
  assert.deepEqual(m.breath, { morph: 'nostrilBreath', periodSec: 3.6, amount: 0.6 });
  assert.deepEqual(m.texture, { materials: ['peau'], scale: 1, blotch: 0.45, bump: 0.35, scales: 0 });
  assert.equal(normalizeSkinManifest({ model: 'a.glb' }).breath, null);
  assert.equal(normalizeSkinManifest({ model: 'a.glb' }).texture, null);
  assert.equal(normalizeSkinManifest({ model: 'a.glb', breath: { morph: 'x', periodSec: 99, amount: 5 } }).breath.periodSec, 12);
  assert.equal(normalizeSkinManifest({ model: 'a.glb', breath: { morph: 'x', amount: 5 } }).breath.amount, 1);
  for (const bad of [{ breath: {} }, { breath: { morph: '' } }, { texture: {} }, { texture: { materials: [] } }, { texture: { materials: [3] } }]) {
    assert.throws(() => normalizeSkinManifest({ model: 'a.glb', ...bad }), undefined, JSON.stringify(bad));
  }
  const again = normalizeSkinManifest({ ...m, transform: { position: m.position, rotation: m.rotation, scale: m.scale } });
  assert.deepEqual([again.breath, again.texture], [m.breath, m.texture]);
});

test('breathValue : oscillation douce entre 0 et amount, periodique', () => {
  const breath = { morph: 'x', periodSec: 4, amount: 0.6 };
  assert.equal(breathValue(0, null), 0);
  assert.ok(Math.abs(breathValue(0, breath) - 0.3) < 1e-9);
  assert.ok(Math.abs(breathValue(1, breath) - 0.6) < 1e-9, 'sommet a un quart de periode');
  assert.ok(Math.abs(breathValue(3, breath)) < 1e-9, 'creux a trois quarts de periode');
  assert.ok(Math.abs(breathValue(4, breath) - breathValue(0, breath)) < 1e-9);
  for (let t = 0; t < 10; t += 0.37) assert.ok(breathValue(t, breath) >= -1e-9 && breathValue(t, breath) <= 0.6 + 1e-9);
});

test('jawAngle : ecart des levres (lip), zone morte et courbe', () => {
  const jaw = { node: 'J', axis: [1, 0, 0], maxAngleDeg: 30, gain: 1, lipGain: 4, curve: 1 };
  assert.equal(jawAngle(0, jaw, 0), 0);
  assert.equal(jawAngle(0, jaw, 0.015), 0, 'sous la zone morte : levres fermees');
  // Petite ouverture : jawOpen reste faible (0.05) mais les levres sont nettement ecartees.
  const small = jawAngle(0.05, jaw, 0.1);
  assert.ok(small > jawAngle(0.05, jaw, 0) * 3, 'la mesure des levres prend le relais');
  assert.ok(Math.abs(small - ((0.08 * 4 * 30 * Math.PI) / 180)) < 1e-9);
  // Le plus grand des deux l'emporte (pas de somme).
  assert.equal(jawAngle(0.5, jaw, 0.05), jawAngle(0.5, jaw, 0));
  // Une courbe < 1 amplifie les faibles ouvertures sans changer le maximum.
  const curved = { ...jaw, curve: 0.5 };
  assert.ok(jawAngle(0.1, curved, 0) > jawAngle(0.1, jaw, 0));
  assert.ok(Math.abs(jawAngle(1, curved, 0) - jawAngle(1, jaw, 0)) < 1e-9);
  assert.equal(jawAngle(0.4, { node: 'J', axis: [1, 0, 0], maxAngleDeg: 20 }, undefined), jawAngle(0.4, { node: 'J', axis: [1, 0, 0], maxAngleDeg: 20, gain: 1 }, 0));
});

test('normalizeSkinManifest : stabilize et morphGains', () => {
  assert.equal(normalizeSkinManifest({ model: 'a.glb' }).stabilize, null);
  assert.deepEqual(normalizeSkinManifest({ model: 'a.glb', stabilize: {} }).stabilize, { noseHold: 0.85 });
  assert.equal(normalizeSkinManifest({ model: 'a.glb', stabilize: { noseHold: 9 } }).stabilize.noseHold, 1);
  assert.deepEqual(normalizeSkinManifest({ model: 'a.glb' }).morphGains, {});
  assert.deepEqual(normalizeSkinManifest({ model: 'a.glb', morphGains: { eyeBlinkLeft: 1.6, noseSneerRight: 99 } }).morphGains, { eyeBlinkLeft: 1.6, noseSneerRight: 6 });
  assert.throws(() => normalizeSkinManifest({ model: 'a.glb', morphGains: { inconnu: 2 } }));
  assert.throws(() => normalizeSkinManifest({ model: 'a.glb', morphGains: [1] }));
});

test('poseHoldWeight : monte avec le froncement de nez, nul sans stabilisation', () => {
  const stab = { noseHold: 0.8 };
  assert.equal(poseHoldWeight({}, stab), 0);
  assert.equal(poseHoldWeight({ noseSneerLeft: 0.05 }, stab), 0, 'sous le seuil');
  assert.equal(poseHoldWeight({ noseSneerLeft: 1 }, stab), 0.8, 'plafonne a noseHold');
  const mid = poseHoldWeight({ noseSneerRight: 0.21 }, stab);
  assert.ok(mid > 0 && mid < 0.8);
  assert.equal(poseHoldWeight({ noseSneerLeft: 1 }, null), 0);
  assert.equal(poseHoldWeight(undefined, stab), 0);
});

test('sanitizePoseAndBlend : lip borne', () => {
  assert.deepEqual(sanitizePoseAndBlend({ lip: 0.12 }), { lip: 0.12 });
  assert.equal(sanitizePoseAndBlend({ lip: -1 }), null);
  assert.equal(sanitizePoseAndBlend({ lip: 99 }), null);
  assert.equal(sanitizePoseAndBlend({ lip: 'x' }), null);
});
