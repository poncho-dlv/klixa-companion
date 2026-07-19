import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aesCcmDecrypt,
  aesCcmEncrypt,
  aesCmac,
  computeSharedSecret,
  generateProvisioningKeyPair,
  k1,
  k2,
  k3,
  k4,
  s1
} from '../src/integrations/smallrig/mesh-crypto.js';

const RFC4493_KEY = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
const RFC4493_MSG = Buffer.from(
  '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52ef' +
  'f69f2445df4f9b17ad2b417be66c3710',
  'hex'
);

test('aesCmac: vecteurs officiels RFC 4493 §4', () => {
  assert.equal(aesCmac(RFC4493_KEY, Buffer.alloc(0)).toString('hex'), 'bb1d6929e95937287fa37d129b756746');
  assert.equal(aesCmac(RFC4493_KEY, RFC4493_MSG.subarray(0, 16)).toString('hex'), '070a16b46b4d4144f79bdd9dd04a287c');
  assert.equal(aesCmac(RFC4493_KEY, RFC4493_MSG.subarray(0, 40)).toString('hex'), 'dfa66747de9ae63030ca32611497c827');
  assert.equal(aesCmac(RFC4493_KEY, RFC4493_MSG.subarray(0, 64)).toString('hex'), '51f0bebf7e3b9d92fc49741779363cfe');
});

test('s1: longueur de sortie 16 octets, déterministe', () => {
  const out = s1('test');
  assert.equal(out.length, 16);
  assert.deepEqual(out, s1('test'));
  assert.notDeepEqual(out, s1('autre'));
});

test('k2: NID sur 7 bits, EncryptionKey/PrivacyKey 16 octets chacune, déterministe', () => {
  const netKey = Buffer.from('f7a2a44f8e8a8029064f173ddc1e2b00', 'hex');
  const { nid, encryptionKey, privacyKey } = k2(netKey, Buffer.from([0x00]));
  assert.ok(nid >= 0 && nid <= 0x7f);
  assert.equal(encryptionKey.length, 16);
  assert.equal(privacyKey.length, 16);
  const again = k2(netKey, Buffer.from([0x00]));
  assert.deepEqual(again, { nid, encryptionKey, privacyKey });
});

test('k3: Network ID sur 8 octets', () => {
  const netKey = Buffer.from('f7a2a44f8e8a8029064f173ddc1e2b00', 'hex');
  const id = k3(netKey);
  assert.equal(id.length, 8);
});

test('k4: AID sur 6 bits (0..63)', () => {
  const appKey = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff));
  const aid = k4(appKey);
  assert.ok(aid >= 0 && aid <= 0x3f);
});

test('k1: dérive une clé de session déterministe de 16 octets', () => {
  const secret = Buffer.alloc(32, 0xab);
  const salt = s1(Buffer.from('ConfirmationSalt-test'));
  const derived = k1(secret, salt, Buffer.from('prsk'));
  assert.equal(derived.length, 16);
  assert.deepEqual(derived, k1(secret, salt, Buffer.from('prsk')));
});

test('AES-CCM: round-trip chiffrement/déchiffrement, MIC 4 et 8 octets', () => {
  const key = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const nonce = Buffer.from('00112233445566778899aabbcc', 'hex'); // 13 octets
  const plaintext = Buffer.from('e45d0033040000006464', 'hex');

  for (const micLength of [4, 8]) {
    const { ciphertext, mic } = aesCcmEncrypt(key, nonce, plaintext, micLength);
    assert.equal(mic.length, micLength);
    assert.notDeepEqual(ciphertext, plaintext);
    const decrypted = aesCcmDecrypt(key, nonce, ciphertext, mic, micLength);
    assert.deepEqual(decrypted, plaintext);
  }
});

test('AES-CCM: un MIC altéré fait échouer le déchiffrement (authentification)', () => {
  const key = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const nonce = Buffer.from('00112233445566778899aabbcc', 'hex');
  const { ciphertext, mic } = aesCcmEncrypt(key, nonce, Buffer.from('hello mesh'), 4);
  const tampered = Buffer.from(mic);
  tampered[0] ^= 0xff;
  assert.throws(() => aesCcmDecrypt(key, nonce, ciphertext, tampered, 4));
});

test('ECDH P-256: les deux parties dérivent le même secret partagé', () => {
  const alice = generateProvisioningKeyPair();
  const bob = generateProvisioningKeyPair();
  assert.equal(alice.publicKeyXY.length, 64);
  assert.equal(bob.publicKeyXY.length, 64);

  const secretFromAlice = computeSharedSecret(alice.ecdh, bob.publicKeyXY);
  const secretFromBob = computeSharedSecret(bob.ecdh, alice.publicKeyXY);
  assert.equal(secretFromAlice.length, 32);
  assert.deepEqual(secretFromAlice, secretFromBob);
});
