/**
 * Introduction tests — the rules that let peers bring each other in, so a relay
 * is only needed for the first connection.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isControlMessage,
  shouldInitiate,
  createSeenSignals,
  signalId,
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
} from '../src/network/introductions.js';
import { createMultiSignalingClient } from '../src/network/multi-signaling.js';
import type { SignalingClient } from '../src/network/signaling.js';

describe('who opens the connection', () => {
  test('exactly one side of any pair initiates', () => {
    const peers = ['did:key:zAlice', 'did:key:zBob', 'did:key:zCarol'];

    for (const a of peers) {
      for (const b of peers) {
        if (a === b) continue;
        // Both are told about each other at the same moment. Without a rule
        // both would offer, leaving two half-open connections to unpick.
        assert.notEqual(
          shouldInitiate(a, b),
          shouldInitiate(b, a),
          `${a} and ${b} disagreed about who offers`,
        );
      }
    }
  });

  test('a peer never initiates to itself', () => {
    assert.equal(shouldInitiate('did:key:zAlice', 'did:key:zAlice'), false);
  });
});

describe('mesh housekeeping', () => {
  test('control messages are recognised and ordinary ones are not', () => {
    assert.equal(isControlMessage(PEERS_MESSAGE), true);
    assert.equal(isControlMessage(SIGNAL_MESSAGE), true);
    // Anything the application sends must reach it untouched.
    assert.equal(isControlMessage('sync'), false);
    assert.equal(isControlMessage('pair'), false);
  });

  test('a flooded signal is acted on once', () => {
    const seen = createSeenSignals();
    const id = signalId();

    assert.equal(seen.accept(id), true);
    // The same signal arriving by a second route.
    assert.equal(seen.accept(id), false);
    assert.equal(seen.accept(signalId()), true);
  });

  test('the record of seen signals stays bounded', () => {
    const seen = createSeenSignals(4);
    const ids = Array.from({ length: 4 }, signalId);
    for (const id of ids) seen.accept(id);

    // Pushing past the limit forgets the oldest — unbounded memory fed by the
    // network would be a way for a peer to take this tab down.
    seen.accept(signalId());
    assert.equal(seen.accept(ids[0]!), true, 'the oldest id should have been forgotten');
    assert.equal(seen.accept(ids[3]!), false, 'a recent id should still be remembered');
  });

  test('ids do not collide', () => {
    const ids = new Set(Array.from({ length: 500 }, signalId));
    assert.equal(ids.size, 500);
  });
});

// ─── Several relays at once ────────────────────────────────────────────

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  sent: string[];
  send(data: string): void;
  close(): void;
}

let sockets: FakeSocket[] = [];
const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

/**
 * Clients to shut down after each test.
 *
 * A closed socket schedules a reconnect with backoff, so a client left running
 * keeps timers alive and holds the test process open long after its assertions
 * have passed.
 */
let created: SignalingClient[] = [];

function makeClient(urls: ReadonlyArray<string>, did: string = 'did:key:zMe'): SignalingClient {
  const client = createMultiSignalingClient(urls, did);
  created.push(client);
  return client;
}

/** A WebSocket that opens immediately and records what it was told to send. */
function installFakeWebSocket(): void {
  sockets = [];

  function FakeWebSocketCtor(this: FakeSocket, url: string) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.sent = [];
    this.send = (data: string) => void this.sent.push(data);
    this.close = () => {
      this.readyState = 3;
      this.onclose?.();
    };

    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  (FakeWebSocketCtor as unknown as { OPEN: number }).OPEN = 1;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocketCtor;
}

/** Delivers a message as if it had arrived from a relay. */
function deliver(socket: FakeSocket, message: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(message) });
}

