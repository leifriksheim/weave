/**
 * WebRTC made on one side of a message port and used from the
 * other. A node running in a worker can't count on `RTCPeerConnection` being
 * there (not every browser has it in workers), so the page keeps the
 * connections (`serveTransport`) and the worker's mesh drives them
 * (`remoteTransport`): offers, answers and candidates go one way, frames and
 * connection events come back.
 *
 * The ICE servers travel with each offer and answer, because the mesh in the
 * worker is what learns a relay's short-lived TURN passwords.
 */
import type { CandidateSink, PeerTransportEvents, SignalledTransport } from './transport.js';
import { createRTCTransport } from './rtc-transport.js';
import { createEmitter } from '../utils/events.js';
import { isRecord } from '../utils/guards.js';
import type { MessagePortLike } from '../utils/port.js';

const TAG = 'weave-transport';

type Binding = { readonly local: string; readonly remote: string } | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EVENTS = ['data', 'connected', 'disconnected', 'error'] as const;

/** Listens to every event of `transport`; returns what stops listening. */
function listen(transport: SignalledTransport, events: PeerTransportEvents): () => void {
  for (const name of EVENTS) transport.on(name, events[name]);
  return () => {
    for (const name of EVENTS) transport.off(name, events[name]);
  };
}

/**
 * Keeps WebRTC connections on this side of `port` for a `remoteTransport` on
 * the other. Returns a function that closes them all and stops.
 */
export function serveTransport(
  port: MessagePortLike,
  create: (iceServers: () => ReadonlyArray<RTCIceServer>) => SignalledTransport = (iceServers) =>
    createRTCTransport({ iceServers }),
): () => void {
  let iceServers: ReadonlyArray<RTCIceServer> = [];
  const transport = create(() => iceServers);
  const post = (message: Record<string, unknown>) => {
    port.postMessage({ [TAG]: true, ...message });
  };
  const candidates =
    (peer: string): CandidateSink =>
    (candidate) =>
      post({ kind: 'candidate', peer, candidate });

  const stop = listen(transport, {
    data: (peer, data) => post({ kind: 'data', peer, data }),
    // The binding is read only once a connection is open, so it goes with the news that it is.
    connected: (peer) => post({ kind: 'connected', peer, binding: transport.binding?.(peer) ?? null }),
    disconnected: (peer) => post({ kind: 'disconnected', peer }),
    error: (peer, error) => post({ kind: 'error', peer, message: errorText(error) }),
  });

  const run = async (message: Record<string, unknown>): Promise<unknown> => {
    const peer = String(message.peer);
    if (Array.isArray(message.iceServers)) iceServers = message.iceServers;
    switch (message.kind) {
      case 'offer':
        return transport.createOffer(peer, candidates(peer));
      case 'answer-offer': {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- setRemoteDescription checks it and rejects
        const offer = message.description as RTCSessionDescriptionInit;
        return transport.handleOffer(peer, offer, candidates(peer));
      }
      case 'answer':
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- setRemoteDescription checks it and rejects
        return transport.handleAnswer(peer, message.description as RTCSessionDescriptionInit);
      case 'candidate':
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- addIceCandidate checks it and rejects
        return transport.addIceCandidate(peer, message.candidate as RTCIceCandidateInit);
      default:
        throw new Error(`No such transport call: ${String(message.kind)}`);
    }
  };

  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[TAG] !== true) return;
    const peer = String(message.peer);
    if (message.kind === 'send' && message.data instanceof Uint8Array) {
      try {
        transport.send(peer, message.data);
      } catch (error) {
        post({ kind: 'error', peer, message: errorText(error) });
      }
    } else if (message.kind === 'close') {
      transport.close(peer);
    } else if (message.kind === 'close-all') {
      transport.closeAll();
    } else if (typeof message.id === 'number') {
      const { id } = message;
      void run(message).then(
        (value) => post({ kind: 'reply', id, ok: true, value }),
        (error: unknown) => post({ kind: 'reply', id, ok: false, message: errorText(error) }),
      );
    }
  };
  port.addEventListener('message', onMessage);
  port.start?.();

  return () => {
    port.removeEventListener('message', onMessage);
    stop();
    transport.closeAll();
  };
}

/**
 * The connections a `serveTransport` keeps on the other side of `port`, as a
 * transport the mesh can use: `createTransport` in the node's network config.
 *
 * `send` can't report a closed channel at once, as WebRTC's own does; the
 * failure comes back as an `error` event instead.
 */
