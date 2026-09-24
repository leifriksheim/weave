/**
 * @module session/connect
 * An app using an account without ever seeing its seed.
 *
 * The account lives in an *account home* — a page, at an address the person
 * chose, that holds the account and does nothing else. An app that wants to
 * act for the account:
 *
 * 1. Makes its own key, kept in its own site's storage, never exportable.
 * 2. Opens the home in a popup, and says what it wants: read or write, and
 *    which spaces — existing ones the person picks, or new ones for it.
 * 3. The person unlocks at the home (a passkey, or the account password from
 *    their password manager) and approves.
 * 4. The home signs a note — a UCAN — saying the app's key may write in those
 *    spaces until a date, and hands back invites for them.
 * 5. The app starts a node that signs with its key under that note.
 *
 * Every peer checks the note, so the app cannot write anywhere it was not
 * given. It never holds the seed, so it cannot become the account.
 *
 * The popup and the app talk with `postMessage`. Each side checks the other's
 * origin as the browser reports it — never as a message claims it — and the
 * home only ever sends a grant to the origin that asked for it.
 */
import { createP256Provider } from '../identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { cidFromBytes } from '../utils/hash.js';
import { utf8Encode } from '../utils/encoding.js';
import { verifyUCAN, parseUCAN, type Capability, type UCANToken } from '../identity/ucan.js';
import type { RootSigner } from '../identity/root-signer.js';
import { createNode } from '../node/node.js';
import { indexedDBStores, type StoreFactory } from '../node/stores.js';
import type { NewSpace, NodeNetworkConfig, P2PNode } from '../node/types.js';
import type { KeyValueStore } from './stay-signed-in.js';

/** Messages between an app and the home it opened */
const HELLO = 'weave:hello';
const REQUEST = 'weave:request';
const GRANT = 'weave:grant';
const DENIED = 'weave:denied';

/** What an app asks a home for */
export interface ConnectRequest {
  readonly v: 1;
  /** The app's key — the note is made out to it */
  readonly audience: string;
  /** What the app calls itself. Shown, but never trusted: the home shows the origin too. */
  readonly name?: string;
  /** `write` to change the spaces it is given, `read` only to look */
  readonly access: 'read' | 'write';
  /** Spaces the home should make for the app, and give it */
  readonly create?: ReadonlyArray<NewSpace>;
  /** Whether to offer the person's existing spaces to pick from. Default true. */
  readonly chooseSpaces?: boolean;
}

/** A space an app was given */
export interface GrantedSpace {
  readonly id: string;
  readonly name: string;
  /** What the app joins it with — carrying the key, for a private space */
  readonly invite: string;
}

/** What the home hands back when the person approves */
export interface Grant {
  readonly v: 1;
  /** The account's identity — what the app acts for */
  readonly did: string;
  /** The account's name, for showing who is connected */
  readonly name: string;
  /** The signed note: the account → the app's key, for these spaces, until `expiresAt` */
  readonly token: string;
  readonly access: 'read' | 'write';
  readonly spaces: ReadonlyArray<GrantedSpace>;
  /** Unix seconds */
  readonly expiresAt: number;
  /** The home that granted it, so the app can go back there */
  readonly home: string;
}

/** The capabilities a grant carries, for these spaces */
export function grantCapabilities(access: 'read' | 'write', spaceIds: ReadonlyArray<string>): Capability[] {
  return spaceIds.map((id) => ({ with: `space:${id}`, can: access === 'write' ? 'expression/*' : 'expression/read' }));
}

// ─── The app's side ──────────────────────────────────────────────────

/** The app's own key, and its DID */
export interface AppKey {
  readonly keys: CryptoKeyPair;
  readonly did: string;
}

