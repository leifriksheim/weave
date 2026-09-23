/**
 * @module p256-curve
 * Turns a seed into a P-256 private scalar and computes its public point.
 *
 * Web Crypto can import and use keys but cannot turn a private scalar into its
 * public point, which is exactly what deterministic key derivation needs: a
 * seed becomes a scalar, and the scalar has to yield the matching public key.
 * The curve arithmetic comes from `@noble/curves` (audited, dependency-free);
 * only the seed → scalar mapping lives here, because it is part of how every
 * DID is derived and must never change.
 */
import { p256 } from '@noble/curves/nist.js';

/** Group order */
export const N: bigint = p256.Point.Fn.ORDER;

/**
 * Multiplies the base point by a scalar.
 * @param scalar A private scalar in [1, N-1]
 * @returns The affine public point
 */
export function scalarMultBase(scalar: bigint): { readonly x: bigint; readonly y: bigint } {
  if (scalar <= 0n || scalar >= N) {
    throw new Error('Scalar out of range for P-256');
  }
  const { x, y } = p256.Point.BASE.multiply(scalar).toAffine();
  return { x, y };
}

/**
 * Maps arbitrary seed bytes onto a valid private scalar in [1, N-1].
 *
 * Load-bearing: changing this changes every derived DID. `tests/identity.test.ts`
 * pins known seeds to known DIDs to catch that.
 * @param seed The seed bytes (32 bytes recommended)
 * @returns A usable private scalar
 */
export function seedToScalar(seed: Uint8Array): bigint {
  let value = 0n;
  for (const byte of seed) {
    value = (value << 8n) | BigInt(byte);
  }
  return (value % (N - 1n)) + 1n;
}

/**
 * Encodes a field element as a fixed-width 32-byte big-endian array.
 * @param value The value to encode
 * @returns 32 bytes
 */
export function fieldToBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}
