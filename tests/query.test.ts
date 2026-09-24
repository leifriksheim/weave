/**
 * Queries: filters over bodies and record fields, a total sort, paging, and
 * following links with include.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { matches, checkQuery } from '../src/query/filter.js';
import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import type { NodeRecord, P2PNode } from '../src/node/types.js';
import type { QueryResult } from '../src/query/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { memoryStores } from './helpers/memory-stores.js';

function record(body: unknown, extra: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: 'bafy', key: 'k1', version: 'bafy', seq: 0, collection: 'app.x', body,
    author: 'did:key:session', root: 'did:key:alice', createdBy: 'did:key:alice',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
    verified: true, encrypted: false, links: [], conforms: true,
    ...extra,
  } as NodeRecord;
}

describe('filters', () => {
  const r = record({ text: 'Buy Milk', done: false, amount: 12, tags: ['home', 'shop'], place: { city: 'Oslo' } });

  test('bare values mean equality; operators compare', () => {
    assert.equal(matches(r, { done: false }), true);
    assert.equal(matches(r, { done: true }), false);
    assert.equal(matches(r, { amount: { $gt: 10, $lte: 12 } }), true);
    assert.equal(matches(r, { amount: { $gt: 12 } }), false);
    assert.equal(matches(r, { amount: { $in: [1, 12] } }), true);
    assert.equal(matches(r, { amount: { $nin: [1, 12] } }), false);
  });

  test('dotted paths reach into the body; @ fields are about the record', () => {
    assert.equal(matches(r, { 'place.city': 'Oslo' }), true);
    assert.equal(matches(r, { '@root': 'did:key:alice' }), true);
    assert.equal(matches(r, { '@createdAt': { $gte: '2026-09-01' } }), true);
    assert.throws(() => matches(r, { '@nope': 1 }), /Unknown record field/);
  });

  test('$ne and $exists treat a missing field the way people expect', () => {
    assert.equal(matches(r, { priority: { $ne: 'high' } }), true);
    assert.equal(matches(r, { priority: { $exists: false } }), true);
    assert.equal(matches(r, { text: { $exists: true } }), true);
  });

  test('$contains: case-insensitive in text, membership in lists', () => {
    assert.equal(matches(r, { text: { $contains: 'milk' } }), true);
    assert.equal(matches(r, { tags: { $contains: 'shop' } }), true);
    assert.equal(matches(r, { tags: { $contains: 'work' } }), false);
  });

  test('comparisons across types never match', () => {
    assert.equal(matches(r, { amount: { $gt: '1' } }), false);
  });

  test('$and, $or, $not', () => {
    assert.equal(matches(r, { $or: [{ done: true }, { amount: 12 }] }), true);
    assert.equal(matches(r, { $and: [{ done: false }, { amount: 1 }] }), false);
    assert.equal(matches(r, { $not: { done: true } }), true);
  });

  test('a malformed query is refused with a reason', () => {
    assert.equal(checkQuery({ collection: 'app.x', where: { done: false } }), null);
    assert.match(checkQuery({}) ?? '', /collection/);
    assert.match(checkQuery({ collection: 'app.x', where: { a: { $regex: 'x' } } }) ?? '', /unknown operator "\$regex"/);
    assert.match(checkQuery({ collection: 'app.x', where: { $where: 'x' } }) ?? '', /not a field/);
    assert.match(checkQuery({ collection: 'app.x', sort: { a: 'up' } }) ?? '', /"asc" or "desc"/);
    const deep = { rel: 'about', include: { b: { rel: 'about', include: { c: { rel: 'about', include: { d: { rel: 'about' } } } } } } };
    assert.match(checkQuery({ collection: 'app.x', include: { a: deep } }) ?? '', /at most 3 deep/);
  });
});

describe('queries on a node', () => {
  const open: P2PNode[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((node) => node.close()));
  });

  async function person() {
    const manager = createIdentityManager();
    const me = await manager.fromSeed(generateSeed());
    const node = await createNode({ signer: createLocalRootSigner(me, manager.getProvider()), stores: memoryStores(), watchIntervalMs: 0 });
    open.push(node);
    return node;
  }

  async function todos(node: P2PNode, visibility: 'public' | 'private' = 'private') {
    const { id: space } = await node.spaces.create({ name: 'Todos', visibility });
    const items = [];
    for (const [i, text] of ['milk', 'bread', 'eggs', 'coffee', 'tea'].entries()) {
      items.push(await node.records.put(space, 'app.todo.item', { text, done: i % 2 === 1, rank: 5 - i }, { key: `todo-${i}` }));
    }
    return { space, items };
  }

  test('filter and sort over decrypted bodies in a private space', async () => {
    const me = await person();
    const { space } = await todos(me);
    const open = await me.records.query<{ text: string }>(space, {
      collection: 'app.todo.item',
      where: { done: false },
      sort: { rank: 'asc' },
    });
    assert.deepEqual(open.records.map((r) => r.body?.text), ['tea', 'eggs', 'milk']);
    assert.equal(open.cursor, null);
  });

  test('pages with a cursor, never skipping or repeating — even on ties', async () => {
    const me = await person();
    const { space } = await todos(me);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      // Every record ties on done within its group; the key breaks it.
      const page: QueryResult = await me.records.query(space, { collection: 'app.todo.item', sort: { done: 'asc' }, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.records.map((r) => r.key));
      cursor = page.cursor;
    } while (cursor);
    assert.deepEqual(seen, ['todo-0', 'todo-2', 'todo-4', 'todo-1', 'todo-3']);
  });

  test('deleted records are not found', async () => {
    const me = await person();
    const { space } = await todos(me);
    await me.records.delete(space, 'todo-0');
    const all = await me.records.query(space, { collection: 'app.todo.item' });
    assert.equal(all.records.some((r) => r.key === 'todo-0'), false);
    assert.equal(all.records.length, 4);
  });

  test('include pulls in what links to each result: records, counts, filtered, nested', async () => {
    const me = await person();
    const { space } = await todos(me);
    const on = (key: string) => [{ rel: 'about', to: key }];
    await me.records.put(space, 'std.reaction', { emoji: '👍' }, { links: on('todo-0') });
    await me.records.put(space, 'std.reaction', { emoji: '🎉' }, { links: on('todo-0') });
    const comment = await me.records.put(space, 'std.comment', { text: 'oat milk?' }, { links: on('todo-0') });
    await me.records.put(space, 'std.comment', { text: 'yes' }, { links: [...on(comment.key), { rel: 'replyTo', to: comment.key }] });

    const result = await me.records.query(space, {
      collection: 'app.todo.item',
      where: { '@key': 'todo-0' },
      include: {
        reactions: { rel: 'about', from: 'std.reaction', count: true },
        thumbs: { rel: 'about', from: 'std.reaction', where: { emoji: '👍' } },
        comments: { rel: 'about', from: 'std.comment', include: { replies: { rel: 'replyTo', from: 'std.comment' } } },
      },
    });
    const [todo] = result.records;
    assert.equal(todo?.included?.reactions, 2);
    assert.equal((todo?.included?.thumbs as NodeRecord[]).length, 1);
    const [first] = todo?.included?.comments as Array<{ body: { text: string }; included: { replies: Array<{ body: { text: string } }> } }>;
    assert.equal(first?.body.text, 'oat milk?');
    assert.deepEqual(first?.included.replies.map((r) => r.body.text), ['yes']);
  });

  test('include with direction "out" follows a record’s own links', async () => {
    const me = await person();
    const { space } = await todos(me, 'public');
    await me.records.put(space, 'std.comment', { text: 'about milk' }, { links: [{ rel: 'about', to: 'todo-0' }] });
    const result = await me.records.query<{ text: string }>(space, {
      collection: 'std.comment',
      include: { target: { rel: 'about', direction: 'out' } },
    });
    const target = result.records[0]?.included?.target as Array<{ body: { text: string } }>;
    assert.deepEqual(target.map((t) => t.body.text), ['milk']);
  });

  test('watch re-runs when records change, and stops when told', async () => {
    const me = await person();
    const { space } = await todos(me);
    const counts: number[] = [];
    const stop = me.records.watch(space, { collection: 'app.todo.item', where: { done: false } }, (r) => counts.push(r.records.length));
    const until = async (n: number) => {
      const deadline = Date.now() + 2000;
      while (counts.at(-1) !== n) {
        if (Date.now() > deadline) throw new Error(`expected ${n}, saw ${counts.join(',')}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await until(3);
    await me.records.update(space, 'todo-0', { text: 'milk', done: true, rank: 5 });
    await until(2);
    stop();
    const before = counts.length;
    await me.records.update(space, 'todo-2', { text: 'eggs', done: true, rank: 3 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(counts.length, before);
  });

  test('an agent queries through the action, and a bad query says what to fix', async () => {
    const me = await person();
    const { space } = await todos(me);
    const result = (await runAction(me, 'records_query', { space, collection: 'app.todo.item', where: { text: { $contains: 'CO' } } })) as QueryResult<{ text: string }>;
    assert.deepEqual(result.records.map((r) => r.body?.text), ['coffee']);
    await assert.rejects(runAction(me, 'records_query', { space, collection: 'app.todo.item', where: { text: { $like: 'x' } } }), /unknown operator "\$like"/);
  });
});
