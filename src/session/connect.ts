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
import { base64UrlDecode, utf8Encode } from '../utils/encoding.js';
import { verifyUCAN, parseUCAN, type Capability, type UCANToken } from '../identity/ucan.js';
import { isAgentNote } from '../identity/agent-note.js';
import type { RootSigner } from '../identity/root-signer.js';
import { createNode } from '../node/node.js';
import { indexedDBStores, type StoreFactory } from '../node/stores.js';
import type { NewSpace, NodeNetworkConfig, P2PNode } from '../node/types.js';
import { checkStartingRoles } from '../space/space-access.js';
import { parseSpaceInvite } from '../space/space-manager.js';
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
  /**
   * `write` to change the spaces it is given, `read` only to look. `carry` is
   * for a carrier — a browser extension keeping the spaces online — which gets
   * passes and no keys (`connectCarrier`).
   */
  readonly access: 'read' | 'write' | 'carry';
  /**
   * `spaces` (the default): only the spaces the person picks, and any made for
   * the app. `account`: every space, the account's space list, and making and
   * joining spaces itself — for an app that is a view onto the whole account.
   * Either way the app never gets the seed.
   */
  readonly scope?: 'spaces' | 'account';
  /** Spaces the home should make for the app, and give it */
  readonly create?: ReadonlyArray<NewSpace>;
  /**
   * The account's contacts: the contacts space, and the contact key that opens
   * contact requests sent to the account. Asking someone, or accepting, also
   * needs `account` scope — both make or join a space for two.
   */
  readonly contacts?: boolean;
  /** Whether to offer the person's existing spaces to pick from. Default true. */
  readonly chooseSpaces?: boolean;
  /**
   * The key is an agent's — one on the person's computer, connected with
   * `weave connect` (`agent-link.ts`). Its note says so (`AGENT_FACT`), so
   * every record it writes shows as "via agent", and every peer refuses it
   * changing the space's collections or who may do what, or the account's
   * list of spaces. It may be given chosen spaces or the whole account, but
   * never spaces made for it.
   */
  readonly agent?: boolean;
  /** How many days the note should last, 1–365. The home decides; default 7. */
  readonly days?: number;
}

/** The longest a home gives a note for */
export const MAX_GRANT_DAYS = 365;

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
  readonly scope: 'spaces' | 'account';
  readonly spaces: ReadonlyArray<GrantedSpace>;
  /**
   * With `account` scope: the key the account's space list is derived from
   * (base64url), so the app sees every space and adds the ones it makes or
   * joins. It opens every private space in the account — which is what whole
   * account access means — but it cannot sign as the account.
   */
  readonly accountKey?: string;
  /**
   * With `contacts`, or `account` scope: the contact key's private scalar
   * (base64url), which opens contact requests sent to the account
   * (`deriveContactKeyBytes`). It cannot sign as the account.
   */
  readonly contactKey?: string;
  /** With `contacts`: which of `spaces` is the account's contacts space */
  readonly contactsSpace?: string;
  /** Unix seconds */
  readonly expiresAt: number;
  /** Present, and true, when the note is an agent's */
  readonly agent?: true;
  /** The home that granted it, so the app can go back there */
  readonly home: string;
  /**
   * Relays the home meets peers on. A home someone runs themselves may use
   * different ones from the app, and two peers that share no relay never
   * meet — so the app joins these as well.
   */
  readonly relays?: ReadonlyArray<string>;
}

/**
 * What the home hands a carrier: a way into its carry space, which holds a
 * pass for each of the account's spaces — and nothing that reads or writes
 * them (`space/pass.ts`).
 */
export interface CarryGrant {
  readonly v: 1;
  readonly kind: 'carry';
  /** The account it carries for */
  readonly did: string;
  /** The account's name, for showing whose spaces these are */
  readonly name: string;
  /** The carry space, and the view-only invite to it */
  readonly carry: { readonly space: string; readonly invite: string };
  /**
   * Where the account keeps its data, when it lives in a pod: the path inside
   * the pod folder, and the folder's name to help the person find it. Null
   * when the account lives in the home's browser storage.
   */
  readonly pod: { readonly dataPath: string; readonly folder: string } | null;
  readonly relays?: ReadonlyArray<string>;
  /** The home that granted it */
  readonly home: string;
}

