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
import { createPeerAuthenticator, peerNonce, type PeerAuthenticator } from '../src/network/peer-auth.js';
import { generateSpaceKey } from '../src/privacy/space-encryption.js';

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
  options: { authenticator?: PeerAuthenticator; welcome?: (hello: { nonce: string }) => Promise<string> } = {},
) {
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
      const hello = JSON.parse(String(data)) as { did: string; nonce: string; mac?: string };
      if (options.authenticator && !(await options.authenticator.verify('client', hello.did, nonce, hello.mac))) {
        refused.push(hello.did);
        socket.close(4003, 'not a member');
        return;
      }
      greetedBy.push(hello.did);
      const mac = options.authenticator ? await options.authenticator.sign('server', NODE_DID, hello.nonce) : undefined;
      socket.send(options.welcome ? await options.welcome(hello) : JSON.stringify({ type: 'welcome', did: NODE_DID, ...(mac ? { mac } : {}) }));
      socket.on('message', (frame, binary) => {
        if (binary) socket.send(frame, { binary: true });
      });
    });
    socket.send(JSON.stringify({ type: 'challenge', nonce, did: NODE_DID }));
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

  describe('a private space', () => {
    test('connects when both sides hold the key', async () => {
      const key = await generateSpaceKey();
      const node = startNode(0, { authenticator: await createPeerAuthenticator('space-1', key) });
      const port = await node.ready;
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: 'did:key:zMember',
        reconnect: false,
        authenticator: await createPeerAuthenticator('space-1', key),
      });
      const seen = watch(transport);
      await transport.connect!();
      assert.deepEqual(seen.connected, [NODE_DID]);
      transport.closeAll();
      await node.stop();
    });

    test('the node refuses a client without the key', async () => {
      const node = startNode(0, { authenticator: await createPeerAuthenticator('space-1', await generateSpaceKey()) });
      const port = await node.ready;
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: 'did:key:zOutsider',
        reconnect: false,
        authenticator: await createPeerAuthenticator('space-1', await generateSpaceKey()),
      });
      await assert.rejects(transport.connect!());
      assert.deepEqual(node.refused, ['did:key:zOutsider']);
      await node.stop();
    });

    test('the client refuses a node that cannot prove the key', async () => {
      const key = await generateSpaceKey();
      // An impostor: it lets anyone in and answers without a proof.
      const node = startNode(0);
      const port = await node.ready;
      const transport = createWebSocketTransport({
        url: `ws://127.0.0.1:${port}`,
        did: 'did:key:zMember',
        reconnect: false,
        authenticator: await createPeerAuthenticator('space-1', key),
      });
      const seen = watch(transport);
      await assert.rejects(transport.connect!(), /could not prove/);
      assert.equal(seen.connected.length, 0);
      await node.stop();
    });

    test('a proof for one space is useless in another', async () => {
      const key = await generateSpaceKey();
      const one = await createPeerAuthenticator('space-1', key);
      const two = await createPeerAuthenticator('space-2', key);
      const mac = await one.sign('client', 'did:key:zX', 'nonce');
      assert.equal(await one.verify('client', 'did:key:zX', 'nonce', mac), true);
      assert.equal(await two.verify('client', 'did:key:zX', 'nonce', mac), false);
      assert.equal(await one.verify('server', 'did:key:zX', 'nonce', mac), false);
    });
  });
});
