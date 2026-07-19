import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveNetworkKeys, decryptNetworkPdu, encryptNetworkPdu } from '../src/integrations/smallrig/network-layer.js';

const NET_KEY = Buffer.from('f7a2a44f8e8a8029064f173ddc1e2b00', 'hex');

test('deriveNetworkKeys: NID/EncryptionKey/PrivacyKey/NetworkID cohérents', () => {
  const keys = deriveNetworkKeys(NET_KEY);
  assert.ok(keys.nid >= 0 && keys.nid <= 0x7f);
  assert.equal(keys.encryptionKey.length, 16);
  assert.equal(keys.privacyKey.length, 16);
  assert.equal(keys.networkId.length, 8);
});

test('Network PDU: round-trip chiffrement/déchiffrement (message d\'accès, MIC 4)', () => {
  const keys = deriveNetworkKeys(NET_KEY);
  const transportPdu = Buffer.from('e45d0033040000006464', 'hex'); // trame HSI vendor exemple
  const pdu = encryptNetworkPdu({
    ...keys, ivi: 0, ivIndex: 0, ctl: false, ttl: 5, seq: 42, src: 0x0002, dst: 0xc001, transportPdu
  });

  const decoded = decryptNetworkPdu({ ...keys, ivIndex: 0, pdu });
  assert.equal(decoded.ctl, false);
  assert.equal(decoded.ttl, 5);
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.src, 0x0002);
  assert.equal(decoded.dst, 0xc001);
  assert.deepEqual(decoded.transportPdu, transportPdu);
});

test('Network PDU: round-trip message de contrôle (CTL=1, MIC 8)', () => {
  const keys = deriveNetworkKeys(NET_KEY);
  const transportPdu = Buffer.from('0a0b0c', 'hex');
  const pdu = encryptNetworkPdu({
    ...keys, ivi: 1, ivIndex: 7, ctl: true, ttl: 0, seq: 99, src: 0x0001, dst: 0xffff, transportPdu
  });
  const decoded = decryptNetworkPdu({ ...keys, ivIndex: 7, pdu });
  assert.equal(decoded.ctl, true);
  assert.equal(decoded.ivi, 1);
  assert.deepEqual(decoded.transportPdu, transportPdu);
});

test('Network PDU: NID différent -> rejeté sans tenter le déchiffrement', () => {
  const keys = deriveNetworkKeys(NET_KEY);
  const otherKeys = deriveNetworkKeys(Buffer.alloc(16, 0x11));
  const pdu = encryptNetworkPdu({
    ...keys, ivi: 0, ivIndex: 0, ctl: false, ttl: 5, seq: 1, src: 1, dst: 2, transportPdu: Buffer.from([1, 2, 3])
  });
  assert.throws(() => decryptNetworkPdu({ ...otherKeys, ivIndex: 0, pdu }), /UNKNOWN_NID|NID inconnu/);
});

test('Network PDU: IVIndex différent -> échec d\'authentification (nonce faux)', () => {
  const keys = deriveNetworkKeys(NET_KEY);
  const pdu = encryptNetworkPdu({
    ...keys, ivi: 0, ivIndex: 0, ctl: false, ttl: 5, seq: 1, src: 1, dst: 2, transportPdu: Buffer.from([1, 2, 3])
  });
  assert.throws(() => decryptNetworkPdu({ ...keys, ivIndex: 1, pdu }));
});
