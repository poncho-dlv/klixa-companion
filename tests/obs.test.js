import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToken, setToken, urlMatchesBase } from '../src/integrations/obs.js';

const BASE = 'https://overlays.klixa.live';

test('urlMatchesBase: ne matche que les URLs de l\'origine overlay', () => {
  assert.equal(urlMatchesBase(`${BASE}/Alerts/?wsToken=abc`, BASE), true);
  assert.equal(urlMatchesBase(`${BASE}/Alerts/`, `${BASE}/`), true); // base avec slash final
  assert.equal(urlMatchesBase('https://autre.site/Alerts/', BASE), false);
  assert.equal(urlMatchesBase(`${BASE}/x`, ''), false);
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
