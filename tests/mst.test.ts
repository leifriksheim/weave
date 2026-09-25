/**
 * MST tests — the structural invariants that make the tree a Merkle *Search*
 * Tree, plus the cost guarantees that depend on them.
 *
 * The property that matters most is determinism: the same set of entries must
 * produce the same root CID regardless of insertion order. Everything the sync
 * protocol does with roots rests on it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import {
  insertIntoMST,
  deleteFromMST,
  lookupInMST,
  listMSTEntries,
  loadNode,
  nodeHeight,
  createEmptyNode,
  type MSTNode,
} from '../src/storage/mst.js';
import type { StorageAdapter } from '../src/types.js';

const listMSTKeys = async (adapter: StorageAdapter, root: string | null) => (await listMSTEntries(adapter, root)).map((e) => e.key);

/** Builds a tree from entries in the order given, returning the root. */
async function build(adapter: StorageAdapter, keys: ReadonlyArray<string>): Promise<string | null> {
  let root: string | null = null;
  for (const key of keys) root = await insertIntoMST(adapter, root, key, `v:${key}`);
  return root;
}

/** A deterministic shuffle, so a failure is reproducible. */
function shuffle<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const keyRange = (n: number, prefix = 'key') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`);

/**
 * Walks the whole tree asserting every structural invariant, and reports the
 * shape so tests can make claims about depth.
 */
async function checkInvariants(adapter: StorageAdapter, root: string | null) {
  let nodeCount = 0;
  let maxDepth = 0;
  const seenKeys: string[] = [];

  async function visit(cid: string | null, expectedHeight: number, depth: number): Promise<void> {
    if (cid === null) return;
    nodeCount++;
    maxDepth = Math.max(maxDepth, depth);

    const node = await loadNode(adapter, cid);

    assert.equal(node.height, expectedHeight, `node ${cid} sits at the wrong height`);
    assert.equal(
      node.children.length,
      node.keys.length + 1,
      `node ${cid} has ${node.children.length} children for ${node.keys.length} keys`,
    );
    assert.equal(node.values.length, node.keys.length, `node ${cid} key/value length mismatch`);

    for (let i = 0; i < node.keys.length; i++) {
      const key = node.keys[i]!;
      assert.equal(
        await nodeHeight(key),
        node.height,
        `key ${key} hashes to a different height than the node holding it`,
      );
      if (i > 0) {
        assert.ok(node.keys[i - 1]! < key, `keys out of order in ${cid}: ${node.keys[i - 1]} !< ${key}`);
      }
    }

    // An empty node is only legitimate as a spacer with exactly one child.
    if (node.keys.length === 0) {
      assert.equal(node.children.length, 1, `empty node ${cid} should have exactly one child slot`);
      assert.notEqual(node.children[0], null, `empty node ${cid} should never be stored with no child`);
    }

    for (let i = 0; i < node.keys.length; i++) {
      await visit(node.children[i] ?? null, node.height - 1, depth + 1);
      seenKeys.push(node.keys[i]!);
    }
    await visit(node.children[node.keys.length] ?? null, node.height - 1, depth + 1);
  }

  if (root !== null) {
    const rootNode = await loadNode(adapter, root);
    assert.ok(rootNode.keys.length > 0, 'the root should always carry at least one key');
    await visit(root, rootNode.height, 1);
  }

  const sorted = [...seenKeys].sort();
  assert.deepEqual(seenKeys, sorted, 'in-order traversal did not produce sorted keys');

  return { nodeCount, maxDepth };
}

describe('MST structure', () => {
  test('an empty node reports the height it was made at', () => {
    const node: MSTNode = createEmptyNode(3);
    assert.equal(node.height, 3);
    assert.deepEqual(node.keys, []);
    assert.deepEqual(node.children, [null]);
  });

  test('inserts round-trip and come back sorted', async () => {
    const adapter = createMemoryAdapter();
    const keys = shuffle(keyRange(500), 7);
    const root = await build(adapter, keys);

    for (const key of keys) {
      assert.equal(await lookupInMST(adapter, root, key), `v:${key}`);
    }
    assert.deepEqual(await listMSTKeys(adapter, root), [...keys].sort());
    assert.equal(await lookupInMST(adapter, root, 'key-99999'), null, 'absent key should miss');
  });

  test('holds every structural invariant at scale', async () => {
    const adapter = createMemoryAdapter();
    const root = await build(adapter, shuffle(keyRange(2000), 11));
    const { maxDepth } = await checkInvariants(adapter, root);

    // The regression this suite exists for: a single fat root node is not a tree.
    assert.ok(maxDepth > 1, `tree collapsed to depth ${maxDepth} — keys are not being pushed down`);
  });

  test('is deterministic — insertion order cannot change the root CID', async () => {
    const keys = keyRange(1000);

    const a = createMemoryAdapter();
    const rootA = await build(a, keys);

    const b = createMemoryAdapter();
    const rootB = await build(b, shuffle(keys, 3));

    const c = createMemoryAdapter();
    const rootC = await build(c, [...keys].reverse());

    assert.equal(rootA, rootB, 'shuffled insertion produced a different root');
    assert.equal(rootA, rootC, 'reversed insertion produced a different root');
  });

  test('updating a key changes the value and the root, not the key set', async () => {
    const adapter = createMemoryAdapter();
    const keys = keyRange(200);
    const root = await build(adapter, keys);

    const updated = await insertIntoMST(adapter, root, keys[42]!, 'replacement');
    assert.notEqual(updated, root, 'a changed value must change the root');
    assert.equal(await lookupInMST(adapter, updated, keys[42]!), 'replacement');
    assert.deepEqual(await listMSTKeys(adapter, updated), [...keys].sort());
    await checkInvariants(adapter, updated);
  });
});

describe('MST deletion', () => {
  test('removes keys and keeps the tree canonical', async () => {
    const adapter = createMemoryAdapter();
    const keys = keyRange(600);
    let root = await build(adapter, shuffle(keys, 5));

    const doomed = shuffle(keys, 9).slice(0, 200);
    for (const key of doomed) root = await deleteFromMST(adapter, root, key);

    const survivors = keys.filter((k) => !doomed.includes(k)).sort();
    assert.deepEqual(await listMSTKeys(adapter, root), survivors);
    for (const key of doomed) {
      assert.equal(await lookupInMST(adapter, root, key), null, `${key} survived deletion`);
    }
    await checkInvariants(adapter, root);
  });

  test('delete is the exact inverse of insert', async () => {
    const adapter = createMemoryAdapter();
    const keys = keyRange(400);

    const baseline = await build(adapter, keys);

    // Add some extras, then take them back out again.
    let root: string | null = baseline;
    const extras = keyRange(50, 'extra');
    for (const key of extras) root = await insertIntoMST(adapter, root, key, `v:${key}`);
    assert.notEqual(root, baseline);
    for (const key of shuffle(extras, 13)) root = await deleteFromMST(adapter, root, key);

    assert.equal(root, baseline, 'insert-then-delete did not return the original tree');
  });

  test('emptying the tree yields a null root', async () => {
    const adapter = createMemoryAdapter();
    const keys = keyRange(120);
    let root: string | null = await build(adapter, keys);

    for (const key of shuffle(keys, 17)) root = await deleteFromMST(adapter, root, key);

    assert.equal(root, null);
    assert.deepEqual(await listMSTKeys(adapter, root), []);
  });

  test('deleting an absent key leaves the root untouched', async () => {
    const adapter = createMemoryAdapter();
    const root = await build(adapter, keyRange(100));
    assert.equal(await deleteFromMST(adapter, root, 'not-in-the-tree'), root);
  });
});

describe('MST cost', () => {
  /** Counts adapter writes so the tests can assert on amplification. */
  function countingAdapter() {
    const inner = createMemoryAdapter();
    const stats = { puts: 0, bytes: 0 };
    const adapter: StorageAdapter = {
      ...inner,
      async put(key: string, value: Uint8Array) {
        stats.puts++;
        stats.bytes += value.byteLength;
        return inner.put(key, value);
      },
    };
    return { adapter, stats };
  }

  test('write amplification stays flat as the tree grows', async () => {
    const small = countingAdapter();
    await build(small.adapter, shuffle(keyRange(500), 21));
    const smallBytesPerInsert = small.stats.bytes / 500;

    const large = countingAdapter();
    await build(large.adapter, shuffle(keyRange(4000), 21));
    const largeBytesPerInsert = large.stats.bytes / 4000;

    // An 8x bigger tree must not cost meaningfully more per insert. The old
    // single-node implementation grew this linearly.
    const growth = largeBytesPerInsert / smallBytesPerInsert;
    assert.ok(
      growth < 2,
      `bytes per insert grew ${growth.toFixed(1)}x from N=500 to N=4000 ` +
        `(${smallBytesPerInsert.toFixed(0)} -> ${largeBytesPerInsert.toFixed(0)} B) — insert is not O(log N)`,
    );

    const putsPerInsert = large.stats.puts / 4000;
    assert.ok(putsPerInsert < 12, `${putsPerInsert.toFixed(1)} node writes per insert is too many`);
  });
});

describe('MST listing under a prefix', () => {
  test('lists exactly the keys that start with it, in order', async () => {
    const adapter = createMemoryAdapter();
    const keys = [...keyRange(500), 'a', 'key', 'key-', 'kez', 'zzz'];
    const root = await build(adapter, keys);
    for (const prefix of ['', 'key-001', 'key-0049', 'key', 'kez', 'nothing', 'a', 'z']) {
      const listed = (await listMSTEntries(adapter, root, prefix)).map((e) => e.key);
      assert.deepEqual(listed, keys.filter((k) => k.startsWith(prefix)).sort(), `prefix "${prefix}"`);
    }
  });

  test('reads only the nodes that can hold them', async () => {
    const adapter = createMemoryAdapter();
    const root = await build(adapter, keyRange(4000));
    let loads = 0;
    const counting: StorageAdapter = {
      ...adapter,
      async get(key: string) {
        loads++;
        return adapter.get(key);
      },
    };
    const listed = await listMSTEntries(counting, root, 'key-0200');
    assert.equal(listed.length, 10);
    assert.ok(loads < 40, `${loads} nodes read to list 10 of 4,000 entries`);
  });
});
