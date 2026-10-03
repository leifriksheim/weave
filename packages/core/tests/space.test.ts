/**
 * Space tests — the four kinds of list, invites, and end-to-end encryption.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createSpaceManager, parseSpaceInvite } from '../src/space/space-manager.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { issueUCAN, type Capability } from '../src/identity/ucan.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { createCapabilityGate } from '../src/validation/capability-gate.js';
import { createVersionCheck } from '../src/validation/check-version.js';
import { encryptExpression, decryptExpression } from '../src/privacy/space-encryption.js';
import { team } from '../src/space/presets.js';
import { makeKey } from './helpers/person.js';

const provider = createP256Provider();
const signer = createSigner(provider);
const OWNER = 'did:key:zOwnerPlaceholder';

describe('space manager', () => {
  test('creates private and public spaces, alone or with roles', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());

    const privatePersonal = await spaces.create({ name: 'Groceries', visibility: 'private', creator: OWNER });
    const publicPersonal = await spaces.create({ name: 'Reading', visibility: 'public', creator: OWNER });
    const privateShared = await spaces.create({
      name: 'Move house',
      ...team,
      visibility: 'private',
      creator: OWNER,
    });
    const publicShared = await spaces.create({
      name: 'Potluck',
      ...team,
      visibility: 'public',
      creator: OWNER,
    });

    // Only private spaces carry a key
    assert.notEqual(privatePersonal.key, null);
    assert.notEqual(privateShared.key, null);
    assert.equal(publicPersonal.key, null);
    assert.equal(publicShared.key, null);

    assert.equal(privatePersonal.space.encryptionKeyId, privatePersonal.key?.id);
    assert.equal(publicShared.space.encryptionKeyId, undefined);
    assert.equal(publicPersonal.space.creator, OWNER);
    assert.equal(publicPersonal.space.creatorRole, 'owner');
    assert.equal(privateShared.role, 'owner');

    const listed = await spaces.list();
    assert.equal(listed.length, 4);
  });

  test('gives each space a distinct id, even with one name', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const first = await spaces.create({ name: 'Todo', visibility: 'public', creator: OWNER });
    const second = await spaces.create({ name: 'Todo', visibility: 'public', creator: OWNER });
    assert.notEqual(first.space.id, second.space.id);
  });

  test('forgets a space and its key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const record = await spaces.create({ name: 'Temp', visibility: 'private', creator: OWNER });

    await spaces.remove(record.space.id);
    assert.equal(await spaces.get(record.space.id), null);
    assert.equal((await spaces.list()).length, 0);
  });
});

describe('invites', () => {
  test('carries a private space key to another device', async () => {
    const mine = createSpaceManager(createMemoryAdapter());
    const theirs = createSpaceManager(createMemoryAdapter());

    const record = await mine.create({ name: 'Move house', ...team, visibility: 'private', creator: OWNER });
    const invite = await mine.createInvite(record.space.id, OWNER);

    const preview = parseSpaceInvite(invite);
    assert.equal(preview.space.name, 'Move house');
    assert.equal(typeof preview.key, 'string');

    const joined = await theirs.join(invite);
    assert.equal(joined.space.id, record.space.id);
    assert.notEqual(joined.key, null);
    assert.equal(joined.invite, null, 'a view-only invite carries no secret to wait on');

    // The key that arrived must open what the owner sealed
    const sealed = await encryptExpression(
      {
        id: 'x',
        author: OWNER,
        collection: 'app.test.note',
        createdAt: 'now',
        key: 'x',
        seq: 0,
        body: { text: 'secret' },
        signature: '',
      },
      record.key!,
    );
    const opened = await decryptExpression(sealed, joined.key!);
    assert.deepEqual(opened.body, { text: 'secret' });
  });

  test('a public space invite carries no key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const record = await spaces.create({ name: 'Potluck', ...team, visibility: 'public', creator: OWNER });
    const invite = await spaces.createInvite(record.space.id, OWNER);

    assert.equal(parseSpaceInvite(invite).key, undefined);
  });

  test('joining keeps the roles the space started with, so every copy agrees who may write', async () => {
    const mine = createSpaceManager(createMemoryAdapter());
    const theirs = createSpaceManager(createMemoryAdapter());

    const record = await mine.create({ name: 'Reading', visibility: 'public', creator: OWNER, ...team });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const joined = await theirs.join(
      await mine.createInvite(record.space.id, OWNER, { secret, role: 'editor' }),
    );

    assert.deepEqual(joined.space.roles, record.space.roles);
    assert.equal(joined.space.creator, OWNER);
    assert.deepEqual(joined.invite, secret, 'the secret waits until its record arrives');
    assert.equal(joined.role, null);
  });

  test('rejects a corrupted invite', () => {
    assert.throws(() => parseSpaceInvite('not-an-invite'), /could not be read/i);
  });
});

describe('private space expressions', () => {
  test('encrypt-then-sign survives validation without the key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const owner = await makeKey();
    const record = await spaces.create({
      name: 'Secrets',
      ...team,
      visibility: 'private',
      creator: owner.did,
    });
    const spaceId = record.space.id;

    const required: Capability = { with: `space:${spaceId}`, can: 'expression/write' };

    const session = await makeKey();
    const ucan = await issueUCAN(
      { issuer: owner, audience: session.did, capabilities: [{ with: '*', can: 'expression/*' }] },
      provider,
    );

    // Encrypt first, then sign: the signature covers the ciphertext.
    const sealed = await encryptExpression(
      {
        id: '',
        author: '',
        collection: 'app.test.note',
        createdAt: '',
        key: '',
        seq: 0,
        body: { text: 'dinner at eight' },
        signature: '',
      },
      record.key!,
    );
    const unsigned = createExpression({
      author: session.did,
      collection: 'app.test.note',
      space: spaceId,
      body: sealed.body,
      proof: ucan.encoded,
    });
    const expression = await signer.sign(unsigned, session.privateKey);

    const check = createVersionCheck({ provider, requiredCapability: () => required });

    // A peer with no key still verifies and relays it: the signature and capability hold.
    const verdict = await check(expression);
    assert.equal(verdict.passed, true, verdict.reason ?? 'no reason given');
    assert.equal(expression.space, spaceId);
    assert.equal('text' in expression.body, false);

    // A member opens it
    const opened = await decryptExpression(expression, record.key!);
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
    const expression = await signer.sign(unsigned, strangerSession.privateKey);

    const result = await gate.validate(expression);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /not authorized/i);
  });
});
