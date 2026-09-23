/**
 * Identity tests — deterministic key derivation, DID round-trips, and
 * signature verification over the derived keys.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../src/identity/did.js';
import { scalarMultBase, seedToScalar, fieldToBytes } from '../src/identity/p256-curve.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { utf8Encode, base64UrlEncode } from '../src/utils/encoding.js';

const provider = createP256Provider();

describe('p256-curve', () => {
  test('derives the same public point Web Crypto does', async () => {
    // Generate a key pair with Web Crypto, then recompute its public point from
    // the private scalar alone — the two must agree.
    for (let i = 0; i < 5; i++) {
      const pair = await globalThis.crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);

      const d = BigInt('0x' + Buffer.from(jwk.d!, 'base64url').toString('hex'));
      const point = scalarMultBase(d);

      assert.equal(base64UrlEncode(fieldToBytes(point.x)), jwk.x);
      assert.equal(base64UrlEncode(fieldToBytes(point.y)), jwk.y);
    }
  });

  test('maps seeds into the valid scalar range', () => {
    const zero = seedToScalar(new Uint8Array(32));
    assert.equal(zero > 0n, true);
    const max = seedToScalar(new Uint8Array(32).fill(0xff));
    assert.equal(max > 0n, true);
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
