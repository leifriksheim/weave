/**
 * Network manager tests — the transport seam. Everything here runs in one
 * process: in-memory transports stand in for WebRTC and for a socket to a node,
 * and the real relay runs as a child process where signalling is under test.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createFakeHub } from './helpers/fake-transport.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createNetworkManager, type NetworkManager } from '../src/network/network-manager.js';
import { createMesh } from '../src/network/mesh.js';
import type { PeerTransport, PeerTransportEvents } from '../src/network/transport.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { createCryptoGate } from '../src/validation/crypto-gate.js';
import { createSyncEngine } from '../src/sync/sync-engine.js';
import type { NetworkMessage, PeerInfo } from '../src/types.js';
import { createMeshAuth } from '../src/network/peer-auth.js';
import { generateSpaceKey } from '../src/privacy/space-encryption.js';
import { deriveReadKey } from '../src/space/space-access.js';

/** Resolves when `predicate` holds, polling; fails the test after `ms`. */
async function until(predicate: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collect(manager: NetworkManager) {
  const messages: NetworkMessage[] = [];
  const connected: string[] = [];
  const disconnected: string[] = [];
  const errors: Error[] = [];
  manager.on('message', (m: NetworkMessage) => messages.push(m));
  manager.on('peer-connected', (p: PeerInfo) => connected.push(p.did));
  manager.on('peer-disconnected', (p: PeerInfo) => disconnected.push(p.did));
  manager.on('error', (e: Error) => errors.push(e));
  return { messages, connected, disconnected, errors };
}

describe('choosing a transport', () => {
  test('the mesh is WebRTC, which needs a relay', () => {
    assert.throws(() => createMesh({ did: 'did:key:zA', relays: [] }), /at least one relay/i);
    // With a relay it constructs — nothing dials until a room is joined.
    const room = createMesh({ did: 'did:key:zA', relays: ['ws://127.0.0.1:1'] }).join('r');
    assert.equal(room.isConnected(), false);
  });

  test('a transport that dials on its own needs no relay', () => {
    const hub = createFakeHub();
    const manager = createNetworkManager({ did: 'did:key:zA', createTransport: () => hub.transport('did:key:zA') });
    assert.equal(manager.isConnected(), false);
  });
});

describe('over an unsignalled transport', () => {
  test('two managers meet and exchange messages', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const a = createNetworkManager({ did: 'did:key:zA', createTransport: () => hub.transport('did:key:zA') });
    const b = createNetworkManager({ did: 'did:key:zB', createTransport: () => hub.transport('did:key:zB') });
    const seenA = collect(a);
    const seenB = collect(b);

    await a.connect();
    await b.connect();
    await until(() => seenA.connected.includes('did:key:zB') && seenB.connected.includes('did:key:zA'), 1000, 'both sides connected');

    a.send('did:key:zB', { type: 'hello', from: 'did:key:zA', payload: { n: 1 } });
    await until(() => seenB.messages.length === 1, 1000, 'message');
    assert.deepEqual(seenB.messages[0], { type: 'hello', from: 'did:key:zA', payload: { n: 1 } });
    assert.equal(a.isConnected(), true);
  });

  test('a message is attributed to the connection it arrived on, not to its claim', async () => {
    const hub = createFakeHub();
    const a = createNetworkManager({ did: 'did:key:zA', createTransport: () => hub.transport('did:key:zA') });
    const b = createNetworkManager({ did: 'did:key:zB', createTransport: () => hub.transport('did:key:zB') });
    const seenB = collect(b);
    await a.connect();
    await b.connect();
    await until(() => seenB.connected.length === 1, 1000, 'connection');

    a.send('did:key:zB', { type: 'hello', from: 'did:key:zSomebodyElse', payload: null });
    await until(() => seenB.messages.length === 1, 1000, 'message');
    assert.equal(seenB.messages[0]!.from, 'did:key:zA');
  });

  test('losing a link surfaces as peer-disconnected', async () => {
    const hub = createFakeHub();
    const a = createNetworkManager({ did: 'did:key:zA', createTransport: () => hub.transport('did:key:zA') });
    const b = createNetworkManager({ did: 'did:key:zB', createTransport: () => hub.transport('did:key:zB') });
    const seenA = collect(a);
    await a.connect();
    await b.connect();
    await until(() => seenA.connected.length === 1, 1000, 'connection');

    hub.cut('did:key:zA', 'did:key:zB');
    await until(() => seenA.disconnected.includes('did:key:zB'), 1000, 'disconnect');
    assert.deepEqual(a.getPeers(), []);
  });

  test('a transport error becomes a manager error event, not a throw', async () => {
    const errorListeners = new Set<PeerTransportEvents['error']>();
    const broken: PeerTransport = {
      send: () => {},
      close: () => {},
      closeAll: () => {},
      on: (event, callback) => {
        if (event === 'error') errorListeners.add(callback as PeerTransportEvents['error']);
      },
      off: () => {},
    };
    const manager = createNetworkManager({ did: 'did:key:zA', createTransport: () => broken });
    const seen = collect(manager);

    for (const callback of errorListeners) callback('did:key:zB', new Error('wire fell out'));
    assert.equal(seen.errors.length, 1);
    assert.match(seen.errors[0]!.message, /wire fell out/);
  });
});

