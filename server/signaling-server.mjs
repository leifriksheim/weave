/**
 * The relay on its own (`relay.mjs`), for running publicly: an HTTP server
 * that answers /health and hands every WebSocket upgrade to the relay.
 *
 *   node server/signaling-server.mjs [port]
 *   TURN_SECRET=… TURN_URLS=turn:host:3478 node server/signaling-server.mjs
 *
 * An always-on node (`weave serve`) runs the same relay next to its own
 * sockets, so either works as a relay for the app.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRelay, turnFromEnv, MAX_MESSAGE_BYTES } from './relay.mjs';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const log = (message) => console.log(`[signaling] ${message}`);

const relay = createRelay({ turn: turnFromEnv(process.env), log });

const server = createServer((req, res) => {
  if (req.url === '/health') {
    // Liveness only: how many rooms or peers exist is nobody's business.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('This endpoint speaks WebSocket only.\n');
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: false,
  clientTracking: false,
});

server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));

server.listen(PORT, () => {
  log(`relaying on ws://localhost:${PORT} — data never touches this process`);
});
