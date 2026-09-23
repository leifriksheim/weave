/**
 * Space tests — the four kinds of list, invites, and end-to-end encryption.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createSpaceManager, parseSpaceInvite } from '../src/space/space-manager.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../src/identity/did.js';
import { issueUCAN, type Capability } from '../src/identity/ucan.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { createSchemaEngine } from '../src/schema/schema-engine.js';
import { createCryptoGate } from '../src/validation/crypto-gate.js';
import { createStructuralGate } from '../src/validation/structural-gate.js';
import { createStatefulGate } from '../src/validation/stateful-gate.js';
import { createCapabilityGate } from '../src/validation/capability-gate.js';
import { createValidationEngine } from '../src/validation/validation-engine.js';
import { encryptExpression, decryptExpression } from '../src/privacy/space-encryption.js';
import type { Expression, StandardSchemaV1 } from '../src/types.js';

const provider = createP256Provider();
const signer = createSigner(provider);
const OWNER = 'did:key:zOwnerPlaceholder';

const noteSchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) =>
      typeof (value as { text?: unknown })?.text === 'string'
        ? { value }
        : { issues: [{ message: 'text must be a string' }] },
  },
};

async function makeKey() {
  const pair = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  return { did, privateKey: pair.privateKey };
}

describe('space manager', () => {
  test('creates the four kinds of list', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());

    const privatePersonal = await spaces.create({ name: 'Groceries', type: 'personal', visibility: 'private', owner: OWNER });
    const publicPersonal = await spaces.create({ name: 'Reading', type: 'personal', visibility: 'public', owner: OWNER });
    const privateShared = await spaces.create({ name: 'Move house', type: 'shared', visibility: 'private', owner: OWNER });
    const publicShared = await spaces.create({ name: 'Potluck', type: 'shared', visibility: 'public', owner: OWNER });

    // Only private spaces carry a key
    assert.notEqual(privatePersonal.key, null);
    assert.notEqual(privateShared.key, null);
    assert.equal(publicPersonal.key, null);
    assert.equal(publicShared.key, null);

    assert.equal(privatePersonal.space.encryptionKeyId, privatePersonal.key?.id);
    assert.equal(publicShared.space.encryptionKeyId, undefined);
    assert.deepEqual(publicPersonal.space.members, [OWNER]);

    const listed = await spaces.list();
    assert.equal(listed.length, 4);
  });

  test('gives each space a distinct id, even with one name', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const first = await spaces.create({ name: 'Todo', type: 'personal', visibility: 'public', owner: OWNER });
    const second = await spaces.create({ name: 'Todo', type: 'personal', visibility: 'public', owner: OWNER });
    assert.notEqual(first.space.id, second.space.id);
  });

  test('forgets a space and its key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const record = await spaces.create({ name: 'Temp', type: 'personal', visibility: 'private', owner: OWNER });

    await spaces.remove(record.space.id);
    assert.equal(await spaces.get(record.space.id), null);
    assert.equal((await spaces.list()).length, 0);
  });
});

describe('invites', () => {
  test('carries a private space key to another device', async () => {
    const mine = createSpaceManager(createMemoryAdapter());
    const theirs = createSpaceManager(createMemoryAdapter());

    const record = await mine.create({ name: 'Move house', type: 'shared', visibility: 'private', owner: OWNER });
    const invite = await mine.createInvite(record.space.id, OWNER);

    const preview = parseSpaceInvite(invite);
    assert.equal(preview.space.name, 'Move house');
    assert.equal(typeof preview.key, 'string');

    const joined = await theirs.join(invite, 'did:key:zFriend');
    assert.equal(joined.space.id, record.space.id);
    assert.equal(joined.space.members.includes('did:key:zFriend'), true);
    assert.notEqual(joined.key, null);

    // The key that arrived must open what the owner sealed
    const sealed = await encryptExpression(
      { id: 'x', author: OWNER, collection: 'app.test.note', createdAt: 'now', body: { text: 'secret' }, signature: '' },
      record.key!,
    );
    const opened = await decryptExpression(sealed, joined.key!);
    assert.deepEqual(opened.body, { text: 'secret' });
  });

  test('a public space invite carries no key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const record = await spaces.create({ name: 'Potluck', type: 'shared', visibility: 'public', owner: OWNER });
    const invite = await spaces.createInvite(record.space.id, OWNER);

    assert.equal(parseSpaceInvite(invite).key, undefined);
  });

  test('joining a personal space keeps it personal, so every copy agrees who may write', async () => {
    const mine = createSpaceManager(createMemoryAdapter());
    const theirs = createSpaceManager(createMemoryAdapter());

    const record = await mine.create({ name: 'Reading', type: 'personal', visibility: 'public', owner: OWNER });
    const joined = await theirs.join(await mine.createInvite(record.space.id, OWNER), 'did:key:zFriend');

    assert.equal(joined.space.type, 'personal');
  });

  test('rejects a corrupted invite', () => {
    assert.throws(() => parseSpaceInvite('not-an-invite'), /could not be read/i);
  });
});

describe('private space expressions', () => {
  test('encrypt-then-sign survives validation without the key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const owner = await makeKey();
    const record = await spaces.create({ name: 'Secrets', type: 'shared', visibility: 'private', owner: owner.did });
    const spaceId = record.space.id;

    const required: Capability = { with: `space:${spaceId}`, can: 'expression/write' };

    const session = await makeKey();
    const ucan = await issueUCAN(
      { issuer: owner, audience: session.did, capabilities: [{ with: '*', can: 'expression/*' }] },
      provider,
    );

    // Encrypt first, then sign: the signature covers the ciphertext.
    const sealed = await encryptExpression(
      { id: '', author: '', collection: 'app.test.note', createdAt: '', body: { text: 'dinner at eight' }, signature: '' },
      record.key!,
    );
    const unsigned = createExpression({
      author: session.did,
      collection: 'app.test.note',
      space: spaceId,
      body: sealed.body,
      proof: ucan.encoded,
    });
    const expression = (await signer.sign(unsigned, session.privateKey)) as Expression;

    const schemaEngine = createSchemaEngine();
    schemaEngine.registerCollection({ name: 'app.test.note', schema: noteSchema });

    const validation = createValidationEngine({
      cryptoGate: createCryptoGate(provider),
      structuralGate: createStructuralGate(schemaEngine),
      statefulGate: createStatefulGate(),
      capabilityGate: createCapabilityGate({ provider, requiredCapability: () => required }),
      resolvePublicKey: async (did) => provider.importPublicKey(didToPublicKey(did).publicKeyBytes),
      getExpression: async () => null,
    });

    // A peer with no key still verifies and relays it: the schema gate steps
    // aside for an encrypted body, the signature and capability still hold.
    const verdict = await validation.validate(expression);
    assert.equal(verdict.valid, true, verdict.gates.find((g) => !g.passed)?.reason);
    assert.equal(expression.space, spaceId);
    assert.equal((expression.body as { text?: string }).text, undefined);

    // A member opens it
    const opened = await decryptExpression(expression as never, record.key!);
    assert.deepEqual(opened.body, { text: 'dinner at eight' });
  });

  test('a personal space refuses a stranger, whatever they sign', async () => {
    const owner = await makeKey();
    const stranger = await makeKey();
    const strangerSession = await makeKey();
    const spaceId = 'space-personal';

    const gate = createCapabilityGate({
      provider,
      requiredCapability: () => ({ with: `space:${spaceId}`, can: 'expression/write' }),
      isTrustedRoot: (rootDid) => rootDid === owner.did,
    });

    // Perfectly valid UCAN — from the wrong root.
    const ucan = await issueUCAN(
      { issuer: stranger, audience: strangerSession.did, capabilities: [{ with: '*', can: 'expression/*' }] },
      provider,
    );
    const unsigned = createExpression({
      author: strangerSession.did,
      collection: 'app.test.note',
      space: spaceId,
      body: { text: 'let me in' },
      proof: ucan.encoded,
    });
    const expression = (await signer.sign(unsigned, strangerSession.privateKey)) as Expression;

    const result = await gate.validate(expression);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /not authorized/i);
  });
});
