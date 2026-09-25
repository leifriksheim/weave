/**
 * @module calls
 * Voice and video calls between the people in a space.
 *
 * Nothing here is new to the protocol. A call is live messages
 * (`node.spaces.send`) in the space it belongs to, and a WebRTC connection of
 * its own between each pair of people in it — the shape Matrix gives group
 * calls (MSC3401, Element Call's full mesh):
 *
 * ```
 * call.here     { call, since, camera, muted }   to the space, every few seconds while in it
 * call.ring     { call }                         to one account: ring its devices
 * call.answered { call } / call.declined         to the caller, and to your own other devices
 * call.cancel   { call }                         the caller gave up ringing
 * call.signal   { call, description | candidate } to one device: setting up the connection
 * call.leave    { call }                         to the space: gone now, not in 15 seconds
 * ```
 *
 * The setup travels over the space's own peer connection, whose handshake
 * proved who is at the other end — so the offer, and the fingerprint of the
 * key the browser will insist on, really come from that person. A relay only
 * ever introduced the two devices; it never sees a call.
 *
 * Only members of the space (anyone holding a role) are rung by, heard in or
 * connected to a call; a view-only reader of a public space is not.
 *
 * A call belongs to the space, not to a screen: it keeps the space open
 * (`spaces.hold`) for as long as it runs, so moving between spaces
 * never interrupts it. One call at a time.
 *
 * Each connection is made with an audio and a video transceiver from the
 * start. Turning the camera on or off, or sharing the screen, swaps the track
 * a sender carries and never renegotiates — so neither side can offer at the
 * same moment as the other, and the side with the lower session DID always
 * makes the offer.
 */
import type { P2PNode, NodeEvent } from '../node/types.js';
import { call as callSchema } from '../schemas/index.js';

export interface CallsOptions {
  /** How a WebRTC connection is made. `new RTCPeerConnection` by default. */
  readonly createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  /** Camera and microphone. `navigator.mediaDevices.getUserMedia` by default. */
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** The screen, for sharing it. `navigator.mediaDevices.getDisplayMedia` by default. */
  readonly getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  /** How a set of tracks becomes something a `<video>` can show. `new MediaStream` by default. */
  readonly createStream?: (tracks: ReadonlyArray<MediaStreamTrack>) => MediaStream | null;
  /** Where the call you're in is remembered, to offer rejoining after a reload. `sessionStorage` by default; null for nowhere. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** How often you say you're in a call. Default 5 s. */
  readonly heartbeatMs?: number;
  /** How long without hearing that someone is gone. Default 15 s. */
  readonly goneMs?: number;
  /** How long a ring rings before it's a missed call. Default 45 s. */
  readonly ringMs?: number;
}

/** Someone else in the call you're in: one device of theirs */
export interface CallPeer {
  /** Their device's session DID */
  readonly peer: string;
  /** Their account */
  readonly account: string;
  /** What they send: sound, and video when their camera is on. Null until it arrives. */
  readonly stream: MediaStream | null;
  readonly muted: boolean;
  readonly camera: boolean;
  readonly connection: 'connecting' | 'connected' | 'failed';
}

/** The call you're in */
export interface CurrentCall {
  readonly id: string;
  readonly space: string;
  /** When you joined it, ms */
  readonly joinedAt: number;
  /** Your own camera and microphone, for showing yourself */
  readonly local: MediaStream | null;
  readonly muted: boolean;
  readonly camera: boolean;
  readonly sharing: boolean;
  readonly people: ReadonlyArray<CallPeer>;
  /** Who you're ringing, while it rings — and what came of it, for a moment after */
  readonly outgoing: { readonly to: string; readonly since: number; readonly state: 'ringing' | 'declined' | 'missed' } | null;
  /** Something went wrong that you should hear about: no microphone, say */
  readonly problem: string | null;
}

/** Someone ringing you */
export interface IncomingCall {
  readonly id: string;
  readonly space: string;
  /** The caller's account */
  readonly from: string;
  readonly since: number;
}

