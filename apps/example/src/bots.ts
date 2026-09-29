/**
 * Who says they are a bot in a space: `bot: true` on their own `std.profile`
 * there. Only they can write it (`std.profile` is one per person, theirs to
 * change), and it is their word, not something anyone checked: an honest
 * operator discloses with it, and a bot that leaves it out looks like anyone.
 */
import { useLive } from '@weaveprotocol/core/react';
import { profile, type Profile } from '@weaveprotocol/core/schemas';

export function useBots(spaceId: string): ReadonlySet<string> {
  const bots = useLive(
    spaceId,
    async (node) => {
      const profiles = await node.records.list<Profile>(spaceId, { collection: profile.name });
      return new Set(
        profiles.flatMap((record) =>
          record.body?.bot === true && record.root === record.createdBy && record.root ? [record.root] : [],
        ),
      );
    },
    [],
  );
  return bots ?? new Set();
}
