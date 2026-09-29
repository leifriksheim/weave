/**
 * Showing people by name. A space tells us the name each person gave there;
 * this turns an identity into something to print — and never lets a name
 * pretend to be someone else: two people with the same name get the tail of
 * their identity after it, and someone with no profile is shown by that tail.
 */
import { displayName, type SpaceProfile } from '@weaveprotocol/core';

/** Someone in a space: the name the space keeps, and whether their `std.profile` says they are a bot */
export type Someone = SpaceProfile & { readonly bot?: true };

export type People = ReadonlyMap<string, Someone>;

/** Everyone with a name in a space; `bots` are those whose `std.profile` there says so */
export function peopleFrom(
  profiles: ReadonlyArray<SpaceProfile> | undefined,
  bots: ReadonlySet<string> = new Set(),
): People {
  return new Map((profiles ?? []).map((p) => [p.did, bots.has(p.did) ? { ...p, bot: true as const } : p]));
}

/** "Leif", "Leif · 4YtJb2" when someone else here is also Leif, or "4YtJb2" with no profile */
export function nameOf(did: string | null | undefined, people: People): string {
  return displayName(did, people.values());
}

/** Whether an account says it is a bot, in its `std.profile` in this space: its own word, shown and nothing more */
export const isBot = (did: string | null | undefined, people: People): boolean =>
  !!did && people.get(did)?.bot === true;

/**
 * Who wrote this version: their name, "via agent" when an agent wrote it for
 * them, and "bot" when the account says it is one. The account signed "via
 * agent" into the agent's note, so the agent can't leave it out.
 */
export function writerOf(
  record: { readonly root: string | null; readonly viaAgent?: true },
  people: People,
): string {
  const name = nameOf(record.root, people);
  if (record.viaAgent) return `${name} via agent`;
  return isBot(record.root, people) ? `${name} · bot` : name;
}

/**
 * `respondingTo` for a record written in answer to `author`'s: a reaction,
 * comment, vote or ballot, so they can be told. Nothing when it is your own.
 */
export function respondingTo(
  author: string | null | undefined,
  me: string | null | undefined,
): { respondingTo?: string } {
  return author && author !== me ? { respondingTo: author } : {};
}
