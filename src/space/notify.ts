/**
 * @module space/notify
 * Subscriptions: "let me know when…", across spaces, by nodes that can't read.
 *
 * A person says what they want to hear about — new records in a collection,
 * in some spaces or all of them, perhaps only those with a topic value
 * ("mentions me", "in #design"), perhaps only other people's. That is kept in
 * the account registry, sealed, value and all (`NOTIFY_COLLECTION`).
 *
 * The account's carriers — its extension, its hosts — are the ones online to
 * notice, and they can't read. So every device holding the account key copies
 * each subscription into each carry space with the value replaced by that
 * space's topic tag (`records/topics.ts`): a carrier learns "tag X, in Club",
 * never what X stands for. It matches arriving records by space, collection,
 * author and tag, all on the outside of a record, and says so; the extension
 * shows a notification. The label is the person's own words, shown as is.
 *
 * The same split as a query in a space held in part (BLOCK-22): the part a
 * blind node can check runs there, the rest where the keys are.
 */
import type { Expression } from '../types.js';
import type { SpaceKey } from '../privacy/space-encryption.js';
import { parseUCAN } from '../identity/ucan.js';
import { checkTopics, topicKey, topicTag } from '../records/topics.js';

/** Subscriptions as the person made them, in the account registry: key `notify:<id>` */
export const NOTIFY_COLLECTION = 'sys.notify';
/** Subscriptions as a carrier holds them, in its carry space: the same key, values replaced by tags */
export const SUBSCRIPTION_COLLECTION = 'sys.subscription';

/** Spaces a subscription looks at: every space of the account, or these */
export type NotifySpaces = 'all' | ReadonlyArray<string>;

/** A subscription as the person made it */
export interface NotifyWhen {
  /** What the notification says, in the person's words: "Mentioned in Club" */
  readonly label: string;
  /** New records in this collection */
  readonly collection: string;
  readonly spaces: NotifySpaces;
  /** Only records whose topic field holds this value — `{ field: 'mentions', value: <my did> }` */
  readonly topic?: { readonly field: string; readonly value: string | number | boolean };
  /** Only records other people wrote. Default true. */
  readonly others?: boolean;
  /** Where clicking the notification goes: an app's address. Default: the account home. */
  readonly open?: string;
  /** Kept, but quiet */
  readonly paused?: boolean;
  /** When it was made: nothing written before it notifies */
  readonly since: string;
}

/** A subscription as a carrier holds it: no values, only tags */
export interface CarriedSubscription {
  readonly v: 1;
  readonly label: string;
  readonly collection: string;
  readonly spaces: NotifySpaces;
  /** Per space: a record matches when it carries any of these. Absent: no topic, every record matches. */
  readonly tags?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly others: boolean;
  readonly open?: string;
  readonly paused: boolean;
  readonly since: string;
}

const COLLECTION = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/** Why a subscription can't be kept, or null */
export function checkNotify(when: unknown): string | null {
  const w = when as Partial<NotifyWhen> | null;
  if (typeof w !== 'object' || w === null) return 'A subscription must be an object';
  if (typeof w.label !== 'string' || !w.label.trim() || w.label.length > 120) return 'label is what the notification says: some text, at most 120 characters';
  if (typeof w.collection !== 'string' || !COLLECTION.test(w.collection) || w.collection.startsWith('sys.')) return 'collection must be one of the space’s collections, like "app.chat.message"';
  if (w.spaces !== 'all' && !(Array.isArray(w.spaces) && w.spaces.length > 0 && w.spaces.length <= 256 && w.spaces.every((s) => typeof s === 'string'))) {
    return 'spaces must be "all" or a list of space ids';
  }
  if (w.topic !== undefined) {
    const t = w.topic as Partial<NonNullable<NotifyWhen['topic']>> | null;
    if (typeof t !== 'object' || t === null || typeof t.field !== 'string' || checkTopics([t.field]) !== null) return 'topic.field must be a field name';
    if (!['string', 'number', 'boolean'].includes(typeof t.value)) return 'topic.value must be text, a number or yes/no';
  }
  if (w.others !== undefined && typeof w.others !== 'boolean') return 'others must be true or false';
  if (w.paused !== undefined && typeof w.paused !== 'boolean') return 'paused must be true or false';
  if (w.open !== undefined) {
    try {
      const url = new URL(w.open);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return 'open must be an https:// address';
    } catch {
      return 'open must be a web address';
    }
  }
  if (typeof w.since !== 'string' || !Number.isFinite(Date.parse(w.since))) return 'since must be a date';
  return null;
}

