/**
 * Notifications, from this app: asked for when the person wants them, shown
 * by the app itself.
 *
 * Connecting asks for nothing. Each app says what in it is worth hearing
 * about (its `notify`: in `apps/index.ts` for the built-in ones, in the
 * `std.app` record for ones made for a space), and the bell on an open app
 * offers exactly that, for that space. "Turn on notifications" in the
 * account menu offers the lot, in every space: contact requests, the
 * built-in apps, and every app added to one of your spaces. Either way the
 * account home is asked (`connection.propose`); the person keeps what they
 * want, and can pause or remove it there later. The app then matches what
 * arrives against what they kept (`watchNotifications`) and shows it — while
 * it is open, in a tab or installed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useConnection, useNode } from '@weaveprotocol/core/react';
import { MAX_PROPOSALS, watchNotifications, type NotifyProposal, type NotifyView } from '@weaveprotocol/core';
import { app as appSchema, supersededApps, type App, type AppNotify } from '@weaveprotocol/core/schemas';
import { APPS } from './components/apps';
import { isForMe, madeNotify } from './components/apps/entries';
import { isAdded } from './components/apps/MadeApps';

/** Offered whatever apps a space has */
const CONTACTS: NotifyProposal = {
  label: 'Someone asks to be your contact',
  collection: 'std.contact-request',
  others: true,
};

const supported = () => typeof globalThis.Notification === 'function';

/** Where the account home keeps the person's notifications */
const manageUrl = (home: string) => `${new URL('.', home).href}#notifications`;

/** This app's subscriptions, as the account keeps them */
export function useSubscriptions(): ReadonlyArray<NotifyView> {
  const node = useNode();
  const [mine, setMine] = useState<ReadonlyArray<NotifyView>>([]);
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
  return mine;
}

/** One proposal, as the same thing asked for again would be */
const proposalKey = (proposal: NotifyProposal) =>
  `${proposal.collection} ${JSON.stringify(proposal.topic ?? null)} ${JSON.stringify(proposal.where ?? null)} ${proposal.spaces?.join(',') ?? 'all'}`;

/**
 * Asking the browser, then the home: both need the click that got here. What
 * the home said yes to counts as on at once: the account's copy of it reaches
 * this app only once the account space has synced.
 */
export function useAsk() {
  const { connection, state } = useConnection();
  const [permission, setPermission] = useState(() => (supported() ? Notification.permission : 'denied'));
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());

  // Allowed or blocked in the browser's own site settings: follow it there too.
  useEffect(() => {
    let status: PermissionStatus | null = null;
    const follow = () => supported() && setPermission(Notification.permission);
    void globalThis.navigator?.permissions
      ?.query({ name: 'notifications' })
      .then((found) => {
        status = found;
        found.addEventListener('change', follow);
      })
      .catch(() => {});
    return () => status?.removeEventListener('change', follow);
  }, []);

  /** Resolves to whether the person kept any of them */
  const ask = useCallback(
    (proposals: ReadonlyArray<NotifyProposal>): Promise<boolean> => {
      setError(null);
      // Everything asked for is on already: nothing to open the home for.
      if (proposals.length === 0) return Promise.resolve(true);
      if (!supported()) {
        setError('This browser can’t show notifications.');
        return Promise.resolve(false);
      }
      if (Notification.permission === 'denied') {
        setError('Notifications are blocked for this site in your browser’s settings.');
        return Promise.resolve(false);
      }
      const asking =
        Notification.permission === 'granted'
          ? Promise.resolve('granted' as const)
          : Notification.requestPermission();
      const proposing = connection.propose(proposals);
      void asking.then(setPermission);
      setAsking(true);
      return proposing
        .then((answer) => {
          const labels = new Set(answer.notify.map((sub) => sub.label));
          const yes = proposals.filter((proposal) => labels.has(proposal.label.trim()));
          setKept((was) => new Set([...was, ...yes.map(proposalKey)]));
          return yes.length > 0;
        })
        .catch((failed: unknown) => {
          setError(failed instanceof Error ? failed.message : String(failed));
          return false;
        })
        .finally(() => setAsking(false));
    },
    [connection],
  );

  const allow = useCallback(() => {
    if (supported()) void Notification.requestPermission().then(setPermission);
  }, []);

  const manage = useCallback(() => {
    globalThis.open(manageUrl(state.home), 'weave-account', 'popup,width=720,height=820');
  }, [state.home]);

  return { permission, error, asking, kept, ask, allow, manage };
}

/**
 * Everything this app can notify about, in every space: worked out ahead of
 * the click, since the home's popup must open from the click itself.
 */
function useEverything(): ReadonlyArray<NotifyProposal> {
  const node = useNode();
  const [offers, setOffers] = useState<ReadonlyArray<NotifyProposal>>(() => gather([]));
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const made: App[] = [];
      for (const space of await node.spaces.list()) {
        const [apps, collections] = await Promise.all([
          node.records.list<App>(space.id, { collection: appSchema.name }),
          node.collections.list(space.id),
        ]).catch(() => [[], []] as const);
        const superseded = supersededApps(apps, collections);
        for (const record of apps)
          if (record.body && !superseded.has(record.key) && isAdded(record, collections))
            made.push(record.body);
      }
      if (live) setOffers(gather(made));
    };
    void load();
    // Apps come and go with records; one look a little after a burst of them is enough.
    const stop = node.subscribe((event) => {
      if (event.type !== 'records') return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 1500);
    });
    return () => {
      live = false;
      clearTimeout(timer);
      stop();
    };
  }, [node]);
  return offers;
}

