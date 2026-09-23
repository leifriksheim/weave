/**
 * @module p256-curve
 * Minimal secp256r1 (NIST P-256) scalar multiplication.
 *
 * Web Crypto can import and use keys but cannot turn a private scalar into its
 * public point, which is exactly what deterministic key derivation needs: a
 * seed becomes a scalar, and the scalar has to yield the matching public key.
 * These are the few lines of curve arithmetic required to close that gap —
 * public-key derivation only, no signing or verification (Web Crypto does that).
 */

/** Field prime */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
/** Group order */
export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** Base point */
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

/** A point in Jacobian coordinates: x = X/Z², y = Y/Z³. Z = 0 is the point at infinity. */
interface JacobianPoint {
  readonly X: bigint;
  readonly Y: bigint;
  readonly Z: bigint;
}

const INFINITY: JacobianPoint = { X: 1n, Y: 1n, Z: 0n };

/** Reduces into [0, P). */
function mod(value: bigint): bigint {
  const result = value % P;
  return result < 0n ? result + P : result;
}

/** Modular exponentiation, used for inversion via Fermat's little theorem. */
function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

/** Point doubling (a = -3 formulas). */
function double(point: JacobianPoint): JacobianPoint {
  const { X, Y, Z } = point;
  if (Z === 0n || Y === 0n) return INFINITY;

  const delta = mod(Z * Z);
  const gamma = mod(Y * Y);
  const beta = mod(X * gamma);
  const alpha = mod(3n * mod((X - delta) * (X + delta)));
  const X3 = mod(alpha * alpha - 8n * beta);
  const Z3 = mod(mod((Y + Z) * (Y + Z)) - gamma - delta);
  const Y3 = mod(alpha * mod(4n * beta - X3) - 8n * mod(gamma * gamma));

  return { X: X3, Y: Y3, Z: Z3 };
}

/** Point addition in Jacobian coordinates. */
function add(p1: JacobianPoint, p2: JacobianPoint): JacobianPoint {
  if (p1.Z === 0n) return p2;
  if (p2.Z === 0n) return p1;

  const Z1Z1 = mod(p1.Z * p1.Z);
  const Z2Z2 = mod(p2.Z * p2.Z);
  const U1 = mod(p1.X * Z2Z2);
  const U2 = mod(p2.X * Z1Z1);
  const S1 = mod(p1.Y * p2.Z * Z2Z2);
  const S2 = mod(p2.Y * p1.Z * Z1Z1);

  const H = mod(U2 - U1);
  const r = mod(2n * mod(S2 - S1));

  if (H === 0n) {
    return r === 0n ? double(p1) : INFINITY;
  }

  const I = mod(mod(2n * H) * mod(2n * H));
  const J = mod(H * I);
  const V = mod(U1 * I);
  const X3 = mod(r * r - J - 2n * V);
  const Y3 = mod(r * mod(V - X3) - 2n * mod(S1 * J));
  const Z3 = mod(mod(mod((p1.Z + p2.Z) * (p1.Z + p2.Z)) - Z1Z1 - Z2Z2) * H);

  return { X: X3, Y: Y3, Z: Z3 };
}

/**
 * Multiplies the base point by a scalar.
 * @param scalar A private scalar in [1, N-1]
 * @returns The affine public point
 */
export function scalarMultBase(scalar: bigint): { readonly x: bigint; readonly y: bigint } {
  if (scalar <= 0n || scalar >= N) {
    throw new Error('Scalar out of range for P-256');
  }

  let result = INFINITY;
  let addend: JacobianPoint = { X: GX, Y: GY, Z: 1n };

  for (let k = scalar; k > 0n; k >>= 1n) {
    if (k & 1n) result = add(result, addend);
    addend = double(addend);
  }

  if (result.Z === 0n) {
    throw new Error('Scalar multiplication produced the point at infinity');
  }

  const zInv = modPow(result.Z, P - 2n);
  const zInv2 = mod(zInv * zInv);
  return {
    x: mod(result.X * zInv2),
    y: mod(result.Y * zInv2 * zInv),
  };
}

/**
 * Maps arbitrary seed bytes onto a valid private scalar in [1, N-1].
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
