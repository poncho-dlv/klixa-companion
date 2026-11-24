import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToken, setToken, urlMatchesBase, resolveOverlayUrlUpdate } from '../src/integrations/obs.js';

const BASE = 'https://overlays.klixa.live';

test('urlMatchesBase: ne matche que les URLs de l\'origine overlay', () => {
  assert.equal(urlMatchesBase(`${BASE}/Alerts/?wsToken=abc`, BASE), true);
  assert.equal(urlMatchesBase(`${BASE}/Alerts/`, `${BASE}/`), true); // base avec slash final
  assert.equal(urlMatchesBase('https://autre.site/Alerts/', BASE), false);
  assert.equal(urlMatchesBase('https://overlays.klixa.live.attacker.example/Alerts/', BASE), false);
  assert.equal(urlMatchesBase('http://overlays.klixa.live/Alerts/', BASE), false);
  assert.equal(urlMatchesBase(`${BASE}/x`, ''), false);
});

test('urlMatchesBase: respecte la frontière du chemin configuré', () => {
  assert.equal(urlMatchesBase(`${BASE}/overlays/alerts`, `${BASE}/overlays`), true);
  assert.equal(urlMatchesBase(`${BASE}/overlays-other/alerts`, `${BASE}/overlays`), false);
});

test('extractToken: lit wsToken/overlayToken/token', () => {
  assert.equal(extractToken(`${BASE}/Alerts/?wsToken=abc`), 'abc');
  assert.equal(extractToken(`${BASE}/Alerts/?overlayToken=def`), 'def');
  assert.equal(extractToken(`${BASE}/Alerts/?token=ghi`), 'ghi');
  assert.equal(extractToken(`${BASE}/Alerts/`), '');
});

test('setToken: remplace le paramètre existant en conservant le reste', () => {
  const out = setToken(`${BASE}/Alerts/?wsToken=old&foo=1`, 'new');
  assert.equal(extractToken(out), 'new');
  assert.ok(out.includes('foo=1'));
});

test('setToken: ajoute wsToken si absent', () => {
  const out = setToken(`${BASE}/Alerts/`, 'tok');
  assert.equal(extractToken(out), 'tok');
  assert.ok(out.includes('wsToken=tok'));
});

test('setToken: préserve le paramètre overlayToken si c\'est lui qui est présent', () => {
  const out = setToken(`${BASE}/Alerts/?overlayToken=old`, 'new');
  assert.ok(out.includes('overlayToken=new'));
  assert.ok(!out.includes('wsToken='));
});

test('resolveOverlayUrlUpdate: skip une URL hors origine overlay', () => {
  const r = resolveOverlayUrlUpdate('https://autre.site/x?wsToken=old', BASE, 'new');
  assert.equal(r.action, 'skip');
});

test('resolveOverlayUrlUpdate: skip une URL vide', () => {
  assert.equal(resolveOverlayUrlUpdate('', BASE, 'new').action, 'skip');
});

test('resolveOverlayUrlUpdate: ok quand le token est déjà bon', () => {
  const r = resolveOverlayUrlUpdate(`${BASE}/Alerts/?wsToken=new`, BASE, 'new');
  assert.equal(r.action, 'ok');
});

test('resolveOverlayUrlUpdate: update réécrit le token sur une source overlay', () => {
  const r = resolveOverlayUrlUpdate(`${BASE}/Alerts/?wsToken=old`, BASE, 'new');
  assert.equal(r.action, 'update');
  assert.equal(extractToken(r.url), 'new');
});

import { overlayIdFromUrl, buildSceneItems } from '../src/integrations/obs.js';

test('overlayIdFromUrl: id d\'overlay en minuscules, jamais le token', () => {
  assert.equal(overlayIdFromUrl(`${BASE}/Alerts/?wsToken=secret`, BASE), 'alerts');
  assert.equal(overlayIdFromUrl(`${BASE}/Mascot/`, `${BASE}/`), 'mascot');
  assert.equal(overlayIdFromUrl('https://autre.site/Alerts/', BASE), '');
  assert.equal(overlayIdFromUrl(`${BASE}/`, BASE), '');
});

test('buildSceneItems: classe les sources, ne fuit ni URL ni token', () => {
  const out = buildSceneItems({
    sceneName: 'Live',
    canvas: { baseWidth: 1920, baseHeight: 1080 },
    items: [
      { sourceName: 'Alertes', sceneItemId: 1, sceneItemEnabled: true, inputKind: 'browser_source',
        sceneItemTransform: { positionX: 100, positionY: 50, scaleX: 0.5, scaleY: 0.5, sourceWidth: 1920, sourceHeight: 1080, alignment: 5 } },
      { sourceName: 'Web', sceneItemId: 2, inputKind: 'browser_source', sceneItemTransform: {} },
      { sourceName: 'Cam', sceneItemId: 3, sceneItemEnabled: false, inputKind: 'dshow_input', sceneItemTransform: {} }
    ],
    inputs: {
      Alertes: { url: `${BASE}/Alerts/?wsToken=secret`, width: 1920, height: 1080 },
      Web: { url: 'https://exemple.org/?wsToken=secret' }
    }
  }, BASE);
  assert.deepEqual(out.canvas, { width: 1920, height: 1080 });
  assert.equal(out.currentScene, 'Live');
  assert.deepEqual(out.items.map((i) => i.kind), ['overlay', 'browser', 'other']);
  assert.equal(out.items[0].overlay, 'alerts');
  assert.equal(out.items[0].transform.scaleX, 0.5);
  assert.equal(out.items[2].enabled, false);
  assert.ok(!JSON.stringify(out).includes('secret'));
  assert.ok(!JSON.stringify(out).includes('http'));
});
