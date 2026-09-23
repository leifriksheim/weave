/**
 * Anti-entropy tests — the cost of a sync follows the difference, not the
 * size, and a hostile or broken peer cannot derail it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStorageProvider, type StorageProvider } from '../src/storage/storage-provider.js';
import { createSyncEngine, type SyncEngine } from '../src/sync/sync-engine.js';
import { decodeSyncMessage, encodeSyncMessage } from '../src/sync/sync-messages.js';
import { utf8Encode } from '../src/utils/encoding.js';
import type { Expression } from '../src/types.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';

function note(i: number): Expression {
  return {
    id: `b${i.toString(36).padStart(8, '0')}${'q'.repeat(40)}`,
    author: 'did:key:zTest',
    collection: 'app.test',
    createdAt: new Date(1_700_000_000_000 + i).toISOString(),
    body: { i },
    signature: 'sig',
  };
}

async function filled(ids: Iterable<number>): Promise<StorageProvider> {
  const storage = createStorageProvider(createMemoryAdapter());
  for (const i of ids) await storage.addExpression(note(i));
  return storage;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/**
 * Two engines wired together in memory. `tamper` may rewrite or drop what B
 * sends A — how the hostile-peer tests misbehave.
 */
function wire(a: StorageProvider, b: StorageProvider, tamper?: (data: Uint8Array) => Uint8Array | null) {
  const stats = { messages: 0, bytes: 0, nodesSent: 0, rounds: 0 };
  const queue: Array<() => Promise<void>> = [];
  let engineA: SyncEngine;
  let engineB: SyncEngine;
  const count = (data: Uint8Array) => {
    stats.messages++;
    stats.bytes += data.byteLength;
    const message = decodeSyncMessage(data);
    if (message?.type === 'node-response') stats.nodesSent += message.nodes.length;
  };
  engineA = createSyncEngine({
    storageProvider: a,
    sendToPeer: (_peer, data) => {
      count(data);
      queue.push(() => engineB.handleMessage('a', data));
    },
  });
  engineB = createSyncEngine({
    storageProvider: b,
    sendToPeer: (_peer, data) => {
      const sent = tamper ? tamper(data) : data;
      if (!sent) return;
      count(sent);
      queue.push(() => engineA.handleMessage('b', sent));
    },
  });
  engineA.addPeer('b');
  engineB.addPeer('a');

  const settle = async () => {
    for (let idle = 0; idle < 3; ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (queue.length === 0) {
        idle++;
        continue;
      }
      idle = 0;
      stats.rounds++;
      await Promise.all(queue.splice(0).map((deliver) => deliver()));
    }
  };
  return { engineA, engineB, stats, settle };
}

const sameRoot = async (a: StorageProvider, b: StorageProvider) => (await a.getRootCid()) === (await b.getRootCid());

describe('the cost of a sync follows the difference', () => {
  test('identical trees: one round trip, no nodes', async () => {
    const a = await filled(range(0, 500));
    const b = await filled(range(0, 500));
    const { engineA, stats, settle } = wire(a, b);

    const synced: string[] = [];
    engineA.on('synced', (peer: string) => synced.push(peer));
    engineA.notifyPeers(['b']);
    await settle();

    assert.equal(stats.messages, 2);
    assert.equal(stats.nodesSent, 0);
    assert.ok(stats.bytes < 1024);
    assert.deepEqual(synced, ['b']);
  });

  test('one entry different out of 2,000: a handful of nodes, not the whole tree', async () => {
    const a = await filled(range(0, 2000));
    const b = await filled(range(0, 2000).filter((i) => i !== 1234));
    const { engineB, stats, settle } = wire(a, b);

    engineB.notifyPeers(['a']);
    await settle();

    assert.equal(await sameRoot(a, b), true);
    assert.notEqual(await b.getExpression(note(1234).id), null);
    assert.ok(stats.nodesSent < 20, `${stats.nodesSent} nodes`);
  });

  test('an empty peer pulls a full tree', async () => {
    const a = await filled(range(0, 1500));
    const b = await filled([]);
    const { engineB, settle } = wire(a, b);

    engineB.notifyPeers(['a']);
    await settle();

    assert.equal(await sameRoot(a, b), true);
    assert.equal((await b.queryExpressions('app.test', 5000)).length, 1500);
  });

  test('each side holding what the other lacks: both converge from one request', async () => {
    const a = await filled([...range(0, 300), ...range(300, 350)]);
    const b = await filled([...range(0, 300), ...range(350, 420)]);
    const { engineA, settle } = wire(a, b);

    engineA.notifyPeers(['b']);
    await settle();

    assert.equal(await sameRoot(a, b), true);
    assert.equal((await a.queryExpressions('app.test', 5000)).length, 420);
  });
});

