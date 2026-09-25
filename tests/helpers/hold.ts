/**
 * Holding spaces in tests, and letting go again to take a node offline:
 * `hold(node, space)` keeps the release, and `letGo(node, space)` uses every
 * one the test kept for that space — so the space closes, as it would once
 * nothing in an app holds it. A space opened only by reading it closes too.
 */
import type { P2PNode } from '../../src/node/types.js';

const kept = new WeakMap<P2PNode, Map<string, Array<() => Promise<void>>>>();

export async function hold(node: P2PNode, spaceId: string): Promise<void> {
  const release = await node.spaces.hold(spaceId);
  const byNode = kept.get(node) ?? kept.set(node, new Map()).get(node)!;
  (byNode.get(spaceId) ?? byNode.set(spaceId, []).get(spaceId)!).push(release);
}

export async function letGo(node: P2PNode, spaceId: string): Promise<void> {
  const releases = kept.get(node)?.get(spaceId) ?? [];
  kept.get(node)?.delete(spaceId);
  if (releases.length === 0) releases.push(await node.spaces.hold(spaceId));
  for (const release of releases) await release();
}
