/** Nodes and folders for a test file, each closed or removed when its tests end */
import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNode } from '../../../core/src/node/node.js';
import type { NodeConfig, P2PNode } from '../../../core/src/node/types.js';
import { createIdentityManager } from '../../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../../core/src/identity/root-signer.js';
import { deriveVaultKeyBytes } from '../../../core/src/identity/account-vault.js';
import { memoryStores } from '../../../core/tests/helpers/memory-stores.js';
import type { FakeHub } from '../../../core/tests/helpers/fake-transport.js';

const nodes: P2PNode[] = [];
const dirs: string[] = [];
after(async () => {
  await Promise.all(nodes.splice(0).map((node) => node.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A folder of its own under the system's temporary one */
export async function tempDir(prefix = 'weave-cli-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Network settings that reach the other nodes on a fake hub */
export const onHub = (hub: FakeHub) => ({
  transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
});

/**
 * A node in memory, of the identity seeded with `fill`. With `account`, it
 * follows its account space, where its name is kept.
 */
export async function aNode(
  fill: number,
  options: Partial<NodeConfig> & { readonly account?: boolean } = {},
): Promise<P2PNode> {
  const { account, ...config } = options;
  const seed = new Uint8Array(16).fill(fill);
  const manager = createIdentityManager();
  const node = await createNode({
    signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
    stores: memoryStores(),
    watchIntervalMs: 0,
    ...(account ? { accountKey: await deriveVaultKeyBytes(seed) } : {}),
    ...config,
  });
  nodes.push(node);
  return node;
}
