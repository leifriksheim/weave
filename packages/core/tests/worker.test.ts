/**
 * A node started in a worker: the page keeps the signer, the worker keeps
 * the node, and the page uses it as if it were its own. A message channel
 * stands in for the worker here; the worker's side runs as it would there.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runNodeWorker, startNodeInWorker, workerNetwork } from '../src/node/worker.js';
import type { WorkerStores } from '../src/node/stores.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner, type RootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { team } from '../src/space/presets.js';
import { memoryStores } from './helpers/memory-stores.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function signer(): Promise<RootSigner> {
  const manager = createIdentityManager();
  return createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
}

/** A pretend worker running `runNodeWorker`, and what it was asked to open */
function fakeWorker() {
  const channel = new MessageChannel();
  const opened: WorkerStores[] = [];
  const stores = memoryStores();
  runNodeWorker(channel.port2, {
    openStores: (described) => {
      opened.push(described);
      return stores;
    },
  });
  channel.port2.start();
  let terminated = false;
  cleanup.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  return {
    opened,
    get terminated() {
      return terminated;
    },
    worker: {
      postMessage: (message: unknown, transfer: Transferable[]) =>
        channel.port1.postMessage(message, transfer),
      terminate: () => {
        terminated = true;
      },
    },
  };
}

describe('a node in a worker', () => {
  test('acts for the signer on the page, and is used from the page', async () => {
    const me = await signer();
    const fake = fakeWorker();
    const node = await startNodeInWorker(fake.worker, { signer: me, stores: { indexedDB: 'weave:test' } });
    cleanup.push(() => node.close());

    assert.deepEqual(fake.opened, [{ indexedDB: 'weave:test' }]);
    assert.equal(node.did, me.did);
    assert.equal(node.delegation().payload.iss, me.did, 'the session was signed by the key on the page');
    const { id: space } = await node.spaces.create({ name: 'Groceries', ...team, visibility: 'private' });
    const written = await node.records.put(space, 'app.todo.item', { text: 'Milk' });
    assert.equal(written.root, me.did);
    assert.deepEqual(
      (await node.records.list(space)).map((record) => record.key),
      [written.key],
    );
  });

  test('closing the node ends the worker', async () => {
    const fake = fakeWorker();
    const node = await startNodeInWorker(fake.worker, { signer: await signer(), stores: { indexedDB: 'x' } });
    await node.close();
    assert.equal(fake.terminated, true);
    await assert.rejects(() => node.spaces.list(), /closed/);
  });

  test("a node that can't start says why, and the worker is ended", async () => {
    const fake = fakeWorker();
    const refusing: RootSigner = {
      did: 'did:key:zNobody',
      custody: 'remote',
      delegate: () => Promise.reject(new Error('Access has run out')),
    };
    await assert.rejects(
      () => startNodeInWorker(fake.worker, { signer: refusing, stores: { indexedDB: 'x' } }),
      /Access has run out/,
    );
    assert.equal(fake.terminated, true);
  });

  test('only plain data of a network config is sent', () => {
    assert.deepEqual(
      workerNetwork({
        relays: ['wss://relay.test'],
        iceServers: [{ urls: 'stun:stun.test' }],
        transports: () => [],
      }),
      { relays: ['wss://relay.test'], iceServers: [{ urls: 'stun:stun.test' }] },
    );
  });
});
