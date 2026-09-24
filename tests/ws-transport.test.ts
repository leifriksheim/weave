/**
 * WebSocket transport tests, against a real socket server (`ws`, dev-only).
 * The server plays the always-on node: it says hello with its own DID and
 * echoes binary frames back.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import { createWebSocketTransport } from '../src/network/ws-transport.js';
import { createClientAuth, createServerAuth, peerNonce, type ServerAuth } from '../src/network/peer-auth.js';
import { generateSpaceKey } from '../src/privacy/space-encryption.js';
import { deriveReadKey } from '../src/space/space-access.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';

const provider = createP256Provider();

/** A node's own identity: a DID and the key it signs welcomes with */
async function nodeIdentity() {
  const pair = await provider.generateKeyPair();
  return { did: publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC), privateKey: pair.privateKey };
}

const NODE_DID = 'did:key:zNode';

async function until(predicate: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A node that runs the handshake and echoes every binary frame.
 * `authenticator` makes it demand and give proof; `welcome` overrides its reply.
 */
function startNode(
  port = 0,
  options: { authenticator?: ServerAuth; did?: string; welcome?: (hello: { nonce: string }) => Promise<string> } = {},
) {
  const did = options.did ?? NODE_DID;
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  const greetedBy: string[] = [];
  const refused: string[] = [];
  const sockets = new Set<ServerSocket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const nonce = peerNonce();
    socket.once('message', async (data, isBinary) => {
      if (isBinary) return;
      const hello = JSON.parse(String(data)) as { did: string; nonce: string; sig?: string; read?: string };
      if (options.authenticator && !(await options.authenticator.checkHello(hello.did, did, nonce, hello))) {
        refused.push(hello.did);
        socket.close(4003, 'not a reader');
        return;
      }
      greetedBy.push(hello.did);
      const sig = options.authenticator ? await options.authenticator.welcome(did, hello.nonce) : undefined;
      socket.send(options.welcome ? await options.welcome(hello) : JSON.stringify({ type: 'welcome', did, ...(sig ? { sig } : {}) }));
      socket.on('message', (frame, binary) => {
        if (binary) socket.send(frame, { binary: true });
      });
    });
    socket.send(JSON.stringify({ type: 'challenge', nonce, did }));
  });
  const ready = new Promise<number>((resolve) => server.on('listening', () => resolve((server.address() as AddressInfo).port)));
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.terminate();
      server.close(() => resolve());
    });
  return { ready, greetedBy, refused, stop };
}

function watch(transport: ReturnType<typeof createWebSocketTransport>) {
  const seen = { connected: [] as string[], disconnected: [] as string[], data: [] as Uint8Array[], errors: [] as Error[] };
  transport.on('connected', (peer) => seen.connected.push(peer));
  transport.on('disconnected', (peer) => seen.disconnected.push(peer));
  transport.on('data', (_peer, data) => seen.data.push(data));
  transport.on('error', (_peer, error) => seen.errors.push(error));
  return seen;
}

