import crypto from 'node:crypto';

// Primitives cryptographiques Bluetooth Mesh Profile 1.0.1 (Annexe 8) : AES-CMAC
// (RFC 4493), les dérivations s1/k1/k2/k3/k4, AES-CCM, et l'échange ECDH P-256 du
// provisioning. Aucune de ces fonctions ne dépend du matériel Bluetooth : elles sont
// testées unitairement (tests/smallrig-mesh-crypto.test.js), cf. RM75_SPEC_DEV.md §3.

const ZERO16 = Buffer.alloc(16);
const RB = 0x87n; // constante de génération de sous-clé CMAC (RFC 4493 §2.3)

function aesEcbEncryptBlock(key, block) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

// Un seul bloc AES-128-ECB (16 octets) — utilisé pour l'obfuscation d'en-tête réseau
// (PECB, cf. RM75_SPEC_DEV.md §5), en plus de CMAC en interne.
export const aesEcbEncrypt = aesEcbEncryptBlock;

function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function leftShiftOneBit(buf) {
  const out = Buffer.alloc(buf.length);
  let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const value = (buf[i] << 1) | carry;
    out[i] = value & 0xff;
    carry = (value >> 8) & 1;
  }
  return out;
}

function generateSubkeys(key) {
  const l = aesEcbEncryptBlock(key, ZERO16);
  const msb = l[0] & 0x80;
  let k1 = leftShiftOneBit(l);
  if (msb) k1[15] ^= Number(RB);
  const msb1 = k1[0] & 0x80;
  let k2 = leftShiftOneBit(k1);
  if (msb1) k2[15] ^= Number(RB);
  return { k1, k2 };
}

// AES-CMAC (RFC 4493), clé 128 bits, message de longueur quelconque (y compris vide).
export function aesCmac(key, message) {
  const { k1, k2 } = generateSubkeys(key);
  const n = message.length === 0 ? 1 : Math.ceil(message.length / 16);
  const lastBlockComplete = message.length !== 0 && message.length % 16 === 0;

  let lastBlock;
  if (lastBlockComplete) {
    lastBlock = xorBuffers(message.subarray((n - 1) * 16, n * 16), k1);
  } else {
    const remainder = message.subarray((n - 1) * 16);
    const padded = Buffer.concat([remainder, Buffer.from([0x80]), Buffer.alloc(16 - remainder.length - 1)]);
    lastBlock = xorBuffers(padded, k2);
  }

  let x = ZERO16;
  for (let i = 0; i < n - 1; i++) {
    const block = message.subarray(i * 16, (i + 1) * 16);
    x = aesEcbEncryptBlock(key, xorBuffers(x, block));
  }
  return aesEcbEncryptBlock(key, xorBuffers(x, lastBlock));
}

// s1(M) = AES-CMAC(ZERO, M)
export function s1(message) {
  return aesCmac(ZERO16, Buffer.isBuffer(message) ? message : Buffer.from(message));
}

// k1(N, SALT, P) = AES-CMAC(AES-CMAC(SALT, N), P)
export function k1(n, salt, p) {
  const t = aesCmac(salt, n);
  return aesCmac(t, p);
}

function bufConcat(...parts) {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}

// k2(N, P) -> { nid, encryptionKey, privacyKey } (dérivation des clés réseau depuis la NetKey)
export function k2(n, p) {
  const salt = s1(Buffer.from('smk2', 'ascii'));
  const t = aesCmac(salt, n);
  const t1 = aesCmac(t, bufConcat(p, Buffer.from([0x01])));
  const t2 = aesCmac(t, bufConcat(t1, p, Buffer.from([0x02])));
  const t3 = aesCmac(t, bufConcat(t2, p, Buffer.from([0x03])));
  const full = bufConcat(t1, t2, t3); // 48 octets, on garde les 33 derniers (1 + 16 + 16)
  const relevant = full.subarray(full.length - 33);
  return {
    nid: relevant[0] & 0x7f,
    encryptionKey: relevant.subarray(1, 17),
    privacyKey: relevant.subarray(17, 33)
  };
}

// k3(N) -> Network ID (8 octets)
export function k3(n) {
  const salt = s1(Buffer.from('smk3', 'ascii'));
  const t = aesCmac(salt, n);
  const full = aesCmac(t, Buffer.from('id64\x01', 'binary'));
  return full.subarray(full.length - 8);
}

// k4(N) -> AID (6 bits, dérivé de l'AppKey)
export function k4(n) {
  const salt = s1(Buffer.from('smk4', 'ascii'));
  const t = aesCmac(salt, n);
  const full = aesCmac(t, Buffer.from('id6\x01', 'binary'));
  return full[full.length - 1] & 0x3f;
}

// AES-CCM générique (network/upper-transport, sans AAD). `nonce` = 13 octets,
// `micLength` = 4 ou 8 selon la couche (network: 4/8 selon CTL, access: 4, device: 4).
export function aesCcmEncrypt(key, nonce, plaintext, micLength = 4) {
  const cipher = crypto.createCipheriv('aes-128-ccm', key, nonce, { authTagLength: micLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mic = cipher.getAuthTag();
  return { ciphertext, mic };
}

export function aesCcmDecrypt(key, nonce, ciphertext, mic, micLength = 4) {
  const decipher = crypto.createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: micLength });
  decipher.setAuthTag(mic);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Échange ECDH P-256 du provisioning (FIPS P-256, cf. §4 RM75_SPEC_DEV.md).
export function generateProvisioningKeyPair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const uncompressed = ecdh.getPublicKey(); // 0x04 || X(32) || Y(32)
  return {
    ecdh,
    publicKeyXY: uncompressed.subarray(1) // X(32) || Y(32), format attendu par le PDU Public Key
  };
}

// Recompose une clé publique 0x04||X||Y à partir des 64 octets X||Y reçus du device.
export function computeSharedSecret(ecdh, peerPublicKeyXY) {
  const uncompressed = Buffer.concat([Buffer.from([0x04]), peerPublicKeyXY]);
  return ecdh.computeSecret(uncompressed); // coordonnée X (32 octets)
}

export function randomBytes(length) {
  return crypto.randomBytes(length);
}
