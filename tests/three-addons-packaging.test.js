import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const jsm = path.join(path.dirname(require.resolve('three')), '..', 'examples', 'jsm');
const RELATIVE_IMPORT = /from\s*['"](\.[^'"]+)['"]/g;

// electron-builder exclut `examples` des node_modules : tout addon servi par le compagnon
// (et ses imports relatifs, recursivement) doit etre liste dans extraResources.
test('les addons three.js servis (GLTFLoader et dependances) sont tous embarques', () => {
  const shipped = new Set(pkg.build.extraResources.map((r) => r.to.replace(/^three-addons\//, '')));
  const seen = new Set();
  const queue = ['loaders/GLTFLoader.js'];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    assert.ok(shipped.has(rel), `${rel} manque dans build.extraResources`);
    const source = fs.readFileSync(path.join(jsm, rel), 'utf8');
    for (const [, spec] of source.matchAll(RELATIVE_IMPORT)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  }
});