describe('sync through a transport', () => {
  test('two peers converge with the network manager in the middle', async () => {
    const provider = createP256Provider();
    const signer = createSigner(provider);
    const hub = createFakeHub({ latencyMs: 1 });

    const makePeer = (did: string) => {
      const network = createNetworkManager({ did, createTransport: () => hub.transport(did) });
      const storage = createStorageProvider(createMemoryAdapter());
      const cryptoGate = createCryptoGate(provider);
      const sync = createSyncEngine({
        storageProvider: storage,
        heartbeatInterval: 60_000,
        sendToPeer: (peerId, message) => network.send(peerId, { type: 'sync', from: did, payload: message }),
        validate: async (expression) => {
          const result = await cryptoGate.validate(expression, async (did) =>
            provider.importPublicKey(didToPublicKey(did).publicKeyBytes),
          );
          return { valid: result.passed, reason: result.reason };
        },
      });
      network.on('message', (message: NetworkMessage) => {
        if (message.type === 'sync') void sync.handleMessage(message.from, message.payload);
      });
      network.on('peer-connected', (info: PeerInfo) => {
        sync.addPeer(info.did);
        sync.notifyPeers([info.did]);
      });
      return { network, storage, sync };
    };

    const a = makePeer('did:key:zA');
    const b = makePeer('did:key:zB');

    const pair = await provider.generateKeyPair();
    const author = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    for (const text of ['one', 'two', 'three']) {
      const signed = await signer.sign(createExpression({ author, collection: 'app.test.note', body: { text } }), pair.privateKey);
      await a.storage.addExpression(signed);
    }

    await a.network.connect();
    await b.network.connect();

    await until(() => hub.delivered() > 0, 1000, 'first frame');
    const rootA = await a.storage.getRootCid();
    let rootB: string | null = null;
    const deadline = Date.now() + 3000;
    while (rootB !== rootA && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rootB = await b.storage.getRootCid();
    }
    assert.equal(rootB, rootA);
    assert.equal((await b.storage.queryExpressions('app.test.note')).length, 3);

    a.sync.stop();
    b.sync.stop();
    a.network.disconnect();
    b.network.disconnect();
  });
});

