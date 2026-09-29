/**
 * @module node/remote
 * A node running in one place, used from another. `serveNode` answers for a
 * node over a message port (a worker's, a frame's), and `remoteNode` is the
 * node at the other end of that port, with the same API. A page can then keep
 * its main thread for drawing and input while the node checks signatures,
 * decrypts and syncs in a worker.
 *
 * What a node returns is plain data already (see `node/types`), so it crosses
 * unchanged. The exceptions: events and `records.watch` become messages.
 * `delegation()` and `network.status()` answer at once, so this side keeps
 * the last value the node reported. `spaces.preview` only reads the invite,
 * so it runs here. Validators and typed collection references go as the JSON
 * Schema and name they stand for, because functions can't be cloned.
 */
import type { MeshStatus } from '../network/mesh.js';
import type { Capability, Fact, UCANToken } from '../identity/ucan.js';
import type { RootSigner } from '../identity/root-signer.js';
import type { Query, ResultOf } from '../query/types.js';
import { plainQuery } from '../query/types.js';
import { toJsonSchema } from '../schema/collection-def.js';
import { previewInvite } from '../space/space-manager.js';
import { isRecord } from '../utils/guards.js';
import type { MessagePortLike } from '../utils/port.js';
import type {
  DefineCollection,
  NodeAccount,
  NodeCarriers,
  NodeCollection,
  NodeCollections,
  NodeContacts,
  NodeDirect,
  NodeDoors,
  NodeEvent,
  NodeHosting,
  NodeNotifications,
  NodeRecords,
  NodeSpaces,
  P2PNode,
} from './types.js';

/** What `remoteNode` keeps of a node, to answer the calls that can't wait */
interface NodeState {
  readonly did: string;
  readonly sessionDid: string;
  readonly delegation: UCANToken;
  readonly status: MeshStatus;
}

/** Tags every message, so a port shared with other traffic can tell ours apart */
const TAG = 'weave-node';

/** The namespaces whose methods cross, and the node's own methods that do */
const NAMESPACES = new Set([
  'spaces',
  'records',
  'collections',
  'account',
  'carriers',
  'hosting',
  'notifications',
  'contacts',
  'direct',
  'doors',
  'network',
]);
const OWN_METHODS = new Set(['iceServers', 'delegate']);

/** How often the served side checks for a renewed delegation between calls */
const DELEGATION_CHECK_MS = 60_000;

interface SentError {
  readonly name: string;
  readonly message: string;
  readonly code?: unknown;
}

function sendable(error: unknown): SentError {
  if (!isRecord(error)) return { name: 'Error', message: String(error) };
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : 'The node failed',
    ...(error.code !== undefined ? { code: error.code } : {}),
  };
}

function received(sent: unknown): Error {
  const fields = isRecord(sent) ? sent : {};
  const error = new Error(typeof fields.message === 'string' ? fields.message : 'The node failed');
  if (typeof fields.name === 'string') error.name = fields.name;
  if (fields.code !== undefined) Object.assign(error, { code: fields.code });
  return error;
}

const stateOf = (node: P2PNode): NodeState => ({
  did: node.did,
  sessionDid: node.sessionDid,
  delegation: node.delegation(),
  status: node.network.status(),
});

/** The method a call names, bound to its namespace, or null when it is not one that crosses */
function methodAt(node: P2PNode, path: string): ((...args: unknown[]) => unknown) | null {
  const parts = path.split('.');
  const [first, second] = parts;
  if (first === undefined || parts.length > 2) return null;
  let owner: unknown = node;
  let name = first;
  if (second !== undefined) {
    if (!NAMESPACES.has(first)) return null;
    owner = Reflect.get(node, first);
    name = second;
  } else if (!OWN_METHODS.has(first)) return null;
  if (!isRecord(owner) || !Object.hasOwn(owner, name)) return null;
  const method: unknown = owner[name];
  if (typeof method !== 'function') return null;
  return (...args: unknown[]): unknown => Reflect.apply(method, owner, args);
}

