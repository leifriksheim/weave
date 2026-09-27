import { CryptoProvider, CryptoKeyPairResult } from '../types.js';
import { base64UrlEncode } from '../utils/encoding.js';
import { p256 } from '@noble/curves/nist.js';

/** 48 bytes: the 32-byte group order plus 16 more, so reducing mod n is unbiased */
const P256_SEED_BYTES = 48;

/** Domain separation for identity keys. Changing it changes every derived DID. */
const P256_KEY_INFO = new TextEncoder().encode('weave/p256-identity-key/v1');

/** HKDF-SHA256 with an empty salt: the seed is already uniformly random. */
async function hkdf(ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Creates a CryptoProvider using the Web Crypto API with ECDSA P-256.
 * @returns {CryptoProvider} A crypto provider implementation for ECDSA P-256.
 */
export function createP256Provider(): CryptoProvider {
  return Object.freeze({
    algorithm: 'ECDSA-P256',

    async generateKeyPair(): Promise<CryptoKeyPairResult> {
      const keyPair = await globalThis.crypto.subtle.generateKey(
        {
          name: 'ECDSA',
          namedCurve: 'P-256'
        },
        // Not extractable: a script that gets into the page can sign with the
        // key while it is there, but cannot carry it off and keep signing.
        // The public half exports regardless.
        false,
        ['sign', 'verify']
      );

      return Object.freeze({
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey
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
        ['sign']
      );

      const publicKey = await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x, y, ext: true, key_ops: ['verify'] },
        algorithm,
        true,
        ['verify']
      );

      return Object.freeze({ publicKey, privateKey });
    },

    async sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
      const signature = await globalThis.crypto.subtle.sign(
        {
          name: 'ECDSA',
          hash: { name: 'SHA-256' }
        },
        privateKey,
        data as BufferSource
      );
      return new Uint8Array(signature);
    },

    async verify(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
      return await globalThis.crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: { name: 'SHA-256' }
        },
        publicKey,
        signature as BufferSource,
        data as BufferSource
      );
    },

    /** The 33-byte compressed point — the form did:key specifies for P-256. */
    async exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
      const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key));
      return p256.Point.fromBytes(raw).toBytes(true);
    },

    /** Accepts a compressed or uncompressed point; Web Crypto only reliably imports the latter. */
    async importPublicKey(bytes: Uint8Array): Promise<CryptoKey> {
      const uncompressed = p256.Point.fromBytes(bytes).toBytes(false);
      return await globalThis.crypto.subtle.importKey(
        'raw',
        uncompressed as BufferSource,
        {
          name: 'ECDSA',
          namedCurve: 'P-256'
        },
        true,
        ['verify']
      );
    },

    async importPrivateKey(bytes: Uint8Array): Promise<CryptoKey> {
      return await globalThis.crypto.subtle.importKey(
        'pkcs8',
        bytes as BufferSource,
        {
          name: 'ECDSA',
          namedCurve: 'P-256'
        },
        false,
        ['sign']
      );
    }
  });
}
