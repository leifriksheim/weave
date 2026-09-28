/**
 * @module sync-engine
 * Keeps one store in step with its peers.
 *
 * 1. A peer says hello with a fingerprint of each collection it keeps. Equal
 *    fingerprints mean the same versions: nothing to do for that collection.
 * 2. For each collection that differs, one side — the initiator — reconciles
 *    it with the other (`negentropy.ts`). A few rounds of fingerprints of
 *    ever smaller ranges end with the initiator knowing which versions each
 *    side lacks.
 * 3. The initiator asks for what it lacks, and sends what the other lacks.
 *    Everything that arrives passes the gatekeeper before it is stored.
 *
 * Cost follows the difference, not the size: two stores differing by one
 * version exchange a few hundred bytes.
 *
 * The initiator is the peer whose id sorts first, so two peers that hear each
 * other's hello at once don't both do the work. A peer that isn't the
 * initiator answers a hello with its own, which starts the other.
 *
 * **Holding part of a space.** A node may hold every collection, or only
 * some (plus the space's own `sys.*`, which every node holds). Each hello
 * says which. Two peers reconcile only the collections both hold, and a
 * version for a collection this node doesn't hold is not taken in. Whatever
 * a node does take in from a peer, it tells that peer it has (`stored`): a
 * node holding part of a space keeps its own writes until enough keepers have
 * said so.
 */
import type { Expression } from '../types.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { cidDigest, cidOfDigest } from '../utils/hash.js';
import { base64UrlDecode, base64UrlEncode, bytesToHex } from '../utils/encoding.js';
import { createEmitter } from '../utils/events.js';
import { createReconciler, fingerprintOf } from './negentropy.js';
import {
  parseSyncMessage,
  SYNC_PROTOCOL_VERSION,
  type SyncMessage,
  type SyncMessageBody,
} from './sync-messages.js';

/** Verdict on an expression that arrived from a peer */
export interface IncomingValidation {
  readonly valid: boolean;
  readonly reason?: string;
  /**
   * Not judged yet, rather than refused: it depends on something that has not
   * arrived — a record's first version, the definition it was written under.
   * It is held and tried again as other records come in, and fetched again on
   * the next round if it is still waiting.
   */
  readonly later?: boolean;
}

/** At most this many records wait for what they depend on; the oldest give way */
const MAX_WAITING = 1000;
/** Refusals remembered, so reconciling doesn't ask a peer for the same bad version every round */
const MAX_REFUSED = 10_000;

/** What a node holds of a space: every collection, or these (besides `sys.*`, which every node holds) */
export type Holds = 'all' | ReadonlySet<string>;

/** Whether a collection is held, given what a node holds */
export const holdsCollection = (holds: Holds, collection: string): boolean =>
  collection.startsWith('sys.') || holds === 'all' || holds.has(collection);

/** Collection definitions first, then records by version — what others depend on comes first */
const rank = (e: Expression): number => (e?.collection === 'sys.collection' ? -1 : (e?.seq ?? 0));

export interface SyncEngineConfig {
  readonly storageProvider: StorageProvider;
  readonly sendToPeer: (peerId: string, message: SyncMessage) => void;
  /**
   * This node's id among its peers. The one of two peers whose id sorts first
   * starts reconciling. Without it, this node starts whenever it hears of a
   * difference — harmless, just sometimes twice the work.
   */
  readonly self?: string;
  readonly heartbeatInterval?: number;
  /**
   * Gatekeeper for expressions arriving from peers — typically
   * `createVersionCheck`. Anything it rejects is dropped instead of committed,
   * and surfaces as a `rejected` event.
   *
   * Leaving it out accepts whatever peers send, which is only ever appropriate
   * for a trusted transport or a test.
   */
  readonly validate?: (expression: Expression) => Promise<IncomingValidation>;
  /** What this node holds, asked afresh for every hello. Default: everything. */
  readonly holds?: () => Holds;
}

/**
 * - `synced` (peer, full): nothing left in flight with the peer; `full` when the peer holds every collection
 * - `level` (peer, collection, full): this node holds what the peer holds of a
 *   collection, as far as it could take it in; `full` when the peer holds every collection
 * - `stored` (peer, ids): the peer says it now has these versions
 * - `expression-received` (version): each version taken in
 * - `received` (versions): every version one message brought, once all are in — what to redraw after
 * - `rejected` (peer, version, reason), `error` (error)
 */
