/**
 * Who is at work on what in a space, as each says in its own `std.activity`:
 * a bot replying to a message, an agent on a task. Only what is going on now,
 * working or waiting and not gone stale, by the record it is about.
 */
import { useEffect, useState } from 'react';
import { DEFINE, roleHolds } from '@weaveprotocol/core';
import { useAccess, useCollections, useLive, useNode } from '@weaveprotocol/core/react';
import {
  activeNow,
  activity,
  rule,
  ruleOf,
  type Activity,
  type ActivityState,
} from '@weaveprotocol/core/schemas';

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

/**
 * Whether a space with rules that ask an agent or a bot keeps no
 * `std.activity`, where they say they are at work, and a way to turn it on
 * for someone who may add collections. A bot can't add it, and a space whose
 * rules came before it has none. Asked, never done on opening: opening a
 * space writes nothing.
 */
export function useActivityOff(
  spaceId: string,
  writable: boolean,
): { readonly off: boolean; readonly turnOn: (() => Promise<void>) | null } {
  const node = useNode();
  const access = useAccess(spaceId);
  const collections = useCollections(spaceId);
  const kept = collections.some((c) => c.name === activity.name && c.version !== null);
  const asks = useLive(
    spaceId,
    async (n) =>
      (await n.records.list(spaceId, { collection: rule.name })).some(
        (record) => ruleOf(record)?.then.kind === 'ask',
      ),
    [],
  );
  const mayDefine = writable && roleHolds(access?.role, DEFINE);
  return {
    off: !!asks && !kept,
    turnOn: mayDefine
      ? async () => {
          await node.collections.define(spaceId, activity);
        }
      : null,
  };
}
