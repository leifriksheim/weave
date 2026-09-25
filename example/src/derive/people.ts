/**
 * Showing people by name. A space tells us the name each person gave there;
 * this turns an identity into something to print — and never lets a name
 * pretend to be someone else: two people with the same name get the tail of
 * their identity after it, and someone with no profile is shown by that tail.
 */
import type { SpaceProfile } from '@weaveprotocol/core';

export type People = ReadonlyMap<string, SpaceProfile>;

export function peopleFrom(profiles: ReadonlyArray<SpaceProfile> | undefined): People {
  return new Map((profiles ?? []).map((p) => [p.did, p]));
}

const tail = (did: string) => did.slice(-6);

/** "Leif", "Leif · 4YtJb2" when someone else here is also Leif, or "4YtJb2" with no profile */
export function nameOf(did: string | null | undefined, people: People): string {
  if (!did) return 'someone';
  const profile = people.get(did);
  if (!profile) return tail(did);
  const shared = [...people.values()].some((other) => other.did !== did && other.name.toLowerCase() === profile.name.toLowerCase());
  return shared ? `${profile.name} · ${tail(did)}` : profile.name;
}

/**
 * Who wrote this version: their name, and "via agent" when an agent wrote it
 * for them. The account signed that into the agent's note, so it can't be
 * left out by the agent.
 */
export function writerOf(record: { readonly root: string | null; readonly viaAgent?: true }, people: People): string {
  return record.viaAgent ? `${nameOf(record.root, people)} via agent` : nameOf(record.root, people);
}
