/**
 * Contacts and doors, for the screens that show them.
 *
 * A contact is someone you share a private space for two with (`node.contacts`);
 * a door is how someone you share no space with asks to become one
 * (`node.doors`). Door links carry the code in the URL fragment, like invites,
 * so the server hosting this page never sees it.
 */
import { useEffect, useState } from 'react';
import type { ContactView } from '@weaveprotocol/core';
import { useNode } from '@weaveprotocol/core/react';

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
