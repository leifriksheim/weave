/**
 * Who is at work on what in a space, as each says in its own `std.activity`:
 * a bot replying to a message, an agent on a task. Only what is going on now,
 * working or waiting and not gone stale, by the record it is about.
 */
import { useEffect, useState } from 'react';
import { useLive } from '@weaveprotocol/core/react';
import { activeNow, activity, type Activity, type ActivityState } from '@weaveprotocol/core/schemas';

export interface AtWork {
  readonly did: string;
  readonly state: ActivityState;
  readonly label?: string;
}

export function useActivity(spaceId: string): ReadonlyMap<string, ReadonlyArray<AtWork>> {
  const records = useLive(
    spaceId,
    async (node) => node.records.list<Activity>(spaceId, { collection: activity.name }),
    [],
  );
  // Looked at again now and then: a writer that went away mid-way stops showing once it goes stale.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const byRecord = new Map<string, AtWork[]>();
  for (const record of records ?? []) {
    const on = record.links.find((link) => link.rel === 'about')?.to;
    if (!on || record.deleted || !record.root || !activeNow(record.body, now) || !record.body) continue;
    const { state, label } = record.body;
    byRecord.set(on, [...(byRecord.get(on) ?? []), { did: record.root, state, ...(label ? { label } : {}) }]);
  }
  return byRecord;
}
