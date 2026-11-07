// Genere le modele PROVISOIRE du skin "dragon" (cornes, crete, machoire articulee) sans aucune
// dependance : ecrit un .glb et son manifeste dans assets/camskin/skins/dragon/.
// Sert a valider la chaine 3D (pose, occluder, machoire). A remplacer par un vrai modele
// (Blender -> glTF binaire) : il suffit de deposer le .glb et d'ajuster manifest.json.
//
// Usage : node scripts/make-placeholder-skin.mjs
//
// Unites : centimetres, repere "visage canonique" de MediaPipe (+Y haut, +Z vers l'avant).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'camskin', 'skins', 'dragon');

/** Cone de base circulaire (axe +Y), normales lisses sur le flanc, disque de base. */
function cone(radius, height, segments = 20) {
  const pos = [];
  const nor = [];
  const idx = [];
  const slope = radius / height;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const len = Math.hypot(c, slope, s);
    pos.push(c * radius, 0, s * radius, 0, height, 0);
    nor.push(c / len, slope / len, s / len, c / len, slope / len, s / len);
  }
  for (let i = 0; i < segments; i++) idx.push(i * 2, i * 2 + 1, (i + 1) * 2);
  const base = pos.length / 3;
  pos.push(0, 0, 0);
  nor.push(0, -1, 0);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pos.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    nor.push(0, -1, 0);
  }
  for (let i = 0; i < segments; i++) idx.push(base, base + 2 + i, base + 1 + i);
  return { pos, nor, idx };
}

/** Quaternion [x,y,z,w] d'une rotation `deg` autour d'un axe unitaire. */
function quat(axis, deg) {
  const h = (deg * Math.PI) / 360;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
function mul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

const materials = [
  { name: 'corne', pbrMetallicRoughness: { baseColorFactor: [0.93, 0.86, 0.62, 1], metallicFactor: 0, roughnessFactor: 0.55 } },
  { name: 'crete', pbrMetallicRoughness: { baseColorFactor: [0.75, 0.16, 0.12, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
  { name: 'menton', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.55, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.6 } }
];

// [nom, geometrie, materiau, position, quaternion]
const parts = [];
for (const side of [-1, 1]) {
  // Cornes : partent du haut du front, vers l'arriere et l'exterieur.
  const q = mul(quat([0, 0, 1], -side * 28), quat([1, 0, 0], -32));
  parts.push([side < 0 ? 'CorneGauche' : 'CorneDroite', cone(1.5, 10, 20), 0, [side * 4.6, 8.2, 1.5], q]);
}
[[0, 11.2, 0.5, 3.5], [0, 10.6, -2.6, 3], [0, 9.2, -5.4, 2.4]].forEach(([x, y, z, h], i) => {
  parts.push([`Crete${i + 1}`, cone(0.9, h, 14), 1, [x, y, z], quat([1, 0, 0], -50 - i * 12)]);
});
// Machoire : le noeud est charniere pres des oreilles ; la geometrie (pique de menton, cone
// retourne vers le bas) est decalee par rapport a l'origine du noeud pour pivoter avec lui.
const jawPivot = [0, -3.2, 0.5];
const chin = cone(1.2, 3.5, 16);
for (let i = 0; i < chin.pos.length; i += 3) {
  chin.pos[i + 1] = -chin.pos[i + 1] - 7.5 - jawPivot[1];
  chin.pos[i + 2] += 4.2 - jawPivot[2];
  chin.nor[i + 1] = -chin.nor[i + 1];
}
for (let i = 0; i < chin.idx.length; i += 3) [chin.idx[i + 1], chin.idx[i + 2]] = [chin.idx[i + 2], chin.idx[i + 1]];
parts.push(['Jaw', chin, 2, jawPivot, [0, 0, 0, 1]]);

// --- Assemblage glTF binaire ---------------------------------------------------------------
const buffers = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];
function addBuffer(typed, target) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
  buffers.push(padded);
  byteLength += padded.length;
  return bufferViews.length - 1;
}
function addAccessor(view, componentType, count, type, extra = {}) {
  accessors.push({ bufferView: view, componentType, count, type, ...extra });
  return accessors.length - 1;
}

const meshes = [];
const nodes = [];
const sceneNodes = [];
for (const [name, geo, material, position, rotation] of parts) {
  const positions = new Float32Array(geo.pos);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  const aPos = addAccessor(addBuffer(positions, 34962), 5126, positions.length / 3, 'VEC3', { min, max });
  const aNor = addAccessor(addBuffer(new Float32Array(geo.nor), 34962), 5126, geo.nor.length / 3, 'VEC3');
  const aIdx = addAccessor(addBuffer(new Uint16Array(geo.idx), 34963), 5123, geo.idx.length, 'SCALAR');
  meshes.push({ name, primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor }, indices: aIdx, material }] });
  nodes.push({ name, mesh: meshes.length - 1, translation: position, rotation });
  sceneNodes.push(nodes.length - 1);
}
nodes.push({ name: 'Dragon', children: sceneNodes });

const json = {
  asset: { version: '2.0', generator: 'klixa make-placeholder-skin' },
  scene: 0,
  scenes: [{ nodes: [nodes.length - 1] }],
  nodes,
  meshes,
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength }]
};
const jsonBytes = Buffer.from(JSON.stringify(json));
const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
const binChunk = Buffer.concat(buffers);
const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const chunkHeader = (length, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(length, 0);
  b.write(type, 4, 'ascii');
  return b;
};
const glb = Buffer.concat([header, chunkHeader(jsonChunk.length, 'JSON'), jsonChunk, chunkHeader(binChunk.length, 'BIN\0'), binChunk]);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'dragon.glb'), glb);

const manifestPath = path.join(outDir, 'manifest.json');
// Ne pas ecraser un manifeste deja calibre.
if (!fs.existsSync(manifestPath)) {
  const manifest = {
    model: 'dragon.glb',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    occluder: { enabled: true, position: [0, 0, -3], radii: [7, 9.5, 8] },
    jaw: { node: 'Jaw', axis: [1, 0, 0], maxAngleDeg: 22 }
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`dragon.glb : ${glb.length} octets (${parts.length} pieces)`);
