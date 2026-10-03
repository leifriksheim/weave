/**
 * What the benchmarks share: a person with a node, on a fake network when
 * given one, and an account that never runs a node, to add as a member.
 */
import { createNode } from '../../src/node/node.js';
import type { P2PNode } from '../../src/node/types.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { generateSeed } from '../../src/identity/recovery-code.js';
import type { FakeHub } from '../helpers/fake-transport.js';
import { memoryStores } from '../helpers/memory-stores.js';

const manager = createIdentityManager();

/** A node of a new account; on the hub when one is given */
export async function person(hub?: FakeHub): Promise<P2PNode> {
  const signer = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
  return createNode({
    signer,
    stores: memoryStores(),
    watchIntervalMs: 0,
    ...(hub ? { network: { transports: (s: string, d: string) => [hub.transport(d, s)] } } : {}),
  });
}

/** The DID of a new account that never runs a node */
export async function someone(): Promise<string> {
  return (await manager.fromSeed(generateSeed())).did;
}

/** Milliseconds `run` takes */
export async function time(run: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await run();
  return performance.now() - t;
}

export const ms = (n: number) => `${n.toFixed(1)}ms`;