/** A call going on in a space you have open, that you're not in */
export interface CallAround {
  readonly id: string;
  readonly space: string;
  /** Accounts in it, each once */
  readonly people: ReadonlyArray<string>;
  /** When the first of them joined, ms */
  readonly since: number;
}

export interface CallsState {
  readonly current: CurrentCall | null;
  readonly ringing: ReadonlyArray<IncomingCall>;
  readonly around: ReadonlyArray<CallAround>;
  /** The call you were in before this page loaded, while it's still going on */
  readonly rejoin: CallAround | null;
}

export interface CallOptions {
  /** Start with the camera on. Default false: sound only. */
  readonly video?: boolean;
}

export interface Calls {
  /** What's going on now. The same object until something changes. */
  getState(): CallsState;
  subscribe(listener: () => void): () => void;
  /** Joins the call going on in a space, or starts one. Leaves any other call first. */
  start(space: string, options?: CallOptions & { readonly call?: string }): Promise<void>;
  /** Starts a call in a space, and rings one person there — all their devices, until one answers */
  ring(space: string, account: string, options?: CallOptions): Promise<void>;
  answer(id: string, options?: CallOptions): Promise<void>;
  decline(id: string): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): void;
  setCamera(on: boolean): Promise<void>;
  /** Shows your screen in place of your camera, until you stop it (or the browser does) */
  shareScreen(): Promise<void>;
  stopSharing(): Promise<void>;
  /** Stops offering `rejoin` */
  forgetRejoin(): void;
  /** Leaves any call and stops listening */
  close(): Promise<void>;
}

