/**
 * @module node/api
 * Every method of a node's namespaces, listed once: what an agent may do with
 * each (`asAgent`), and what crosses a message port (`node/remote.ts`).
 */
import type { P2PNode } from './types.js';

/** The members of a node that hold methods */
export type Namespace =
  | 'spaces'
  | 'records'
  | 'collections'
  | 'account'
  | 'carriers'
  | 'hosting'
  | 'notifications'
  | 'contacts'
  | 'direct'
  | 'doors'
  | 'network';

/**
 * What an agent may do with a method: `pass`, as the node does; `scoped`, only
 * in a space its note names (the first argument); `own`, as `asAgent` says;
 * or the words of a refusal, "An agent can't …".
 */
type AgentPolicy = string;

/** Every method is listed, so a new one does not type-check until it is decided here. */
type Table = { readonly [N in Namespace]: { readonly [M in keyof P2PNode[N]]-?: AgentPolicy } };

export const API = Object.freeze({
  spaces: {
    list: 'own',
    get: 'own',
    create: 'make spaces',
    invite: 'invite anyone',
    preview: 'pass',
    join: 'join spaces',
    leave: 'leave spaces',
    access: 'scoped',
    setMember: 'change who is in a space',
    putRole: 'change roles',
    removeRole: 'change roles',
    closeInvite: 'close invites',
    changeKey: "change a space's key",
    setRelays: "change a space's relays",
    setKeepers: 'change who keeps a copy',
    revoke: 'revoke notes',
    hold: 'scoped',
    // It would arrive as the person: a live message carries no note of its own to say "via agent".
    send: 'send live messages',
    status: 'scoped',
    authenticator: 'own',
    profiles: 'scoped',
  },
  records: {
    list: 'scoped',
    get: 'scoped',
    put: 'scoped',
    update: 'scoped',
    linked: 'scoped',
    delete: 'scoped',
    history: 'scoped',
    can: 'own',
    query: 'scoped',
    watch: 'own',
  },
  collections: { list: 'scoped', define: 'own', delete: 'remove collections', tag: 'scoped' },
  account: { profile: 'pass', setName: 'rename the account', revoke: 'revoke notes' },
  carriers: { list: 'pass', add: 'add a carrier', remove: 'remove a carrier' },
  notifications: {
    list: 'look at notifications',
    add: 'subscribe to anything',
    update: 'change notifications',
    remove: 'change notifications',
    versions: 'look at notifications',
    take: 'change notifications',
  },
  hosting: {
    list: 'look at hosting',
    use: 'start using a host',
    pay: 'pay for hosting',
    manage: 'pay for hosting',
    remind: 'pay for hosting',
    stop: 'stop using a host',
    // Open to an agent in a space it was given, as reading the space is.
    space: 'own',
    payForSpace: 'pay for hosting',
    remindForSpace: 'pay for hosting',
    stopForSpace: 'stop using a host',
    startBot: 'start a bot',
  },
  // The list only when the agent was given it; changing it, or asking anyone, is the person's.
  contacts: {
    space: 'own',
    list: 'own',
    get: 'own',
    put: 'change contacts',
    remove: 'change contacts',
    block: 'block anyone',
    ask: 'ask anyone to be a contact',
    requests: 'open contact requests',
    accept: 'accept contact requests',
    others: "look inside a contact's space",
  },
  // Direct messages are sealed to the person's member key, which an agent isn't given.
  direct: { reachable: 'own', send: 'send direct messages', list: 'read direct messages' },
  // Doors are the person's: an agent has none and knocks on none.
  doors: {
    list: 'own',
    open: 'open a door',
    close: 'close a door',
    knock: "knock on anyone's door",
    clear: 'clear a door',
    knocks: 'read knocks',
    sent: 'look at knocks',
    accept: 'open the door to anyone',
    dismiss: 'dismiss a knock',
  },
  network: { status: 'pass', reconnect: 'pass' },
} as const satisfies Table);

/** The methods of a namespace the table marks `own` */
export type OwnMethods<N extends Namespace> = {
  readonly [
    M in keyof (typeof API)[N] as (typeof API)[N][M] extends 'own' ? M : never
  ]: M extends keyof P2PNode[N] ? P2PNode[N][M] : never;
};

/** Calls a method of `owner` by name */
export function callMethod(owner: object, name: string, args: ReadonlyArray<unknown>): unknown {
  const method: unknown = Reflect.get(owner, name);
  if (typeof method !== 'function') throw new Error(`No method ${name}`);
  return Reflect.apply(method, owner, args);
}

/** Every namespace, with every method the table lists, each made by `member` */
export function buildNamespaces(
  member: (namespace: string, name: string, policy: string) => unknown,
): Pick<P2PNode, Namespace> {
  const built: Record<string, unknown> = {};
  for (const [namespace, methods] of Object.entries(API)) {
    const made: Record<string, unknown> = {};
    for (const [name, policy] of Object.entries(methods)) made[name] = member(namespace, name, policy);
    built[namespace] = Object.freeze(made);
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the table names every method of every namespace, and `member` makes each
  return built as unknown as Pick<P2PNode, Namespace>;
}

/** What `member` finds in `given` for a method, when it gives one */
export function givenFor(given: object, namespace: string, name: string): unknown {
  const methods: unknown = Reflect.get(given, namespace);
  return typeof methods === 'object' && methods !== null && Object.hasOwn(methods, name)
    ? Reflect.get(methods, name)
    : undefined;
}
