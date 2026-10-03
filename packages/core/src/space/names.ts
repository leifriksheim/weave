/**
 * Showing people by the name they gave in a space, without letting a name
 * pretend to be someone else.
 */
import type { SpaceProfile } from '../node/types.js';

/** The last characters of an identity: enough to tell two people apart at a glance */
const tail = (did: string) => did.slice(-6);

/**
 * What to print for someone: their name, their name and the tail of their
 * identity when someone else in the space gave the same name, or only the
 * tail when they gave none. A name is whatever its owner typed, so two people
 * both called "Sam" must never look like one.
 *
 * ```ts
 * displayName(did, profiles)   // "Sam", "Sam · 4YtJb2", or "4YtJb2"
 * ```
 */
export function displayName(did: string | null | undefined, profiles: Iterable<SpaceProfile>): string {
  if (!did) return 'someone';
  const all = [...profiles];
  const profile = all.find((p) => p.did === did);
  if (!profile) return tail(did);
  const shared = all.some(
    (other) => other.did !== did && other.name.toLowerCase() === profile.name.toLowerCase(),
  );
  return shared ? `${profile.name} · ${tail(did)}` : profile.name;
}
