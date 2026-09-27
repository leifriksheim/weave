/**
 * Identity tests — deterministic key derivation, DID round-trips, and
 * signature verification over the derived keys.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../src/identity/did.js';
import { p256 } from '@noble/curves/nist.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { utf8Encode, base64UrlEncode, base64UrlDecode } from '../src/utils/encoding.js';

const provider = createP256Provider();

describe('P-256 keys', () => {
  test('noble computes the same public point Web Crypto does', async () => {
    // Web Crypto can sign with a scalar but not compute its public point, so
    // derived keys rely on noble for that one step. The two must agree.
    for (let i = 0; i < 5; i++) {
      const pair = await globalThis.crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
      const point = p256.getPublicKey(base64UrlDecode(jwk.d!), false);

      assert.equal(base64UrlEncode(point.subarray(1, 33)), jwk.x);
      assert.equal(base64UrlEncode(point.subarray(33, 65)), jwk.y);
    }
  });

  test('public keys export compressed and import either way', async () => {
    const pair = await provider.generateKeyPair();
    const compressed = await provider.exportPublicKey(pair.publicKey);
    assert.equal(compressed.length, 33);

    const message = utf8Encode('hello');
    const signature = await provider.sign(pair.privateKey, message);
    const fromCompressed = await provider.importPublicKey(compressed);
    const fromFull = await provider.importPublicKey(p256.Point.fromBytes(compressed).toBytes(false));
    assert.equal(await provider.verify(fromCompressed, signature, message), true);
    assert.equal(await provider.verify(fromFull, signature, message), true);
  });

  test('reads the did:key specification\'s P-256 example', async () => {
    // https://w3c-ccg.github.io/did-key-spec/#p-256
    const did = 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169';
    const { publicKeyBytes, multicodecPrefix } = didToPublicKey(did);
    assert.deepEqual(multicodecPrefix, P256_MULTICODEC);
    assert.equal(publicKeyBytes.length, 33);
    await provider.importPublicKey(publicKeyBytes); // a valid point, or this throws
    assert.equal(publicKeyToDid(publicKeyBytes, P256_MULTICODEC), did);
  });
});

describe('deriveKeyPairFromSeed', () => {
  test('is deterministic and produces a usable signing key', async () => {
    const seed = utf8Encode('a seed with enough entropy for a test');

    const first = await provider.deriveKeyPairFromSeed(seed);
    const second = await provider.deriveKeyPairFromSeed(seed);

    const firstBytes = await provider.exportPublicKey(first.publicKey);
    const secondBytes = await provider.exportPublicKey(second.publicKey);
    assert.deepEqual(firstBytes, secondBytes);

    // The public half must actually verify what the private half signs
    const message = utf8Encode('hello');
    const signature = await provider.sign(first.privateKey, message);
    assert.equal(await provider.verify(second.publicKey, signature, message), true);
  });

  test('different seeds produce different keys', async () => {
    const a = await provider.deriveKeyPairFromSeed(utf8Encode('seed-a'));
    const b = await provider.deriveKeyPairFromSeed(utf8Encode('seed-b'));
    assert.notDeepEqual(
      await provider.exportPublicKey(a.publicKey),
      await provider.exportPublicKey(b.publicKey),
    );
  });
});

describe('derivation is frozen', () => {
  // HKDF-SHA256 → 48 bytes → noble's FIPS 186-5 reduction → compressed did:key.
  // If any of these change, every existing account silently becomes a
  // different identity — fine before release, never after.
  const golden: ReadonlyArray<readonly [Uint8Array, string]> = [
    [new Uint8Array(16), 'did:key:zDnaebsZZSYuq5oaFMhu2qAaAygqtwPtZwuiVJpjenjA9GwQE'],
    [new Uint8Array(16).fill(0xff), 'did:key:zDnaexDGpQByMfPbsypSPAewepYNqS1yerAq5pEpDZwAmFQWS'],
    [Uint8Array.from({ length: 16 }, (_, i) => i * 17), 'did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr'],
  ];

  test('known seeds derive their recorded DIDs', async () => {
    for (const [seed, did] of golden) {
      assert.equal((await createIdentityManager().fromSeed(seed)).did, did);
    }
  });

  test('a known recovery code derives its recorded DID', async () => {
    const identity = await createIdentityManager().fromRecoveryCode('K7N6-ERYP-68TZ-A7HN-VJW3-QWKN-CG');
    assert.equal(identity.did, 'did:key:zDnaeUvx3uMBwitdxXZoqFuvYEqWuuXeEzGb3TLqkbShhPcPR');
  });
});

describe('did:key', () => {
  test('round-trips a public key', async () => {
    const pair = await provider.generateKeyPair();
    const bytes = await provider.exportPublicKey(pair.publicKey);
    const did = publicKeyToDid(bytes, P256_MULTICODEC);

    assert.match(did, /^did:key:z/);
    const parsed = didToPublicKey(did);
    assert.deepEqual(parsed.publicKeyBytes, bytes);
    assert.deepEqual(parsed.multicodecPrefix, P256_MULTICODEC);
  });
});

describe('identity manager', () => {
  test('the same password yields the same DID', async () => {
    const manager = createIdentityManager();
    const a = await manager.fromPassword('correct horse battery staple');
    const b = await manager.fromPassword('correct horse battery staple');
    const other = await manager.fromPassword('a different password');

    assert.equal(a.did, b.did);
    assert.notEqual(a.did, other.did);
  });

  test('expressions signed by an identity verify against its DID', async () => {
    const manager = createIdentityManager();
    const identity = await manager.fromPassword('correct horse battery staple');
    const signer = createSigner(provider);

    const unsigned = createExpression({
      author: identity.did,
      collection: 'app.test.note',
      body: { text: 'signed by a derived key' },
    });
    const signed = await signer.sign(unsigned, identity.privateKey);

    // A verifier who only has the DID must be able to check the signature
    const { publicKeyBytes } = didToPublicKey(signed.author);
    const publicKey = await provider.importPublicKey(publicKeyBytes);
    assert.equal(await signer.verify(signed, publicKey), true);

    const tampered = { ...signed, body: { text: 'tampered' } };
    assert.equal(await signer.verify(tampered, publicKey), false);
  });
});
