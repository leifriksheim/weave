/**
 * @module recovery-code
 * A PRF-free way to anchor an identity: 128 bits of entropy the user can write
 * down, type on another device, and derive the exact same root key from.
 *
 * Encoded in Crockford base32 — no padding, no ambiguity between 0/O or 1/I/L,
 * and case-insensitive, so it survives being copied by hand.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford's substitutions for characters people confuse when transcribing. */
const SUBSTITUTIONS: Record<string, string> = { O: '0', I: '1', L: '1', U: 'V' };

/** 128 bits: 16 bytes, 26 base32 characters, shown in groups of four. */
const SEED_BYTES = 16;

/** How many bytes a seed is. Anything else cannot be written as a code. */
export const RECOVERY_SEED_BYTES = SEED_BYTES;

/**
 * Generates a fresh seed.
 * @returns 128 bits of entropy, ready to derive an identity from
 */
export function generateSeed(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SEED_BYTES));
}

/**
 * Writes a seed out as a code a person can copy.
 *
 * The inverse of {@link recoveryCodeToSeed} — which matters once the seed is
 * kept wrapped rather than written down, because showing the user their code
 * then means encoding a seed that already exists rather than minting one.
 *
 * @param seed The seed bytes
 * @returns A grouped code such as `K7M2-9QPX-...`
 */
export function seedToRecoveryCode(seed: Uint8Array): string {
  if (seed.length !== SEED_BYTES) {
    throw new Error(`A recovery code carries exactly ${SEED_BYTES} bytes, not ${seed.length}.`);
  }
  return formatRecoveryCode(encodeBase32(seed));
}

/**
 * Generates a fresh recovery code.
 * @returns A grouped code such as `K7M2-9QPX-...`
 */
export function generateRecoveryCode(): string {
  return seedToRecoveryCode(generateSeed());
}

/**
 * Strips formatting and resolves look-alike characters.
 * @param code A code as typed by a user
 * @returns The canonical, ungrouped form
 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .split('')
    .map((char) => SUBSTITUTIONS[char] ?? char)
    .join('');
}

/**
 * Checks whether a code could decode to a seed.
 * @param code A code as typed by a user
 * @returns Whether it is well formed
 */
export function isValidRecoveryCode(code: string): boolean {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== Math.ceil((SEED_BYTES * 8) / 5)) return false;
  return normalized.split('').every((char) => ALPHABET.includes(char));
}

/**
 * Decodes a recovery code into the seed bytes it stands for.
 * @param code A code as typed by a user
 * @returns The seed, ready for key derivation
 */
export function recoveryCodeToSeed(code: string): Uint8Array {
  const normalized = normalizeRecoveryCode(code);
  if (!isValidRecoveryCode(code)) {
    throw new Error('That recovery code is not valid — check for a missing or mistyped character.');
  }

  const bytes = new Uint8Array(SEED_BYTES);
  let buffer = 0;
  let bitsInBuffer = 0;
  let index = 0;

  for (const char of normalized) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char);
    bitsInBuffer += 5;
    if (bitsInBuffer >= 8 && index < SEED_BYTES) {
      bitsInBuffer -= 8;
      bytes[index++] = (buffer >> bitsInBuffer) & 0xff;
    }
  }

  return bytes;
}

/** Groups a code into readable blocks of four. */
function formatRecoveryCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join('-');
}

/** Encodes bytes as Crockford base32, most significant bit first. */
function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bitsInBuffer = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      out += ALPHABET[(buffer >> bitsInBuffer) & 0x1f];
    }
  }

  if (bitsInBuffer > 0) {
    out += ALPHABET[(buffer << (5 - bitsInBuffer)) & 0x1f];
  }

  return out;
}
