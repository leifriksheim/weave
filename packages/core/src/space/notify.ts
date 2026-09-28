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
 * never what X stands for. It can match arriving records by space,
 * collection, author and tag, all on the outside of a record, and say so
 * (`CarrierEvent` 'notify') — what a host needs to wake an app that is closed.
 * No carrier shows notifications itself. The label is the person's own words,
 * shown as is.
 *
 * The same split as a query in a space held in part (spec/05-sync-and-storage.md, What a node holds): the part a
 * blind node can check runs there, the rest where the keys are.
 *
 * Only an app proposes subscriptions (`NotifyProposal`), when the person asks
 * it to — "Notify me" — as a node already connected (`proposeToHome`); never
 * while connecting, and never a carrier or the home on its own. The person
 * says yes to each on the home's approval screen, and the home writes them
 * into the registry naming the app — the app never writes there itself. In
 * the home they can pause or remove them, not add any.
 *
 * The app that asked shows the notifications: an app given the whole account
 * reads the registry and matches what it sees arrive (`matchesRecord`,
 * `node/watch-notifications.ts`), with the body in hand.
 */
import type { Expression } from '../types.js';
import type { SpaceKey } from '../privacy/space-encryption.js';
import { parseUCAN } from '../identity/ucan.js';
import { checkTopics, topicKey, topicTag, topicValues } from '../records/topics.js';
import { isObject } from '../utils/guards.js';

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
  /** The app that proposed it, by the origin the browser reported. Absent: the person made it in the home. */
  readonly app?: NotifyApp;
}

/** Who proposed a subscription */
export interface NotifyApp {
  readonly origin: string;
  /** What the app called itself. Shown, never trusted. */
  readonly name?: string;
}

/**
 * A subscription an app asks for. It looks at the spaces the app may reach —
 * every space for a whole-account app or a carrier, else the spaces it was
 * given — or at `spaces`, some of those. `topic.me` stands for the account's
 * DID, which the app does not know before it connects: "mentions me".
 */
export interface NotifyProposal {
  readonly label: string;
  readonly collection: string;
  readonly topic?:
    | { readonly field: string; readonly value: string | number | boolean }
    | { readonly field: string; readonly me: true };
  readonly others?: boolean;
  /** Only these of the spaces the app may reach. Default: all of them. */
  readonly spaces?: ReadonlyArray<string>;
  /** Must be on the app's own origin. Default: the app's origin. */
  readonly open?: string;
}

/** At most this many proposals in one request */
export const MAX_PROPOSALS = 8;

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
  if (!isObject(when)) return 'A subscription must be an object';
  const w = when;
  if (typeof w.label !== 'string' || !w.label.trim() || w.label.length > 120)
    return 'label is what the notification says: some text, at most 120 characters';
  if (typeof w.collection !== 'string' || !COLLECTION.test(w.collection) || w.collection.startsWith('sys.'))
    return 'collection must be one of the space’s collections, like "app.chat.message"';
  if (
    w.spaces !== 'all' &&
    !(
      Array.isArray(w.spaces) &&
      w.spaces.length > 0 &&
      w.spaces.length <= 256 &&
      w.spaces.every((s) => typeof s === 'string')
    )
  ) {
    return 'spaces must be "all" or a list of space ids';
  }
  if (w.topic !== undefined) {
    const t = w.topic;
    if (!isObject(t) || typeof t.field !== 'string' || checkTopics([t.field]) !== null)
      return 'topic.field must be a field name';
    if (!['string', 'number', 'boolean'].includes(typeof t.value))
      return 'topic.value must be text, a number or yes/no';
  }
  if (w.others !== undefined && typeof w.others !== 'boolean') return 'others must be true or false';
  if (w.paused !== undefined && typeof w.paused !== 'boolean') return 'paused must be true or false';
  if (w.open !== undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- URL stringifies what it is given; String() keeps what passes unchanged
      const url = new URL(String(w.open));
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      )
        return 'open must be an https:// address';
    } catch {
      return 'open must be a web address';
    }
  }
  if (typeof w.since !== 'string' || !Number.isFinite(Date.parse(w.since))) return 'since must be a date';
  if (w.app !== undefined) {
    const a = w.app;
    if (!isObject(a) || typeof a.origin !== 'string' || !isOrigin(a.origin))
      return 'app.origin must be a web origin';
    if (a.name !== undefined && (typeof a.name !== 'string' || a.name.length > 80))
      return 'app.name must be text, at most 80 characters';
  }
  return null;
}

