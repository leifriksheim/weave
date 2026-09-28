/**
 * Notifications, from this app: asked for when the person wants them, shown
 * by the app itself.
 *
 * Connecting asks for nothing. "Turn on notifications" in the account menu
 * asks the browser for permission and offers the account home what this app
 * can notify about (`connection.propose`); the person keeps what they want,
 * and can pause or remove it there later. The app then matches what arrives
 * against what they kept (`watchNotifications`) and shows it — while it is
 * open, in a tab or installed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useNode } from '@weaveprotocol/core/react';
import { watchNotifications, type NotifyProposal, type NotifyView } from '@weaveprotocol/core';

/** What this app offers to notify about */
const PROPOSALS: ReadonlyArray<NotifyProposal> = [
  { label: 'New chat message', collection: 'std.message', others: true },
  { label: 'New poll', collection: 'std.poll', others: true },
  { label: 'Someone asks to be your contact', collection: 'std.contact-request', others: true },
];

const supported = () => typeof globalThis.Notification === 'function';

/** Where the account home keeps the person's notifications */
const manageUrl = (home: string) => `${new URL('.', home).href}#notifications`;

/** This app's notifications as the account keeps them, and turning them on */
export function useAppNotifications() {
  const node = useNode();
  const { connection, state } = useConnection();
  const [mine, setMine] = useState<ReadonlyArray<NotifyView>>([]);
  const [permission, setPermission] = useState(() => (supported() ? Notification.permission : 'denied'));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      void node.notifications
        .list()
        .then((all) => live && setMine(all.filter((sub) => sub.app?.origin === globalThis.location.origin)))
        .catch(() => {});
    load();
    const stop = node.subscribe((event) => {
      if (event.type === 'records' || event.type === 'account') load();
    });
    return () => {
      live = false;
      stop();
    };
  }, [node]);

  /** From a click: both the permission prompt and the home's popup need one */
  const turnOn = useCallback(() => {
    setError(null);
    if (!supported()) return setError('This browser can’t show notifications.');
    if (Notification.permission === 'denied')
      return setError('Notifications are blocked for this site in your browser’s settings.');
    const asking =
      Notification.permission === 'granted'
        ? Promise.resolve('granted' as const)
        : Notification.requestPermission();
    const proposing = connection.propose(PROPOSALS);
    void asking.then(setPermission);
    proposing.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)));
  }, [connection]);

  const allow = useCallback(() => {
    if (supported()) void Notification.requestPermission().then(setPermission);
  }, []);

  const manage = useCallback(() => {
    globalThis.open(manageUrl(state.home), 'weave-account', 'popup,width=720,height=820');
  }, [state.home]);

  return { on: mine.filter((sub) => !sub.paused).length, permission, error, turnOn, allow, manage };
}

/** Shows what this app's subscriptions match, while nobody is looking at it. A click opens the space. */
export function useShowNotifications(openSpace: (id: string) => void) {
  const node = useNode();
  const open = useRef(openSpace);
  open.current = openSpace;
  useEffect(
    () =>
      watchNotifications(node, {
        onNotify: ({ subscription, record }) => {
          if (!supported() || Notification.permission !== 'granted' || globalThis.document.hasFocus()) return;
          void node.spaces.get(record.space).then((space) => {
            const shown = new Notification(subscription.label, {
              body: space ? `In ${space.name}` : '',
              tag: `${subscription.id}:${record.space}`,
            });
            shown.onclick = () => {
              globalThis.focus();
              open.current(record.space);
              shown.close();
            };
          });
        },
      }),
    [node],
  );
}
