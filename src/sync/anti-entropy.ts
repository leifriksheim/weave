/**
 * @module anti-entropy
 * The pieces of reconciliation that do not depend on messages.
 *
 * Two peers reconcile by walking each other's Merkle Search Tree from the root,
 * descending only into subtrees they do not already have. Nodes are content
 * addressed, so a subtree whose CID is part of your own tree is identical to
 * yours and can be skipped whole. Two trees differing by one entry exchange only
 * the nodes on the path to it — a handful at any size — instead of every key.
 */
import type { StorageAdapter } from '../types.js';
import { cidFromBytes } from '../utils/hash.js';
import { deserializeNode, type MSTNode } from '../storage/mst.js';

/**
 * Compares two root CIDs to check if they differ.
 * @returns True if they are different, false otherwise.
 */
export function compareRoots(localRoot: string | null, remoteRoot: string | null): boolean {
  return localRoot !== remoteRoot;
}

/**
 * Checks a node a peer sent: it must hash to the CID it was sent as.
 *
 * A peer can send anything. A node stored under the wrong CID could never be
 * found again and would poison the walk, so a mismatch is dropped.
 *
 * @returns The node, or null when the bytes do not match the CID or do not parse
 */
export async function verifyNode(cid: string, bytes: Uint8Array): Promise<MSTNode | null> {
  if ((await cidFromBytes(bytes)) !== cid) return null;
  try {
    const node = deserializeNode(bytes);
    const wellFormed =
      Array.isArray(node.keys) &&
      Array.isArray(node.children) &&
      node.children.length === node.keys.length + 1 &&
      node.keys.every((key) => typeof key === 'string') &&
      node.children.every((child) => child === null || typeof child === 'string');
    return wellFormed ? node : null;
  } catch {
    return null;
  }
}

/**
 * The children of a peer's node worth fetching: those not already part of the
 * local tree.
 *
 * @param node A node from the peer's tree
 * @param localTree Every CID reachable from the local root
 */
export function unknownChildren(node: MSTNode, localTree: ReadonlySet<string>): string[] {
  return node.children.filter((child): child is string => child !== null && !localTree.has(child));
}

/**
 * Of a node's keys, the ones this store does not hold.
 * @param adapter The local store
 * @param node A node from the peer's tree
 */
export async function missingKeys(adapter: StorageAdapter, node: MSTNode): Promise<string[]> {
  const present = await Promise.all(node.keys.map(async (key) => (await adapter.getExpression(key)) !== null));
  return node.keys.filter((_, i) => !present[i]);
}
