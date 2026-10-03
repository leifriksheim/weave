/**
 * An app showing its own notifications (`watchNotifications`): every new record a
 * kept subscription asks about, once, whatever else changes at the same time.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { watchNotifications, type NotifyMatch } from '../src/node/watch-notifications.js';
import type { NodeEvent, NodeRecord, NotifyView, P2PNode } from '../src/node/types.js';
import { until } from './helpers/until.js';

const ME = 'did:key:zMe';
const ORIGIN = 'https://chat.test';

/** A message to me, from someone else */
const dm = (key: string): NodeRecord => ({
  key,
  version: `v-${key}`,
  seq: 0,
  space: 'club',
  collection: 'std.direct',
  author: 'did:key:zBo',
  root: 'did:key:zBo',
  createdBy: 'did:key:zBo',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  body: { to: [ME] },
  links: [],
  encrypted: true,
  verified: true,
  conforms: true,
});

/** Just enough of a node: one space, its direct messages, and events to send by hand */
function fakeNode() {
  const records: NodeRecord[] = [];
  const listeners = new Set<(event: NodeEvent) => void>();
  const subscription: NotifyView = {
    id: 'notify:1',
    label: 'New direct message',
    collection: 'std.direct',
    spaces: 'all',
    topic: { field: 'to', value: ME },
    app: { origin: ORIGIN },
    since: new Date(Date.now() - 60_000).toISOString(),
  };
  const node = {
    did: ME,
    subscribe: (listener: (event: NodeEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifications: { list: async () => [subscription] },
    spaces: { list: async () => [{ id: 'club' }] },
    records: { list: async () => [...records].reverse() },
  };
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a fake with only the members the watcher reaches
    node: node as unknown as P2PNode,
    add: (record: NodeRecord) => records.push(record),
    emit: (event: NodeEvent) => listeners.forEach((listener) => listener(event)),
  };
}

describe('an app showing its own notifications', () => {
  test('a record arriving as the account changes is still news', async () => {
    const { node, add, emit } = fakeNode();
    add(dm('before'));
    const heard: NotifyMatch[] = [];
    const stop = watchNotifications(node, { origin: ORIGIN, onNotify: (match) => heard.push(match) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The message and an account change (another device, a setting) land together.
    add(dm('hello'));
    emit({ type: 'account' });
    emit({ type: 'records', space: 'club' });
    await until(() => heard.length > 0, 1000, 'the message');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      heard.map((match) => match.record.key),
      ['hello'],
      'once, and never what was there before',
    );
    stop();
  });
});
