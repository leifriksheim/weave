/**
 * Everything that happens inside one space: its own Merkle Search Tree, its own
 * validation pipeline, its own gossip room.
 *
 * A space is the unit of storage and of sync — its own store, its own MST root,
 * its own signaling room — so two spaces never mix, and a peer you share one
 * list with learns nothing about the others. The store is a directory inside the
 * user's data folder when there is one, and a database belonging to this origin
 * alone when there is not.
 */
import {
  createStorageProvider,
  createSchemaEngine,
  createExpression,
  createCryptoGate,
  createStructuralGate,
  createStatefulGate,
  createCapabilityGate,
  createValidationEngine,
  createNetworkManager,
  createSyncEngine,
  encryptExpression,
  decryptExpression,
  didToPublicKey,
  resolveDelegationRoot,
  type Expression,
  type EncryptedExpression,
  type NetworkManager,
  type NetworkMessage,
  type PeerInfo,
  type SpaceRecord,
  type StandardSchemaV1,
  type StorageProvider,
  type SyncEngine,
} from '@p2p-web/protocol';
import { requireSession, spacePath, writeCapability, type Session } from './protocol';
import { openStore, watchFolder } from './storage-backend';
import { relayUrls } from './relay';

export const COLLECTION = 'app.p2p-todo.item';

export { relayUrl, relayUrls } from './relay';

export interface Todo {
  readonly text: string;
  readonly completed: boolean;
  readonly order: number;
}

const todoSchema: StandardSchemaV1<Todo> = {
  '~standard': {
    version: 1,
    vendor: 'p2p-todo-example',
    validate(value: unknown) {
      if (typeof value !== 'object' || value === null) {
        return { issues: [{ message: 'Expected an object' }] };
      }
      const v = value as Record<string, unknown>;
      if (typeof v.text !== 'string' || v.text.length === 0) {
        return { issues: [{ message: 'text must be a non-empty string' }] };
      }
      if (typeof v.completed !== 'boolean') {
        return { issues: [{ message: 'completed must be a boolean' }] };
      }
      if (typeof v.order !== 'number') {
        return { issues: [{ message: 'order must be a number' }] };
      }
      return { value: value as Todo };
    },
  },
};

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
  readonly peers: ReadonlyArray<PeerInfo>;
  readonly connection: ConnectionState;
  readonly mstRoot: string | null;
  /** Expressions peers sent that the gatekeeper threw out */
  readonly rejected: number;
}

export interface SpaceSession {
  readonly record: SpaceRecord;
  list(): Promise<ReadonlyArray<TodoView>>;
  add(text: string): Promise<void>;
  toggle(todo: TodoView): Promise<void>;
  remove(id: string): Promise<void>;
  status(): SpaceStatus;
  /** Fires whenever todos or connectivity change */
  subscribe(listener: () => void): () => void;
  close(): void;
}

/**
 * Opens a space: storage, gates, gossip.
 *
 * @param record The space and its key, from the space manager
 * @returns A live session for that space
 */