const KEY_DB = 'weave-app-key';

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(KEY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function keyStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openKeyDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction('keys', mode).objectStore('keys'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * This app's key: made once, kept in this site's IndexedDB, and never
 * exportable — a script that gets into the page can sign with it while it is
 * there, but cannot carry it off.
 */
export async function appKey(name = 'default'): Promise<AppKey> {
  const provider = createP256Provider();
  let keys = await keyStore<CryptoKeyPair | undefined>('readonly', (store) => store.get(name));
  if (!keys) {
    const made = await provider.generateKeyPair();
    keys = { privateKey: made.privateKey, publicKey: made.publicKey };
    await keyStore('readwrite', (store) => store.put(keys, name));
  }
  return { keys, did: publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC) };
}

/** Forgets this app's key. The next connection makes a new one. */
export async function forgetAppKey(name = 'default'): Promise<void> {
  await keyStore('readwrite', (store) => store.delete(name));
}

export interface ConnectOptions {
  /** The home's connect page, e.g. `https://weave.example/connect` */
  readonly home: string;
  /** What to ask for; `audience` is filled in with this app's key */
  readonly request: Omit<ConnectRequest, 'v' | 'audience'>;
  /** The key to ask for. Default: {@link appKey}. */
  readonly key?: AppKey;
  /** How long to wait for the person. Default 10 minutes. */
  readonly timeoutMs?: number;
}

/**
 * Opens the home and asks for access. Call it from a click — browsers only
 * allow a popup that a person asked for.
 *
 * @returns The grant, checked: signed by the account, made out to this app's key
 * @throws When the popup is blocked, closed, denied, or the answer does not check out
 */
export async function connectToHome(options: ConnectOptions): Promise<Grant> {
  const homeUrl = new URL(options.home, globalThis.location.href);
  const homeOrigin = homeUrl.origin;
  // Opened before anything is awaited, so it still counts as the click's.
  const popup = globalThis.open(homeUrl.href, 'weave-home', 'popup,width=460,height=720');
  if (!popup) throw new Error('The browser blocked the window. Allow pop-ups for this site and try again.');

  const key = options.key ?? (await appKey());
  const request: ConnectRequest = { v: 1, audience: key.did, ...options.request };

  const grant = await new Promise<Grant>((resolve, reject) => {
    const done = (finish: () => void) => {
      globalThis.removeEventListener('message', onMessage);
      globalThis.clearInterval(watch);
      globalThis.clearTimeout(timer);
      finish();
    };
    const onMessage = (event: MessageEvent) => {
      // Only the popup we opened, at the address we opened it on.
      if (event.source !== popup || event.origin !== homeOrigin) return;
      const data = event.data as { type?: string; grant?: Grant; reason?: string } | null;
      if (data?.type === HELLO) popup.postMessage({ type: REQUEST, request }, homeOrigin);
      else if (data?.type === GRANT && data.grant) done(() => resolve(data.grant!));
      else if (data?.type === DENIED) done(() => reject(new Error(data.reason ?? 'Access was not given.')));
    };
    const watch = globalThis.setInterval(() => {
      if (popup.closed) done(() => reject(new Error('The window was closed before access was given.')));
    }, 500);
    const timer = globalThis.setTimeout(
      () => done(() => reject(new Error('No answer from your account home.'))),
      options.timeoutMs ?? 10 * 60_000,
    );
    globalThis.addEventListener('message', onMessage);
  });

  await checkGrant(grant, key.did);
  return { ...grant, home: homeUrl.href };
}

/** Refuses a grant that is not a valid note from the account to this key. */
async function checkGrant(grant: Grant, audience: string): Promise<void> {
  const verified = await verifyUCAN(grant.token, createP256Provider());
  if (!verified.valid) throw new Error(`The grant does not check out: ${verified.reason ?? 'invalid'}`);
  const { payload } = parseUCAN(grant.token);
  if (payload.aud !== audience) throw new Error('The grant was made out to a different key.');
  if (payload.iss !== grant.did) throw new Error('The grant was not signed by the account it names.');
}

/** A signer that answers with the note the home gave — the app holds nothing else. */
export function grantSigner(grant: Grant): RootSigner {
  let token: Promise<UCANToken> | null = null;
  return {
    did: grant.did,
    custody: 'remote',
    async delegate() {
      if (grant.expiresAt <= Math.floor(Date.now() / 1000)) {
        throw new Error('Access has run out. Connect to your account home again.');
      }
      token ??= cidFromBytes(utf8Encode(grant.token)).then((cid) => ({ ...parseUCAN(grant.token), encoded: grant.token, cid }));
      return token;
    },
  };
}

/**
 * Starts a node acting for the account, under a grant.
 *
 * It joins the granted spaces (again, harmlessly, on later starts) and keeps
 * its data in this site's storage. It has no account key: it sees the spaces
 * it was given, not the account's whole list.
 */
export async function startConnectedNode(params: {
  readonly grant: Grant;
  readonly key?: AppKey;
  readonly network?: NodeNetworkConfig;
  readonly stores?: StoreFactory;
}): Promise<P2PNode> {
  const key = params.key ?? (await appKey());
  const node = await createNode({
    signer: grantSigner(params.grant),
    sessionKey: key.keys,
    stores: params.stores ?? indexedDBStores(`weave-app:${params.grant.did}`),
    ...(params.network ? { network: params.network } : {}),
  });
  const held = new Set((await node.spaces.list()).map((space) => space.id));
  for (const space of params.grant.spaces) {
    if (!held.has(space.id)) await node.spaces.join(space.invite);
  }
  return node;
}

/** Where an app keeps its grant between visits */
export function grantStore(storage: KeyValueStore | null = globalThis.localStorage ?? null, key = 'weave.grant') {
  return {
    load(): Grant | null {
      try {
        const grant = JSON.parse(storage?.getItem(key) ?? 'null') as Grant | null;
        return grant && grant.expiresAt > Math.floor(Date.now() / 1000) ? grant : null;
      } catch {
        return null;
      }
    },
    save(grant: Grant): void {
      storage?.setItem(key, JSON.stringify(grant));
    },
    forget(): void {
      storage?.removeItem(key);
    },
  };
}

// ─── The home's side ─────────────────────────────────────────────────

/** A request as the home received it */
export interface IncomingRequest {
  readonly request: ConnectRequest;
  /** Where it came from, as the browser reports it — the only name to trust */
  readonly origin: string;
  /** Sends the grant back to that origin, and closes the window */
  approve(grant: Omit<Grant, 'home'>): void;
  /** Says no, and closes the window */
  deny(reason?: string): void;
}

/**
 * Waits for the app that opened this page to say what it wants.
 * @returns The request, or null when this page was not opened by an app
 */
export function receiveConnectRequest(timeoutMs = 10_000): Promise<IncomingRequest | null> {
  const opener = globalThis.opener as Window | null;
  if (!opener) return Promise.resolve(null);

  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener) return;
      const data = event.data as { type?: string; request?: ConnectRequest } | null;
      if (data?.type !== REQUEST || !isRequest(data.request)) return;
      globalThis.removeEventListener('message', onMessage);
      globalThis.clearTimeout(timer);

      const origin = event.origin;
      const reply = (message: unknown) => {
        opener.postMessage(message, origin);
        // A moment's grace, so the answer is delivered before the window goes.
        globalThis.setTimeout(() => globalThis.close(), 100);
      };
      resolve({
        request: data.request,
        origin,
        approve: (grant) => reply({ type: GRANT, grant }),
        deny: (reason) => reply({ type: DENIED, reason: reason ?? 'Access was not given.' }),
      });
    };
    const timer = globalThis.setTimeout(() => {
      globalThis.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);
    globalThis.addEventListener('message', onMessage);
    // Nothing secret in a hello, so any origin may hear it; the request that
    // answers it is what names the app.
    opener.postMessage({ type: HELLO }, '*');
  });
}

function isRequest(value: unknown): value is ConnectRequest {
  const request = value as ConnectRequest | null;
  return (
    !!request &&
    request.v === 1 &&
    typeof request.audience === 'string' &&
    request.audience.startsWith('did:key:') &&
    (request.access === 'read' || request.access === 'write')
  );
}
