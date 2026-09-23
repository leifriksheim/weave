import { CryptoProvider, CryptoKeyPairResult } from '../types.js';
import { base64UrlEncode } from '../utils/encoding.js';
import { scalarMultBase, seedToScalar, fieldToBytes } from './p256-curve.js';

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
        true,
        ['sign', 'verify']
      );

      return Object.freeze({
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey
      });
    },

    async deriveKeyPairFromSeed(seed: Uint8Array): Promise<CryptoKeyPairResult> {
      const scalar = seedToScalar(seed);
      const point = scalarMultBase(scalar);

      const x = base64UrlEncode(fieldToBytes(point.x));
      const y = base64UrlEncode(fieldToBytes(point.y));
      const d = base64UrlEncode(fieldToBytes(scalar));

      const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const;

      const privateKey = await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x, y, d, ext: true, key_ops: ['sign'] },
        algorithm,
        true,
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

    async exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
      const exported = await globalThis.crypto.subtle.exportKey('raw', key);
      return new Uint8Array(exported);
    },

    async importPublicKey(bytes: Uint8Array): Promise<CryptoKey> {
      return await globalThis.crypto.subtle.importKey(
        'raw',
        bytes as BufferSource,
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
        true,
        ['sign']
      );
    }
  });
}