/**
 * Answers for `node` over `port`, until the returned function is called.
 * Stopping leaves the node running: closing it is its owner's to do, or the
 * other side's, through `close()`.
 *
 * Nodes started from it with `asAgent` are served on the same port.
 */
export function serveNode(node: P2PNode, port: MessagePortLike): () => void {
  interface Served {
    readonly node: P2PNode;
    readonly unsubscribe: () => void;
    sent: string;
  }
  const served = new Map<number, Served>();
  const watches = new Map<number, { readonly handle: number; readonly stop: () => void }>();
  const holds = new Map<number, { readonly handle: number; readonly release: () => Promise<void> }>();
  let nextHandle = 0;
  let nextHold = 0;

  const post = (message: Record<string, unknown>) => {
    port.postMessage({ [TAG]: true, ...message });
  };
  const sendState = (handle: number, entry: Served) => {
    const state = stateOf(entry.node);
    entry.sent = state.delegation.encoded;
    post({ kind: 'state', node: handle, state });
  };
  /** Sends the delegation again when the node has renewed it */
  const checkDelegation = (handle: number) => {
    const entry = served.get(handle);
    if (entry && entry.node.delegation().encoded !== entry.sent) sendState(handle, entry);
  };

  const add = (added: P2PNode): number => {
    const handle = nextHandle++;
    const entry: Served = {
      node: added,
      sent: added.delegation().encoded,
      unsubscribe: added.subscribe((event) => {
        post({ kind: 'event', node: handle, event });
        if (event.type === 'network') sendState(handle, entry);
      }),
    };
    served.set(handle, entry);
    return handle;
  };
  const drop = (handle: number) => {
    served.get(handle)?.unsubscribe();
    served.delete(handle);
    for (const [id, watch] of watches) {
      if (watch.handle !== handle) continue;
      watch.stop();
      watches.delete(id);
    }
    for (const [id, held] of holds) {
      if (held.handle !== handle) continue;
      holds.delete(id);
      void held.release().catch(() => {});
    }
  };
  add(node);
  const timer = setInterval(() => {
    for (const handle of served.keys()) checkDelegation(handle);
  }, DELEGATION_CHECK_MS);

  const run = async (handle: number, path: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
    const entry = served.get(handle);
    if (!entry) throw new Error('That node has closed');
    const target = entry.node;
    if (path === 'hello') return stateOf(target);
    if (path === 'asAgent') {
      const agent = args[0];
      if (!isRecord(agent) || !isRecord(agent.keys) || typeof agent.note !== 'string')
        throw new Error('asAgent takes { keys, note }');
      const { privateKey, publicKey } = agent.keys;
      if (!(privateKey instanceof CryptoKey) || !(publicKey instanceof CryptoKey))
        throw new Error('asAgent takes a key pair');
      const started = await target.asAgent({ keys: { privateKey, publicKey }, note: agent.note });
      return { handle: add(started), state: stateOf(started) };
    }
    if (path === 'hold') {
      const release = await target.spaces.hold(String(args[0]));
      const id = ++nextHold;
      holds.set(id, { handle, release });
      return id;
    }
    if (path === 'release') {
      const held = holds.get(Number(args[0]));
      holds.delete(Number(args[0]));
      await held?.release();
      return undefined;
    }
    if (path === 'close') {
      drop(handle);
      // With the node itself closed there is nothing left to renew; later calls are told it has closed.
      if (handle === 0) clearInterval(timer);
      await target.close();
      return undefined;
    }
    const method = methodAt(target, path);
    if (!method) throw new Error(`A node has no method ${path}`);
    return await method(...args);
  };

  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[TAG] !== true) return;
    const handle = typeof message.node === 'number' ? message.node : 0;
    if (message.kind === 'call' && typeof message.id === 'number' && typeof message.path === 'string') {
      const { id } = message;
      const args = Array.isArray(message.args) ? message.args : [];
      void run(handle, message.path, args).then(
        (value) => {
          try {
            post({ kind: 'reply', id, ok: true, value });
          } catch (error) {
            // A value that won't clone: say so, rather than leave the call waiting.
            post({ kind: 'reply', id, ok: false, error: sendable(error) });
          }
          checkDelegation(handle);
        },
        (error: unknown) => post({ kind: 'reply', id, ok: false, error: sendable(error) }),
      );
    } else if (
      message.kind === 'watch' &&
      typeof message.watch === 'number' &&
      typeof message.space === 'string'
    ) {
      const entry = served.get(handle);
      const { watch } = message;
      if (!entry || !isRecord(message.query)) {
        post({ kind: 'result', watch, error: sendable(new Error('Nothing to watch')) });
        return;
      }
      const stop = entry.node.records.watch(
        message.space,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the query runner checks it and reports what's wrong through onError
        message.query as unknown as Query,
        (result) => post({ kind: 'result', watch, result }),
        (error) => post({ kind: 'result', watch, error: sendable(error) }),
      );
      watches.set(watch, { handle, stop });
    } else if (message.kind === 'unwatch' && typeof message.watch === 'number') {
      watches.get(message.watch)?.stop();
      watches.delete(message.watch);
    }
  };

  port.addEventListener('message', onMessage);
  port.start?.();
  return () => {
    clearInterval(timer);
    port.removeEventListener('message', onMessage);
    for (const handle of [...served.keys()]) drop(handle);
  };
}

