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

const NODE_DID = 'did:key:zNode';

async function until(predicate: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A node that answers the hello and echoes every binary frame. */
function startNode(port = 0, hello: string = JSON.stringify({ type: 'hello', did: NODE_DID })) {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  const greetedBy: string[] = [];
  const sockets = new Set<ServerSocket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('message', (data, isBinary) => {
      if (!isBinary) greetedBy.push(JSON.parse(String(data)).did);
      socket.send(hello);
      socket.on('message', (frame, binary) => {
        if (binary) socket.send(frame, { binary: true });
      });
    });
  });
  const ready = new Promise<number>((resolve) => server.on('listening', () => resolve((server.address() as AddressInfo).port)));
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.terminate();
      server.close(() => resolve());
    });
  return { ready, greetedBy, stop };
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

  test('a server that does not say hello is refused', async () => {
    const node = startNode(0, 'not a hello');
    const port = await node.ready;
    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}`, did: 'did:key:zBrowser', reconnect: false });
    const seen = watch(transport);

    await assert.rejects(transport.connect!());
    assert.equal(seen.connected.length, 0);
    assert.match(seen.errors[0]!.message, /hello/);
    await node.stop();
  });
});
