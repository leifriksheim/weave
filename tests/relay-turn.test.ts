/**
 * TURN passwords from the relay: one per address, so coturn's per-user quota
 * caps an address rather than each second someone asks.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createRelay, MAX_MESSAGE_BYTES } from '../server/relay.mjs';

const secret = 'test-secret';

describe('TURN passwords from the relay', () => {
  const relay = createRelay({ turn: { secret, urls: ['turn:127.0.0.1:3478'], ttlSeconds: 3600 } });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let server: Server;
  let url: string;

  before(async () => {
    server = createServer();
    server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    relay.close();
    server.close();
  });

  /** Opens a socket, joins a room as `did` and returns the first TURN offer it gets. */
  const firstOffer = async (did: string) => {
    const ws = new WebSocket(url);
    await new Promise((resolve) => ws.once('open', resolve));
    const offer = new Promise<{ servers: { username: string; credential: string }[]; expiresAt: number }>((resolve) =>
      ws.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (message.type === 'ice') resolve(message.payload);
      }),
    );
    ws.send(JSON.stringify({ type: 'join', from: did, room: 'room' }));
    return { ws, offer: await offer };
  };

  test('sockets from one address share a username, and the password checks out', async () => {
    const a = await firstOffer('did:key:zA');
    const b = await firstOffer('did:key:zB');
    const [serverA] = a.offer.servers;
    const [serverB] = b.offer.servers;
    assert.equal(serverA.username, serverB.username);

    // coturn's use-auth-secret: the part before the colon is when it expires.
    const [expiry, holder] = serverA.username.split(':');
    assert.equal(Number(expiry) * 1000, a.offer.expiresAt);
    assert.ok(holder.length > 0);
    assert.equal(serverA.credential, createHmac('sha1', secret).update(serverA.username).digest('base64'));

    // Asking again gets the same one back, not a fresh one.
    const again = new Promise<string>((resolve) =>
      a.ws.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (message.type === 'ice') resolve(message.payload.servers[0].username);
      }),
    );
    a.ws.send(JSON.stringify({ type: 'ice' }));
    assert.equal(await again, serverA.username);

    a.ws.close();
    b.ws.close();
  });
});
