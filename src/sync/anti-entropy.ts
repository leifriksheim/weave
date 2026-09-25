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
import { hashNode, lookupInMST, type MSTNode } from '../storage/mst.js';

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Checks a node a peer sent: it must be well formed, and hash to the CID it
 * was sent as.
 *
 * A peer can send anything. Only the four fields of a node are read, and they
 * are hashed the one canonical way — so whatever else came with it, a node
 * that checks out is exactly the node that CID names.
 *
 * @returns The node, or null when it is malformed or does not match the CID
 */
export async function verifyNode(cid: string, value: unknown): Promise<MSTNode | null> {
  const { height, keys, values, children } = (value ?? {}) as Partial<Record<keyof MSTNode, unknown>>;
  if (
    !Number.isSafeInteger(height) ||
    !Array.isArray(keys) || !keys.every(isString) ||
    !Array.isArray(values) || values.length !== keys.length || !values.every(isString) ||
    !Array.isArray(children) || children.length !== keys.length + 1 ||
    !children.every((child) => child === null || isString(child))
  ) return null;
  const node: MSTNode = { height: height as number, keys, values, children };
  return (await hashNode(node)) === cid ? node : null;
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
 * The version ids a peer's node names that differ from this store's.
 *
 * A key is a record key under a prefix (`r/`, `g/`, `h/`) and its value a
 * version id, so two peers can hold the same key with different values — two
 * versions of one record. Either way the other side's version is worth
 * fetching: the ordering rule decides, on arrival, whether it is kept.
 *
 * @param adapter The local store
 * @param localRoot The local tree's root
 * @param node A node from the peer's tree
 */
export async function differingEntries(adapter: StorageAdapter, localRoot: string | null, node: MSTNode): Promise<string[]> {
  const ours = await Promise.all(node.keys.map((key) => lookupInMST(adapter, localRoot, key)));
  const wanted: string[] = [];
  for (let i = 0; i < node.keys.length; i++) {
    const theirs = node.values[i];
    if (typeof theirs === 'string' && ours[i] !== theirs && !(await adapter.getExpression(theirs))) wanted.push(theirs);
  }
  return wanted;
}