/**
 * `https://chat.example`, nothing after it: what a browser reports as a
 * message's origin. A browser extension's origin (`chrome-extension://<id>`)
 * is one too, though `URL` gives it none.
 */
function isOrigin(value: string): boolean {
  if (/^(chrome|moz|safari-web)-extension:\/\/[a-z0-9-]{1,64}$/i.test(value)) return true;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * What an app kept in a space (`std.app`) says is worth hearing about: a
 * subscription it offers, before anyone has picked spaces or where a click
 * goes. Whoever shows the app proposes it, as a {@link NotifyProposal} of
 * its own, when the person asks.
 */
export interface AppNotify {
  readonly label: string;
  readonly collection: string;
  readonly topic?: NotifyProposal['topic'];
  readonly others?: boolean;
}

/** Why an app's `notify` entry can't be offered, or null */
export function checkAppNotify(value: unknown): string | null {
  if (!isObject(value)) return 'Each notify entry must be an object';
  if ('spaces' in value || 'open' in value)
    return 'A notify entry leaves out spaces and open: the app that shows it decides those';
  return checkProposal(value);
}

/**
 * Why an app's proposal can't be offered, or null. `origin` is the app's, as
 * the browser reported it: a click may only lead back to the app that asked.
 * Without it, only what the proposal says is checked.
 */
export function checkProposal(proposal: unknown, origin?: string): string | null {
  if (!isObject(proposal)) return 'A proposed subscription must be an object';
  const p = proposal;
  const topic = p.topic === undefined ? undefined : isObject(p.topic) ? p.topic : null;
  if (topic === null || (topic && 'me' in topic && (topic.me !== true || 'value' in topic))) {
    return 'topic is { field, value } or { field, me: true }';
  }
  const problem = checkNotify({
    label: p.label,
    collection: p.collection,
    spaces: p.spaces ?? 'all',
    ...(topic ? { topic: { field: topic.field, value: topic.me === true ? 'me' : topic.value } } : {}),
    ...(p.others !== undefined ? { others: p.others } : {}),
    ...(p.open !== undefined ? { open: p.open } : {}),
    since: new Date(0).toISOString(),
    ...(origin !== undefined ? { app: { origin } } : {}),
  });
  if (problem) return problem;
  if (origin === undefined) return null;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- checkNotify has passed it as a web address, the way URL reads it
  if (p.open !== undefined && new URL(String(p.open)).origin !== origin)
    return 'open must be an address on the app’s own site';
  return null;
}

/**
 * The spaces a proposal looks at, given the ones the app may reach; null when
 * it names one outside them.
 */
export function proposalSpaces(proposal: NotifyProposal, reach: NotifySpaces): NotifySpaces | null {
  if (!proposal.spaces) return reach;
  if (reach !== 'all' && proposal.spaces.some((id) => !reach.includes(id))) return null;
  return [...new Set(proposal.spaces)];
}

/** The subscription a proposal becomes, once the person says yes to it */
export function fromProposal(
  proposal: NotifyProposal,
  context: {
    readonly app: NotifyApp;
    readonly spaces: NotifySpaces;
    readonly account: string;
    readonly since?: string;
  },
): NotifyWhen {
  const topic = proposal.topic;
  const when: NotifyWhen = {
    label: proposal.label.trim(),
    collection: proposal.collection,
    spaces: context.spaces,
    ...(topic ? { topic: { field: topic.field, value: 'me' in topic ? context.account : topic.value } } : {}),
    others: proposal.others ?? true,
    open: proposal.open ?? `${context.app.origin}/`,
    since: context.since ?? new Date().toISOString(),
    app: context.app,
  };
  // An app on plain http elsewhere than this machine: a click goes to the home instead.
  if (checkNotify(when) === null || proposal.open !== undefined) return when;
  const { open: _open, ...rest } = when;
  return rest;
}

/** Whether two subscriptions ask about the same thing: an app connecting again adds nothing twice */
export function sameSubscription(a: NotifyWhen, b: NotifyWhen): boolean {
  const spaces = (s: NotifySpaces) => (s === 'all' ? 'all' : [...s].sort().join(','));
  return (
    a.collection === b.collection &&
    spaces(a.spaces) === spaces(b.spaces) &&
    a.topic?.field === b.topic?.field &&
    a.topic?.value === b.topic?.value &&
    (a.others ?? true) === (b.others ?? true)
  );
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
export async function carriedFor(
  when: NotifyWhen,
  spaces: ReadonlyArray<NotifySpace>,
): Promise<CarriedSubscription> {
  let tags: Record<string, string[]> | undefined;
  if (when.topic) {
    tags = {};
    const only = when.spaces;
    const looked = only === 'all' ? spaces : spaces.filter((s) => only.includes(s.id));
    for (const space of looked) {
      if (space.visibility === 'private' && !space.key) continue;
      const key = await topicKey(
        space.visibility === 'private' ? { spaceKey: space.key!.key } : { spaceId: space.id },
      );
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
  return isCarried(body) ? body : null;
}

/** `checkNotify` checks the fields a carried subscription shares with the person's; the tags are checked here. */
function isCarried(body: unknown): body is CarriedSubscription {
  if (!isObject(body) || body.v !== 1) return false;
  if (checkNotify({ ...body, topic: undefined }) !== null) return false;
  if (body.tags === undefined) return true;
  return (
    isObject(body.tags) &&
    Object.values(body.tags).every((list) => Array.isArray(list) && list.every((t) => typeof t === 'string'))
  );
}

/** Who a version was written for: the account at the root of its note, else its own key */
function rootOf(version: Expression): string {
  if (!version.proof) return version.author;
  try {
    return parseUCAN(version.proof).payload.iss;
  } catch {
    return version.author;
  }
}

/** How long after it was written a record may still notify: a carrier catching up on last week stays quiet */
const NOTIFY_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a record that just arrived in a space is one a subscription asks
 * about — decided from its outside alone.
 */
export function matchesSubscription(
  sub: CarriedSubscription,
  spaceId: string,
  version: Expression,
  account: string,
  now = Date.now(),
): boolean {
  if (sub.paused || version.collection !== sub.collection) return false;
  if (version.seq !== 0 || version.deleted) return false;
  if (sub.spaces !== 'all' && !sub.spaces.includes(spaceId)) return false;
  const written = Date.parse(version.createdAt);
  if (!Number.isFinite(written) || written < Date.parse(sub.since) || now - written > NOTIFY_WITHIN_MS)
    return false;
  if (sub.others && rootOf(version) === account) return false;
  if (sub.tags) {
    const wanted = sub.tags[spaceId];
    if (!wanted?.length || !version.tags?.some((tag) => wanted.includes(tag))) return false;
  }
  return true;
}

/** What an app sees of a record, enough to match a subscription: its outside and, where it can open it, its body */
export interface ReadableRecord {
  readonly key: string;
  readonly space: string;
  readonly collection: string;
  readonly createdAt: string;
  /** Who created it: the account, not the key that signed */
  readonly createdBy: string | null;
  readonly body: unknown;
  readonly verified: boolean;
  readonly deleted?: true;
}

/**
 * Whether a record an app just saw is one a subscription asks about. The
 * app can read, so a topic is matched on the body's value, not a tag — the
 * same answer `matchesSubscription` gives a carrier from the outside.
 */
export function matchesRecord(
  when: NotifyWhen,
  record: ReadableRecord,
  account: string,
  now = Date.now(),
): boolean {
  if (when.paused || !record.verified || record.deleted || record.collection !== when.collection)
    return false;
  if (when.spaces !== 'all' && !when.spaces.includes(record.space)) return false;
  const written = Date.parse(record.createdAt);
  if (!Number.isFinite(written) || written < Date.parse(when.since) || now - written > NOTIFY_WITHIN_MS)
    return false;
  if ((when.others ?? true) && record.createdBy === account) return false;
  if (when.topic && !topicValues(record.body, when.topic.field).includes(when.topic.value)) return false;
  return true;
}