type CallMessage =
  | { type: 'call.here'; call: string; since?: unknown; camera?: unknown; muted?: unknown }
  | { type: 'call.ring' | 'call.answered' | 'call.declined' | 'call.cancel' | 'call.leave'; call: string }
  | { type: 'call.signal'; call: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

const CALL_TYPES = new Set(['call.here', 'call.ring', 'call.answered', 'call.declined', 'call.cancel', 'call.signal', 'call.leave']);
/** Rings one account may make you hear in a minute */
const RINGS_PER_MINUTE = 3;
const REJOIN_KEY = 'weave-call';
/** How long "declined" or "missed" shows before a call with nobody else in it ends */
const GIVE_UP_MS = 2500;
/** How long a space stays open after leaving its call, for the goodbye to get out */
const LEAVE_LINGER_MS = 1000;
/** How long a member list is trusted before asking the space again */
const MEMBERS_MS = 10_000;

function isCallMessage(value: unknown): value is CallMessage {
  const message = value as { type?: unknown; call?: unknown } | null;
  return (
    typeof message?.type === 'string' &&
    CALL_TYPES.has(message.type) &&
    typeof message.call === 'string' &&
    message.call.length > 0 &&
    message.call.length <= 64
  );
}

const randomId = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

interface Link {
  readonly peer: string;
  readonly account: string;
  readonly pc: RTCPeerConnection;
  readonly offerer: boolean;
  tracks: MediaStreamTrack[];
  stream: MediaStream | null;
  state: CallPeer['connection'];
  /** Candidates that arrived before the other side's description */
  pending: RTCIceCandidateInit[];
  described: boolean;
}

interface Presence {
  readonly account: string;
  readonly since: number;
  lastSeen: number;
  camera: boolean;
  muted: boolean;
}

interface Active {
  id: string;
  readonly space: string;
  readonly joinedAt: number;
  /** Lets go of the space, once the call is over */
  readonly release: () => Promise<void>;
  /** When the first person in it joined, as far as anyone said */
  startedAt: number;
  audio: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  muted: boolean;
  local: MediaStream | null;
  readonly links: Map<string, Link>;
  /** Everyone who was in the call while you were, for its history */
  readonly seen: Set<string>;
  outgoing: CurrentCall['outgoing'];
  problem: string | null;
  ice: ReadonlyArray<RTCIceServer>;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  heartbeat: ReturnType<typeof setInterval> | null;
}

export function createCalls(node: P2PNode, options: CallsOptions = {}): Calls {
  const heartbeatMs = options.heartbeatMs ?? 5000;
  const goneMs = options.goneMs ?? 15_000;
  const ringMs = options.ringMs ?? 45_000;
  const createConnection = options.createConnection ?? ((config: RTCConfiguration) => new RTCPeerConnection(config));
  const getUserMedia = options.getUserMedia ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
  const getDisplayMedia = options.getDisplayMedia ?? ((constraints: DisplayMediaStreamOptions) => navigator.mediaDevices.getDisplayMedia(constraints));
  const createStream =
    options.createStream ??
    ((tracks: ReadonlyArray<MediaStreamTrack>) => (typeof MediaStream === 'function' ? new MediaStream([...tracks]) : null));
  const storage = options.storage === undefined ? safeSessionStorage() : options.storage;

  const listeners = new Set<() => void>();
  /** Who is in which call, by space, call and device */
  const around = new Map<string, Map<string, Map<string, Presence>>>();
  const ringing = new Map<string, IncomingCall & { readonly peer: string; readonly timer: ReturnType<typeof setTimeout> }>();
  const ringsFrom = new Map<string, number[]>();
  const members = new Map<string, { readonly at: number; readonly dids: Promise<ReadonlySet<string>> }>();
  let active: Active | null = null;
  /** A start under way, so a second one waits for it rather than racing it */
  let starting: Promise<void> | null = null;
  let state: CallsState | null = null;
  let closed = false;

  let remembered = readRejoin();
  /** The space of the call from before a reload, held while it might still be going on — to hear it, and offer rejoining */
  let rejoinHold: Promise<(() => Promise<void>) | null> | null = null;
  if (remembered) {
    rejoinHold = node.spaces.hold(remembered.space).catch(() => null);
    const check = () => {
      if (!rejoinHold || !remembered) return;
      if (inCall(remembered.space, remembered.call)?.size) later(check, goneMs);
      else forgetRejoin();
    };
    later(check, goneMs * 2);
  }

  const changed = () => {
    state = null;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's problem is its own.
      }
    }
  };

  function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  /** Stops offering to rejoin the call from before the reload */
  function forgetRejoin() {
    const was = remembered;
    remembered = null;
    void rejoinHold?.then((release) => release?.());
    rejoinHold = null;
    if (was) changed();
  }

  const send = (space: string, message: CallMessage, to?: string) => node.spaces.send(space, message, to).catch(() => {});

  // ─── Who may take part ─────────────────────────────────────────────

  /** Whether an account holds a role in the space — a view-only reader holds none */
  async function isMember(space: string, account: string | null): Promise<boolean> {
    if (!account) return false;
    let known = members.get(space);
    if (!known || Date.now() - known.at > MEMBERS_MS) {
      known = { at: Date.now(), dids: node.spaces.access(space).then((access) => new Set(access.members.map((m) => m.did))) };
      members.set(space, known);
    }
    try {
      const dids = await known.dids;
      if (dids.has(account)) return true;
      // Someone who joined a moment ago: ask again, once.
      if (Date.now() - known.at < 1000) return false;
      members.delete(space);
      return (await node.spaces.access(space)).members.some((m) => m.did === account);
    } catch {
      return false;
    }
  }

  function withinRingAllowance(account: string): boolean {
    const now = Date.now();
    const recent = (ringsFrom.get(account) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= RINGS_PER_MINUTE) return false;
    recent.push(now);
    ringsFrom.set(account, recent);
    return true;
  }

  // ─── Calls going on ────────────────────────────────────────────────

  const inCall = (space: string, call: string) => around.get(space)?.get(call);

  function notePresence(space: string, call: string, peer: string, account: string, message: { since?: unknown; camera?: unknown; muted?: unknown }): boolean {
    const calls = around.get(space) ?? around.set(space, new Map()).get(space)!;
    // A device is in one call at a time.
    for (const [id, peers] of calls) if (id !== call && peers.delete(peer) && peers.size === 0) calls.delete(id);
    const peers = calls.get(call) ?? calls.set(call, new Map()).get(call)!;
    const known = peers.get(peer);
    const since = typeof message.since === 'number' && Number.isFinite(message.since) ? Math.min(message.since, Date.now()) : Date.now();
    peers.set(peer, {
      account,
      since: known?.since ?? since,
      lastSeen: Date.now(),
      camera: message.camera === true,
      muted: message.muted === true,
    });
    return !known;
  }

  function forget(space: string, call: string, peer: string) {
    const calls = around.get(space);
    const peers = calls?.get(call);
    if (!peers?.delete(peer)) return;
    if (peers.size === 0) calls!.delete(call);
    if (calls!.size === 0) around.delete(space);
  }

  /** Drops whoever has gone quiet, and the connections to them */
  function sweep() {
    const now = Date.now();
    let dropped = false;
    for (const [space, calls] of around) {
      for (const [call, peers] of calls) {
        for (const [peer, presence] of peers) {
          if (now - presence.lastSeen <= goneMs) continue;
          forget(space, call, peer);
          if (active?.space === space && active.id === call) closeLink(peer);
          dropped = true;
        }
      }
    }
    if (dropped) changed();
  }
  const sweeper = setInterval(sweep, Math.max(250, Math.min(heartbeatMs, goneMs / 3)));
  (sweeper as { unref?: () => void }).unref?.();

  // ─── Connections ───────────────────────────────────────────────────

  const videoTrack = (call: Active) => call.screen ?? call.camera;

  function localStream(call: Active): MediaStream | null {
    const tracks = [call.audio, videoTrack(call)].filter((t): t is MediaStreamTrack => t !== null);
    return tracks.length > 0 ? createStream(tracks) : null;
  }

  function hereMessage(call: Active): CallMessage {
    return { type: 'call.here', call: call.id, since: call.joinedAt, camera: videoTrack(call) !== null, muted: call.muted };
  }

  function linkFor(call: Active, peer: string, account: string, offerer: boolean): Link {
    closeLink(peer);
    const pc = createConnection({ iceServers: [...call.ice] });
    const link: Link = { peer, account, pc, offerer, tracks: [], stream: null, state: 'connecting', pending: [], described: false };
    call.links.set(peer, link);
    call.seen.add(account);

    pc.onicecandidate = (event) => {
      if (event.candidate && active === call) void send(call.space, { type: 'call.signal', call: call.id, candidate: event.candidate.toJSON() }, peer);
    };
    pc.ontrack = (event) => {
      if (call.links.get(peer) !== link) return;
      if (!link.tracks.includes(event.track)) link.tracks = [...link.tracks, event.track];
      link.stream = createStream(link.tracks);
      changed();
    };
    pc.onconnectionstatechange = () => {
      if (call.links.get(peer) !== link) return;
      const now = pc.connectionState;
      const next = now === 'connected' ? 'connected' : now === 'failed' || now === 'closed' ? 'failed' : link.state;
      if (next === link.state) return;
      link.state = next;
      changed();
      // The side that offers tries again, while the other is still in the call.
      if (next === 'failed' && link.offerer) {
        call.timers.add(
          later(() => {
            if (active === call && call.links.get(peer) === link && inCall(call.space, call.id)?.has(peer)) void offer(call, peer, account);
          }, 2000),
        );
      }
    };
    return link;
  }

  function closeLink(peer: string) {
    const link = active?.links.get(peer);
    if (!link) return;
    active!.links.delete(peer);
    try {
      link.pc.close();
    } catch {
      // Already closed.
    }
  }

  async function offer(call: Active, peer: string, account: string): Promise<void> {
    const link = linkFor(call, peer, account, true);
    try {
      link.pc.addTransceiver(call.audio ?? 'audio', { direction: 'sendrecv' });
      link.pc.addTransceiver(videoTrack(call) ?? 'video', { direction: 'sendrecv' });
      const description = await link.pc.createOffer();
      await link.pc.setLocalDescription(description);
      if (active !== call || call.links.get(peer) !== link) return;
      await send(call.space, { type: 'call.signal', call: call.id, description: { type: description.type, sdp: description.sdp ?? '' } }, peer);
    } catch {
      link.state = 'failed';
      changed();
    }
  }

  async function onSignal(call: Active, peer: string, account: string, message: Extract<CallMessage, { type: 'call.signal' }>): Promise<void> {
    const { description, candidate } = message;
    if (description && typeof description === 'object') {
      if (description.type === 'offer') {
        // Only the lower DID offers; an offer the other way round is someone not following that.
        if (!(peer < node.sessionDid)) return;
        const link = linkFor(call, peer, account, false);
        try {
          await link.pc.setRemoteDescription({ type: 'offer', sdp: String(description.sdp ?? '') });
          link.described = true;
          for (const transceiver of link.pc.getTransceivers()) {
            const kind = transceiver.receiver.track?.kind;
            if (kind !== 'audio' && kind !== 'video') continue;
            transceiver.direction = 'sendrecv';
            await transceiver.sender.replaceTrack(kind === 'audio' ? call.audio : videoTrack(call));
          }
          const answer = await link.pc.createAnswer();
          await link.pc.setLocalDescription(answer);
          if (active !== call || call.links.get(peer) !== link) return;
          await send(call.space, { type: 'call.signal', call: call.id, description: { type: answer.type, sdp: answer.sdp ?? '' } }, peer);
          await flush(link);
        } catch {
          link.state = 'failed';
          changed();
        }
      } else if (description.type === 'answer') {
        const link = call.links.get(peer);
        if (!link?.offerer || link.described) return;
        try {
          await link.pc.setRemoteDescription({ type: 'answer', sdp: String(description.sdp ?? '') });
          link.described = true;
          await flush(link);
        } catch {
          link.state = 'failed';
          changed();
        }
      }
    } else if (candidate && typeof candidate === 'object') {
      const link = call.links.get(peer);
      if (!link) return;
      if (!link.described) {
        if (link.pending.length < 64) link.pending.push(candidate);
        return;
      }
      await link.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async function flush(link: Link) {
    const pending = link.pending.splice(0);
    for (const candidate of pending) await link.pc.addIceCandidate(candidate).catch(() => {});
  }

  /** Puts a new video track (camera, screen or none) on every connection */
  async function sendVideo(call: Active) {
    const track = videoTrack(call);
    await Promise.all(
      [...call.links.values()].flatMap((link) =>
        link.pc
          .getTransceivers()
          .filter((t) => (t.sender.track?.kind ?? t.receiver.track?.kind) === 'video')
          .map((t) => t.sender.replaceTrack(track).catch(() => {})),
      ),
    );
    call.local = localStream(call);
    void send(call.space, hereMessage(call));
    changed();
  }

  // ─── Messages ──────────────────────────────────────────────────────

  async function onMessage(event: Extract<NodeEvent, { type: 'message' }>): Promise<void> {
    const message = event.message;
    if (!isCallMessage(message) || !event.from) return;
    const { space, peer, from } = event;
    // An agent acting for someone can't take part in their calls.
    if (event.agent) return;

    switch (message.type) {
      case 'call.here': {
        if (!(await isMember(space, from))) return;
        const isNew = notePresence(space, message.call, peer, from, message);
        const call = active;
        if (call && call.space === space) {
          if (call.id === message.call) {
            call.seen.add(from);
            call.startedAt = Math.min(call.startedAt, inCall(space, call.id)?.get(peer)?.since ?? call.startedAt);
            // Someone just arrived: tell them we're here now, not at our next heartbeat.
            if (isNew) void send(space, hereMessage(call), peer);
            if (!call.links.has(peer) && node.sessionDid < peer) void offer(call, peer, from);
          } else if (message.call < call.id && call.links.size === 0) {
            // Two calls started at once in one space: the lower id wins, and everyone moves into it.
            call.id = message.call;
            writeRejoin(call);
            void send(space, hereMessage(call));
            if (node.sessionDid < peer) void offer(call, peer, from);
          }
        }
        changed();
        return;
      }
      case 'call.leave': {
        forget(space, message.call, peer);
        if (active?.space === space && active.id === message.call) closeLink(peer);
        for (const [id, ring] of ringing) if (id === message.call && ring.peer === peer) stopRinging(id);
        changed();
        return;
      }
      case 'call.ring': {
        if (active?.id === message.call || ringing.has(message.call)) return;
        if (!withinRingAllowance(from) || !(await isMember(space, from))) return;
        const timer = later(() => stopRinging(message.call), ringMs);
        ringing.set(message.call, { id: message.call, space, from, peer, since: Date.now(), timer });
        changed();
        return;
      }
      case 'call.cancel': {
        if (ringing.get(message.call)?.from === from) stopRinging(message.call);
        return;
      }
      case 'call.answered':
      case 'call.declined': {
        // Your own other device answered or declined: stop ringing here too.
        if (from === node.did) {
          stopRinging(message.call);
          return;
        }
        const call = active;
        if (!call || call.id !== message.call || call.outgoing?.to !== from || call.outgoing.state !== 'ringing') return;
        if (message.type === 'call.answered') {
          call.outgoing = null;
        } else {
          call.outgoing = { ...call.outgoing, state: 'declined' };
          giveUpIfAlone(call);
        }
        changed();
        return;
      }
      case 'call.signal': {
        const call = active;
        if (!call || call.space !== space || call.id !== message.call) return;
        if (!(await isMember(space, from))) return;
        await onSignal(call, peer, from, message);
        return;
      }
    }
  }

  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'message') void onMessage(event);
  });

  function stopRinging(id: string) {
    const ring = ringing.get(id);
    if (!ring) return;
    clearTimeout(ring.timer);
    ringing.delete(id);
    changed();
  }

  /** Ends a call nobody else joined, a moment after the ringing came to nothing */
  function giveUpIfAlone(call: Active) {
    call.timers.add(
      later(() => {
        if (active === call && call.links.size === 0 && (inCall(call.space, call.id)?.size ?? 0) === 0) void leave();
      }, GIVE_UP_MS),
    );
  }

  // ─── History ───────────────────────────────────────────────────────

  async function remember(space: string, body: Record<string, unknown>) {
    try {
      const defined = (await node.collections.list(space)).some((c) => c.name === callSchema.name && c.version !== null);
      if (defined) await node.records.put(space, callSchema.name, body);
    } catch {
      // History is a nicety; a space that won't take it still had the call.
    }
  }

  // ─── Rejoining after a reload ──────────────────────────────────────

  function readRejoin(): { space: string; call: string } | null {
    try {
      const saved = JSON.parse(storage?.getItem(REJOIN_KEY) ?? 'null') as { space?: unknown; call?: unknown } | null;
      return typeof saved?.space === 'string' && typeof saved.call === 'string' ? { space: saved.space, call: saved.call } : null;
    } catch {
      return null;
    }
  }

  function writeRejoin(call: Active | null) {
    try {
      if (call) storage?.setItem(REJOIN_KEY, JSON.stringify({ space: call.space, call: call.id }));
      else storage?.removeItem(REJOIN_KEY);
    } catch {
      // Private mode, or storage turned off: no rejoining, nothing else lost.
    }
  }

  // ─── Joining and leaving ───────────────────────────────────────────

  async function media(video: boolean): Promise<{ stream: MediaStream | null; problem: string | null }> {
    try {
      return { stream: await getUserMedia({ audio: true, video }), problem: null };
    } catch {
      if (video) {
        try {
          return { stream: await getUserMedia({ audio: true, video: false }), problem: 'The camera isn’t available, so you joined with sound only.' };
        } catch {
          // Neither: fall through.
        }
      }
      return { stream: null, problem: 'The microphone isn’t available, so others can’t hear you.' };
    }
  }

  async function start(space: string, opts: CallOptions & { readonly call?: string } = {}): Promise<void> {
    if (closed) throw new Error('Calls have been closed');
    while (starting) await starting.catch(() => {});
    if (active && active.space === space && (!opts.call || opts.call === active.id)) return;
    starting = (async () => {
      if (active) await leave();
      const release = await node.spaces.hold(space);
      try {
        const { stream, problem } = await media(opts.video === true);
        const going = [...(around.get(space) ?? new Map<string, Map<string, Presence>>())].sort(([a], [b]) => (a < b ? -1 : 1))[0]?.[0];
        const call: Active = {
          id: opts.call ?? going ?? randomId(),
          space,
          joinedAt: Date.now(),
          release,
          startedAt: Date.now(),
          audio: stream?.getAudioTracks()[0] ?? null,
          camera: stream?.getVideoTracks()[0] ?? null,
          screen: null,
          muted: false,
          local: null,
          links: new Map(),
          seen: new Set([node.did]),
          outgoing: null,
          problem,
          ice: await node.iceServers().catch(() => []),
          timers: new Set(),
          heartbeat: null,
        };
        call.local = localStream(call);
        if (closed) {
          for (const track of stream?.getTracks() ?? []) track.stop();
          throw new Error('Calls have been closed');
        }
        active = call;
        forgetRejoin();
        writeRejoin(call);
        call.heartbeat = setInterval(() => void send(space, hereMessage(call)), heartbeatMs);
        (call.heartbeat as { unref?: () => void }).unref?.();
        await send(space, hereMessage(call));
        for (const [peer, presence] of inCall(space, call.id) ?? []) {
          call.seen.add(presence.account);
          call.startedAt = Math.min(call.startedAt, presence.since);
          if (node.sessionDid < peer) void offer(call, peer, presence.account);
        }
        changed();
      } catch (error) {
        await release().catch(() => {});
        throw error;
      }
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  async function leave(): Promise<void> {
    const call = active;
    if (!call) return;
    active = null;
    writeRejoin(null);
    if (call.heartbeat) clearInterval(call.heartbeat);
    for (const timer of call.timers) clearTimeout(timer);
    for (const link of call.links.values()) {
      try {
        link.pc.close();
      } catch {
        // Already closed.
      }
    }
    for (const track of [call.audio, call.camera, call.screen]) track?.stop();
    changed();

    await send(call.space, { type: 'call.leave', call: call.id });
    if (call.outgoing?.state === 'ringing') {
      await send(call.space, { type: 'call.cancel', call: call.id }, call.outgoing.to);
      await remember(call.space, { status: 'missed', to: call.outgoing.to, startedAt: new Date(call.outgoing.since).toISOString() });
    }
    // The last one out writes down who was there — if anyone else ever was.
    const stillIn = inCall(call.space, call.id)?.size ?? 0;
    if (stillIn === 0 && call.seen.size > 1) {
      await remember(call.space, {
        status: 'ended',
        startedAt: new Date(call.startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        people: [...call.seen].slice(0, 64),
      });
    }
    // A moment late, so the goodbye leaves before the connection it travels on closes.
    later(() => void call.release().catch(() => {}), LEAVE_LINGER_MS);
  }

  function snapshot(): CallsState {
    const call = active;
    const current: CurrentCall | null = call && {
      id: call.id,
      space: call.space,
      joinedAt: call.joinedAt,
      local: call.local,
      muted: call.muted,
      camera: videoTrack(call) !== null,
      sharing: call.screen !== null,
      outgoing: call.outgoing,
      problem: call.problem,
      people: [...(inCall(call.space, call.id) ?? new Map<string, Presence>())]
        .map(([peer, presence]): CallPeer => {
          const link = call.links.get(peer);
          return {
            peer,
            account: presence.account,
            stream: link?.stream ?? null,
            muted: presence.muted,
            camera: presence.camera,
            connection: link?.state ?? 'connecting',
          };
        })
        .sort((a, b) => (a.peer < b.peer ? -1 : 1)),
    };
    const all: CallAround[] = [];
    for (const [space, calls] of around) {
      for (const [id, peers] of calls) {
        if (peers.size === 0) continue;
        const present = [...peers.values()];
        all.push({ id, space, people: [...new Set(present.map((p) => p.account))], since: Math.min(...present.map((p) => p.since)) });
      }
    }
    const was = remembered;
    return {
      current,
      ringing: [...ringing.values()].map(({ id, space, from, since }) => ({ id, space, from, since })),
      around: all.filter((c) => !(call && c.space === call.space && c.id === call.id)),
      rejoin: !call && was ? (all.find((c) => c.space === was.space && c.id === was.call) ?? null) : null,
    };
  }

  return Object.freeze({
    getState: () => (state ??= snapshot()),

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    start,

    async ring(space: string, account: string, opts: CallOptions = {}) {
      if (account === node.did) throw new Error('That’s you.');
      await start(space, opts);
      const call = active;
      if (!call) return;
      call.outgoing = { to: account, since: Date.now(), state: 'ringing' };
      await send(space, { type: 'call.ring', call: call.id }, account);
      call.timers.add(
        later(() => {
          if (active !== call || call.outgoing?.state !== 'ringing') return;
          const { to, since } = call.outgoing;
          call.outgoing = { to, since, state: 'missed' };
          void send(space, { type: 'call.cancel', call: call.id }, to);
          void remember(space, { status: 'missed', to, startedAt: new Date(since).toISOString() });
          giveUpIfAlone(call);
          changed();
        }, ringMs),
      );
      changed();
    },

    async answer(id: string, opts: CallOptions = {}) {
      const ring = ringing.get(id);
      if (!ring) throw new Error('That call isn’t ringing any more.');
      stopRinging(id);
      await start(ring.space, { ...opts, call: id });
      await send(ring.space, { type: 'call.answered', call: id }, ring.from);
      await send(ring.space, { type: 'call.answered', call: id }, node.did);
    },

    async decline(id: string) {
      const ring = ringing.get(id);
      if (!ring) return;
      stopRinging(id);
      await send(ring.space, { type: 'call.declined', call: id }, ring.from);
      await send(ring.space, { type: 'call.declined', call: id }, node.did);
    },

    leave,
    forgetRejoin,

    setMuted(muted: boolean) {
      const call = active;
      if (!call) return;
      call.muted = muted;
      if (call.audio) call.audio.enabled = !muted;
      void send(call.space, hereMessage(call));
      changed();
    },

    async setCamera(on: boolean) {
      const call = active;
      if (!call || on === (call.camera !== null)) return;
      if (on) {
        let track: MediaStreamTrack | undefined;
        try {
          track = (await getUserMedia({ video: true })).getVideoTracks()[0];
        } catch {
          track = undefined;
        }
        if (active !== call) {
          track?.stop();
          return;
        }
        if (!track) {
          call.problem = 'The camera isn’t available.';
          changed();
          return;
        }
        call.camera = track;
      } else {
        call.camera?.stop();
        call.camera = null;
      }
      await sendVideo(call);
    },

    async shareScreen() {
      const call = active;
      if (!call || call.screen) return;
      const track = (await getDisplayMedia({ video: true, audio: false })).getVideoTracks()[0];
      if (!track) return;
      if (active !== call) {
        track.stop();
        return;
      }
      call.screen = track;
      // The browser's own "Stop sharing" button ends the track.
      track.addEventListener?.('ended', () => {
        if (active === call && call.screen === track) {
          call.screen = null;
          void sendVideo(call);
        }
      });
      await sendVideo(call);
    },

    async stopSharing() {
      const call = active;
      if (!call?.screen) return;
      call.screen.stop();
      call.screen = null;
      await sendVideo(call);
    },

    async close() {
      if (closed) return;
      closed = true;
      await leave();
      clearInterval(sweeper);
      for (const ring of ringing.values()) clearTimeout(ring.timer);
      ringing.clear();
      forgetRejoin();
      unsubscribe();
      listeners.clear();
    },
  });
}

function safeSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