interface SyncEvents {
  synced: (peer: string, full: boolean) => void;
  level: (peer: string, collection: string, full: boolean) => void;
  stored: (peer: string, ids: string[]) => void;
  'expression-received': (version: Expression) => void;
  received: (versions: Expression[]) => void;
  /** A method, so listeners written before `reason` could be missing still type-check */
  rejected(peer: string, version: Expression, reason: string | undefined): void;
  error: (error: unknown) => void;
}
export type SyncEvent = keyof SyncEvents;

export interface SyncEngine {
  start(): void;
  stop(): void;
  /** Handles whatever a peer sent; anything that is not a sync message this peer speaks is ignored. */
  handleMessage(peerId: string, message: unknown): Promise<void>;
  /** Says hello to these peers now, rather than at the next heartbeat. */
  notifyPeers(peers: ReadonlyArray<string>): void;
  onLocalChange(expression: Expression): void;
  addPeer(peerId: string): void;
  removePeer(peerId: string): void;
  on<K extends SyncEvent>(event: K, callback: SyncEvents[K]): void;
  off<K extends SyncEvent>(event: K, callback: SyncEvents[K]): void;
}

/** Records asked for, or sent, in one message. */
export const MAX_IDS_PER_REQUEST = 200;
/** `want`s in flight to one peer at a time; the rest queue */
export const MAX_WANTS_IN_FLIGHT = 4;
/** Largest Negentropy message, in bytes before base64. Stays well inside a data channel's limit. */
export const FRAME_SIZE_LIMIT = 32_000;
/** Collections one hello may name. Past this it is hostile, not big. */
const MAX_COLLECTIONS = 1000;
/** Rounds one reconciliation may take before it is given up as runaway. */
const MAX_ROUNDS = 64;
/** A session that has heard nothing for this long is given up on. */
const STALE_MS = 30_000;

/** Reconciling one collection with one peer, as initiator */
interface Session {
  readonly id: number;
  readonly collection: string;
  readonly reconciler: ReturnType<typeof createReconciler>;
  rounds: number;
  touchedAt: number;
  /** The peer said something new about this collection mid-session: go again once done */
  again: boolean;
  /**
   * Ids already sent or asked for. A round cut short by the frame limit can
   * name some ids again in the next — the reference implementation does too.
   */
  readonly handled: Set<string>;
  /** Ids found so far, oldest first: what they lack, and what we lack */
  readonly have: string[];
  readonly need: string[];
}

/** Everything in flight with one peer */
interface PeerState {
  readonly sessions: Map<string, Session>;
  /** `want` requests in flight, by request id, and the collection they are for */
  readonly wants: Map<
    number,
    { readonly ids: ReadonlySet<string>; readonly collection: string; readonly at: number }
  >;
  /**
   * Ids to ask for once fewer wants are in flight, front first. An id counts
   * as queued while it is in `queuedIds`; an entry whose id is not (it was
   * moved to the front, and asked for there) is passed over.
   */
  readonly queued: Array<{ readonly id: string; readonly collection: string }>;
  readonly queuedIds: Set<string>;
  /** What the peer said it holds, in its last hello */
  holds: Holds;
}

/**
 * Creates a sync engine orchestrator.
 * @param config Sync engine configuration.
 * @returns A sync engine instance.
 */