describe('the mesh, through real relays', () => {
  const ports = [0, 1].map(() => 20_000 + Math.floor(Math.random() * 20_000));
  const [relay, otherRelay] = ports.map((port) => `ws://127.0.0.1:${port}`) as [string, string];
  let servers: ChildProcess[] = [];

  before(async () => {
    const script = fileURLToPath(new URL('../server/signaling-server.mjs', import.meta.url));
    servers = ports.map((port) => spawn(process.execPath, [script, String(port)], { stdio: 'ignore' }));
    for (const port of ports) {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) throw new Error('relay did not start');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });

  after(() => {
    for (const server of servers) server.kill();
  });

  const hub = createFakeHub({ latencyMs: 1 });
  /** A mesh whose connections are counted as they open */
  const mesh = (did: string, relays: string[], namespace: string, options: { authTimeoutMs?: number } = {}) => {
    const opened: string[] = [];
    const created = createMesh({
      did,
      relays,
      createTransport: () => {
        const transport = hub.signalled(did, namespace);
        transport.on('connected', (peer) => opened.push(peer));
        return transport;
      },
      ...options,
    });
    return Object.assign(created, { opened });
  };

  test('a relay connects the first pair, and a peer introduces the rest', async () => {
    // A and C are on different relays, so no relay can introduce them. B is
    // on both, and has to do it.
    const a = mesh('did:key:zA', [relay], 'intro').join('shared');
    const b = mesh('did:key:zB', [relay, otherRelay], 'intro').join('shared');
    const c = mesh('did:key:zC', [otherRelay], 'intro').join('shared');
    const seenA = collect(a);
    const seenC = collect(c);

    await b.connect();
    await a.connect();
    await c.connect();

    await until(() => seenA.connected.includes('did:key:zC'), 5000, 'A to meet C through B');
    await until(() => seenC.connected.includes('did:key:zA'), 5000, 'C to meet A through B');

    // And the introduced link carries data like any other.
    a.send('did:key:zC', { type: 'hello', from: 'did:key:zA', payload: 'via the mesh' });
    await until(() => seenC.messages.some((m) => m.payload === 'via the mesh'), 2000, 'message over introduced link');

    for (const room of [a, b, c]) room.disconnect();
  });

  test('two spaces shared by two devices use one connection', async () => {
    const [meshA, meshB] = [mesh('did:key:zA', [relay], 'shared-link'), mesh('did:key:zB', [relay], 'shared-link')];
    const [a1, a2, b1, b2] = [meshA.join('one'), meshA.join('two'), meshB.join('one'), meshB.join('two')];
    const seen = { a1: collect(a1), a2: collect(a2), b1: collect(b1), b2: collect(b2) };
    for (const room of [a1, a2, b1, b2]) await room.connect();
    await until(() => Object.values(seen).every((room) => room.connected.length === 1), 5000, 'both rooms to meet, on both sides');

    assert.deepEqual(meshA.opened, ['did:key:zB']);
    assert.deepEqual(meshB.opened, ['did:key:zA']);

    // Each room's messages stay in that room.
    a2.send('did:key:zB', { type: 'note', from: 'did:key:zA', payload: 'for two' });
    await until(() => seen.b2.messages.length === 1, 2000, 'the message in room two');
    assert.equal(seen.b1.messages.length, 0);
    for (const room of [a1, a2, b1, b2]) room.disconnect();
  });

  test('a peer is a peer only in the rooms it shares, and leaving one keeps the others', async () => {
    const [meshA, meshB] = [mesh('did:key:zA', [relay], 'leaving'), mesh('did:key:zB', [relay], 'leaving')];
    const [a1, a2, a3, b1, b2] = [meshA.join('l1'), meshA.join('l2'), meshA.join('l3'), meshB.join('l1'), meshB.join('l2')];
    const seen = { a1: collect(a1), a2: collect(a2), a3: collect(a3), b1: collect(b1) };
    for (const room of [a1, a2, a3, b1, b2]) await room.connect();
    await until(() => seen.a1.connected.length === 1 && seen.a2.connected.length === 1 && seen.b1.connected.length === 1, 5000, 'the shared rooms to meet');
    assert.deepEqual(a3.getPeers(), []);

    b2.disconnect();
    await until(() => seen.a2.disconnected.includes('did:key:zB'), 2000, 'B to leave room two');
    b1.send('did:key:zA', { type: 'note', from: 'did:key:zB', payload: 'still here' });
    await until(() => seen.a1.messages.some((m) => m.payload === 'still here'), 2000, 'room one to carry on');
    assert.deepEqual(meshA.opened, ['did:key:zB'], 'over the same connection');
    for (const room of [a1, a2, a3, b1]) room.disconnect();
  });

  test('the relay still serves the older one-room sockets, as app versions before the mesh use them', async () => {
    const open = async (did: string) => {
      const socket = new WebSocket(`${relay}?room=legacy`);
      const heard: Array<Record<string, unknown>> = [];
      socket.addEventListener('message', (event) => heard.push(JSON.parse(String(event.data))));
      await new Promise((resolve) => socket.addEventListener('open', resolve));
      socket.send(JSON.stringify({ type: 'join', from: did }));
      return { socket, heard };
    };
    const first = await open('did:key:zPast1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await open('did:key:zPast2');
    await until(() => first.heard.some((m) => m.type === 'join' && m.from === 'did:key:zPast2'), 2000, 'the join notice');

    second.socket.send(JSON.stringify({ type: 'offer', from: 'did:key:zPast2', to: 'did:key:zPast1', payload: { sdp: 'x' } }));
    await until(() => first.heard.some((m) => m.type === 'offer' && m.from === 'did:key:zPast2'), 2000, 'the offer');
    first.socket.close();
    second.socket.close();
  });

  describe('every peer proves who it is, in every room', () => {
    const provider = createP256Provider();
    const identity = async () => {
      const pair = await provider.generateKeyPair();
      return { did: publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC), key: pair.privateKey };
    };
    type Read = Parameters<typeof createMeshAuth>[2];
    /** A peer in `room`, which signs its proofs with `signWith` — its own key, unless it is lying */
    const peer = (room: string, who: { did: string; key: CryptoKey }, read: Read = null, signWith = who.key) =>
      mesh(who.did, [relay], room, { authTimeoutMs: 1000 }).join(room, createMeshAuth(room, { did: who.did, key: signWith }, read, provider));

    test('two peers who can prove their names meet and talk', async () => {
      const [alice, bob] = [await identity(), await identity()];
      const a = peer('proved', alice);
      const b = peer('proved', bob);
      const seenB = collect(b);
      await a.connect();
      await b.connect();
      await until(() => seenB.connected.includes(alice.did), 5000, 'Bob to meet Alice');
      a.send(bob.did, { type: 'hello', from: alice.did, payload: 'proved' });
      await until(() => seenB.messages.some((m) => m.payload === 'proved'), 2000, 'the message');
      a.disconnect();
      b.disconnect();
    });

    test('a peer using someone else\'s name never becomes a peer', async () => {
      const [alice, victim, impostor] = [await identity(), await identity(), await identity()];
      const a = peer('impostor', alice);
      const liar = peer('impostor', victim, null, impostor.key);
      const seenA = collect(a);
      await a.connect();
      await liar.connect();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.deepEqual(seenA.connected, []);
      a.disconnect();
      liar.disconnect();
    });

    test('in a private space, a peer without its key never becomes a peer', async () => {
      const key = await generateSpaceKey();
      const readKey = await deriveReadKey(key, provider);
      const read: Read = { key: readKey, publicDid: readKey.did };
      const stranger: Read = { key: await deriveReadKey(await generateSpaceKey(), provider), publicDid: readKey.did };
      const [alice, bob, eve] = [await identity(), await identity(), await identity()];
      const a = peer('private', alice, read);
      const b = peer('private', bob, read);
      const e = peer('private', eve, stranger);
      const seenA = collect(a);
      await a.connect();
      await e.connect();
      await b.connect();
      await until(() => seenA.connected.includes(bob.did), 5000, 'Alice to meet Bob');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.deepEqual(seenA.connected, [bob.did]);
      for (const room of [a, b, e]) room.disconnect();
    });

    test('failing to prove it in one room costs nothing in another', async () => {
      const key = await generateSpaceKey();
      const readKey = await deriveReadKey(key, provider);
      const [alice, bob] = [await identity(), await identity()];
      const [meshA, meshB] = [mesh(alice.did, [relay], 'mixed', { authTimeoutMs: 1000 }), mesh(bob.did, [relay], 'mixed', { authTimeoutMs: 1000 })];
      const open = meshA.join('open', createMeshAuth('open', alice, null, provider));
      const secret = meshA.join('secret', createMeshAuth('secret', alice, { key: readKey, publicDid: readKey.did }, provider));
      const bobOpen = meshB.join('open', createMeshAuth('open', bob, null, provider));
      const bobSecret = meshB.join('secret', createMeshAuth('secret', bob, { key: await deriveReadKey(await generateSpaceKey(), provider), publicDid: readKey.did }, provider));
      const seen = { open: collect(open), secret: collect(secret) };
      for (const room of [open, secret, bobOpen, bobSecret]) await room.connect();
      await until(() => seen.open.connected.includes(bob.did), 5000, 'the open room to meet');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.deepEqual(seen.secret.connected, []);
      bobOpen.send(alice.did, { type: 'note', from: bob.did, payload: 'still talking' });
      await until(() => seen.open.messages.some((m) => m.payload === 'still talking'), 2000, 'the open room to carry on');
      for (const room of [open, secret, bobOpen, bobSecret]) room.disconnect();
    });
  });
});
