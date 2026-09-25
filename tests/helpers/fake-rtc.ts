/**
 * A stand-in for the browser's WebRTC and camera, enough for calls to be
 * tested in one process: two fake connections pair up when an offer made by
 * one is answered by the other, and each then receives the tracks the other
 * sends.
 */
let nextId = 0;
const id = (prefix: string) => `${prefix}-${++nextId}`;

export class FakeTrack {
  readonly id = id('track');
  enabled = true;
  stopped = false;
  constructor(readonly kind: 'audio' | 'video') {}
  stop() {
    this.stopped = true;
  }
  addEventListener() {}
}

class FakeTransceiver {
  direction: RTCRtpTransceiverDirection = 'recvonly';
  readonly sender: { track: FakeTrack | null; replaceTrack(track: FakeTrack | null): Promise<void> };
  readonly receiver: { track: FakeTrack };
  constructor(kind: 'audio' | 'video', track: FakeTrack | null) {
    this.sender = {
      track,
      async replaceTrack(next) {
        this.track = next;
      },
    };
    // What arrives from the other side, once connected.
    this.receiver = { track: new FakeTrack(kind) };
  }
}

/** Offers waiting for their answer, by the token in their SDP */
const offers = new Map<string, FakeConnection>();

export class FakeConnection {
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  ontrack: ((event: { track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly transceivers: FakeTransceiver[] = [];
  partner: FakeConnection | null = null;
  candidatesAdded = 0;

  constructor(readonly config: RTCConfiguration) {}

  addTransceiver(trackOrKind: FakeTrack | 'audio' | 'video', init?: RTCRtpTransceiverInit) {
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const transceiver = new FakeTransceiver(kind, typeof trackOrKind === 'string' ? null : trackOrKind);
    transceiver.direction = init?.direction ?? 'sendrecv';
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers() {
    return this.transceivers;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const token = id('offer');
    offers.set(token, this);
    return { type: 'offer', sdp: `${token}|${this.transceivers.map((t) => t.receiver.track.kind).join(',')}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: `answer|${this.remoteToken}` };
  }

  private remoteToken = '';

  async setLocalDescription(_description: RTCSessionDescriptionInit) {
    setTimeout(() => this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: id('candidate') }) } }), 1);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    const [first, rest] = String(description.sdp).split('|');
    if (description.type === 'offer') {
      this.remoteToken = first!;
      for (const kind of (rest ?? '').split(',').filter(Boolean)) this.transceivers.push(new FakeTransceiver(kind as 'audio' | 'video', null));
      return;
    }
    // An answer: the offer it answers names who we're now connected to.
    const offerer = offers.get(rest!);
    const answerer = [...connections].find((c) => c.remoteToken === rest && c !== this);
    if (offerer !== this || !answerer) throw new Error('Answer to an unknown offer');
    offers.delete(rest!);
    this.partner = answerer;
    answerer.partner = this;
    setTimeout(() => {
      for (const side of [this, answerer]) {
        if (side.connectionState === 'closed') continue;
        side.connectionState = 'connected';
        side.onconnectionstatechange?.();
        for (const transceiver of side.transceivers) side.ontrack?.({ track: transceiver.receiver.track });
      }
    }, 1);
  }

  async addIceCandidate() {
    this.candidatesAdded += 1;
  }

  close() {
    this.connectionState = 'closed';
    connections.delete(this);
  }
}

const connections = new Set<FakeConnection>();

export function fakeConnection(config: RTCConfiguration): RTCPeerConnection {
  const connection = new FakeConnection(config);
  connections.add(connection);
  return connection as unknown as RTCPeerConnection;
}

/** A camera and microphone that always say yes, and hand out fresh tracks */
export async function fakeUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const tracks = [constraints.audio ? new FakeTrack('audio') : null, constraints.video ? new FakeTrack('video') : null].filter((t): t is FakeTrack => t !== null);
  return fakeStream(tracks as unknown as MediaStreamTrack[]);
}

export function fakeStream(tracks: ReadonlyArray<MediaStreamTrack>): MediaStream {
  const list = [...tracks];
  return {
    getTracks: () => list,
    getAudioTracks: () => list.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => list.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}
