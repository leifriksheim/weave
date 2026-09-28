/**
 * Signaling client reconnects: a relay that goes away for a while is found
 * again, however long it was gone, and until the client is let go of.
 *
 * A fake WebSocket stands in for the relay, and the clock is mocked, so a
 * minute of backoff takes no time.
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createSignalingClient, type RelayStatus, type SignalingClient } from '../src/network/signaling.js';
import { createMesh } from '../src/network/mesh.js';
import type { PeerTransportEvents, SignalledTransport } from '../src/network/transport.js';
import { createEmitter } from '../src/utils/events.js';

/** Whether the pretend relay answers */
let relayUp = true;
/** What the pretend relay closes a newly opened socket with, if anything */
let refuseWith: number | null = null;
let sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];

  readonly url: string;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => {
      if (!relayUp) {
        this.readyState = 3;
        this.onerror?.();
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      this.readyState = 1;
      this.onopen?.();
      if (refuseWith !== null) this.drop(refuseWith);
    });
  }

  send = (data: string) => void this.sent.push(data);

  close = () => this.drop(1000);

  /** The relay, or the network, ends it. */
  drop(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

const global: { WebSocket?: unknown } = globalThis;
const realWebSocket = global.WebSocket;
let client: SignalingClient;

/** Lets queued socket events run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Moves the mocked clock on, a second at a time, letting sockets open and close as it goes. */
async function pass(ms: number): Promise<void> {
  for (let gone = 0; gone < ms; gone += 1000) {
    mock.timers.tick(1000);
    await settle();
  }
}

const opened = () => sockets.filter((socket) => socket.readyState === 1);

describe('signaling reconnects', () => {
  beforeEach(() => {
    relayUp = true;
    refuseWith = null;
    sockets = [];
    global.WebSocket = FakeWebSocket;
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    client = createSignalingClient('ws://relay.example', 'did:key:zMe');
  });

  afterEach(() => {
    client.disconnect();
    mock.timers.reset();
    global.WebSocket = realWebSocket;
  });

  test('comes back after a relay is gone for minutes, not five tries', async () => {
    await client.connect();
    client.join('room-a');
    assert.equal(client.status().state, 'open');

    relayUp = false;
    sockets.at(-1)!.drop();
    await settle();
    assert.equal(client.status().state, 'waiting');

    // Ten minutes of the relay being unreachable: far more than five attempts.
    await pass(10 * 60_000);
    assert.ok(sockets.length > 10, `tried ${sockets.length - 1} times`);
    assert.equal(client.status().state, 'waiting');
    assert.ok(client.status().failures > 5);

    relayUp = true;
    await pass(35_000);
    assert.equal(client.status().state, 'open');
    assert.equal(client.status().failures, 0);
    // And the room is joined again on the new socket.
    const joins = opened()[0]!.sent.map((message): unknown => JSON.parse(message));
    assert.deepEqual(joins, [{ type: 'join', room: 'room-a', from: 'did:key:zMe' }]);
  });

  test('never waits more than about 30 seconds between tries', async () => {
    await client.connect();
    relayUp = false;
    sockets.at(-1)!.drop();
    await settle();
    await pass(5 * 60_000);
    const status = client.status();
    assert.ok(status.retryAt !== null && status.retryAt - Date.now() <= 36_000);
  });

  test('reconnects after a disconnect and a fresh connect', async () => {
    // The mesh lets go when its last room closes, and connects again for the next.
    await client.connect();
    client.disconnect();
    assert.equal(client.status().state, 'stopped');

    await client.connect();
    sockets.at(-1)!.drop();
    await settle();
    assert.equal(client.status().state, 'waiting');
    await pass(5_000);
    assert.equal(client.status().state, 'open');
  });

  test('stops trying once let go of', async () => {
    await client.connect();
    relayUp = false;
    sockets.at(-1)!.drop();
    await settle();
    client.disconnect();
    const tried = sockets.length;
    await pass(5 * 60_000);
    assert.equal(sockets.length, tried);
    assert.equal(client.status().state, 'stopped');
  });

  test('a late close from a replaced socket leaves the new one alone', async () => {
    await client.connect();
    const old = sockets.at(-1)!;
    const onclose = old.onclose;
    old.drop();
    await settle();
    await pass(3_000);
    assert.equal(client.status().state, 'open');
    // The old socket's handler, called again, is ignored.
    onclose?.({ code: 1006, reason: '' });
    assert.equal(client.status().state, 'open');
  });

  test('reconnect() tries at once instead of waiting', async () => {
    await client.connect();
    relayUp = false;
    sockets.at(-1)!.drop();
    await settle();
    await pass(2 * 60_000);
    relayUp = true;
    client.reconnect();
    await settle();
    assert.equal(client.status().state, 'open');
  });

  test('says why when the relay still holds an earlier socket', async () => {
    await client.connect();
    const seen: RelayStatus[] = [];
    client.on('status', (status) => seen.push(status));
    refuseWith = 4009;
    sockets.at(-1)!.drop();
    await pass(3_000);
    const refused = seen.find((status) => status.closeCode === 4009);
    assert.ok(refused?.problem?.includes('another tab'), 'the refusal is explained');
    // And the next try waits for the relay to let the old one go.
    const status = client.status();
    assert.equal(status.state, 'waiting');
    assert.ok(status.retryAt !== null && status.retryAt - Date.now() >= 5_000);

    refuseWith = null;
    await pass(15_000);
    assert.equal(client.status().state, 'open');
  });
});

/**
 * A transport whose offers are never answered: the connection neither opens
 * nor fails, the way a WebRTC connection sits when the other side never heard.
 */
function silentTransport() {
  const offers: string[] = [];
  const closed: string[] = [];
  const events = createEmitter<PeerTransportEvents>();
  const transport: SignalledTransport = {
    createOffer: (peer) => {
      offers.push(peer);
      return Promise.resolve({ type: 'offer', sdp: 'v=0' });
    },
    handleOffer: () => Promise.resolve({ type: 'answer', sdp: 'v=0' }),
    handleAnswer: () => Promise.resolve(),
    addIceCandidate: () => Promise.resolve(),
    send: () => {},
    close: (peer) => void closed.push(peer),
    closeAll: () => {},
    on: events.on,
    off: events.off,
  };
  return { transport, offers, closed, events };
}

/** A relay message, as if it had arrived on the first socket */
const fromRelay = (message: object) => sockets[0]!.onmessage?.({ data: JSON.stringify(message) });

describe('the mesh offers again', () => {
  beforeEach(() => {
    relayUp = true;
    refuseWith = null;
    sockets = [];
    global.WebSocket = FakeWebSocket;
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
    global.WebSocket = realWebSocket;
  });

  const meshWith = (transport: SignalledTransport) =>
    createMesh({ did: 'did:key:zMe', relays: ['ws://relay.example'], createTransport: () => transport });

  test('when an offer is never answered, while the peer is still in the room', async () => {
    const fake = silentTransport();
    const mesh = meshWith(fake.transport);
    const room = mesh.join('room-a');
    await room.connect();

    fromRelay({ type: 'join', room: 'room-a', from: 'did:key:zThem' });
    await settle();
    assert.deepEqual(fake.offers, ['did:key:zThem']);
    assert.equal(mesh.status().connecting.length, 1);

    // Unanswered, it is given up and made again, rather than waited on for ever.
    await pass(21_000);
    assert.deepEqual(fake.closed, ['did:key:zThem']);
    assert.equal(fake.offers.length, 2);
    assert.equal(mesh.status().connecting[0]?.tries, 1);

    // Each wait is longer than the last: nothing more at 30 s, again by 41 s.
    await pass(30_000);
    assert.equal(fake.offers.length, 2);
    await pass(11_000);
    assert.equal(fake.offers.length, 3);

    // Gone from the room: the attempt runs out, and no other is made.
    fromRelay({ type: 'leave', room: 'room-a', from: 'did:key:zThem' });
    await pass(5 * 60_000);
    assert.equal(fake.offers.length, 3);
    assert.equal(mesh.status().connecting.length, 0);
    room.disconnect();
  });

  test('a connection that opens stops the clock', async () => {
    const fake = silentTransport();
    const mesh = meshWith(fake.transport);
    const room = mesh.join('room-a');
    await room.connect();
    fromRelay({ type: 'join', room: 'room-a', from: 'did:key:zThem' });
    await settle();
    fake.events.emit('connected', 'did:key:zThem');
    assert.equal(mesh.status().connecting.length, 0);
    assert.deepEqual(mesh.status().links, [{ peer: 'did:key:zThem', rooms: 0 }]);
    await pass(60_000);
    assert.equal(fake.offers.length, 1);
    room.disconnect();
  });

  test('status carries every relay, and changes are heard', async () => {
    const mesh = meshWith(silentTransport().transport);
    let heard = 0;
    const stop = mesh.subscribe(() => heard++);
    const room = mesh.join('room-a');
    await room.connect();
    assert.equal(mesh.status().relays[0]?.state, 'open');
    assert.ok(heard > 0);

    relayUp = false;
    sockets[0]!.drop();
    await settle();
    assert.equal(mesh.status().relays[0]?.state, 'waiting');
    assert.equal(room.isConnected(), false);
    stop();
    room.disconnect();
  });
});