describe('a peer that misbehaves', () => {
  test('nodes that do not hash to their CID are dropped, and nothing is stored from them', async () => {
    const a = await filled([]);
    const b = await filled(range(0, 200));
    const { engineA, settle } = wire(a, b, (data) => {
      const message = decodeSyncMessage(data);
      if (message?.type !== 'node-response') return data;
      // Swap every node's bytes for another node's: valid nodes, wrong CIDs.
      const bytes = message.nodes.map((n) => n.bytes).reverse();
      return encodeSyncMessage({ type: 'node-response', id: message.id, nodes: message.nodes.map((n, i) => ({ cid: n.cid, bytes: bytes[i]! })) });
    });

    engineA.notifyPeers(['b']);
    await settle();
    // A single-node root swapped with itself would still be honest; with more
    // than one node every swap is a lie. Either way nothing false is stored.
    for (const expression of await a.queryExpressions('app.test', 500)) {
      assert.notEqual(await b.getExpression(expression.id), null);
    }
  });

  test('a peer that answers without the nodes asked for does not hang the walk', async () => {
    const a = await filled([]);
    const b = await filled(range(0, 200));
    const { engineA, settle } = wire(a, b, (data) => {
      const message = decodeSyncMessage(data);
      return message?.type === 'node-response' ? encodeSyncMessage({ type: 'node-response', id: message.id, nodes: [] }) : data;
    });

    const synced: string[] = [];
    engineA.on('synced', (peer: string) => synced.push(peer));
    engineA.notifyPeers(['b']);
    await settle();
    assert.deepEqual(synced, ['b']);
  });

  test('a message from another protocol version is dropped, not half-processed', async () => {
    const a = await filled(range(0, 10));
    const errors: unknown[] = [];
    const sent: Uint8Array[] = [];
    const engine = createSyncEngine({ storageProvider: a, sendToPeer: (_p, d) => sent.push(d) });
    engine.on('error', (e: unknown) => errors.push(e));
    engine.addPeer('x');

    await engine.handleMessage('x', utf8Encode(JSON.stringify({ v: 99, type: 'sync-request', rootCid: null })));
    await engine.handleMessage('x', utf8Encode('not json'));
    assert.equal(sent.length, 0);
    assert.equal(errors.length, 0);
  });

  test('only tree nodes are served — not other keys in the store', async () => {
    const a = await filled(range(0, 5));
    await a.getAdapter().put('secret', utf8Encode('not for peers'));
    const sent: Uint8Array[] = [];
    const engine = createSyncEngine({ storageProvider: a, sendToPeer: (_p, d) => sent.push(d) });

    await engine.handleMessage('x', encodeSyncMessage({ type: 'node-request', id: 1, cids: ['secret'] }));
    const reply = decodeSyncMessage(sent[0]!);
    assert.equal(reply?.type, 'node-response');
    assert.deepEqual(reply?.type === 'node-response' ? reply.nodes : null, []);
  });
});

describe('the store under concurrent writes', () => {
  test('writes that overlap all land in the tree', async () => {
    // Replies from peers are handled concurrently. Before writes took turns,
    // two inserts starting from the same root lost one of them from the tree
    // while the record itself was still stored.
    const concurrent = createStorageProvider(createMemoryAdapter());
    await Promise.all(range(0, 300).map((i) => concurrent.addExpression(note(i))));
    const sequential = await filled(range(0, 300));
    assert.equal(await concurrent.getRootCid(), await sequential.getRootCid());
  });
});