/**
 * Turns what a person typed into a home's connect page:
 * `weave.example.com` → `https://weave.example.com/connect`. Plain `http` only
 * for this machine, where development happens.
 * @throws When it is not a web address
 */
export function homeAddress(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Type the address of your account home.');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(trimmed);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${local ? 'http' : 'https'}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${trimmed}" is not a web address.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // Browsers parse more than they should ("not a url" becomes a host), so ask
  // for a name that could be a real domain.
  if (!loopback && !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)) {
    throw new Error(`"${trimmed}" is not a web address.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('An account home must be on https.');
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/connect';
  url.hash = '';
  url.search = '';
  return url.href;
}

/** The capabilities a grant carries, for these spaces */
export function grantCapabilities(access: 'read' | 'write', spaceIds: ReadonlyArray<string> | 'all'): Capability[] {
  const can = access === 'write' ? 'expression/*' : 'expression/read';
  return spaceIds === 'all' ? [{ with: '*', can }] : spaceIds.map((id) => ({ with: `space:${id}`, can }));
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
  /** The key to ask for. Default: {@link appKey} under `keyName`. */
  readonly key?: AppKey;
  /** Which of this app's keys to use when `key` is not given. Default `default`. */
  readonly keyName?: string;
  /**
   * Ask for a note made out to this key instead of one of the app's own —
   * an agent's, which lives on another computer (`offerAgentLink`).
   */
  readonly audience?: string;
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
  // Opened before anything is awaited, so it still counts as the click's.
  const popup = openHome(homeUrl);
  const audience = options.audience ?? (options.key ?? (await appKey(options.keyName))).did;
  const grant = (await askHome(popup, homeUrl.origin, { v: 1, audience, ...options.request }, options.timeoutMs)) as Grant;
  await checkGrant(grant, audience);
  // An agent's note must say so, or its writes would pass as the person's own.
  if (options.request.agent && !isAgentNote(grant.token)) throw new Error('The home gave an ordinary note, not an agent\'s. Update your account home.');
  return { ...grant, home: homeUrl.href };
}

/**
 * Asks a home to use this carrier — a browser extension, say — for the
 * account. Call it from a click, in a page that stays open until the answer
 * comes: an extension's toolbar popup closes the moment the home's window
 * takes focus, and the answer would have nowhere to go.
 *
 * @param options.key The carrier's own key; it becomes its name to peers
 * @returns The grant, checked: an invite to a private carry space the account made
 */
export async function connectCarrier(options: {
  readonly home: string;
  readonly key: AppKey;
  readonly name?: string;
  readonly timeoutMs?: number;
}): Promise<CarryGrant> {
  const homeUrl = new URL(options.home, globalThis.location.href);
  const popup = openHome(homeUrl);
  const request: ConnectRequest = { v: 1, audience: options.key.did, access: 'carry', ...(options.name ? { name: options.name } : {}) };
  const grant = (await askHome(popup, homeUrl.origin, request, options.timeoutMs)) as CarryGrant;
  checkCarryGrant(grant);
  return { ...grant, home: homeUrl.href };
}

/** Refuses a carry grant that is not an invite to a private space the account made. */
function checkCarryGrant(grant: CarryGrant): void {
  if (grant?.kind !== 'carry' || typeof grant.did !== 'string' || typeof grant.carry?.invite !== 'string') {
    throw new Error('The home did not answer with a way to carry your spaces.');
  }
  const invite = parseSpaceInvite(grant.carry.invite);
  if (invite.space.id !== grant.carry.space || invite.space.creator !== grant.did || invite.space.visibility !== 'private' || !invite.key) {
    throw new Error('The carry space the home named does not check out.');
  }
  if (grant.pod !== null && (typeof grant.pod?.dataPath !== 'string' || grant.pod.dataPath.split('/').some((part) => !part || part === '..'))) {
    throw new Error('The pod the home named does not check out.');
  }
}

function openHome(homeUrl: URL): Window {
  const popup = globalThis.open(homeUrl.href, 'weave-home', 'popup,width=460,height=720');
  if (!popup) throw new Error('The browser blocked the window. Allow pop-ups for this site and try again.');
  return popup;
}

/** Sends the request once the home says hello, and waits for its answer. */
function askHome(popup: Window, homeOrigin: string, request: ConnectRequest, timeoutMs = 10 * 60_000): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const done = (finish: () => void) => {
      globalThis.removeEventListener('message', onMessage);
      globalThis.clearInterval(watch);
      globalThis.clearTimeout(timer);
      finish();
    };
    const onMessage = (event: MessageEvent) => {
      // Only the popup we opened, at the address we opened it on.
      if (event.source !== popup || event.origin !== homeOrigin) return;
      const data = event.data as { type?: string; grant?: unknown; reason?: string } | null;
      if (data?.type === HELLO) popup.postMessage({ type: REQUEST, request }, homeOrigin);
      else if (data?.type === GRANT && data.grant) done(() => resolve(data.grant!));
      else if (data?.type === DENIED) done(() => reject(new Error(data.reason ?? 'Access was not given.')));
    };
    const watch = globalThis.setInterval(() => {
      if (popup.closed) done(() => reject(new Error('The window was closed before access was given.')));
    }, 500);
    const timer = globalThis.setTimeout(() => done(() => reject(new Error('No answer from your account home.'))), timeoutMs);
    globalThis.addEventListener('message', onMessage);
  });
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
  // The home's relays as well as the app's, so the two always share one.
  const relays = [...new Set([...(params.network?.relays ?? []), ...(params.grant.relays ?? [])])];
  const network = params.network || relays.length ? { ...params.network, relays } : undefined;
  const node = await createNode({
    signer: grantSigner(params.grant),
    sessionKey: key.keys,
    stores: params.stores ?? indexedDBStores(`weave-app:${params.grant.did}`),
    ...(params.grant.accountKey ? { accountKey: base64UrlDecode(params.grant.accountKey) } : {}),
    ...(params.grant.contactKey ? { contactKey: base64UrlDecode(params.grant.contactKey) } : {}),
    ...(params.grant.contactsSpace ? { contactsSpace: params.grant.contactsSpace } : {}),
    ...(network ? { network } : {}),
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
  approve(grant: Omit<Grant, 'home'> | Omit<CarryGrant, 'home'>): void;
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
      if (data?.type !== REQUEST) return;
      globalThis.removeEventListener('message', onMessage);
      globalThis.clearTimeout(timer);

      // A request this home cannot read — often an app newer than the home —
      // is answered, not ignored: otherwise both sides wait with nothing said.
      if (!isRequest(data.request)) {
        opener.postMessage(
          { type: DENIED, reason: 'Your account home did not understand what was asked. It may be older than this app — update it, or use another home.' },
          event.origin,
        );
        globalThis.setTimeout(() => globalThis.close(), 100);
        resolve(null);
        return;
      }

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
    (request.access === 'read' || request.access === 'write' || request.access === 'carry') &&
    (request.scope === undefined || request.scope === 'spaces' || request.scope === 'account') &&
    (request.name === undefined || (typeof request.name === 'string' && request.name.length <= 80)) &&
    (request.contacts === undefined || typeof request.contacts === 'boolean') &&
    (request.create === undefined || isNewSpaces(request.create)) &&
    (request.days === undefined || (Number.isInteger(request.days) && request.days >= 1 && request.days <= MAX_GRANT_DAYS)) &&
    // An agent works in spaces that exist: none made for it, and no carrying.
    (request.agent === undefined ||
      request.agent === false ||
      (request.agent === true && request.access !== 'carry' && request.create === undefined && !request.contacts))
  );
}

/** At most this many spaces made for an app in one go */
const MAX_CREATE = 8;

/** Spaces an app asks to have made: few, named, with a visibility — the roles are checked when they are made */
function isNewSpaces(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CREATE &&
    value.every(
      (space: Partial<NewSpace> | null) =>
        !!space &&
        typeof space.name === 'string' &&
        space.name.trim().length > 0 &&
        space.name.length <= 80 &&
        (space.visibility === 'private' || space.visibility === 'public') &&
        (space.roles === undefined || checkStartingRoles(space.roles, space.creatorRole ?? [...space.roles].sort((a, b) => b.rank - a.rank)[0]?.name) === null),
    )
  );
}
