/** Contacts (`node.contacts`) and doors (`node.doors`), for the screens that show them. */
import { useEffect, useState } from 'react';
import type { ContactView, P2PNode } from '@weaveprotocol/core';
import { useLive, useNode } from '@weaveprotocol/core/react';

/** A link that knocks on a door: this app, with the code after `#door=` */
export function doorLink(code: string): string {
  return `${globalThis.location.origin}/app#door=${code}`;
}

/** The door code in this page's URL, if someone opened a door link */
export function readDoorFromUrl(): string | null {
  return /[#&]door=([A-Za-z0-9_-]+)/.exec(globalThis.location.hash)?.[1] ?? null;
}

/** Drops the door code from the address bar once it has been dealt with */
export function clearDoorFromUrl(): void {
  globalThis.history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
}

/**
 * The contact list, kept current: loaded again whenever the contacts space
 * changes, here or on another device. Undefined until the first load; empty
 * for an app not given the contacts.
 */
export function useContacts(): ReadonlyArray<ContactView> | undefined {
  const node = useNode();
  const [contacts, setContacts] = useState<ReadonlyArray<ContactView>>();

  useEffect(() => {
    let stopped = false;
    let space: string | null = null;
    const load = () =>
      void node.contacts
        .list()
        .then((list) => !stopped && setContacts(list))
        .catch(() => !stopped && setContacts([]));
    void node.contacts.space().then((id) => {
      space = id;
      load();
    });
    const unsubscribe = node.subscribe((event) => {
      if (event.type === 'records' && event.space === space) load();
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [node]);

  return contacts;
}

/** Where a contact stands with your space for two (`gone`: you left it); undefined while loading */
export type Standing = 'joined' | 'waiting' | 'gone' | 'none';

export function useStanding(contact: ContactView | undefined): Standing | undefined {
  return useLive(
    contact?.space ?? '',
    async (node): Promise<Standing | undefined> => {
      if (!contact) return undefined;
      if (!contact.space) return 'none';
      if (!(await node.spaces.list()).some((space) => space.id === contact.space)) return 'gone';
      const { members } = await node.spaces.access(contact.space);
      return members.some((member) => member.did === contact.did) ? 'joined' : 'waiting';
    },
    [contact?.did, contact?.space],
  );
}

/**
 * Takes back a request to become someone's contact: deletes the ones you left
 * for them in the given spaces, so they can't accept into a space you are no
 * longer in, then removes them, which leaves the space for two.
 */
export async function takeBack(
  node: P2PNode,
  spaceIds: ReadonlyArray<string>,
  me: string,
  did: string,
): Promise<void> {
  for (const spaceId of spaceIds) {
    const asked = await node.records
      .list<{ to?: string }>(spaceId, { collection: 'std.contact-request' })
      .catch(() => []);
    for (const record of asked) {
      if (record.root === me && record.body?.to === did)
        await node.records.delete(spaceId, record.key).catch(() => {});
    }
  }
  await node.contacts.remove(did);
}
