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
import { until } from './helpers/until.js';
import { isRecord } from '../src/utils/guards.js';

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

/** A pretend `SharedWorker` running `runNodeWorker`: each tab connects on a port of its own */
function fakeSharedWorker() {
  const target = new EventTarget();
  const scope = {
    addEventListener: (type: 'message' | 'connect', listener: (event: MessageEvent) => void) =>
      target.addEventListener(type, (event) => {
        if (event instanceof MessageEvent) listener(event);
      }),
  };
  const opened: WorkerStores[] = [];
  const stores = new Map<string, ReturnType<typeof memoryStores>>();
  runNodeWorker(scope, {
    openStores: (described) => {
      opened.push(described);
      const name = 'indexedDB' in described ? described.indexedDB : 'folder';
      const kept = stores.get(name) ?? memoryStores();
      stores.set(name, kept);
      return kept;
    },
  });
  /** What a tab's `new SharedWorker(…).port` would be; `tabs` collects the id each start names */
  const tabs: string[] = [];
  const connect = () => {
    const channel = new MessageChannel();
    target.dispatchEvent(new MessageEvent('connect', { ports: [channel.port2] }));
    cleanup.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    return {
      postMessage: (message: unknown, transfer: Transferable[]) => {
        if (isRecord(message) && typeof message.tab === 'string') tabs.push(message.tab);
        channel.port1.postMessage(message, transfer);
      },
    };
  };
  return { connect, opened, tabs };
}

describe('a node shared by the tabs of a site', () => {
  test('two tabs of the same account share one node', async () => {
    const me = await signer();
    const shared = fakeSharedWorker();
    const first = await startNodeInWorker(shared.connect(), {
      signer: me,
      stores: { indexedDB: 'weave:me' },
    });
    const second = await startNodeInWorker(shared.connect(), {
      signer: me,
      stores: { indexedDB: 'weave:me' },
    });
    cleanup.push(
      () => first.close(),
      () => second.close(),
    );

    assert.equal(shared.opened.length, 1, 'the stores were opened once');
    assert.equal(second.sessionDid, first.sessionDid, 'one node, one session');
    const events: string[] = [];
    second.subscribe((event) => events.push(event.type));
    const { id: space } = await first.spaces.create({ name: 'Groceries', ...team, visibility: 'private' });
    const written = await first.records.put(space, 'app.todo.item', { text: 'Milk' });
    assert.deepEqual(
      await second.records.get(space, written.key),
      await first.records.get(space, written.key),
    );
    await until(() => events.includes('records'), 1000, 'the other tab to hear of the write');
  });

  test('another account, or other stores, get a node of their own', async () => {
    const shared = fakeSharedWorker();
    const me = await signer();
    const a = await startNodeInWorker(shared.connect(), { signer: me, stores: { indexedDB: 'weave:me' } });
    const b = await startNodeInWorker(shared.connect(), {
      signer: await signer(),
      stores: { indexedDB: 'weave:me' },
    });
    const c = await startNodeInWorker(shared.connect(), {
      signer: me,
      stores: { indexedDB: 'weave:elsewhere' },
    });
    cleanup.push(
      () => a.close(),
      () => b.close(),
      () => c.close(),
    );
    assert.equal(new Set([a.sessionDid, b.sessionDid, c.sessionDid]).size, 3);
  });

  test('the node outlives a tab that closes it, and closes with the last', async () => {
    const me = await signer();
    const shared = fakeSharedWorker();
    const first = await startNodeInWorker(shared.connect(), {
      signer: me,
      stores: { indexedDB: 'weave:me' },
    });
    const second = await startNodeInWorker(shared.connect(), {
      signer: me,
      stores: { indexedDB: 'weave:me' },
    });
    const { id: space } = await first.spaces.create({ name: 'Groceries', ...team, visibility: 'private' });

    await first.close();
    await assert.rejects(() => first.spaces.list(), /closed/);
    assert.deepEqual(
      (await second.spaces.list()).map((s) => s.id),
      [space],
      'still open for the other tab',
    );

    await second.close();
    const later = await startNodeInWorker(shared.connect(), {
      signer: me,
      stores: { indexedDB: 'weave:me' },
    });
    cleanup.push(() => later.close());
    assert.notEqual(later.sessionDid, second.sessionDid, 'a new node, the old one having closed');
    assert.deepEqual(
      (await later.spaces.list()).map((s) => s.id),
      [space],
      'on the same stores',
    );
  });

  // Node has Web Locks from 24; browsers have had them for years.
  test(
    'a tab that goes without closing is noticed by its lock, and lets go of the node',
    {
      skip: globalThis.navigator?.locks ? false : 'no Web Locks in this runtime',
    },
    async () => {
      const me = await signer();
      const shared = fakeSharedWorker();
      const gone = await startNodeInWorker(shared.connect(), {
        signer: me,
        stores: { indexedDB: 'weave:me' },
      });
      const tab = shared.tabs[0]!;
      // What the browser does when a tab closes: its locks are let go. Taking this one lets go of the tab's hold.
      await navigator.locks.request(`weave-node-tab:${tab}`, { steal: true }, async () => {});

      let next = gone;
      await until(
        async () => {
          next = await startNodeInWorker(shared.connect(), { signer: me, stores: { indexedDB: 'weave:me' } });
          cleanup.push(() => next.close());
          return next.sessionDid !== gone.sessionDid;
        },
        2000,
        'the node to close once its only tab was gone',
      );
    },
  );
});