/** A space the account follows, as far as a subscription needs: its id, and its current key when private */
export interface NotifySpace {
  readonly id: string;
  readonly key: SpaceKey | null;
  readonly visibility: 'public' | 'private';
}

/**
 * What a carrier gets: the subscription with its value replaced by each
 * space's tag. A private space whose key this device doesn't hold gets none,
 * so it never matches — better quiet than wrong.
 */
export async function carriedFor(when: NotifyWhen, spaces: ReadonlyArray<NotifySpace>): Promise<CarriedSubscription> {
  let tags: Record<string, string[]> | undefined;
  if (when.topic) {
    tags = {};
    const looked = when.spaces === 'all' ? spaces : spaces.filter((s) => (when.spaces as ReadonlyArray<string>).includes(s.id));
    for (const space of looked) {
      if (space.visibility === 'private' && !space.key) continue;
      const key = await topicKey(space.visibility === 'private' ? { spaceKey: space.key!.key } : { spaceId: space.id });
      tags[space.id] = [await topicTag(key, when.collection, when.topic.field, when.topic.value)];
    }
  }
  return {
    v: 1,
    label: when.label,
    collection: when.collection,
    spaces: when.spaces,
    ...(tags ? { tags } : {}),
    others: when.others ?? true,
    ...(when.open ? { open: when.open } : {}),
    paused: when.paused ?? false,
    since: when.since,
  };
}

/** A carried subscription as read back from a carry space, or null when it isn't one */
export function readCarried(body: unknown): CarriedSubscription | null {
  const b = body as Partial<CarriedSubscription> | null;
  if (typeof b !== 'object' || b === null || b.v !== 1) return null;
  const problem = checkNotify({ ...b, others: b.others, topic: undefined });
  if (problem) return null;
  if (b.tags !== undefined) {
    if (typeof b.tags !== 'object' || b.tags === null) return null;
    for (const list of Object.values(b.tags)) if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) return null;
  }
  return b as CarriedSubscription;
}

/** Who a version was written for: the account at the root of its note, else its own key */
export function rootOf(version: Expression): string {
  if (!version.proof) return version.author;
  try {
    return parseUCAN(version.proof).payload.iss;
  } catch {
    return version.author;
  }
}

/** How long after it was written a record may still notify: a carrier catching up on last week stays quiet */
export const NOTIFY_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a record that just arrived in a space is one a subscription asks
 * about — decided from its outside alone.
 */
export function matchesSubscription(sub: CarriedSubscription, spaceId: string, version: Expression, account: string, now = Date.now()): boolean {
  if (sub.paused || version.collection !== sub.collection) return false;
  if (version.seq !== 0 || version.deleted) return false;
  if (sub.spaces !== 'all' && !sub.spaces.includes(spaceId)) return false;
  const written = Date.parse(version.createdAt);
  if (!Number.isFinite(written) || written < Date.parse(sub.since) || now - written > NOTIFY_WITHIN_MS) return false;
  if (sub.others && rootOf(version) === account) return false;
  if (sub.tags) {
    const wanted = sub.tags[spaceId];
    if (!wanted?.length || !version.tags?.some((tag) => wanted.includes(tag))) return false;
  }
  return true;
}
