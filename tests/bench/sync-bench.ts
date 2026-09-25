/**
 * Sync cost, measured: two peers, N records each, differing by one.
 *
 *   npx tsx tests/bench/sync-bench.ts [N ...]
 *
 * Counts messages, bytes on the wire and message rounds for one full
 * reconciliation, started by the peer that is behind. Validation is off — this
 * measures the protocol, not the gates.
 */
import { createStorageProvider } from '../../src/storage/storage-provider.js';
import { createSyncEngine, type SyncEngine } from '../../src/sync/sync-engine.js';
import type { Expression } from '../../src/types.js';
import { createMemoryAdapter } from '../helpers/memory-adapter.js';

function fakeExpression(i: number): Expression {
  const id = `b${i.toString(36).padStart(8, '0')}${'x'.repeat(40)}`;
  return { id, author: 'did:key:zBench', collection: 'app.bench', createdAt: new Date(1_700_000_000_000 + i).toISOString(), body: { i }, signature: 'sig', key: `k${i.toString(36)}`, seq: 0 };
}

/** Bytes of the frame a space actually sends: the sync message inside the network's envelope */
const wireBytes = (message: unknown) => JSON.stringify({ type: 'sync', from: 'did:key:zBench', payload: message }).length;

async function measure(n: number, differing = 1) {
  const a = createStorageProvider(createMemoryAdapter());
  const b = createStorageProvider(createMemoryAdapter());
  for (let i = 0; i < n; i++) {
    const expression = fakeExpression(i);
    await a.addExpression(expression);
    if (differing === 0 || i !== Math.floor(n / 2)) await b.addExpression(expression);
  }

  let messages = 0;
  let bytes = 0;
  const queue: Array<() => Promise<void>> = [];
  let engineA: SyncEngine;
  let engineB: SyncEngine;
  engineA = createSyncEngine({
    storageProvider: a,
    sendToPeer: (_peer, data) => {
      messages++;
      bytes += wireBytes(data);
      queue.push(() => engineB.handleMessage('a', data));
    },
  });
  engineB = createSyncEngine({
    storageProvider: b,
    sendToPeer: (_peer, data) => {
      messages++;
      bytes += wireBytes(data);
      queue.push(() => engineA.handleMessage('b', data));
    },
  });
  engineA.addPeer('b');
  engineB.addPeer('a');

  const started = performance.now();
  engineB.notifyPeers(['a']);
  let rounds = 0;
  for (let idle = 0; idle < 3; ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (queue.length === 0) {
      idle++;
      continue;
    }
    idle = 0;
    rounds++;
    const batch = queue.splice(0);
    await Promise.all(batch.map((deliver) => deliver()));
  }
  const ms = performance.now() - started;
  const converged = (await a.getRootCid()) === (await b.getRootCid());
  return { n, messages, bytes, rounds, ms: Math.round(ms), converged };
}

const sizes = process.argv.slice(2).map(Number);
for (const [n, differing] of (sizes.length ? sizes : [100, 1000, 10000]).flatMap((n) => [[n, 1], [n, 0]] as const)) {
  const r = await measure(n, differing);
  const kb = r.bytes < 10_000 ? `${r.bytes} B` : `${(r.bytes / 1024).toFixed(1)} KB`;
  console.log(`N=${String(r.n).padEnd(6)} ${differing ? 'one differs' : 'identical  '}  messages=${String(r.messages).padEnd(4)} wire=${kb.padEnd(10)} rounds=${String(r.rounds).padEnd(3)} ${r.ms} ms  converged=${r.converged}`);
}