export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  const { storageProvider: storage, sendToPeer, heartbeatInterval = 30000, validate, self } = config;
  const ourHolds = config.holds ?? (() => 'all' as const);
  /** Peers to say hello to and push to */
  const peers = new Set<string>();
  /** What's in flight with each peer */
  const states = new Map<string, PeerState>();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let nextId = 1;

  const { on, off, emit } = createEmitter<SyncEvents>();

  const stamp = (msg: SyncMessageBody): SyncMessage => ({ v: SYNC_PROTOCOL_VERSION, ...msg });
  const send = (peerId: string, msg: SyncMessageBody) => sendToPeer(peerId, stamp(msg));
  const stateOf = (peerId: string): PeerState =>
    states.get(peerId) ??
    states
      .set(peerId, { sessions: new Map(), wants: new Map(), queued: [], queuedIds: new Set(), holds: 'all' })
      .get(peerId)!;

  // ─── Taking in versions ────────────────────────────────────────────

  /** Records that could not be judged yet — tried again whenever something new is admitted */
  const waiting = new Map<string, { peerId: string; expression: Expression }>();
  /**
   * Versions the gatekeeper refused, as `peer + id`, oldest first. By peer,
   * not by id alone: an id doesn't cover the signature, so a stranger's
   * mangled copy shares the real record's id — refusing it must not stop us
   * fetching the real one from someone else.
   */
  const refused = new Set<string>();
  const refusal = (peerId: string, id: string) => `${peerId}\n${id}`;

  /** What one message brought in: the versions stored, and the first versions to ask for */
  interface Intake {
    readonly placed: Expression[];
    readonly firsts: Map<string, string>;
  }

  /**
   * Commits an expression from a peer, but only if the gatekeeper allows it.
   * A version waiting for its first version names it, so that is asked for
   * at once rather than on the next round.
   * @returns Whether the expression was accepted
   */
  const admit = async (peerId: string, expression: Expression, intake: Intake): Promise<boolean> => {
    if (validate) {
      const verdict = await validate(expression);
      if (!verdict.valid) {
        if (verdict.later) {
          waiting.set(expression.id, { peerId, expression });
          if (waiting.size > MAX_WAITING) waiting.delete(waiting.keys().next().value!);
          const first = expression.seq > 0 ? expression.genesis : undefined;
          if (typeof first === 'string' && !(await storage.getExpression(first)))
            intake.firsts.set(first, expression.collection);
        } else {
          refused.add(refusal(peerId, expression.id));
          if (refused.size > MAX_REFUSED) refused.delete(refused.values().next().value!);
          emit('rejected', peerId, expression, verdict.reason);
        }
        return false;
      }
    }
    waiting.delete(expression.id);
    await storage.addExpression(expression);
    intake.placed.push(expression);
    emit('expression-received', expression);
    return true;
  };

  const retryWaiting = async (intake: Intake) => {
    let progressed = true;
    while (progressed && waiting.size > 0) {
      progressed = false;
      for (const [id, held] of [...waiting]) {
        waiting.delete(id);
        if (await admit(held.peerId, held.expression, intake)) progressed = true;
      }
    }
  };

  /**
   * Queues these versions to ask a peer for, in this order, or ahead of
   * everything queued (`first`), as the space's own records always are: who
   * may do what decides whether the rest counts. A few wants are in flight at
   * a time: what arrives can then pull what it waits for ahead of the rest,
   * and fewer versions wait at once.
   */
  const want = (peerId: string, collection: string, ids: ReadonlyArray<string>, ahead = false) => {
    const first = ahead || collection.startsWith('sys.');
    const state = stateOf(peerId);
    const entries = ids.filter((id) => first || !state.queuedIds.has(id)).map((id) => ({ id, collection }));
    for (const { id } of entries) state.queuedIds.add(id);
    if (first) state.queued.unshift(...entries);
    else state.queued.push(...entries);
    pump(peerId);
  };

  /** Sends wants from the front of the queue while there is room in flight, at most 200 ids each, one collection each */
  const pump = (peerId: string) => {
    const state = states.get(peerId);
    if (!state) return;
    while (state.wants.size < MAX_WANTS_IN_FLIGHT && state.queuedIds.size > 0) {
      const ids: string[] = [];
      let collection: string | null = null;
      while (state.queued.length > 0 && ids.length < MAX_IDS_PER_REQUEST) {
        const next = state.queued[0]!;
        if (!state.queuedIds.has(next.id)) {
          state.queued.shift();
          continue;
        }
        if (collection !== null && next.collection !== collection) break;
        collection = next.collection;
        state.queued.shift();
        state.queuedIds.delete(next.id);
        ids.push(next.id);
      }
      if (collection === null) break;
      const wantId = nextId++;
      state.wants.set(wantId, { ids: new Set(ids), collection, at: Date.now() });
      send(peerId, { type: 'want', id: wantId, ids });
    }
  };

  /** Ids this node has asked a peer for and not yet been answered */
  const asked = (peerId: string) =>
    new Set([...(states.get(peerId)?.wants.values() ?? [])].flatMap((w) => [...w.ids]));

  /**
   * Admits a batch: definitions and first versions before what depends on
   * them, so little has to wait. Versions of collections this node doesn't
   * hold are passed over. The peer is told which it now has.
   */
  const admitAll = async (peerId: string, expressions: ReadonlyArray<Expression>) => {
    const holds = ourHolds();
    const stored: string[] = [];
    const intake: Intake = { placed: [], firsts: new Map() };
    for (const expression of [...expressions].sort((a, b) => rank(a) - rank(b))) {
      if (!expression || typeof expression !== 'object' || typeof expression.collection !== 'string')
        continue;
      if (!holdsCollection(holds, expression.collection)) continue;
      if (await admit(peerId, expression, intake)) stored.push(expression.id);
    }
    if (stored.length > 0) {
      send(peerId, { type: 'stored', ids: stored });
      await retryWaiting(intake);
    }
    // First versions still missing once everything that could go in has.
    if (intake.firsts.size > 0 && peers.has(peerId)) {
      const inFlight = asked(peerId);
      const byCollection = new Map<string, string[]>();
      for (const [id, collection] of intake.firsts) {
        if (inFlight.has(id) || refused.has(refusal(peerId, id)) || (await storage.getExpression(id)))
          continue;
        (byCollection.get(collection) ?? byCollection.set(collection, []).get(collection)!).push(id);
      }
      for (const [collection, ids] of byCollection) want(peerId, collection, ids, true);
    }
    if (intake.placed.length > 0) emit('received', intake.placed);
  };

  // ─── Hello ─────────────────────────────────────────────────────────

  /** A fingerprint of each collection held and kept, hex */
  const ourSums = async (holds: Holds): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [collection, sum] of await storage.sums()) {
      if (holdsCollection(holds, collection)) out[collection] = bytesToHex(await fingerprintOf(sum));
    }
    return out;
  };

  const hello = async (peerId: string, reply = false) => {
    const holds = ourHolds();
    send(peerId, {
      type: 'hello',
      holds: holds === 'all' ? 'all' : [...holds],
      sums: await ourSums(holds),
      ...(reply ? { reply } : {}),
    });
  };

  /** What a hello says the peer holds; anything malformed counts as holding nothing past `sys.*` */
  const readHolds = (value: unknown): Holds => {
    if (value === undefined || value === 'all') return 'all';
    if (!Array.isArray(value) || value.length > MAX_COLLECTIONS) return new Set();
    return new Set(value.filter((c): c is string => typeof c === 'string'));
  };

  const onHello = async (
    peerId: string,
    theirs: Readonly<Record<string, string>>,
    theirHolds: unknown,
    reply: boolean,
  ) => {
    if (typeof theirs !== 'object' || theirs === null) return;
    const names = Object.keys(theirs);
    if (names.length > MAX_COLLECTIONS) return;
    const state = stateOf(peerId);
    state.holds = readHolds(theirHolds);
    const holds = ourHolds();
    const ours = await ourSums(holds);
    // Everything either side names, and every collection this node holds even if it has none of it yet.
    const named = new Set([...names, ...Object.keys(ours), ...(holds === 'all' ? [] : holds)]);
    const shared = [...named].filter((c) => holdsCollection(holds, c) && holdsCollection(state.holds, c));
    const differing = shared.filter((c) => theirs[c] !== ours[c]);
    for (const c of shared) if (theirs[c] === ours[c]) emit('level', peerId, c, state.holds === 'all');
    if (differing.length === 0) {
      if (!busy(peerId)) emit('synced', peerId, state.holds === 'all');
      return;
    }
    if (self !== undefined && self > peerId) {
      // The other side starts. It may not have heard from us yet: tell it.
      if (!reply) await hello(peerId, true);
      return;
    }
    for (const collection of differing) await begin(peerId, collection);
  };

  // ─── Reconciling, as initiator ─────────────────────────────────────

  const busy = (peerId: string) => {
    const state = states.get(peerId);
    return !!state && (state.sessions.size > 0 || state.wants.size > 0 || state.queuedIds.size > 0);
  };

  const settleIfDone = (peerId: string) => {
    if (!busy(peerId)) emit('synced', peerId, states.get(peerId)?.holds === 'all');
  };

  const begin = async (peerId: string, collection: string) => {
    if (typeof collection !== 'string') return;
    const state = stateOf(peerId);
    const current = state.sessions.get(collection);
    if (current && Date.now() - current.touchedAt < STALE_MS) {
      current.again = true;
      return;
    }
    const reconciler = createReconciler(await storage.items(collection), {
      initiator: true,
      frameSizeLimit: FRAME_SIZE_LIMIT,
    });
    const session: Session = {
      id: nextId++,
      collection,
      reconciler,
      rounds: 0,
      touchedAt: Date.now(),
      again: false,
      handled: new Set(),
      have: [],
      need: [],
    };
    state.sessions.set(collection, session);
    send(peerId, {
      type: 'reconcile',
      id: session.id,
      collection,
      message: base64UrlEncode(await reconciler.initiate()),
    });
  };

  /**
   * A collection's session and every request it made are over: level with the
   * peer, as far as could be. The peer is told where things stand now, so it
   * knows it is level too — marked a reply, so it never starts another round.
   */
  const levelIfDone = (peerId: string, collection: string) => {
    const state = states.get(peerId);
    if (!state || state.sessions.has(collection)) return;
    for (const want of state.wants.values()) if (want.collection === collection) return;
    for (const queued of state.queued)
      if (queued.collection === collection && state.queuedIds.has(queued.id)) return;
    emit('level', peerId, collection, state.holds === 'all');
    void hello(peerId, true).catch((err) => emit('error', err));
  };

  const onReconciled = async (peerId: string, id: number, message: string, held: boolean) => {
    const state = states.get(peerId);
    const session = state && [...state.sessions.values()].find((s) => s.id === id);
    if (!state || !session) return; // not ours, or already over
    session.touchedAt = Date.now();

    // What they lack goes, and what we lack is asked for, once the session
    // has found it all — newest first. Rounds find items oldest first, so
    // sending as they go would show a record as it once was (its first
    // version) until the version that deleted or changed it came along.
    const end = async () => {
      // Asked for before the session goes, so the peer never looks idle in between.
      want(peerId, session.collection, session.need.reverse());
      state.sessions.delete(session.collection);
      const have = session.have.reverse();
      for (let i = 0; i < have.length; i += MAX_IDS_PER_REQUEST) {
        const versions = (
          await Promise.all(have.slice(i, i + MAX_IDS_PER_REQUEST).map((v) => storage.getExpression(v)))
        ).filter((v): v is Expression => v !== null);
        if (versions.length > 0) send(peerId, { type: 'versions', versions });
      }
      if (session.again) void begin(peerId, session.collection).catch((err) => emit('error', err));
    };

    if (!held) {
      // They don't hold it after all — they changed what they hold since their hello.
      await end();
      return settleIfDone(peerId);
    }

    let round;
    try {
      round = await session.reconciler.reconcile(base64UrlDecode(message));
    } catch (err) {
      await end();
      emit(
        'error',
        new Error(`Sync with ${peerId} abandoned: ${err instanceof Error ? err.message : String(err)}`),
      );
      return settleIfDone(peerId);
    }

    const fresh = (id: string) => !session.handled.has(id) && !!session.handled.add(id);
    session.have.push(...round.have.map(cidOfDigest).filter(fresh));
    session.need.push(
      ...round.need.map(cidOfDigest).filter((v) => fresh(v) && !refused.has(refusal(peerId, v))),
    );

    if (round.message && ++session.rounds < MAX_ROUNDS) {
      send(peerId, {
        type: 'reconcile',
        id: session.id,
        collection: session.collection,
        message: base64UrlEncode(round.message),
      });
      return;
    }
    if (round.message)
      emit('error', new Error(`Sync with ${peerId} abandoned: more than ${MAX_ROUNDS} rounds`));
    await end();
    levelIfDone(peerId, session.collection);
    settleIfDone(peerId);
  };

  // ─── Answering ─────────────────────────────────────────────────────

  const onReconcile = async (peerId: string, id: number, collection: string, message: string) => {
    if (typeof collection !== 'string' || typeof message !== 'string') return;
    if (!holdsCollection(ourHolds(), collection)) {
      send(peerId, { type: 'reconciled', id, message: '', held: false });
      return;
    }
    const responder = createReconciler(await storage.items(collection), {
      initiator: false,
      frameSizeLimit: FRAME_SIZE_LIMIT,
    });
    const round = await responder.reconcile(base64UrlDecode(message));
    send(peerId, { type: 'reconciled', id, message: base64UrlEncode(round.message!) });
  };

  const serveWant = async (peerId: string, id: number, ids: ReadonlyArray<string>) => {
    const versions: Expression[] = [];
    for (const v of ids.slice(0, MAX_IDS_PER_REQUEST)) {
      const expression = typeof v === 'string' && cidDigest(v) ? await storage.getExpression(v) : null;
      if (expression) versions.push(expression);
    }
    // Always answered, even empty: the asker counts replies to know it is done.
    send(peerId, { type: 'versions', id, versions });
  };

  const onVersions = async (peerId: string, id: number | undefined, versions: ReadonlyArray<Expression>) => {
    const state = states.get(peerId);
    if (id === undefined) {
      // Sent because we lacked them. Nothing is taken on trust: each passes the gatekeeper.
      await admitAll(peerId, versions.slice(0, MAX_IDS_PER_REQUEST));
      return;
    }
    const asked = state?.wants.get(id);
    if (!state || !asked) return;
    // Only versions asked for are considered.
    await admitAll(
      peerId,
      versions.filter((v) => asked.ids.has(v?.id)),
    );
    state.wants.delete(id);
    pump(peerId);
    levelIfDone(peerId, asked.collection);
    settleIfDone(peerId);
  };

  // ─── Housekeeping ──────────────────────────────────────────────────

  /** Drops sessions and requests a peer stopped answering, so a lost message can't wedge sync */
  const sweep = () => {
    const now = Date.now();
    for (const [peerId, state] of states) {
      for (const [collection, session] of state.sessions)
        if (now - session.touchedAt > STALE_MS) state.sessions.delete(collection);
      // A want whose answer was lost: what it asked for is found again on the next round.
      let dropped = false;
      for (const [id, want] of state.wants) {
        if (now - want.at <= STALE_MS) continue;
        state.wants.delete(id);
        dropped = true;
      }
      if (!dropped) continue;
      pump(peerId);
      settleIfDone(peerId);
    }
  };

  /** Handles one message from a peer; anything that is not a sync message this peer speaks is ignored */
  const handle = async (peerId: string, message: unknown): Promise<void> => {
    try {
      const msg = parseSyncMessage(message);
      // Malformed, a protocol version this peer does not speak, or a peer not
      // added yet: an answer to it would have no way back and be lost, leaving
      // a session waiting. Each side says hello once it adds the other, so
      // nothing said before then is needed.
      if (!msg || !peers.has(peerId)) return;

      switch (msg.type) {
        case 'hello':
          await onHello(peerId, msg.sums, msg.holds, msg.reply === true);
          break;
        case 'reconcile':
          await onReconcile(peerId, msg.id, msg.collection, msg.message);
          break;
        case 'reconciled':
          await onReconciled(peerId, msg.id, msg.message, msg.held !== false);
          break;
        case 'want':
          await serveWant(peerId, msg.id, Array.isArray(msg.ids) ? msg.ids : []);
          break;
        case 'versions':
          await onVersions(peerId, msg.id, Array.isArray(msg.versions) ? msg.versions : []);
          break;
        case 'push-update':
          if (msg.expression && typeof msg.expression === 'object') await admitAll(peerId, [msg.expression]);
          break;
        case 'stored':
          if (Array.isArray(msg.ids))
            emit(
              'stored',
              peerId,
              msg.ids.filter((v): v is string => typeof v === 'string').slice(0, 10 * MAX_IDS_PER_REQUEST),
            );
          break;
      }
    } catch (err) {
      emit('error', err);
    }
  };

  /** Where each peer's messages are up to */
  const inOrder = new Map<string, Promise<void>>();

  return {
    start() {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        sweep();
        for (const peer of peers) void hello(peer).catch((err) => emit('error', err));
      }, heartbeatInterval);
    },

    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      states.clear();
    },

    handleMessage(peerId: string, message: unknown): Promise<void> {
      // One peer's messages are handled in the order they came: a hello saying
      // where things stand must not overtake the versions sent before it.
      const run = (inOrder.get(peerId) ?? Promise.resolve()).then(() => handle(peerId, message));
      inOrder.set(peerId, run);
      void run.finally(() => {
        if (inOrder.get(peerId) === run) inOrder.delete(peerId);
      });
      return run;
    },

    notifyPeers(peerIds: ReadonlyArray<string>) {
      for (const peer of peerIds) if (peers.has(peer)) void hello(peer).catch((err) => emit('error', err));
    },

    onLocalChange(expression: Expression) {
      for (const peer of peers) send(peer, { type: 'push-update', expression });
    },

    addPeer(peerId: string) {
      peers.add(peerId);
    },

    removePeer(peerId: string) {
      // A dropped peer must not leave half-finished sessions holding memory.
      peers.delete(peerId);
      states.delete(peerId);
    },

    on,
    off,
  };
}