export function remoteTransport(
  port: MessagePortLike,
  iceServers: () => ReadonlyArray<RTCIceServer>,
): SignalledTransport {
  const { on, off, emit } = createEmitter<PeerTransportEvents>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const sinks = new Map<string, CandidateSink>();
  const bindings = new Map<string, Binding>();
  let nextId = 0;

  const post = (message: Record<string, unknown>) => {
    port.postMessage({ [TAG]: true, ...message });
  };
  const ask = <R>(message: Record<string, unknown>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the other side ran the call this one stands for
        resolve: (value) => resolve(value as R),
        reject,
      });
      post({ ...message, id });
    });

  const onMessage = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || message[TAG] !== true) return;
    const peer = String(message.peer);
    switch (message.kind) {
      case 'reply': {
        const waiting = pending.get(Number(message.id));
        pending.delete(Number(message.id));
        if (message.ok === true) waiting?.resolve(message.value);
        else waiting?.reject(new Error(String(message.message)));
        break;
      }
      case 'candidate':
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the connection on the other side found it
        sinks.get(peer)?.(message.candidate as RTCIceCandidateInit);
        break;
      case 'data':
        if (message.data instanceof Uint8Array) emit('data', peer, message.data);
        break;
      case 'connected':
        bindings.set(
          peer,
          isRecord(message.binding) &&
            typeof message.binding.local === 'string' &&
            typeof message.binding.remote === 'string'
            ? { local: message.binding.local, remote: message.binding.remote }
            : null,
        );
        emit('connected', peer);
        break;
      case 'disconnected':
        sinks.delete(peer);
        bindings.delete(peer);
        emit('disconnected', peer);
        break;
      case 'error':
        emit('error', peer, new Error(String(message.message)));
        break;
    }
  };
  port.addEventListener('message', onMessage);
  port.start?.();

  return Object.freeze({
    createOffer: (peer: string, onCandidate: CandidateSink) => {
      sinks.set(peer, onCandidate);
      return ask<RTCSessionDescriptionInit>({ kind: 'offer', peer, iceServers: iceServers() });
    },
    handleOffer: (peer: string, description: RTCSessionDescriptionInit, onCandidate: CandidateSink) => {
      sinks.set(peer, onCandidate);
      return ask<RTCSessionDescriptionInit>({
        kind: 'answer-offer',
        peer,
        description,
        iceServers: iceServers(),
      });
    },
    handleAnswer: (peer: string, description: RTCSessionDescriptionInit) =>
      ask<void>({ kind: 'answer', peer, description }),
    addIceCandidate: (peer: string, candidate: RTCIceCandidateInit) =>
      ask<void>({ kind: 'candidate', peer, candidate }),
    send: (peer: string, data: Uint8Array) => post({ kind: 'send', peer, data }),
    close: (peer: string) => {
      sinks.delete(peer);
      bindings.delete(peer);
      post({ kind: 'close', peer });
    },
    closeAll: () => {
      sinks.clear();
      bindings.clear();
      post({ kind: 'close-all' });
    },
    binding: (peer: string) => bindings.get(peer) ?? null,
    on,
    off,
  });
}

/** One transport for the mesh, made through whichever page is there to make it */
export interface TransportSwitch {
  /** What the mesh uses */
  readonly transport: SignalledTransport;
  /** Adds a page's connections; the first one added is used until it leaves */
  add(id: string, transport: SignalledTransport): void;
  /**
   * A page left. When its connections were the ones in use, every peer on
   * them is reported gone, so the mesh connects again through the next page.
   */
  remove(id: string): void;
}

/**
 * The mesh of a node that several pages share (one tab's WebRTC at a time):
 * `transport` forwards to the page that has been there longest, and moves
 * on when it leaves.
 */
export function createTransportSwitch(): TransportSwitch {
  const { on, off, emit } = createEmitter<PeerTransportEvents>();
  const pages = new Map<string, { readonly transport: SignalledTransport; readonly stop: () => void }>();
  /** Peers connected through the page in use */
  const connected = new Set<string>();
  const current = (): SignalledTransport | null => pages.values().next().value?.transport ?? null;
  const using = (): SignalledTransport => {
    const transport = current();
    if (!transport) throw new Error('No page is open to make connections through');
    return transport;
  };

  const transport: SignalledTransport = Object.freeze({
    createOffer: async (peer: string, onCandidate: CandidateSink) => using().createOffer(peer, onCandidate),
    handleOffer: async (peer: string, offer: RTCSessionDescriptionInit, onCandidate: CandidateSink) =>
      using().handleOffer(peer, offer, onCandidate),
    handleAnswer: async (peer: string, answer: RTCSessionDescriptionInit) =>
      using().handleAnswer(peer, answer),
    addIceCandidate: async (peer: string, candidate: RTCIceCandidateInit) =>
      using().addIceCandidate(peer, candidate),
    send: (peer: string, data: Uint8Array) => using().send(peer, data),
    close: (peer: string) => current()?.close(peer),
    closeAll: () => current()?.closeAll(),
    binding: (peer: string) => current()?.binding?.(peer) ?? null,
    on,
    off,
  });

  return Object.freeze({
    transport,
    add(id: string, added: SignalledTransport) {
      // Only the page in use speaks for the mesh; the others wait their turn.
      const stop = listen(added, {
        data: (peer, data) => {
          if (current() === added) emit('data', peer, data);
        },
        connected: (peer) => {
          if (current() !== added) return;
          connected.add(peer);
          emit('connected', peer);
        },
        disconnected: (peer) => {
          if (current() !== added) return;
          connected.delete(peer);
          emit('disconnected', peer);
        },
        error: (peer, error) => {
          if (current() === added) emit('error', peer, error);
        },
      });
      pages.set(id, { transport: added, stop });
    },
    remove(id: string) {
      const page = pages.get(id);
      if (!page) return;
      const wasCurrent = current() === page.transport;
      page.stop();
      pages.delete(id);
      if (!wasCurrent) return;
      const gone = [...connected];
      connected.clear();
      for (const peer of gone) emit('disconnected', peer);
    },
  });
}