export async function openSpace(record: SpaceRecord): Promise<SpaceSession> {
  const session = requireSession();
  const { space, key } = record;

  // One store per space keeps their Merkle trees — and their histories —
  // completely separate. In a data folder that is a directory; otherwise it is
  // a database belonging to this origin alone.
  const adapter = await openStore(spacePath(space.id));
  const storage: StorageProvider = createStorageProvider(adapter);

  const schemaEngine = createSchemaEngine();
  schemaEngine.registerCollection({ name: COLLECTION, schema: todoSchema as StandardSchemaV1 });

  const validation = createValidationEngine({
    cryptoGate: createCryptoGate(session.provider),
    structuralGate: createStructuralGate(schemaEngine),
    statefulGate: createStatefulGate(),
    capabilityGate: createCapabilityGate({
      provider: session.provider,
      requiredCapability: () => writeCapability(space.id),
      // A personal space takes writes from its owner alone. A shared one accepts
      // anyone holding an invite — for a private space, that means the key too.
      ...(space.type === 'personal'
        ? { isTrustedRoot: (rootDid: string) => rootDid === space.owner }
        : {}),
    }),
    resolvePublicKey: async (did) =>
      session.provider.importPublicKey(didToPublicKey(did).publicKeyBytes),
    getExpression: (id) => storage.getExpression(id),
  });

  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  let peers: ReadonlyArray<PeerInfo> = [];
  let connection: ConnectionState = 'offline';
  let mstRoot: string | null = await storage.getRootCid();
  let rejected = 0;

  // Tabs of the same browser share one IndexedDB, so a nudge is enough.
  const channel = new BroadcastChannel(`p2p-todo:${space.id}`);
  channel.onmessage = () => void refreshRoot().then(notify);

  // A data folder has no such nudge: the other writer is a different origin, or
  // a different device behind whatever syncs the folder. So it gets polled, and
  // anything that turns up is folded into this tree. No-op on IndexedDB.
  const unwatchFolder = watchFolder(storage, adapter, () => void refreshRoot().then(notify));

  async function refreshRoot(): Promise<void> {
    mstRoot = await storage.getRootCid();
  }

  // ─── Gossip ──────────────────────────────────────────────────────────

  const network: NetworkManager = createNetworkManager({
    // The room is the space id: peers of one list never meet peers of another.
    // Every configured relay, all at once — and once one peer is found, the
    // mesh introduces the rest without any of them.
    signalingUrls: relayUrls().map((relay) => `${relay}?room=${encodeURIComponent(space.id)}`),
    did: session.sessionDid,
  });

  const sync: SyncEngine = createSyncEngine({
    storageProvider: storage,
    sendToPeer: (peerId, data) => {
      network.send(peerId, {
        type: 'sync',
        from: session.sessionDid,
        payload: Array.from(data),
      });
    },
    validate: async (expression) => {
      // An expression may only claim the space it actually arrived in.
      if (expression.space !== space.id) {
        return { valid: false, reason: 'Expression belongs to a different space' };
      }
      const result = await validation.validate(expression);
      return {
        valid: result.valid,
        ...(result.gates.find((gate) => !gate.passed)?.reason
          ? { reason: result.gates.find((gate) => !gate.passed)!.reason }
          : {}),
      };
    },
  });

  network.on('message', (message: NetworkMessage) => {
    if (message.type !== 'sync' || !Array.isArray(message.payload)) return;
    void sync.handleMessage(message.from, new Uint8Array(message.payload as number[]));
  });

  network.on('peer-connected', (info: PeerInfo) => {
    sync.addPeer(info.did);
    peers = network.getPeers();
    notify();
    // Reconcile immediately rather than waiting for the heartbeat.
    sync.notifyPeers([info.did]);
  });

  network.on('peer-disconnected', () => {
    peers = network.getPeers();
    notify();
  });

  network.on('error', () => {
    if (!network.isConnected()) connection = 'error';
    notify();
  });

  sync.on('expression-received', () => {
    void refreshRoot().then(notify);
  });

  sync.on('rejected', () => {
    rejected += 1;
    notify();
  });

  connection = 'connecting';
  network
    .connect()
    .then(() => {
      connection = 'connected';
      sync.start();
      notify();
    })
    .catch(() => {
      connection = 'error';
      notify();
    });

  // ─── Reading and writing ─────────────────────────────────────────────

  /** Opens an encrypted body, when this space has a key for it. */
  async function readBody(expression: Expression): Promise<{ body: Todo; encrypted: boolean } | null> {
    const body = expression.body as Record<string, unknown>;
    const looksEncrypted =
      typeof body?.ciphertext === 'string' && typeof body?.iv === 'string';

    if (!looksEncrypted) {
      return { body: expression.body as Todo, encrypted: false };
    }
    if (!key) return null; // a member's data we have no key for

    try {
      const opened = await decryptExpression(expression as EncryptedExpression, key);
      return { body: opened.body as Todo, encrypted: true };
    } catch {
      return null;
    }
  }

  async function verify(expression: Expression): Promise<TodoVerification> {
    const result = await validation.validate(expression);
    const failed = result.gates.find((gate) => !gate.passed);
    const signatureValid = result.gates.some((gate) => gate.gate === 'crypto' && gate.passed);

    if (!result.valid) {
      return {
        signatureValid,
        authorized: false,
        rootDid: null,
        ...(failed?.reason ? { reason: failed.reason } : {}),
      };
    }

    const chain = expression.proof
      ? await resolveDelegationRoot(expression.proof, () => null, session.provider)
      : null;

    return { signatureValid: true, authorized: true, rootDid: chain?.rootDid ?? expression.author };
  }

  /** Signs a todo — encrypting it first when the space is private. */
  async function write(body: Todo): Promise<Expression> {
    const validationResult = await schemaEngine.validate(COLLECTION, body);
    if (!validationResult.valid) {
      throw new Error(validationResult.issues?.map((i) => i.message).join(', ') ?? 'Invalid todo');
    }

    // Encrypt *before* signing: peers without the key can still verify the
    // signature and relay the expression, they just cannot read it.
    let payloadBody: unknown = body;
    if (space.visibility === 'private') {
      if (!key) throw new Error('This private space has no key on this device');
      const sealed = await encryptExpression(
        { id: '', author: '', collection: COLLECTION, createdAt: '', body, signature: '' },
        key,
      );
      payloadBody = sealed.body;
    }

    const unsigned = createExpression({
      author: session.sessionDid,
      collection: COLLECTION,
      space: space.id,
      body: payloadBody,
      proof: session.ucan.encoded,
    });

    const signed = await session.signer.sign(unsigned, session.sessionKey);
    await storage.addExpression(signed as Expression);
    await refreshRoot();

    channel.postMessage({ type: 'changed' });
    sync.onLocalChange(signed as Expression);
    notify();

    return signed as Expression;
  }

  return Object.freeze({
    record,

    async list(): Promise<ReadonlyArray<TodoView>> {
      const expressions = await storage.queryExpressions(COLLECTION, 500);

      const views = await Promise.all(
        expressions.map(async (expression) => {
          const opened = await readBody(expression);
          if (!opened) return null;
          return {
            id: expression.id,
            author: expression.author,
            createdAt: expression.createdAt,
            body: opened.body,
            wasEncrypted: opened.encrypted,
            verification: await verify(expression),
          } satisfies TodoView;
        }),
      );

      return views
        .filter((view): view is TodoView => view !== null)
        .sort((a, b) => a.body.order - b.body.order);
    },

    async add(text: string): Promise<void> {
      await write({ text, completed: false, order: Date.now() });
    },

    async toggle(todo: TodoView): Promise<void> {
      await write({ ...todo.body, completed: !todo.body.completed });
      await storage.removeExpression(todo.id);
      await refreshRoot();
      channel.postMessage({ type: 'changed' });
      notify();
    },

    async remove(id: string): Promise<void> {
      await storage.removeExpression(id);
      await refreshRoot();
      channel.postMessage({ type: 'changed' });
      notify();
    },

    status(): SpaceStatus {
      return { peers, connection, mstRoot, rejected };
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close(): void {
      sync.stop();
      network.disconnect();
      unwatchFolder();
      channel.close();
      listeners.clear();
      void storage.close();
    },
  });
}

/** Re-exported so components can talk about a session without importing two modules. */
export type { Session };
