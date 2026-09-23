/**
 * One open list, as the screens need it.
 *
 * Storage, validation, encryption and gossip all live in the node now; this is
 * the thin layer that turns its records into todos and its events into
 * re-renders.
 */
import type { NodeCollection, NodeRecord, SpaceSummary } from '@p2p-web/protocol';
import { requireSession, type Session } from './protocol';
import { COLLECTION, TODO_DEFINITION, type Todo } from './todos';

export { COLLECTION, type Todo } from './todos';
export { relayUrl, relayUrls } from './relay';

/** What a verification pass concluded about one todo */
export interface TodoVerification {
  readonly signatureValid: boolean;
  readonly authorized: boolean;
  /** The root identity the signing key was acting for */
  readonly rootDid: string | null;
  readonly reason?: string;
}

/** A todo as the UI needs it: decrypted content plus who vouched for it */
export interface TodoView {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  readonly body: Todo;
  readonly verification: TodoVerification;
  /** Whether it arrived encrypted and had to be opened with the space key */
  readonly wasEncrypted: boolean;
}

export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'error';

export interface SpaceStatus {
  readonly peers: ReadonlyArray<string>;
  readonly connection: ConnectionState;
  readonly mstRoot: string | null;
  /** Expressions peers sent that the gatekeeper threw out */
  readonly rejected: number;
}

export interface SpaceSession {
  readonly space: SpaceSummary;
  list(): Promise<ReadonlyArray<TodoView>>;
  add(text: string): Promise<void>;
  toggle(todo: TodoView): Promise<void>;
  remove(id: string): Promise<void>;
  status(): Promise<SpaceStatus>;
  /** What the space says it holds */
  collections(): Promise<ReadonlyArray<NodeCollection>>;
  /** Fires whenever todos or connectivity change */
  subscribe(listener: () => void): () => void;
  close(): void;
}

function toView(record: NodeRecord<Todo>): TodoView | null {
  if (record.body === null) return null; // a member's data we have no key for
  return {
    id: record.id,
    author: record.author,
    createdAt: record.createdAt,
    body: record.body,
    wasEncrypted: record.encrypted,
    verification: {
      signatureValid: record.verified,
      authorized: record.verified,
      rootDid: record.root,
      ...(record.reason ? { reason: record.reason } : {}),
    },
  };
}

/**
 * Opens a space: the node starts syncing it and this adapts it for the UI.
 * @param space The space, from the node's list
 */
export async function openSpace(space: SpaceSummary): Promise<SpaceSession> {
  const { node }: Session = requireSession();
  await node.spaces.open(space.id);

  // Describe todos in the space itself, the first time this app opens it.
  // Someone following a personal list cannot write there, and does not need to.
  const described = (await node.collections.list(space.id)).some((c) => c.name === COLLECTION && c.version !== null);
  if (!described) await node.collections.define(space.id, TODO_DEFINITION).catch(() => {});

  return Object.freeze({
    space,

    async list(): Promise<ReadonlyArray<TodoView>> {
      const records = await node.records.list<Todo>(space.id, { collection: COLLECTION });
      return records
        .map(toView)
        .filter((view): view is TodoView => view !== null)
        .sort((a, b) => a.body.order - b.body.order);
    },

    async add(text: string): Promise<void> {
      await node.records.put<Todo>(space.id, COLLECTION, { text, completed: false, order: Date.now() });
    },

    async toggle(todo: TodoView): Promise<void> {
      await node.records.update<Todo>(space.id, todo.id, { ...todo.body, completed: !todo.body.completed });
    },

    async remove(id: string): Promise<void> {
      await node.records.delete(space.id, id);
    },

    collections: () => node.collections.list(space.id),

    async status(): Promise<SpaceStatus> {
      const status = await node.spaces.status(space.id);
      return { peers: status.peers, connection: status.connection, mstRoot: status.root, rejected: status.rejected };
    },

    subscribe(listener: () => void): () => void {
      return node.subscribe((event) => {
        if ('space' in event && event.space === space.id) listener();
      });
    },

    close(): void {
      void node.spaces.close(space.id);
    },
  });
}

/** Re-exported so components can talk about a session without importing two modules. */
export type { Session };
