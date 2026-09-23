/**
 * @module mst
 * Merkle Search Tree (MST) — a deterministic, content-addressed ordered map.
 *
 * Every key carries a height derived from its own hash (see {@link nodeHeight}),
 * and a key lives in the node at exactly that height. Because the height comes
 * from the key rather than from insertion order, the same set of entries always
 * produces the same tree — and therefore the same root CID — no matter what
 * order it was built in. That determinism is what makes the root usable as a
 * one-word summary of a peer's state, and what lets two peers skip any subtree
 * whose CID they both already hold.
 *
 * Nodes are immutable: an insert rewrites only the path from the touched node
 * up to the root, which is O(log N) nodes rather than the whole tree.
 */

import type { StorageAdapter } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import { sha256, cidFromBytes } from '../utils/hash.js';

/**
 * A node in the Merkle Search Tree.
 *
 * Every key in `keys` hashes to `height`. `children` always holds one more
 * entry than `keys`: `children[i]` is the subtree at `height - 1` covering the
 * keys that sort between `keys[i - 1]` and `keys[i]`.
 */
export interface MSTNode {
  readonly height: number;
  readonly keys: ReadonlyArray<string>;
  readonly values: ReadonlyArray<string>;
  readonly children: ReadonlyArray<string | null>;
}

/**
 * Differences between two Merkle Search Trees.
 */
export interface MSTDiff {
  readonly added: ReadonlyArray<{key: string, value: string}>;
  readonly removed: ReadonlyArray<{key: string, value: string}>;
  readonly modified: ReadonlyArray<{key: string, oldValue: string, newValue: string}>;
}

/**
 * Creates an empty MST node at the given height.
 * @param height The height the node sits at.
 * @returns An empty node.
 */
export function createEmptyNode(height = 0): MSTNode {
  return Object.freeze({
    height,
    keys: Object.freeze([]),
    values: Object.freeze([]),
    children: Object.freeze([null])
  });
}

/**
 * Canonical JSON serialization of an MST node.
 * @param node The node to serialize.
 * @returns The canonical bytes.
 */
export function serializeNode(node: MSTNode): Uint8Array {
  // Field order is fixed so the same node always hashes to the same CID.
  const obj = {
    height: node.height,
    keys: node.keys,
    values: node.values,
    children: node.children
  };
  return utf8Encode(JSON.stringify(obj));
}

/**
 * Deserialize an MST node.
 * @param data The canonical bytes.
 * @returns The node.
 */
export function deserializeNode(data: Uint8Array): MSTNode {
  const obj = JSON.parse(utf8Decode(data));
  return Object.freeze({
    height: obj.height ?? 0,
    keys: Object.freeze([...obj.keys]),
    values: Object.freeze([...obj.values]),
    children: Object.freeze([...obj.children])
  });
}

/**
 * Hashes a node to get its CID.
 * @param node The node to hash.
 * @returns The node's CID.
 */
export async function hashNode(node: MSTNode): Promise<string> {
  const bytes = serializeNode(node);
  return cidFromBytes(bytes);
}

/**
 * Calculate the deterministic height of a key using SHA-256.
 * Counts leading zero bits in the hash, divided by 4 — so roughly one key in
 * 16 sits a level higher than the last, giving the tree its branching factor.
 * @param key The key to place.
 * @returns The height the key belongs at.
 */
export async function nodeHeight(key: string): Promise<number> {
  const hashBytes = await sha256(utf8Encode(key));
  let zeros = 0;
  for (let i = 0; i < hashBytes.length; i++) {
    const byte = hashBytes[i]!;
    if (byte === 0) {
      zeros += 8;
    } else {
      let temp = byte;
      while ((temp & 0x80) === 0) {
        zeros++;
        temp <<= 1;
      }
      break;
    }
  }
  return Math.floor(zeros / 4);
}

/**
 * Load a node from the storage adapter.
 * @param adapter The storage adapter.
 * @param cid The node's CID.
 * @returns The node.
 */
export async function loadNode(adapter: StorageAdapter, cid: string): Promise<MSTNode> {
  const data = await adapter.get(cid);
  if (!data) throw new Error(`Node not found: ${cid}`);
  return deserializeNode(data);
}

/**
 * Save a node to the storage adapter and return its CID.
 * @param adapter The storage adapter.
 * @param node The node to store.
 * @returns The node's CID.
 */
export async function saveNode(adapter: StorageAdapter, node: MSTNode): Promise<string> {
  const bytes = serializeNode(node);
  const cid = await cidFromBytes(bytes);
  await adapter.put(cid, bytes);
  return cid;
}

