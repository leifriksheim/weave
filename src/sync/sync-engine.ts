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
 */
import type { Expression } from '../types.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { cidDigest, cidOfDigest } from '../utils/hash.js';
import { base64UrlDecode, base64UrlEncode, bytesToHex } from '../utils/encoding.js';
import { createEmitter } from '../utils/events.js';
import { createReconciler, fingerprintOf } from './negentropy.js';
import { parseSyncMessage, SYNC_PROTOCOL_VERSION, type SyncMessage, type SyncMessageBody } from './sync-messages.js';

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
   * Gatekeeper for expressions arriving from peers — typically a
   * `ValidationEngine`. Anything it rejects is dropped instead of committed,
   * and surfaces as a `rejected` event.
   *
   * Leaving it out accepts whatever peers send, which is only ever appropriate
   * for a trusted transport or a test.
   */
  readonly validate?: (expression: Expression) => Promise<IncomingValidation>;
}

export type SyncEvent = 'synced' | 'expression-received' | 'rejected' | 'error';
type EventHandler = (...args: any[]) => void;

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
  on(event: SyncEvent, callback: EventHandler): void;
  off(event: SyncEvent, callback: EventHandler): void;
}

/** Records asked for, or sent, in one message. */
export const MAX_IDS_PER_REQUEST = 200;
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
}

/** Everything in flight with one peer */
interface PeerState {
  readonly sessions: Map<string, Session>;
  /** `want` requests in flight, by request id */
  readonly wants: Map<number, ReadonlySet<string>>;
}

/**
 * Creates a sync engine orchestrator.
 * @param config Sync engine configuration.
 * @returns A sync engine instance.
 */
