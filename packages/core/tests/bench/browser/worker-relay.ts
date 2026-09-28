/**
 * Two nodes, each in a worker of its own, meeting through a relay: the
 * workers signal over the relay, and the page makes their WebRTC connection
 * (`remoteTransport`). One invites, the other joins, and a write reaches the
 * other side. Run by `run.mjs` with ENTRY=worker-relay.ts.
 */
import type { P2PNode } from '../../../src/node/types.js';
import { startNodeInWorker } from '../../../src/node/worker.js';
import { createIdentityManager } from '../../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../../src/identity/root-signer.js';
import { generateSeed } from '../../../src/identity/recovery-code.js';
import { team } from '../../../src/space/presets.js';

const relay = new URLSearchParams(location.search).get('relay') ?? 'ws://127.0.0.1:8787';
const log = (line: string) => console.log(line);

async function person(name: string): Promise<P2PNode> {
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
  return startNodeInWorker(new Worker('/node-worker.js', { type: 'module' }), {
    signer,
    stores: { indexedDB: `relay-${name}-${Date.now()}` },
    network: { relays: [relay] },
  });
}

async function until(what: string, check: () => Promise<boolean>, ms = 20_000) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

try {
  const alice = await person('alice');
  const bob = await person('bob');
  const { id: space } = await alice.spaces.create({ name: 'Climbing', ...team, visibility: 'private' });
  await alice.spaces.hold(space);
  const t = performance.now();
  await bob.spaces.join(await alice.spaces.invite(space));
  await bob.spaces.hold(space);
  const note = await alice.records.put(space, 'app.note', { text: 'Bring chalk' });
  await until('the note to reach Bob', async () => (await bob.records.get(space, note.key)) !== null);
  log(`a write crossed between two workers in ${(performance.now() - t).toFixed(0)}ms`);
  const status = alice.network.status();
  log(`alice: ${status.relays.length} relay(s), ${status.links.length} link(s)`);
  const reply = await bob.records.put(space, 'app.note', { text: 'And rope' });
  await until('the reply to reach Alice', async () => (await alice.records.get(space, reply.key)) !== null);
  log('and back');
  await Promise.all([alice.close(), bob.close()]);
  log('done');
} catch (error) {
  log(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}

// A module, for the top-level await.
export {};