/** Every member of a namespace: `true` to forward it, or what to use here instead */
type Members<N> = { readonly [K in keyof N]-?: true | N[K] };

/**
 * The node `serveNode` answers for on the other end of `port`: the same API,
 * each call a message. Resolves once the node has said who it is.
 */
export async function remoteNode(port: MessagePortLike): Promise<P2PNode> {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Map<number, Set<(event: NodeEvent) => void>>();
  const states = new Map<number, NodeState>();
  const watchers = new Map<
    number,
    { readonly onResult: (result: unknown) => void; readonly onError: (error: Error) => void }
  >();
  /** Handles closed from this side: calls on them fail at once */
  const closed = new Set<number>();
  let nextId = 0;

  const post = (message: Record<string, unknown>) => {
    port.postMessage({ [TAG]: true, ...message });
  };

  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[TAG] !== true) return;
    const handle = typeof message.node === 'number' ? message.node : 0;
    if (message.kind === 'reply' && typeof message.id === 'number') {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok === true) waiting?.resolve(message.value);
      else waiting?.reject(received(message.error));
    } else if (message.kind === 'event' && isRecord(message.event)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node sent it from its own subscribe
      const nodeEvent = message.event as NodeEvent;
      for (const listener of listeners.get(handle) ?? []) {
        try {
          listener(nodeEvent);
        } catch (error) {
          console.error(error);
        }
      }
    } else if (message.kind === 'state' && isRecord(message.state)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node sent it from its own state
      states.set(handle, message.state as unknown as NodeState);
    } else if (message.kind === 'result' && typeof message.watch === 'number') {
      const watcher = watchers.get(message.watch);
      if (!watcher) return;
      if (message.error !== undefined) watcher.onError(received(message.error));
      else watcher.onResult(message.result);
    }
  };
  port.addEventListener('message', onMessage);
  port.start?.();

  /** Calls a method of the node on the other end; it answers with that method's type */
  const ask = <R>(handle: number, path: string, args: ReadonlyArray<unknown>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      if (closed.has(handle) || closed.has(0)) {
        reject(new Error('That node has closed'));
        return;
      }
      const id = ++nextId;
      pending.set(id, {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node ran the method this one stands for
        resolve: (value) => resolve(value as R),
        reject,
      });
      try {
        post({ kind: 'call', id, node: handle, path, args });
      } catch (error) {
        // An argument that won't clone, a function say.
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const namespace = <N>(handle: number, name: string, members: Members<N>): N => {
    const built: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(members)) {
      built[key] = member === true ? (...args: unknown[]) => ask(handle, `${name}.${key}`, args) : member;
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Members lists every one; each forwarded member runs the real method on the other end
    return Object.freeze(built) as N;
  };

  /** The name a typed collection reference stands for; a validator can't be cloned */
  const collectionName = (ref: unknown): unknown =>
    isRecord(ref) && typeof ref.name === 'string' ? ref.name : ref;

  const build = (handle: number, initial: NodeState): P2PNode => {
    states.set(handle, initial);
    const state = () => states.get(handle) ?? initial;
    const spaces = namespace<NodeSpaces>(handle, 'spaces', {
      list: true,
      get: true,
      create: true,
      invite: true,
      preview: previewInvite,
      join: true,
      leave: true,
      access: true,
      setMember: true,
      putRole: true,
      removeRole: true,
      closeInvite: true,
      changeKey: true,
      setRelays: true,
      setKeepers: true,
      revoke: true,
      async hold(spaceId: string) {
        const held = await ask<number>(handle, 'hold', [spaceId]);
        return () => ask<void>(handle, 'release', [held]);
      },
      send: true,
      status: true,
      authenticator: () =>
        Promise.reject(new Error('A node in a worker serves no sockets; ask the node that holds the space')),
      profiles: true,
    });
    const records = namespace<NodeRecords>(handle, 'records', {
      list: true,
      get: true,
      // Either overload: the record comes back typed as the call asked.
      put: (...args: unknown[]) =>
        ask<never>(handle, 'records.put', [args[0], collectionName(args[1]), ...args.slice(2)]),
      update: true,
      linked: true,
      delete: true,
      history: true,
      can: true,
      query: <const Q extends Query>(spaceId: string, query: Q) =>
        ask<ResultOf<Q>>(handle, 'records.query', [spaceId, plainQuery(query)]),
      watch: <const Q extends Query>(
        spaceId: string,
        query: Q,
        onResult: (result: ResultOf<Q>) => void,
        onError?: (error: Error) => void,
      ) => {
        const watch = ++nextId;
        watchers.set(watch, {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the served node ran this query
          onResult: (result) => onResult(result as ResultOf<Q>),
          onError: onError ?? ((error) => console.error(error)),
        });
        try {
          post({ kind: 'watch', watch, node: handle, space: spaceId, query: plainQuery(query) });
        } catch (error) {
          watchers.delete(watch);
          throw error;
        }
        return () => {
          if (!watchers.delete(watch)) return;
          post({ kind: 'unwatch', watch });
        };
      },
    });
    const collections = namespace<NodeCollections>(handle, 'collections', {
      list: true,
      define: async (spaceId: string, definition: DefineCollection) =>
        ask<NodeCollection>(handle, 'collections.define', [
          spaceId,
          { ...definition, schema: toJsonSchema(definition.schema) },
        ]),
      delete: true,
      tag: true,
    });
    return Object.freeze({
      did: initial.did,
      sessionDid: initial.sessionDid,
      spaces,
      records,
      collections,
      account: namespace<NodeAccount>(handle, 'account', { profile: true, setName: true, revoke: true }),
      carriers: namespace<NodeCarriers>(handle, 'carriers', { list: true, add: true, remove: true }),
      hosting: namespace<NodeHosting>(handle, 'hosting', {
        list: true,
        use: true,
        payPage: true,
        stop: true,
        space: true,
      }),
      notifications: namespace<NodeNotifications>(handle, 'notifications', {
        list: true,
        add: true,
        update: true,
        remove: true,
        versions: true,
        take: true,
      }),
      contacts: namespace<NodeContacts>(handle, 'contacts', {
        space: true,
        list: true,
        get: true,
        put: true,
        remove: true,
        block: true,
        ask: true,
        requests: true,
        accept: true,
        others: true,
      }),
      direct: namespace<NodeDirect>(handle, 'direct', { reachable: true, send: true, list: true }),
      doors: namespace<NodeDoors>(handle, 'doors', {
        list: true,
        open: true,
        close: true,
        knock: true,
        clear: true,
        knocks: true,
        sent: true,
        accept: true,
        dismiss: true,
      }),
      delegation: () => state().delegation,
      iceServers: () => ask<ReadonlyArray<RTCIceServer>>(handle, 'iceServers', []),
      network: Object.freeze({
        status: () => state().status,
        reconnect: () => {
          void ask(handle, 'network.reconnect', []).catch(() => {});
        },
      }),
      delegate: (params) => ask(handle, 'delegate', [params]),
      async asAgent(agent) {
        const started = await ask<{ handle: number; state: NodeState }>(handle, 'asAgent', [agent]);
        return build(started.handle, started.state);
      },
      subscribe(listener) {
        const own = listeners.get(handle) ?? new Set();
        listeners.set(handle, own);
        own.add(listener);
        return () => {
          own.delete(listener);
        };
      },
      async close() {
        if (closed.has(handle)) return;
        await ask(handle, 'close', []);
        closed.add(handle);
        listeners.delete(handle);
        states.delete(handle);
        if (handle !== 0) return;
        port.removeEventListener('message', onMessage);
        for (const waiting of pending.values()) waiting.reject(new Error('That node has closed'));
        pending.clear();
        watchers.clear();
      },
    } satisfies P2PNode);
  };

  return build(0, await ask<NodeState>(0, 'hello', []));
}

const SIGNER_TAG = 'weave-signer';

/**
 * Signs session delegations for a `remoteSigner` on the other side of `port`.
 * The root key stays here: a passkey needs a document, and a key in a tab
 * should stay in the tab that holds it. Returns a function that stops.
 */
export function serveSigner(signer: RootSigner, port: MessagePortLike): () => void {
  const post = (message: Record<string, unknown>) => {
    port.postMessage({ [SIGNER_TAG]: true, ...message });
  };
  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[SIGNER_TAG] !== true || typeof message.id !== 'number') return;
    const { id } = message;
    const run = async (): Promise<unknown> => {
      if (message.kind === 'hello') return { did: signer.did, custody: signer.custody };
      const params = message.params;
      if (
        message.kind !== 'delegate' ||
        !isRecord(params) ||
        typeof params.audience !== 'string' ||
        !Array.isArray(params.capabilities) ||
        typeof params.expiration !== 'number'
      )
        throw new Error('A signer only signs delegations');
      return signer.delegate({
        audience: params.audience,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the signer checks what it signs
        capabilities: params.capabilities as ReadonlyArray<Capability>,
        expiration: params.expiration,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the signer checks what it signs
        ...(Array.isArray(params.facts) ? { facts: params.facts as ReadonlyArray<Fact> } : {}),
      });
    };
    void run().then(
      (value) => post({ kind: 'reply', id, ok: true, value }),
      (error: unknown) => post({ kind: 'reply', id, ok: false, error: sendable(error) }),
    );
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return () => port.removeEventListener('message', onMessage);
}

/** The signer a `serveSigner` keeps on the other side of `port`, for `createNode` to sign sessions with */
export async function remoteSigner(port: MessagePortLike): Promise<RootSigner> {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  port.addEventListener('message', (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[SIGNER_TAG] !== true || message.kind !== 'reply') return;
    const waiting = pending.get(Number(message.id));
    pending.delete(Number(message.id));
    if (message.ok === true) waiting?.resolve(message.value);
    else waiting?.reject(received(message.error));
  });
  port.start?.();
  const ask = <R>(message: Record<string, unknown>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the signer on the other side answered this call
        resolve: (value) => resolve(value as R),
        reject,
      });
      port.postMessage({ [SIGNER_TAG]: true, kind: message.kind, params: message.params, id });
    });
  const { did, custody } = await ask<Pick<RootSigner, 'did' | 'custody'>>({ kind: 'hello' });
  return Object.freeze({
    did,
    custody,
    delegate: (params) => ask<UCANToken>({ kind: 'delegate', params }),
  } satisfies RootSigner);
}