describe('WebSocket transport', () => {
  test('introduces itself, learns the node, and round-trips binary frames', async () => {
    const node = startNode();
    const port = await node.ready;
    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}`, did: 'did:key:zBrowser' });
    const seen = watch(transport);

    await transport.connect!();
    assert.deepEqual(seen.connected, [NODE_DID]);
    assert.deepEqual(node.greetedBy, ['did:key:zBrowser']);

    const frame = Uint8Array.from([0, 1, 2, 250, 255]);
    transport.send(NODE_DID, frame);
    await until(() => seen.data.length === 1, 1000, 'echo');
    assert.deepEqual(seen.data[0], frame);

    assert.throws(() => transport.send('did:key:zSomeoneElse', frame), /Not connected/);

    transport.closeAll();
    await until(() => seen.disconnected.length === 1, 1000, 'disconnect');
    await node.stop();
  });

  test('redials after the node restarts', async () => {
    const first = startNode();
    const port = await first.ready;
    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}`, did: 'did:key:zBrowser', maxBackoffMs: 200 });
    const seen = watch(transport);
    await transport.connect!();

    await first.stop();
    await until(() => seen.disconnected.length === 1, 1000, 'disconnect');

    const second = startNode(port);
    await second.ready;
    await until(() => seen.connected.length === 2, 3000, 'reconnect');
    transport.send(NODE_DID, Uint8Array.from([7]));
    await until(() => seen.data.length === 1, 1000, 'echo after reconnect');

    transport.closeAll();
    await second.stop();
  });

  test('a deliberate close is never fought by the redial', async () => {
    const node = startNode();
    const port = await node.ready;
    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}`, did: 'did:key:zBrowser', maxBackoffMs: 50 });
    const seen = watch(transport);
    await transport.connect!();

    transport.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(seen.connected.length, 1);
    assert.equal(node.greetedBy.length, 1);
    await node.stop();
  });

  test('a node that does not welcome properly is refused', async () => {
    const node = startNode(0, { welcome: async () => 'not a welcome' });
    const port = await node.ready;
    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}`, did: 'did:key:zBrowser', reconnect: false });
    const seen = watch(transport);

    await assert.rejects(transport.connect!());
    assert.equal(seen.connected.length, 0);
    assert.match(seen.errors[0]!.message, /welcome/);
    await node.stop();
  });

  describe('a public space', () => {
    test('a peer proves the DID it gives is its own', async () => {
      const me = await nodeIdentity();
      const member = await nodeIdentity();
      const node = startNode(0, { did: me.did, authenticator: createServerAuth('space-1', null, me.privateKey, provider) });
      const port = await node.ready;
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: member.did,
        reconnect: false,
        authenticator: createClientAuth('space-1', { did: member.did, key: member.privateKey }, null, provider),
      });
      await transport.connect!();
      assert.deepEqual(node.greetedBy, [member.did]);
      transport.closeAll();
      await node.stop();
    });

    test('the node refuses a peer that gives someone else\'s DID', async () => {
      const me = await nodeIdentity();
      const victim = await nodeIdentity();
      const impostor = await nodeIdentity();
      const node = startNode(0, { did: me.did, authenticator: createServerAuth('space-1', null, me.privateKey, provider) });
      const port = await node.ready;
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: victim.did,
        reconnect: false,
        // Signs with its own key while claiming the victim's name.
        authenticator: createClientAuth('space-1', { did: victim.did, key: impostor.privateKey }, null, provider),
      });
      await assert.rejects(transport.connect!());
      assert.deepEqual(node.refused, [victim.did]);
      await node.stop();
    });
  });

  describe('a private space', () => {
    /** A node for space-1 that holds only its public read key, as a blind host would */
    /** A client for space-1: its own identity, and a read key */
    async function reader(key: Awaited<ReturnType<typeof generateSpaceKey>>, spaceId = 'space-1') {
      const who = await nodeIdentity();
      return { did: who.did, auth: createClientAuth(spaceId, { did: who.did, key: who.privateKey }, await deriveReadKey(key, provider), provider) };
    }

    async function privateNode(key: Awaited<ReturnType<typeof generateSpaceKey>>, spaceId = 'space-1') {
      const me = await nodeIdentity();
      const readKey = (await deriveReadKey(key, provider)).did;
      return { me, node: startNode(0, { did: me.did, authenticator: createServerAuth(spaceId, readKey, me.privateKey, provider) }) };
    }

    test('connects when the client can read — and the node holds no secret of the space', async () => {
      const key = await generateSpaceKey();
      const { me, node } = await privateNode(key);
      const port = await node.ready;
      const member = await reader(key);
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: member.did,
        reconnect: false,
        authenticator: member.auth,
      });
      const seen = watch(transport);
      await transport.connect!();
      assert.deepEqual(seen.connected, [me.did]);
      transport.closeAll();
      await node.stop();
    });

    test('the node refuses a client without the key', async () => {
      const { node } = await privateNode(await generateSpaceKey());
      const port = await node.ready;
      const outsider = await reader(await generateSpaceKey());
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: outsider.did,
        reconnect: false,
        authenticator: outsider.auth,
      });
      await assert.rejects(transport.connect!());
      assert.deepEqual(node.refused, [outsider.did]);
      await node.stop();
    });

    test('the client refuses a welcome not signed by the node that sent the challenge', async () => {
      const key = await generateSpaceKey();
      const me = await nodeIdentity();
      const other = await nodeIdentity();
      // Signs its welcome with a key that is not the one its DID names.
      const node = startNode(0, {
        did: me.did,
        authenticator: createServerAuth('space-1', (await deriveReadKey(key, provider)).did, other.privateKey, provider),
      });
      const port = await node.ready;
      const member = await reader(key);
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: member.did,
        reconnect: false,
        authenticator: member.auth,
      });
      const seen = watch(transport);
      await assert.rejects(transport.connect!(), /could not prove/);
      assert.equal(seen.connected.length, 0);
      await node.stop();
    });

    test('the client refuses a node that answers without a proof', async () => {
      const key = await generateSpaceKey();
      const node = startNode(0);
      const port = await node.ready;
      const member = await reader(key);
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: member.did,
        reconnect: false,
        authenticator: member.auth,
      });
      await assert.rejects(transport.connect!(), /could not prove/);
      await node.stop();
    });

    test('a hello is useless for another space, or at another node', async () => {
      const key = await generateSpaceKey();
      const readKey = await deriveReadKey(key, provider);
      const a = await nodeIdentity();
      const b = await nodeIdentity();
      const x = await nodeIdentity();
      const client = createClientAuth('space-1', { did: x.did, key: x.privateKey }, readKey, provider);
      const proof = await client.hello(x.did, a.did, 'nonce');
      assert.equal(await createServerAuth('space-1', readKey.did, a.privateKey, provider).checkHello(x.did, a.did, 'nonce', proof), true);
      assert.equal(await createServerAuth('space-2', readKey.did, a.privateKey, provider).checkHello(x.did, a.did, 'nonce', proof), false);
      assert.equal(await createServerAuth('space-1', readKey.did, b.privateKey, provider).checkHello(x.did, b.did, 'nonce', proof), false);
    });
  });
});