/** Contact requests, the built-in apps and these made ones, once each, as many as one request may carry */
function gather(made: ReadonlyArray<App>): ReadonlyArray<NotifyProposal> {
  const all = [CONTACTS, ...APPS.flatMap((app) => app.notify), ...made.flatMap(madeNotify)];
  const once = new Map(
    all.map((offer) => [`${offer.collection} ${JSON.stringify(offer.topic ?? null)}`, offer]),
  );
  return [...once.values()].slice(0, MAX_PROPOSALS);
}

/** This app's notifications as the account keeps them, and turning them all on */
export function useAppNotifications() {
  const mine = useSubscriptions();
  const everything = useEverything();
  const { permission, error, asking, kept, ask, allow, manage } = useAsk();
  // What is on everywhere already is not asked for again.
  const turnOn = useCallback(
    () =>
      void ask(
        everything.filter(
          (offer) =>
            !kept.has(proposalKey(offer)) &&
            !mine.some(
              (sub) =>
                sub.spaces === 'all' &&
                sub.collection === offer.collection &&
                (offer.topic ? sub.topic?.field === offer.topic.field : !sub.topic),
            ),
        ),
      ),
    [ask, everything, kept, mine],
  );
  return {
    on: mine.filter((sub) => !sub.paused).length,
    permission,
    error,
    asking,
    turnOn,
    allow,
    manage,
  };
}

/**
 * One app's notifications in one space, at two levels: everything new, or
 * only what names you ("Mentions me", "Replies to me"). Whether each is on,
 * and turning one on — what the bell on an open app does. Turning one off
 * is the account home's, where subscriptions are paused and removed.
 */
export function useNotifyFor(spaceId: string, offers: ReadonlyArray<AppNotify>) {
  const { did } = useAccount();
  const mine = useSubscriptions();
  const { permission, error, asking, kept, ask, allow, manage } = useAsk();
  const covers = (offer: AppNotify) =>
    kept.has(proposalKey({ ...offer, spaces: [spaceId] })) ||
    mine.some(
      (sub) =>
        !sub.paused &&
        sub.collection === offer.collection &&
        (sub.spaces === 'all' || sub.spaces.includes(spaceId)) &&
        (offer.topic
          ? sub.topic?.field === offer.topic.field &&
            sub.topic.value === ('me' in offer.topic ? did : offer.topic.value)
          : !sub.topic) &&
        JSON.stringify(sub.where ?? null) === JSON.stringify(offer.where ?? null),
    );
  const everything = offers.filter((offer) => !offer.topic);
  const forMe = offers.filter(isForMe);
  const turnOn = (which: ReadonlyArray<AppNotify>) =>
    void ask(which.filter((offer) => !covers(offer)).map((offer) => ({ ...offer, spaces: [spaceId] })));
  return {
    everything,
    forMe,
    on: {
      everything: everything.length > 0 && everything.every(covers),
      forMe: forMe.length > 0 && forMe.every(covers),
    },
    permission,
    error,
    asking,
    turnOn,
    allow,
    manage,
  };
}

/** How long to wait for every subscription a record matches, before showing one notification for it */
const GATHER_MS = 150;

/**
 * Shows what this app's subscriptions match, while nobody is looking at it.
 * A click opens the space. A record that several of them match — a message
 * that mentions you, when "New message" is on too — is one notification,
 * under the most particular of them.
 */
export function useShowNotifications(openSpace: (id: string) => void) {
  const node = useNode();
  const open = useRef(openSpace);
  open.current = openSpace;
  useEffect(() => {
    const waiting = new Map<
      string,
      { label: string; particular: boolean; timer: ReturnType<typeof setTimeout> }
    >();
    const show = (key: string, label: string, spaceId: string) => {
      waiting.delete(key);
      void node.spaces.get(spaceId).then((space) => {
        const shown = new Notification(label, { body: space ? `In ${space.name}` : '', tag: key });
        shown.onclick = () => {
          globalThis.focus();
          open.current(spaceId);
          shown.close();
        };
      });
    };
    const stop = watchNotifications(node, {
      onNotify: ({ subscription, record }) => {
        if (!supported() || Notification.permission !== 'granted' || globalThis.document.hasFocus()) return;
        const particular = !!subscription.topic;
        const before = waiting.get(record.key);
        if (before && (before.particular || !particular)) return;
        if (before) clearTimeout(before.timer);
        const timer = setTimeout(() => show(record.key, subscription.label, record.space), GATHER_MS);
        waiting.set(record.key, { label: subscription.label, particular, timer });
      },
    });
    return () => {
      stop();
      for (const { timer } of waiting.values()) clearTimeout(timer);
    };
  }, [node]);
}
