/** What is new: records others wrote in an app since you last opened it, tracked in this browser only. */
import { useSyncExternalStore } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { useAccount, useCollections, useLive } from '@weaveprotocol/core/react';
import { namesMe, useSpaceApps, type AppEntry } from './components/apps/entries';

interface Seen {
  /** When this browser started keeping track */
  readonly since: string;
  /** Per space, per app: when it was last open */
  readonly at: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const keyOf = (did: string) => `weave.seen:${did}`;
const cache = new Map<string, Seen>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

function isSeen(value: unknown): value is Seen {
  return (
    typeof value === 'object' &&
    value !== null &&
    'since' in value &&
    typeof value.since === 'string' &&
    'at' in value &&
    typeof value.at === 'object' &&
    value.at !== null
  );
}

function read(did: string): Seen {
  const cached = cache.get(did);
  if (cached) return cached;
  let seen: Seen | null = null;
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(keyOf(did)) ?? 'null');
    if (isSeen(stored)) seen = stored;
  } catch {
    // Storage off or unreadable: start from now, and keep it for this page.
  }
  if (!seen) {
    seen = { since: new Date().toISOString(), at: {} };
    save(did, seen);
  }
  cache.set(did, seen);
  return seen;
}

function save(did: string, seen: Seen) {
  try {
    globalThis.localStorage?.setItem(keyOf(did), JSON.stringify(seen));
  } catch {
    // Kept for this page only.
  }
}

// Another tab looked at something: take its word.
globalThis.addEventListener?.('storage', (event) => {
  if (!event.key?.startsWith('weave.seen:')) return;
  cache.delete(event.key.slice('weave.seen:'.length));
  changed();
});

/** Marks an app in a space as looked at, now */
export function markSeen(did: string, space: string, app: string): void {
  const seen = read(did);
  const next: Seen = {
    since: seen.since,
    at: { ...seen.at, [space]: { ...seen.at[space], [app]: new Date().toISOString() } },
  };
  cache.set(did, next);
  save(did, next);
  changed();
}

/** When an app in a space was last looked at, or when this browser started keeping track */
export const seenAt = (seen: Seen, space: string, app: string): string => seen.at[space]?.[app] ?? seen.since;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What this browser has seen, for the account */
export function useSeen(): Seen {
  const { did } = useAccount();
  return useSyncExternalStore(subscribe, () => read(did));
}

/** What is new in an app: everything, and how much of it names you — a mention, a reply */
export interface Unread {
  readonly count: number;
  readonly forMe: number;
}

const NONE: Unread = { count: 0, forMe: 0 };

/** What is new in each app in a space, by app id */
export function useUnread(spaceId: string, apps: ReadonlyArray<AppEntry>): ReadonlyMap<string, Unread> {
  const { did } = useAccount();
  const seen = useSeen();
  const watch = apps.map((app) => ({
    id: app.id,
    notify: app.notify,
    collections: [...new Set(app.notify.map((n) => n.collection))],
    after: Date.parse(seenAt(seen, spaceId, app.id)),
  }));
  const signature = JSON.stringify(watch);
  const counts = useLive(
    spaceId,
    async (node) => {
      const out = new Map<string, Unread>();
      for (const app of watch) {
        let count = 0;
        let forMe = 0;
        for (const collection of app.collections) {
          const records = await node.records
            .list(spaceId, { collection, newestFirst: true, limit: 100 })
            .catch(() => []);
          for (const record of records) {
            if (record.createdBy === did || Date.parse(record.createdAt) <= app.after) continue;
            count++;
            if (namesMe(app.notify, collection, record.body, did)) forMe++;
          }
        }
        out.set(app.id, { count, forMe });
      }
      return out;
    },
    [signature, did],
  );
  return counts ?? EMPTY;
}

const EMPTY: ReadonlyMap<string, Unread> = new Map();

/** What is new in one app, or nothing */
export const unreadOf = (unread: ReadonlyMap<string, Unread>, id: string): Unread => unread.get(id) ?? NONE;

/** Everything new across some apps */
export function totalOf(unread: ReadonlyMap<string, Unread>): Unread {
  let count = 0;
  let forMe = 0;
  for (const one of unread.values()) {
    count += one.count;
    forMe += one.forMe;
  }
  return { count, forMe };
}

/** Everything new in a space, across its apps: for the list of spaces and the rail */
export function useSpaceUnread(space: SpaceSummary): Unread {
  const collections = useCollections(space.id);
  const { ready } = useSpaceApps(space, collections);
  return totalOf(useUnread(space.id, ready));
}
