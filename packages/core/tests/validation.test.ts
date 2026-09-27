/**
 * Validation gate tests — signature checks and UCAN-based authorization.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../src/identity/did.js';
import { issueUCAN, type Capability } from '../src/identity/ucan.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { createSchemaEngine } from '../src/schema/schema-engine.js';
import { createCryptoGate } from '../src/validation/crypto-gate.js';
import { createStructuralGate } from '../src/validation/structural-gate.js';
import { createCapabilityGate } from '../src/validation/capability-gate.js';
import type { Expression, StandardSchemaV1 } from '../src/types.js';

const provider = createP256Provider();
const signer = createSigner(provider);

const COLLECTION = 'app.test.note';
const WRITE: Capability = { with: `space:${COLLECTION}`, can: 'expression/write' };
const ALL: Capability = { with: `space:${COLLECTION}`, can: 'expression/*' };
const OTHER: Capability = { with: 'space:something.else', can: 'expression/*' };

async function makeKey() {
  const pair = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  return { did, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

const resolvePublicKey = async (did: string) =>
  provider.importPublicKey(didToPublicKey(did).publicKeyBytes);

/** Signs a note, optionally carrying a delegation proof. */
async function signNote(
  key: { did: string; privateKey: CryptoKey },
  text: string,
  proof?: string,
): Promise<Expression<{ text: string }>> {
  const unsigned = createExpression({
    author: key.did,
    collection: COLLECTION,
    body: { text },
    ...(proof ? { proof } : {}),
  });
  return signer.sign(unsigned, key.privateKey);
}

describe('crypto gate', () => {
  const gate = createCryptoGate(provider);

  test('accepts an expression signed by its author', async () => {
    const author = await makeKey();
    const expression = await signNote(author, 'hello');

    const result = await gate.validate(expression as Expression, resolvePublicKey);
    assert.equal(result.passed, true, result.reason);
  });

  test('rejects a tampered body', async () => {
    const author = await makeKey();
    const expression = await signNote(author, 'hello');
    const tampered = { ...expression, body: { text: 'goodbye' } } as Expression;

    const result = await gate.validate(tampered, resolvePublicKey);
    assert.equal(result.passed, false);
  });

  test('rejects an id that does not match the content', async () => {
    const author = await makeKey();
    const expression = await signNote(author, 'hello');
    const relabelled = { ...expression, id: 'bafyfake' } as Expression;

    const result = await gate.validate(relabelled, resolvePublicKey);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /id does not match/i);
  });

  test('rejects a signature from another key', async () => {
    const author = await makeKey();
    const impostor = await makeKey();
    // Same payload, signed by someone else while still claiming the author DID
    const unsigned = createExpression({ author: author.did, collection: COLLECTION, body: { text: 'hi' } });
    const forged = await signer.sign(unsigned, impostor.privateKey);

    const result = await gate.validate(forged as Expression, resolvePublicKey);
    assert.equal(result.passed, false);
  });
});

describe('structural gate', () => {
  const noteSchema: StandardSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        const v = value as { text?: unknown };
        return typeof v?.text === 'string'
          ? { value }
          : { issues: [{ message: 'text must be a string' }] };
      },
    },
  };

  const schemaEngine = createSchemaEngine();
  schemaEngine.registerCollection({ name: COLLECTION, schema: noteSchema });
  const gate = createStructuralGate(schemaEngine);

  test('rejects a body that does not match the collection schema', async () => {
    const author = await makeKey();
    const expression = (await signNote(author, 'fine')) as Expression;
    assert.equal((await gate.validate(expression)).passed, true);

    const broken = { ...expression, body: { text: 42 } } as Expression;
    const result = await gate.validate(broken);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /text must be a string/);
  });
});

describe('capability gate', () => {
  const gate = createCapabilityGate({ provider, requiredCapability: () => WRITE });

  test('accepts an author writing for itself', async () => {
    const author = await makeKey();
    const expression = (await signNote(author, 'my own note')) as Expression;

    const result = await gate.validate(expression);
    assert.equal(result.passed, true, result.reason);
  });

  test('accepts a delegated author carrying a valid proof', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const ucan = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL] },
      provider,
    );

    const expression = (await signNote(session, 'delegated note', ucan.encoded)) as Expression;
    const result = await gate.validate(expression);
    assert.equal(result.passed, true, result.reason);
  });

  test('rejects a proof issued to a different key', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const thief = await makeKey();

    // A perfectly valid UCAN — for somebody else.
    const ucan = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL] },
      provider,
    );

    const expression = (await signNote(thief, 'stolen proof', ucan.encoded)) as Expression;
    const result = await gate.validate(expression);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /different key/i);
  });

  test('rejects a proof that does not grant the required capability', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const ucan = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [OTHER] },
      provider,
    );

    const expression = (await signNote(session, 'wrong space', ucan.encoded)) as Expression;
    const result = await gate.validate(expression);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /does not grant/i);
  });

  test('rejects a record signed after its proof expired', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const ucan = await issueUCAN(
      {
        issuer: root,
        audience: session.did,
        capabilities: [ALL],
        expiration: Math.floor(Date.now() / 1000) - 5,
      },
      provider,
    );

    const expression = (await signNote(session, 'stale', ucan.encoded)) as Expression;
    const result = await gate.validate(expression);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /expired/i);
  });

  test('accepts a record signed while its proof was valid, long after it expired', async () => {
    // A peer that turns up next week must still accept last week's data.
    const root = await makeKey();
    const session = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const ucan = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL], notBefore: now - 10_800, expiration: now - 3600 },
      provider,
    );

    const signedAt = new Date((now - 7200) * 1000).toISOString();
    const unsigned = createExpression({
      author: session.did,
      collection: COLLECTION,
      body: { text: 'written two hours ago' },
      proof: ucan.encoded,
      createdAt: signedAt,
    });
    const expression = (await signer.sign(unsigned, session.privateKey)) as Expression;
    const result = await gate.validate(expression);
    assert.equal(result.passed, true, result.reason);
  });

  test('rejects a record dated before its delegation began', async () => {
    // A leaked session key must not be able to write "last year".
    const root = await makeKey();
    const session = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const ucan = await issueUCAN({ issuer: root, audience: session.did, capabilities: [ALL] }, provider);

    const unsigned = createExpression({
      author: session.did,
      collection: COLLECTION,
      body: { text: 'backdated' },
      proof: ucan.encoded,
      createdAt: new Date((now - 86_400 * 365) * 1000).toISOString(),
    });
    const expression = (await signer.sign(unsigned, session.privateKey)) as Expression;
    assert.equal((await gate.validate(expression)).passed, false);
  });

  test('rejects a record dated in the future', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const ucan = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL], expiration: now + 86_400 },
      provider,
    );
    const unsigned = createExpression({
      author: session.did,
      collection: COLLECTION,
      body: { text: 'from tomorrow' },
      proof: ucan.encoded,
      createdAt: new Date((now + 3600) * 1000).toISOString(),
    });
    const result = await gate.validate((await signer.sign(unsigned, session.privateKey)) as Expression);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /future/);
  });

  test('honours an application trust policy', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const trusted = await makeKey();

    const strictGate = createCapabilityGate({
      provider,
      requiredCapability: () => WRITE,
      isTrustedRoot: (did) => did === trusted.did,
    });

    const ucan = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL] },
      provider,
    );
    const expression = (await signNote(session, 'stranger', ucan.encoded)) as Expression;

    const result = await strictGate.validate(expression);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /not authorized/i);
  });
});
