/**
 * Sync tests — two peers reconciling by Negentropy, with the
 * validation engine acting as gatekeeper on everything that arrives.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../src/identity/did.js';
import { issueUCAN, type Capability } from '../src/identity/ucan.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { createSchemaEngine } from '../src/schema/schema-engine.js';
import { createStorageProvider, type StorageProvider } from '../src/storage/storage-provider.js';
import { createCryptoGate } from '../src/validation/crypto-gate.js';
import { createStructuralGate } from '../src/validation/structural-gate.js';
import { createStatefulGate } from '../src/validation/stateful-gate.js';
import { createCapabilityGate } from '../src/validation/capability-gate.js';
import { createValidationEngine } from '../src/validation/validation-engine.js';
import { createSyncEngine, type SyncEngine } from '../src/sync/sync-engine.js';
import type { Expression, StandardSchemaV1 } from '../src/types.js';

const provider = createP256Provider();
const signer = createSigner(provider);

const COLLECTION = 'app.test.note';
const WRITE: Capability = { with: `space:${COLLECTION}`, can: 'expression/write' };

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

/** A storage provider plus the validating sync engine in front of it. */
function createPeer(send: (peerId: string, data: Uint8Array) => void) {
  const storage = createStorageProvider(createMemoryAdapter());

  const schemaEngine = createSchemaEngine();
  schemaEngine.registerCollection({ name: COLLECTION, schema: noteSchema });

  const engine = createValidationEngine({
    cryptoGate: createCryptoGate(provider),
    structuralGate: createStructuralGate(schemaEngine),
    statefulGate: createStatefulGate(),
    capabilityGate: createCapabilityGate({ provider, requiredCapability: () => WRITE }),
    resolvePublicKey: async (did) => provider.importPublicKey(didToPublicKey(did).publicKeyBytes),
    getExpression: (id) => storage.getExpression(id),
  });

  const sync = createSyncEngine({
    storageProvider: storage,
    sendToPeer: send,
    validate: async (expression) => {
      const result = await engine.validate(expression);
      return {
        valid: result.valid,
        reason: result.gates.find((gate) => !gate.passed)?.reason,
      };
    },
  });

  return { storage, sync };
}

/** Two peers wired directly to each other, with deterministic message delivery. */
function createPair() {
  const inFlight: Promise<void>[] = [];
  let a: { storage: StorageProvider; sync: SyncEngine };
  let b: { storage: StorageProvider; sync: SyncEngine };

  a = createPeer((_peerId, data) => {
    inFlight.push(b.sync.handleMessage('a', data));
  });
  b = createPeer((_peerId, data) => {
    inFlight.push(a.sync.handleMessage('b', data));
  });

  a.sync.addPeer('b');
  b.sync.addPeer('a');

  /**
   * Runs the exchange to completion. Some sends are queued from promise
   * callbacks, so this keeps turning the event loop until two quiet rounds —
   * each a few milliseconds of real time — pass with nothing left to deliver.
   */
  const settle = async () => {
    let idleRounds = 0;
    for (let round = 0; round < 50 && idleRounds < 2; round++) {
      // Nothing to deliver: wait a little real time too. A hello goes out only after its
      // fingerprints are hashed, which on a busy machine takes longer than a turn or two.
      await new Promise((resolve) => setTimeout(resolve, inFlight.length > 0 ? 0 : 25));
      if (inFlight.length === 0) {
        idleRounds++;
        continue;
      }
      idleRounds = 0;
      await Promise.all(inFlight.splice(0, inFlight.length));
    }
  };

  return { a, b, settle };
}

/** Signs a note carrying a UCAN from `root` to the signing key. */
async function delegatedNote(root: { did: string; privateKey: CryptoKey }, text: string) {
  const session = await makeKey();
  const ucan = await issueUCAN(
    { issuer: root, audience: session.did, capabilities: [WRITE] },
    provider,
  );
  const unsigned = createExpression({
    author: session.did,
    collection: COLLECTION,
    body: { text },
    proof: ucan.encoded,
  });
  return (await signer.sign(unsigned, session.privateKey)) as Expression;
}

describe('sync engine', () => {
  test('pushes a local change to a peer', async () => {
    const { a, b, settle } = createPair();
    const root = await makeKey();

    const note = await delegatedNote(root, 'pushed');
    await a.storage.addExpression(note);
    a.sync.onLocalChange(note);
    await settle();

    assert.notEqual(await b.storage.getExpression(note.id), null);
    assert.equal(await b.storage.fingerprint(), await a.storage.fingerprint());
  });

  test('reconciles a peer that is behind', async () => {
    const { a, b, settle } = createPair();
    const root = await makeKey();

    for (const text of ['first', 'second', 'third']) {
      await a.storage.addExpression(await delegatedNote(root, text));
    }

    // b asks a what it has, and pulls whatever it is missing
    b.sync.notifyPeers(['a']);
    await settle();

    const notes = await b.storage.queryExpressions(COLLECTION);
    assert.equal(notes.length, 3);
    assert.equal(await b.storage.fingerprint(), await a.storage.fingerprint());
  });

  test('drops a forged expression instead of committing it', async () => {
    const { a, b, settle } = createPair();
    const root = await makeKey();

    const note = await delegatedNote(root, 'honest');
    const forged = { ...note, body: { text: 'tampered in transit' } } as Expression;

    const rejected: string[] = [];
    b.sync.on('rejected', (_peer: string, _expression: Expression, reason: string) => {
      rejected.push(reason);
    });

    await a.storage.addExpression(forged);
    a.sync.onLocalChange(forged);
    await settle();

    assert.equal(await b.storage.getExpression(forged.id), null);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0] ?? '', /id does not match|signature/i);
  });

  test('drops an expression whose author holds no capability', async () => {
    const { a, b, settle } = createPair();

    // Signed correctly, but the session key presents no delegation at all and
    // is not writing for itself either — a stranger with a valid signature.
    const stranger = await makeKey();
    const root = await makeKey();
    const ucan = await issueUCAN(
      {
        issuer: root,
        audience: root.did, // issued to the root, not to the signer
        capabilities: [WRITE],
      },
      provider,
    );
    const unsigned = createExpression({
      author: stranger.did,
      collection: COLLECTION,
      body: { text: 'not mine to write' },
      proof: ucan.encoded,
    });
    const note = (await signer.sign(unsigned, stranger.privateKey)) as Expression;

    const rejected: string[] = [];
    b.sync.on('rejected', (_peer: string, _expression: Expression, reason: string) => {
      rejected.push(reason);
    });

    await a.storage.addExpression(note);
    a.sync.onLocalChange(note);
    await settle();

    assert.equal(await b.storage.getExpression(note.id), null);
    assert.match(rejected[0] ?? '', /different key/i);
  });

  test('drops an expression that violates the collection schema', async () => {
    const { a, b, settle } = createPair();
    const root = await makeKey();
    const session = await makeKey();

    const ucan = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [WRITE] },
      provider,
    );
    const unsigned = createExpression({
      author: session.did,
      collection: COLLECTION,
      body: { text: 12345 },
      proof: ucan.encoded,
    });
    const note = (await signer.sign(unsigned, session.privateKey)) as Expression;

    const rejected: string[] = [];
    b.sync.on('rejected', (_peer: string, _expression: Expression, reason: string) => {
      rejected.push(reason);
    });

    await a.storage.addExpression(note);
    a.sync.onLocalChange(note);
    await settle();

    assert.equal(await b.storage.getExpression(note.id), null);
    assert.match(rejected[0] ?? '', /text must be a string/);
  });
});
