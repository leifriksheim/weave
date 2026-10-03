import { CryptoProvider, CryptoKeyPairResult } from '../types.js';
import { base64UrlEncode, bytesToHex } from '../utils/encoding.js';
import { bufferSource } from '../utils/guards.js';
import { hkdf } from './hkdf.js';
import { p256 } from '@noble/curves/nist.js';

/** 48 bytes: the 32-byte group order plus 16 more, so reducing mod n is unbiased */
const P256_SEED_BYTES = 48;

/** Domain separation for identity keys. Changing it changes every derived DID. */
const P256_KEY_INFO = new TextEncoder().encode('weave/p256-identity-key/v1');

/** Public keys imported for verifying, by their bytes as hex; the oldest let go first */
const publicKeys = new Map<string, Promise<CryptoKey>>();
const MAX_PUBLIC_KEYS = 1000;

/** Creates a CryptoProvider using the Web Crypto API with ECDSA P-256. */
export function createP256Provider(): CryptoProvider {
  return Object.freeze({
    algorithm: 'ECDSA-P256',

    async generateKeyPair(): Promise<CryptoKeyPairResult> {
      const keyPair = await globalThis.crypto.subtle.generateKey(
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        // Not extractable: a script that gets into the page can sign with the
        // key while it is there, but cannot carry it off and keep signing.
        // The public half exports regardless.
        false,
        ['sign', 'verify'],
      );

      return Object.freeze({
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
      });
    },

    async deriveKeyPairFromSeed(seed: Uint8Array): Promise<CryptoKeyPairResult> {
      // HKDF stretches the seed to the 48 bytes FIPS 186-5 (appendix A.2) asks
      // for, and noble reduces them to a scalar in [1, n-1] with negligible bias.
      // Web Crypto can sign with a scalar but cannot compute its public point,
      // which is the one step noble supplies.
      const expanded = await hkdf(seed, P256_KEY_INFO, P256_SEED_BYTES);
      const secretKey = p256.utils.randomSecretKey(expanded);
      const point = p256.getPublicKey(secretKey, false); // 0x04 ‖ x ‖ y

      const x = base64UrlEncode(point.subarray(1, 33));
      const y = base64UrlEncode(point.subarray(33, 65));
      const d = base64UrlEncode(secretKey);

      const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const;

      const privateKey = await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x, y, d, ext: false, key_ops: ['sign'] },
        algorithm,
        false,
        ['sign'],
      );

      const publicKey = await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x, y, ext: true, key_ops: ['verify'] },
        algorithm,
        true,
        ['verify'],
      );

      return Object.freeze({ publicKey, privateKey });
    },

    async sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
      const signature = await globalThis.crypto.subtle.sign(
        {
          name: 'ECDSA',
          hash: { name: 'SHA-256' },
        },
        privateKey,
        bufferSource(data),
      );
      return new Uint8Array(signature);
    },

    async verify(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
      return await globalThis.crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: { name: 'SHA-256' },
        },
        publicKey,
        bufferSource(signature),
        bufferSource(data),
      );
    },

    /** The 33-byte compressed point — the form did:key specifies for P-256. */
    async exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
      const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key));
      return p256.Point.fromBytes(raw).toBytes(true);
    },

    /**
     * Accepts a compressed or uncompressed point; Web Crypto only reliably
     * imports the latter. Decompressing costs a square root, and a space's
     * records are signed by few keys, so each is imported once.
     */
    importPublicKey(bytes: Uint8Array): Promise<CryptoKey> {
      const id = bytesToHex(bytes);
      let found = publicKeys.get(id);
      if (!found) {
        found = globalThis.crypto.subtle.importKey(
          'raw',
          bufferSource(p256.Point.fromBytes(bytes).toBytes(false)),
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify'],
        );
        publicKeys.set(id, found);
        found.catch(() => publicKeys.delete(id));
        if (publicKeys.size > MAX_PUBLIC_KEYS) publicKeys.delete(publicKeys.keys().next().value!);
      }
      return found;
    },

    async importPrivateKey(bytes: Uint8Array): Promise<CryptoKey> {
      return await globalThis.crypto.subtle.importKey(
        'pkcs8',
        bufferSource(bytes),
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        false,
        ['sign'],
      );
    },
  });
}