export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  const { storageProvider: storage, sendToPeer, heartbeatInterval = 30000, validate, self } = config;
  /** Peers to say hello to and push to */
  const peers = new Set<string>();
  /** What's in flight with each peer */
  const states = new Map<string, PeerState>();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let nextId = 1;

  const { on, off, emit } = createEmitter<Record<SyncEvent, EventHandler>>();

  const stamp = (msg: SyncMessageBody) => ({ v: SYNC_PROTOCOL_VERSION, ...msg }) as SyncMessage;
  const send = (peerId: string, msg: SyncMessageBody) => sendToPeer(peerId, stamp(msg));
  const stateOf = (peerId: string): PeerState => states.get(peerId) ?? states.set(peerId, { sessions: new Map(), wants: new Map() }).get(peerId)!;

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

  /**
   * Commits an expression from a peer, but only if the gatekeeper allows it.
   * @returns Whether the expression was accepted
   */
  const admit = async (peerId: string, expression: Expression): Promise<boolean> => {
    if (validate) {
      const verdict = await validate(expression);
      if (!verdict.valid) {
        if (verdict.later) {
          waiting.set(expression.id, { peerId, expression });
          if (waiting.size > MAX_WAITING) waiting.delete(waiting.keys().next().value!);
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
    emit('expression-received', expression);
    return true;
  };

  const retryWaiting = async () => {
    let progressed = true;
    while (progressed && waiting.size > 0) {
      progressed = false;
      for (const [id, held] of [...waiting]) {
        waiting.delete(id);
        if (await admit(held.peerId, held.expression)) progressed = true;
      }
    }
  };

  /** Admits a batch: definitions and first versions before what depends on them, so little has to wait */
  const admitAll = async (peerId: string, expressions: ReadonlyArray<Expression>) => {
    let admitted = false;
    for (const expression of [...expressions].sort((a, b) => rank(a) - rank(b))) {
      if (expression && typeof expression === 'object' && (await admit(peerId, expression))) admitted = true;
    }
    if (admitted) await retryWaiting();
  };

  // ─── Hello ─────────────────────────────────────────────────────────

  /** A fingerprint of each collection kept, hex */
  const ourSums = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [collection, sum] of await storage.sums()) out[collection] = bytesToHex(await fingerprintOf(sum));
    return out;
  };

  const hello = async (peerId: string, reply = false) => send(peerId, { type: 'hello', sums: await ourSums(), ...(reply ? { reply } : {}) });

  const onHello = async (peerId: string, theirs: Readonly<Record<string, string>>, reply: boolean) => {
    if (typeof theirs !== 'object' || theirs === null) return;
    const names = Object.keys(theirs);
    if (names.length > MAX_COLLECTIONS) return;
    const ours = await ourSums();
    const differing = [...new Set([...names, ...Object.keys(ours)])].filter((c) => theirs[c] !== ours[c]);
    if (differing.length === 0) {
      if (!busy(peerId)) emit('synced', peerId);
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
    return !!state && (state.sessions.size > 0 || state.wants.size > 0);
  };

  const settleIfDone = (peerId: string) => {
    if (!busy(peerId)) emit('synced', peerId);
  };

  const begin = async (peerId: string, collection: string) => {
    if (typeof collection !== 'string') return;
    const state = stateOf(peerId);
    const current = state.sessions.get(collection);
    if (current && Date.now() - current.touchedAt < STALE_MS) {
      current.again = true;
      return;
    }
    const reconciler = createReconciler(await storage.items(collection), { initiator: true, frameSizeLimit: FRAME_SIZE_LIMIT });
    const session: Session = { id: nextId++, collection, reconciler, rounds: 0, touchedAt: Date.now(), again: false, handled: new Set() };
    state.sessions.set(collection, session);
    send(peerId, { type: 'reconcile', id: session.id, collection, message: base64UrlEncode(await reconciler.initiate()) });
  };

  const onReconciled = async (peerId: string, id: number, message: string) => {
    const state = states.get(peerId);
    const session = state && [...state.sessions.values()].find((s) => s.id === id);
    if (!state || !session) return; // not ours, or already over
    session.touchedAt = Date.now();

    const end = () => {
      state.sessions.delete(session.collection);
      if (session.again) void begin(peerId, session.collection).catch((err) => emit('error', err));
    };

    let round;
    try {
      round = await session.reconciler.reconcile(base64UrlDecode(message));
    } catch (err) {
      end();
      emit('error', new Error(`Sync with ${peerId} abandoned: ${(err as Error).message}`));
      return settleIfDone(peerId);
    }

    // What they lack goes now; what we lack is asked for.
    const fresh = (id: string) => !session.handled.has(id) && !!session.handled.add(id);
    const have = round.have.map(cidOfDigest).filter(fresh);
    for (let i = 0; i < have.length; i += MAX_IDS_PER_REQUEST) {
      const versions = (await Promise.all(have.slice(i, i + MAX_IDS_PER_REQUEST).map((v) => storage.getExpression(v)))).filter(
        (v): v is Expression => v !== null,
      );
      if (versions.length > 0) send(peerId, { type: 'versions', versions });
    }
    const need = round.need.map(cidOfDigest).filter((v) => fresh(v) && !refused.has(refusal(peerId, v)));
    for (let i = 0; i < need.length; i += MAX_IDS_PER_REQUEST) {
      const ids = need.slice(i, i + MAX_IDS_PER_REQUEST);
      const wantId = nextId++;
      state.wants.set(wantId, new Set(ids));
      send(peerId, { type: 'want', id: wantId, ids });
    }

    if (round.message && ++session.rounds < MAX_ROUNDS) {
      send(peerId, { type: 'reconcile', id: session.id, collection: session.collection, message: base64UrlEncode(round.message) });
      return;
    }
    if (round.message) emit('error', new Error(`Sync with ${peerId} abandoned: more than ${MAX_ROUNDS} rounds`));
    end();
    settleIfDone(peerId);
  };

  // ─── Answering ─────────────────────────────────────────────────────

  const onReconcile = async (peerId: string, id: number, collection: string, message: string) => {
    if (typeof collection !== 'string' || typeof message !== 'string') return;
    const responder = createReconciler(await storage.items(collection), { initiator: false, frameSizeLimit: FRAME_SIZE_LIMIT });
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
    await admitAll(peerId, versions.filter((v) => asked.has(v?.id)));
    state.wants.delete(id);
    settleIfDone(peerId);
  };

  // ─── Housekeeping ──────────────────────────────────────────────────

  /** Drops sessions and requests a peer stopped answering, so a lost message can't wedge sync */
  const sweep = () => {
    const now = Date.now();
    for (const state of states.values()) {
      for (const [collection, session] of state.sessions) if (now - session.touchedAt > STALE_MS) state.sessions.delete(collection);
    }
  };

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

    async handleMessage(peerId: string, message: unknown): Promise<void> {
      try {
        const msg = parseSyncMessage(message);
        // Malformed, a protocol version this peer does not speak, or a peer not
        // added yet: an answer to it would have no way back and be lost, leaving
        // a session waiting. Each side says hello once it adds the other, so
        // nothing said before then is needed.
        if (!msg || !peers.has(peerId)) return;

        switch (msg.type) {
          case 'hello':
            await onHello(peerId, msg.sums, msg.reply === true);
            break;
          case 'reconcile':
            await onReconcile(peerId, msg.id, msg.collection, msg.message);
            break;
          case 'reconciled':
            await onReconciled(peerId, msg.id, msg.message);
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
        }
      } catch (err) {
        emit('error', err);
      }
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
