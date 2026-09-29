/**
 * Showing people by name. A space tells us the name each person gave there;
 * this turns an identity into something to print — and never lets a name
 * pretend to be someone else: two people with the same name get the tail of
 * their identity after it, and someone with no profile is shown by that tail.
 */
import { displayName, type SpaceProfile } from '@weaveprotocol/core';

export type People = ReadonlyMap<string, SpaceProfile>;

export function peopleFrom(profiles: ReadonlyArray<SpaceProfile> | undefined): People {
  return new Map((profiles ?? []).map((p) => [p.did, p]));
}

/** "Leif", "Leif · 4YtJb2" when someone else here is also Leif, or "4YtJb2" with no profile */
export function nameOf(did: string | null | undefined, people: People): string {
  return displayName(did, people.values());
}

/**
 * Who wrote this version: their name, and "via agent" when an agent wrote it
 * for them. The account signed that into the agent's note, so it can't be
 * left out by the agent.
 */
export function writerOf(
  record: { readonly root: string | null; readonly viaAgent?: true },
  people: People,
): string {
  return record.viaAgent ? `${nameOf(record.root, people)} via agent` : nameOf(record.root, people);
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
