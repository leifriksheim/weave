// Who says they are a bot in a space: `bot: true` on their own `std.profile`, their word, not checked.
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