describe('several relays at once', () => {
  beforeEach(() => {
    created = [];
    installFakeWebSocket();
  });

  afterEach(() => {
    for (const client of created) client.disconnect();
    (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
  });

  test('connects to every relay', async () => {
    const client = makeClient(['ws://a.example', 'ws://b.example']);
    await client.connect();

    assert.deepEqual(sockets.map((socket) => socket.url), ['ws://a.example', 'ws://b.example']);
    assert.equal(client.isConnected(), true);
  });

  test('a peer on two relays is announced once', async () => {
    const client = makeClient(['ws://a.example', 'ws://b.example']);
    const joined: string[] = [];
    client.on('peer-joined', (did, room) => void joined.push(`${room} ${did}`));
    await client.connect();

    // The same person, seen through both phone books. Announcing twice would
    // have both sides opening a second connection to each other.
    deliver(sockets[0]!, { type: 'join', from: 'did:key:zAlice', room: 'r1' });
    deliver(sockets[1]!, { type: 'join', from: 'did:key:zAlice', room: 'r1' });
    // The same person in another room is news, though.
    deliver(sockets[1]!, { type: 'join', from: 'did:key:zAlice', room: 'r2' });

    assert.deepEqual(joined, ['r1 did:key:zAlice', 'r2 did:key:zAlice']);
  });

  test('a peer is only gone once every relay says so', async () => {
    const client = makeClient(['ws://a.example', 'ws://b.example']);
    const left: string[] = [];
    client.on('peer-left', (did) => void left.push(did));
    await client.connect();

    deliver(sockets[0]!, { type: 'join', from: 'did:key:zAlice', room: 'r1' });
    deliver(sockets[1]!, { type: 'join', from: 'did:key:zAlice', room: 'r1' });

    deliver(sockets[0]!, { type: 'leave', from: 'did:key:zAlice', room: 'r1' });
    assert.deepEqual(left, [], 'still reachable through the other relay');

    deliver(sockets[1]!, { type: 'leave', from: 'did:key:zAlice', room: 'r1' });
    assert.deepEqual(left, ['did:key:zAlice']);
  });

  test('replies go back through the relay the peer was seen on', async () => {
    const client = makeClient(['ws://a.example', 'ws://b.example']);
    await client.connect();

    deliver(sockets[1]!, { type: 'join', from: 'did:key:zAlice', room: 'r1' });
    client.signal('offer', 'did:key:zAlice', { type: 'offer', sdp: 'x' });

    assert.equal(sockets[0]!.sent.filter((m) => m.includes('offer')).length, 0);
    assert.equal(sockets[1]!.sent.filter((m) => m.includes('offer')).length, 1);
  });

  test('an unknown peer is shouted at on every relay', async () => {
    const client = makeClient(['ws://a.example', 'ws://b.example']);
    await client.connect();

    // An answer to an offer that arrived before this client saw them join.
    client.signal('answer', 'did:key:zStranger', { type: 'answer', sdp: 'y' });

    for (const socket of sockets) {
      assert.equal(socket.sent.filter((m) => m.includes('answer')).length, 1);
    }
  });

  test('one relay being down is survivable', async () => {
    const client = makeClient(['ws://a.example', 'ws://b.example']);
    await client.connect();

    sockets[0]!.close();

    assert.equal(client.isConnected(), true, 'the other relay is still up');
    client.signal('offer', 'did:key:zAlice', { type: 'offer', sdp: 'x' });
    assert.equal(sockets[1]!.sent.filter((m) => m.includes('offer')).length, 1);
  });

  test('rooms are joined on every relay, before or after connecting', async () => {
    const client = makeClient(['ws://a.example', 'ws://b.example']);
    client.join('r1');
    await client.connect();
    client.join('r2');
    const joins = (socket: FakeSocket) => socket.sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'join').map((m) => m.room);
    for (const socket of sockets) assert.deepEqual(joins(socket), ['r1', 'r2']);

    client.leave('r1');
    assert.ok(sockets[0]!.sent.some((m) => JSON.parse(m).type === 'leave'));
  });

  test('configuring no relay at all is refused', () => {
    assert.throws(() => makeClient([]), /at least one relay/i);
  });
});
