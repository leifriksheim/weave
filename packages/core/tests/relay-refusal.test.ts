/**
 * One DID per room (#55): a relay lets the first socket with a DID into a room
 * and closes any later one with 4009. Two nodes signing with the same key — two
 * tabs of one app, two processes of one agent — collide there. The second must
 * say it was refused, not look connected, and get in once the first stops.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocket as WsSocket, WebSocketServer } from 'ws';
import { createRelay, MAX_MESSAGE_BYTES } from '../../relay/relay.mjs';
import { createSignalingClient, CLOSE_DID_TAKEN } from '../src/network/signaling.js';
import { createNode } from '../src/node/node.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { team } from '../src/space/presets.js';
import { memoryStores } from './helpers/memory-stores.js';
import { hold } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { portOf } from './helpers/net.js';

describe('one DID per room', () => {
  const relay = createRelay({});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let server: Server;
  let url: string;

  before(async () => {
    server = createServer();
    server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${portOf(server)}`;
  });

  after(() => {
    relay.close();
    server.close();
  });

  const joinAs = async (did: string) => {
    const ws = new WsSocket(url);
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'join', from: did, room: 'room' }));
    return ws;
  };

  test('the relay closes a second socket claiming a DID in a room with 4009', async () => {
    const first = await joinAs('did:key:zSame');
    const second = await joinAs('did:key:zSame');
    const code = await new Promise<number>((resolve) => second.once('close', resolve));
    assert.equal(code, CLOSE_DID_TAKEN);
    assert.equal(first.readyState, WsSocket.OPEN, 'the first keeps its place');
    first.close();
  });

  test('a refused client says so, keeps trying, and gets in once the first leaves', async () => {
    const first = createSignalingClient(url, 'did:key:zTwin');
    const second = createSignalingClient(url, 'did:key:zTwin');
    first.join('room');
    await first.connect();
    let refused = 0;
    second.on('refused', () => refused++);
    second.join('room');
    await second.connect();
    await until(() => refused > 0, 5000, 'the refusal');
    const status = second.status();
    assert.equal(status.closeCode, CLOSE_DID_TAKEN);
    assert.equal(status.state, 'waiting');
    assert.match(status.problem ?? '', /another tab/);

    first.disconnect();
    // On its own it tries again 10 s after a refusal (signaling.test.ts, on a mocked clock); here it is asked now.
    // The relay may still hold the first socket a moment, and refuse again: in means in and staying in.
    await until(
      async () => {
        if (second.status().state === 'waiting') second.reconnect();
        if (second.status().state !== 'open') return false;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return second.status().state === 'open';
      },
      5000,
      'the second to get in and stay',
    );
    second.disconnect();
  });

  test('a node refused by every relay reports its spaces as refused, not connected', async () => {
    // Two tabs of one app: one account, one key, one store.
    const manager = createIdentityManager();
    const me = await manager.fromSeed(generateSeed());
    const signer = createLocalRootSigner(me, manager.getProvider());
    const sessionKey = await manager.getProvider().generateKeyPair();
    const stores = memoryStores();
    const start = () =>
      createNode({ signer, sessionKey, stores, watchIntervalMs: 0, network: { relays: [url] } });

    const first = await start();
    const { id: space } = await first.spaces.create({ name: 'Trip', ...team, visibility: 'private' });
    await hold(first, space);
    await until(async () => (await first.spaces.status(space)).connection === 'connected', 5000, 'first in');

    const second = await start();
    await hold(second, space);
    await until(async () => (await second.spaces.status(space)).connection === 'refused', 5000, 'refused');
    assert.equal(second.network.status().relays[0]?.closeCode, CLOSE_DID_TAKEN);

    await first.close();
    // Asked to try now, rather than at its next turn 10 s on.
    const connected = async () => (await second.spaces.status(space)).connection === 'connected';
    await until(
      async () => {
        second.network.reconnect();
        if (!(await connected())) return false;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return connected();
      },
      5000,
      'the second to take over and stay',
    );
    await second.close();
  });
});
