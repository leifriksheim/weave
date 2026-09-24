/**
 * Waits for a join to finish: an invite is used once its record reaches the
 * joining device, which takes a round of sync.
 */
import type { P2PNode } from '../../src/node/types.js';

export async function joined(node: P2PNode, spaceId: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while ((await node.spaces.access(spaceId)).role === null) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the join to finish');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
