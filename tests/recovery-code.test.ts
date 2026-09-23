/**
 * Recovery code tests — the PRF-free path to a root identity.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  isValidRecoveryCode,
  recoveryCodeToSeed,
} from '../src/identity/recovery-code.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';

describe('recovery codes', () => {
  test('generates well-formed, distinct codes', () => {
    const codes = new Set(Array.from({ length: 20 }, generateRecoveryCode));
    assert.equal(codes.size, 20);
    for (const code of codes) {
      assert.equal(isValidRecoveryCode(code), true, code);
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{2,4})+$/);
    }
  });

  test('survives sloppy transcription', () => {
    const code = generateRecoveryCode();
    const seed = recoveryCodeToSeed(code);

    // lower case, spaces instead of dashes, and the classic O/0 and I/1 slips
    const mangled = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'O').replace(/1/g, 'l');
    assert.deepEqual(recoveryCodeToSeed(mangled), seed);
    assert.equal(normalizeRecoveryCode(mangled), normalizeRecoveryCode(code));
  });

  test('rejects a truncated or corrupted code', () => {
    const code = generateRecoveryCode();
    assert.equal(isValidRecoveryCode(code.slice(0, 10)), false);
    assert.equal(isValidRecoveryCode(`${code}XX`), false);
    assert.throws(() => recoveryCodeToSeed('not-a-code'), /not valid/i);
  });

  test('derives a stable identity', async () => {
    const manager = createIdentityManager();
    const code = generateRecoveryCode();

    const first = await manager.fromRecoveryCode(code);
    const second = await manager.fromRecoveryCode(code.toLowerCase().replace(/-/g, ''));
    const other = await manager.fromRecoveryCode(generateRecoveryCode());

    assert.equal(first.did, second.did);
    assert.notEqual(first.did, other.did);
    assert.match(first.did, /^did:key:z/);
  });
});
