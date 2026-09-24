/**
 * What the extension's pages share: the messages between them, the one record
 * it keeps (the grant), and how it reads the build's settings.
 *
 * Four pieces:
 *
 * - **worker** — the service worker. Chrome stops it after half a minute of
 *   quiet, so it only makes sure the offscreen page exists, and sets the badge.
 * - **offscreen** — a hidden page that lives as long as Chrome does. The
 *   carrier node runs here.
 * - **welcome** — a full tab: connecting to the account home, the pod, status.
 * - **popup** — the toolbar button: status at a glance.
 *
 * The offscreen page may only use `chrome.runtime`, so everything it keeps is
 * in IndexedDB, which every page of the extension shares.
 */
import type { CarriedSpace } from 'weave-protocol/node';
import type { CarryGrant } from 'weave-protocol/session';

declare const __WEAVE_HOME__: string;
declare const __WEAVE_RELAYS__: string;

/** The account home offered first; people can type their own */
export const DEFAULT_HOME = __WEAVE_HOME__;

/** Relays built in; the home's own arrive with the grant */
export const BUILT_IN_RELAYS: ReadonlyArray<string> = __WEAVE_RELAYS__
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

/** What the extension calls itself to the home */
export const EXTENSION_NAME = 'Weave for Chrome';

/** The name its key is kept under (`appKey`) */
export const KEY_NAME = 'carrier';

/** How the pod is doing */
export type PodState =
  /** The account lives in the home's browser storage: there is no pod */
  | 'none'
  /** There is a pod, and no folder has been picked here yet */
  | 'not-picked'
  /** Picked, but Chrome wants a click before it may be written again */
  | 'needs-permission'
  /** Being kept up to date */
  | 'writing';

export interface CarrierStatus {
  readonly state: 'not-connected' | 'starting' | 'running' | 'error';
  /** Set when the account stopped using this extension, until it connects again */
  readonly removed?: boolean;
  readonly account?: { readonly name: string; readonly did: string; readonly home: string };
  readonly spaces: ReadonlyArray<CarriedSpace>;
  readonly pod: { readonly state: PodState; readonly folder: string | null };
  readonly error?: string;
}

/** Messages to the offscreen page, and what it answers */
export type Request =
  | { readonly to: 'offscreen'; readonly type: 'status' }
  /** The grant or the pod changed: start again from what is stored */
  | { readonly to: 'offscreen'; readonly type: 'reload' }
  /** Forget everything */
  | { readonly to: 'offscreen'; readonly type: 'disconnect' };

/** Messages to the worker */
export type WorkerMessage =
  | { readonly to: 'worker'; readonly type: 'ensure' }
  | { readonly to: 'worker'; readonly type: 'badge'; readonly status: CarrierStatus };

/** Broadcast by the offscreen page whenever the status changes */
export interface StatusChanged {
  readonly to: 'pages';
  readonly type: 'status';
  readonly status: CarrierStatus;
}

/** Asks the offscreen page something, making sure it is running first. */
export async function ask(request: Request): Promise<CarrierStatus> {
  await chrome.runtime.sendMessage({ to: 'worker', type: 'ensure' } satisfies WorkerMessage);
  return chrome.runtime.sendMessage(request);
}

// ─── The grant, kept in IndexedDB ───────────────────────────────────────

const DB = 'weave-extension';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function kv<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const loadGrant = () => kv<CarryGrant | undefined>('readonly', (store) => store.get('grant')).then((grant) => grant ?? null);
export const saveGrant = (grant: CarryGrant) => kv<void>('readwrite', (store) => store.put(grant, 'grant'));
export const forgetGrant = () => kv<void>('readwrite', (store) => store.delete('grant'));

/** Whether the account removed this extension last time — shown once, until it connects again */
export const loadRemoved = () => kv<boolean | undefined>('readonly', (store) => store.get('removed')).then(Boolean);
export const setRemoved = (removed: boolean) => kv<void>('readwrite', (store) => store.put(removed, 'removed'));

/** The databases the carrier keeps its copy in, for one account */
export const storePrefix = (did: string) => `weave-carrier:${did}`;