// --------------------------------------------------------------- internals

/** Index of the first key that is greater than or equal to `target`. */
function lowerBound(keys: ReadonlyArray<string>, target: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Stores a node, unless it carries nothing at all — an empty node with no
 * surviving child is simply an absent subtree, and representing it as `null`
 * keeps the tree canonical.
 */
async function saveOrPrune(adapter: StorageAdapter, node: MSTNode): Promise<string | null> {
  if (node.keys.length === 0 && node.children.every(child => child === null)) return null;
  return saveNode(adapter, node);
}

/**
 * Wraps a subtree in empty parent nodes until it sits at `toHeight`.
 *
 * A height gap has to be filled with real nodes rather than skipped, because
 * every tree holding the same keys must produce the same CIDs.
 */
async function lift(
  adapter: StorageAdapter,
  cid: string | null,
  fromHeight: number,
  toHeight: number
): Promise<string | null> {
  if (cid === null) return null;
  let current = cid;
  for (let h = fromHeight + 1; h <= toHeight; h++) {
    current = await saveNode(adapter, Object.freeze({
      height: h,
      keys: Object.freeze([]),
      values: Object.freeze([]),
      children: Object.freeze([current])
    }));
  }
  return current;
}

/** Builds a subtree topped at `topHeight` holding exactly one entry. */
async function singleton(
  adapter: StorageAdapter,
  key: string,
  value: string,
  keyHeight: number,
  topHeight: number
): Promise<string> {
  const leaf = await saveNode(adapter, Object.freeze({
    height: keyHeight,
    keys: Object.freeze([key]),
    values: Object.freeze([value]),
    children: Object.freeze([null, null])
  }));
  return (await lift(adapter, leaf, keyHeight, topHeight))!;
}

/**
 * Splits a subtree into the entries below `key` and those above it, both
 * returned at the input subtree's height.
 */
async function splitSubtree(
  adapter: StorageAdapter,
  cid: string | null,
  key: string
): Promise<readonly [string | null, string | null]> {
  if (cid === null) return [null, null];

  const node = await loadNode(adapter, cid);
  const idx = lowerBound(node.keys, key);

  // The child at `idx` straddles the split point, so it splits too.
  const [childLeft, childRight] = await splitSubtree(adapter, node.children[idx] ?? null, key);

  const left: MSTNode = {
    height: node.height,
    keys: node.keys.slice(0, idx),
    values: node.values.slice(0, idx),
    children: [...node.children.slice(0, idx), childLeft]
  };
  const right: MSTNode = {
    height: node.height,
    keys: node.keys.slice(idx),
    values: node.values.slice(idx),
    children: [childRight, ...node.children.slice(idx + 1)]
  };

  return [await saveOrPrune(adapter, left), await saveOrPrune(adapter, right)];
}

/**
 * Merges two adjacent subtrees of equal height, where every key on the left
 * sorts before every key on the right.
 */
async function mergeSubtrees(
  adapter: StorageAdapter,
  left: string | null,
  right: string | null
): Promise<string | null> {
  if (left === null) return right;
  if (right === null) return left;

  const leftNode = await loadNode(adapter, left);
  const rightNode = await loadNode(adapter, right);

  // The two subtrees meet at the left's last child and the right's first.
  const middle = await mergeSubtrees(
    adapter,
    leftNode.children[leftNode.children.length - 1] ?? null,
    rightNode.children[0] ?? null
  );

  return saveOrPrune(adapter, {
    height: leftNode.height,
    keys: [...leftNode.keys, ...rightNode.keys],
    values: [...leftNode.values, ...rightNode.values],
    children: [...leftNode.children.slice(0, -1), middle, ...rightNode.children.slice(1)]
  });
}

/** Inserts into a subtree known to sit at `subtreeHeight`. */
async function insertInto(
  adapter: StorageAdapter,
  cid: string | null,
  subtreeHeight: number,
  key: string,
  value: string,
  keyHeight: number
): Promise<string> {
  if (cid === null) return singleton(adapter, key, value, keyHeight, subtreeHeight);

  const node = await loadNode(adapter, cid);
  const idx = lowerBound(node.keys, key);

  if (keyHeight === node.height) {
    if (node.keys[idx] === key) {
      const values = [...node.values];
      values[idx] = value;
      return saveNode(adapter, { ...node, values });
    }

    // The key lands between two existing keys, so the subtree that currently
    // spans that gap has to be split around it.
    const [childLeft, childRight] = await splitSubtree(adapter, node.children[idx] ?? null, key);
    return saveNode(adapter, {
      height: node.height,
      keys: [...node.keys.slice(0, idx), key, ...node.keys.slice(idx)],
      values: [...node.values.slice(0, idx), value, ...node.values.slice(idx)],
      children: [...node.children.slice(0, idx), childLeft, childRight, ...node.children.slice(idx + 1)]
    });
  }

  // The key belongs further down; only this child changes.
  const child = await insertInto(
    adapter, node.children[idx] ?? null, node.height - 1, key, value, keyHeight
  );
  const children = [...node.children];
  children[idx] = child;
  return saveNode(adapter, { ...node, children });
}

/** Removes from a subtree, returning its new CID, or `null` if nothing is left. */
async function deleteFrom(
  adapter: StorageAdapter,
  cid: string | null,
  key: string,
  keyHeight: number
): Promise<string | null> {
  if (cid === null) return null;

  const node = await loadNode(adapter, cid);

  // A key sitting above this node cannot appear anywhere beneath it.
  if (keyHeight > node.height) return cid;

  const idx = lowerBound(node.keys, key);

  if (keyHeight === node.height) {
    if (node.keys[idx] !== key) return cid;

    // Removing the separator joins the subtrees on either side of it.
    const merged = await mergeSubtrees(
      adapter, node.children[idx] ?? null, node.children[idx + 1] ?? null
    );
    return saveOrPrune(adapter, {
      height: node.height,
      keys: [...node.keys.slice(0, idx), ...node.keys.slice(idx + 1)],
      values: [...node.values.slice(0, idx), ...node.values.slice(idx + 1)],
      children: [...node.children.slice(0, idx), merged, ...node.children.slice(idx + 2)]
    });
  }

  const existing = node.children[idx] ?? null;
  const child = await deleteFrom(adapter, existing, key, keyHeight);
  if (child === existing) return cid;

  const children = [...node.children];
  children[idx] = child;
  return saveOrPrune(adapter, { ...node, children });
}

/** Walks entries in key order, skipping any subtree whose CID is in `prune`. */
async function walkEntries(
  adapter: StorageAdapter,
  cid: string | null,
  prune: ReadonlySet<string> | null,
  visit: (key: string, value: string) => void
): Promise<void> {
  if (cid === null || prune?.has(cid)) return;

  const node = await loadNode(adapter, cid);
  for (let i = 0; i < node.keys.length; i++) {
    await walkEntries(adapter, node.children[i] ?? null, prune, visit);
    visit(node.keys[i]!, node.values[i]!);
  }
  await walkEntries(adapter, node.children[node.keys.length] ?? null, prune, visit);
}

/** Collects the CID of every node reachable from `cid`. */
async function collectCids(
  adapter: StorageAdapter,
  cid: string | null,
  out: Set<string> = new Set()
): Promise<Set<string>> {
  if (cid === null || out.has(cid)) return out;
  out.add(cid);
  const node = await loadNode(adapter, cid);
  for (const child of node.children) {
    await collectCids(adapter, child ?? null, out);
  }
  return out;
}

// ------------------------------------------------------------ public API

/**
 * Every node CID reachable from a root: the tree as it stands, without the
 * orphans older versions left behind in the store. Sync uses it to decide
 * which of a peer's subtrees it already holds; garbage collection uses it to
 * decide what to keep.
 * @param adapter The storage adapter.
 * @param rootCid The root, or null for an empty tree.
 */
export async function collectReachableCids(adapter: StorageAdapter, rootCid: string | null): Promise<Set<string>> {
  return collectCids(adapter, rootCid);
}

/**
 * Insert a key-value pair into the MST.
 * @param adapter The storage adapter.
 * @param rootCid The current root, or null for an empty tree.
 * @param key The key to insert.
 * @param value The value to store against it.
 * @returns The new root CID.
 */
export async function insertIntoMST(
  adapter: StorageAdapter,
  rootCid: string | null,
  key: string,
  value: string
): Promise<string> {
  const keyHeight = await nodeHeight(key);

  if (rootCid === null) return singleton(adapter, key, value, keyHeight, keyHeight);

  const root = await loadNode(adapter, rootCid);

  if (keyHeight > root.height) {
    // The key outranks everything already stored, so it becomes the new root
    // and the existing tree is split to sit beneath it.
    const [left, right] = await splitSubtree(adapter, rootCid, key);
    return saveNode(adapter, {
      height: keyHeight,
      keys: [key],
      values: [value],
      children: [
        await lift(adapter, left, root.height, keyHeight - 1),
        await lift(adapter, right, root.height, keyHeight - 1)
      ]
    });
  }

  return insertInto(adapter, rootCid, root.height, key, value, keyHeight);
}

/**
 * Delete a key from the MST.
 * @param adapter The storage adapter.
 * @param rootCid The current root, or null for an empty tree.
 * @param key The key to remove.
 * @returns The new root CID, or null once the tree is empty.
 */
export async function deleteFromMST(
  adapter: StorageAdapter,
  rootCid: string | null,
  key: string
): Promise<string | null> {
  if (!rootCid) return null;

  const keyHeight = await nodeHeight(key);
  let next = await deleteFrom(adapter, rootCid, key, keyHeight);

  // Removing the tallest key can leave empty wrappers on top; drop them so the
  // root is always the highest node that actually holds a key.
  while (next !== null) {
    const node = await loadNode(adapter, next);
    if (node.keys.length > 0) break;
    next = node.children[0] ?? null;
  }

  return next;
}

/**
 * Lookup a value by key.
 * @param adapter The storage adapter.
 * @param rootCid The root to search from.
 * @param key The key to find.
 * @returns The value, or null when absent.
 */
export async function lookupInMST(
  adapter: StorageAdapter,
  rootCid: string | null,
  key: string
): Promise<string | null> {
  let cid = rootCid;
  while (cid !== null) {
    const node = await loadNode(adapter, cid);
    const idx = lowerBound(node.keys, key);
    if (node.keys[idx] === key) return node.values[idx]!;
    cid = node.children[idx] ?? null;
  }
  return null;
}

/**
 * List all keys in order.
 * @param adapter The storage adapter.
 * @param rootCid The root to walk.
 * @returns Every key, sorted.
 */
export async function listMSTKeys(adapter: StorageAdapter, rootCid: string | null): Promise<string[]> {
  const keys: string[] = [];
  await walkEntries(adapter, rootCid, null, (key) => { keys.push(key); });
  return keys;
}

/**
 * List all entries — keys with their values — in key order.
 * @param adapter The storage adapter.
 * @param rootCid The root, or null for an empty tree.
 */
export async function listMSTEntries(
  adapter: StorageAdapter,
  rootCid: string | null,
): Promise<Array<{ key: string; value: string }>> {
  const entries: Array<{ key: string; value: string }> = [];
  await walkEntries(adapter, rootCid, null, (key, value) => { entries.push({ key, value }); });
  return entries;
}

/**
 * Compute differences between two MSTs.
 *
 * Any subtree both sides already share has the same CID, so it is skipped
 * whole — the walk only descends into what actually differs.
 *
 * @param localAdapter Adapter holding the local tree.
 * @param localRoot The local root CID.
 * @param remoteAdapter Adapter holding the remote tree.
 * @param remoteRoot The remote root CID.
 * @returns What the remote has that the local does not, and vice versa.
 */
export async function diffMST(
  localAdapter: StorageAdapter,
  localRoot: string | null,
  remoteAdapter: StorageAdapter,
  remoteRoot: string | null
): Promise<MSTDiff> {
  const added: {key: string, value: string}[] = [];
  const removed: {key: string, value: string}[] = [];
  const modified: {key: string, oldValue: string, newValue: string}[] = [];

  // Equal roots mean equal trees, all the way down.
  if (localRoot === remoteRoot) {
    return Object.freeze({
      added: Object.freeze(added),
      removed: Object.freeze(removed),
      modified: Object.freeze(modified)
    });
  }

  const localCids = await collectCids(localAdapter, localRoot);
  const remoteCids = await collectCids(remoteAdapter, remoteRoot);

  const localOnly = new Map<string, string>();
  await walkEntries(localAdapter, localRoot, remoteCids, (key, value) => { localOnly.set(key, value); });

  const remoteOnly = new Map<string, string>();
  await walkEntries(remoteAdapter, remoteRoot, localCids, (key, value) => { remoteOnly.set(key, value); });

  for (const [key, remoteValue] of remoteOnly) {
    const localValue = localOnly.get(key);
    if (localValue === undefined) {
      added.push({ key, value: remoteValue });
    } else if (localValue !== remoteValue) {
      modified.push({ key, oldValue: localValue, newValue: remoteValue });
    }
  }

  for (const [key, localValue] of localOnly) {
    if (!remoteOnly.has(key)) removed.push({ key, value: localValue });
  }

  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    modified: Object.freeze(modified)
  });
}
