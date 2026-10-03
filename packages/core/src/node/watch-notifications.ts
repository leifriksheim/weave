/**
 * @module node/watch-notifications
 * An app showing its own notifications: the subscriptions the person kept for
 * it, matched against records as they arrive.
 *
 * The subscriptions live in the account registry (`space/notify.ts`), which a
 * node given the whole account can open. This reads the ones naming the app,
 * follows every space they look at, and hands each new record that matches
 * to the app — which decides how to show it. What was already there when it
 * started is never news.
 */
import { matchesRecord, whereHolds } from '../space/notify.js';
import type { NodeRecord, NotifyView, P2PNode } from './types.js';
import { serial } from '../utils/serial.js';

/** A record one of the app's subscriptions asks about */
export interface NotifyMatch {
  readonly subscription: NotifyView;
  readonly record: NodeRecord;
}

export interface WatchNotificationsOptions {
  /** The app's origin, as the home saw it. Default: this page's. */
  readonly origin?: string;
  readonly onNotify: (match: NotifyMatch) => void;
  readonly onError?: (error: unknown) => void;
}

/** How many of the newest records of a collection are looked at after each change */
const LOOK_BACK = 50;

/**
 * Starts matching. Needs a node with the account key — an app connected with
 * `scope: 'account'`; any other has no subscriptions to read, and hears nothing.
 * @returns Stops it
 */
export function watchNotifications(node: P2PNode, options: WatchNotificationsOptions): () => void {
  const origin = options.origin ?? globalThis.location?.origin;
  let stopped = false;
  let subscriptions: ReadonlyArray<NotifyView> = [];
  let spaces = new Set<string>();
  /** Record keys already seen, by space and collection: anything else is new */
  const seen = new Map<string, Set<string>>();
  /** Spaces with a change not yet looked at; null means the subscriptions or spaces changed */
  const dirty = new Set<string | null>([null]);

  const collectionsIn = (space: string) =>
    new Set(
      subscriptions
        .filter((sub) => sub.spaces === 'all' || sub.spaces.includes(space))
        .map((sub) => sub.collection),
    );

  /** Hands on what is new in one collection; the first look at one only learns what is there */
  async function look(space: string, collection: string): Promise<void> {
    const where = `${space}\n${collection}`;
    const first = !seen.has(where);
    const known = seen.get(where) ?? new Set<string>();
    seen.set(where, known);
    const records = await node.records.list(space, { collection, newestFirst: true, limit: LOOK_BACK });
    for (const record of records) {
      if (known.has(record.key)) continue;
      known.add(record.key);
      if (first) continue;
      for (const subscription of subscriptions) {
        if (stopped) return;
        if (matchesRecord(subscription, record, node.did) && (await whereHolds(subscription, record)))
          options.onNotify({ subscription, record });
      }
    }
  }

  async function reload(): Promise<void> {
    subscriptions = (await node.notifications.list()).filter(
      (sub) => !sub.paused && sub.app?.origin === origin,
    );
    spaces = new Set((await node.spaces.list()).map((space) => space.id));
    // Anything newly looked at starts from what is there now. What was looked at before still
    // reports what arrived since: the account changes all the time, and that is no reason to drop news.
    for (const space of spaces) for (const collection of collectionsIn(space)) await look(space, collection);
  }

  // One look at a time; asked meanwhile, it looks once more after.
  const kick = serial(async () => {
    if (stopped) return;
    const changed = [...dirty];
    dirty.clear();
    try {
      if (changed.includes(null)) await reload();
      for (const space of changed) {
        if (space === null || !spaces.has(space)) continue;
        for (const collection of collectionsIn(space)) await look(space, collection);
      }
    } catch (error) {
      options.onError?.(error);
    }
  });

  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'spaces' || event.type === 'account') dirty.add(null);
    else if (event.type === 'records') dirty.add(spaces.has(event.space) ? event.space : null);
    else return;
    void kick();
  });
  void kick();

  return () => {
    stopped = true;
    unsubscribe();
  };
}
