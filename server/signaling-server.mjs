/**
 * A dumb signaling relay: one small dependency, no state worth stealing.
 *
 * Peers connect with `?room=<id>` — a hash of a space's id, so the relay
 * cannot tell which space a room is — and the relay passes join/leave notices
 * and WebRTC offers, answers and ICE candidates between members of that room.
 * It never sees expression data — that flows peer to peer over WebRTC — and it
 * cannot read a private space even if it wanted to.
 *
 * It is public, so it assumes nobody is polite: every socket gets a size cap,
 * a message budget and a heartbeat, and each IP, room and the process as a
 * whole have a ceiling. Framing is left to `ws` rather than parsed by hand.
 *
 *   node server/signaling-server.mjs [port]
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8787);

// Limits. Signaling messages are an SDP blob at most (a few KB), so these are
// generous for real peers and tight for anyone trying to fill a 256 MB VM.
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 5_000;
const MAX_CONNECTIONS_PER_IP = 32;
const MAX_ROOMS = 10_000;
const MAX_PEERS_PER_ROOM = 64;
const MAX_ROOM_LENGTH = 128;
const MAX_DID_LENGTH = 256;
/** Token bucket per socket: refills this many messages a second, up to the burst. */
const RATE_PER_SECOND = 50;
const RATE_BURST = 100;
/** A peer that misses a ping for this long is gone; its slot and DID are freed. */
const HEARTBEAT_MS = 15_000;
/** A peer that cannot keep up with what it is sent is dropped, not buffered for. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Only these are passed from one peer to another; join and leave come from us. */
const ROUTED = new Set(['offer', 'answer', 'candidate']);
const DID_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

/** A close code a client can tell apart from a network drop. */
const CLOSE_DID_TAKEN = 4009;

/** room id -> Set of clients */
const rooms = new Map();
/** ip -> number of open sockets */
const perIp = new Map();
let connections = 0;

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

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());

  const url = new URL(req.url ?? '/', 'http://relay');
  const room = url.searchParams.get('room') ?? 'default';
  const ip = clientIp(req);

  // Everything that can be refused is refused here, before a socket is opened.
  const refusal =
    room.length === 0 || room.length > MAX_ROOM_LENGTH ? [400, 'Bad room'] :
    connections >= MAX_CONNECTIONS ? [503, 'Relay full'] :
    (perIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP ? [429, 'Too many connections'] :
    !rooms.has(room) && rooms.size >= MAX_ROOMS ? [503, 'Too many rooms'] :
    (rooms.get(room)?.size ?? 0) >= MAX_PEERS_PER_ROOM ? [503, 'Room full'] :
    null;
  if (refusal) {
    socket.end(`HTTP/1.1 ${refusal[0]} ${refusal[1]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => accept(ws, room, ip));
});

/**
 * Admits one socket to its room. It is a nameless member until it sends
 * `join`, which fixes its DID for the life of the socket.
 */
function accept(ws, room, ip) {
  const client = { ws, room, ip, did: null, alive: true, tokens: RATE_BURST, refilled: Date.now() };

  connections++;
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(client);
  log(`peer joined room ${short(room)} (${rooms.get(room).size} present)`);

  ws.on('pong', () => (client.alive = true));
  ws.on('message', (data, isBinary) => {
    if (!withinBudget(client)) {
      ws.terminate(); // a flood gets no goodbye
      return;
    }
    if (!isBinary) handleMessage(client, data.toString('utf8'));
  });

  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    connections--;
    const left = (perIp.get(ip) ?? 1) - 1;
    if (left > 0) perIp.set(ip, left);
    else perIp.delete(ip);

    const peers = rooms.get(room);
    peers?.delete(client);
    if (peers?.size === 0) rooms.delete(room);
    if (client.did) {
      relay(client, { type: 'leave', from: client.did });
    }
    log(`peer left room ${short(room)}`);
  };

  // `ws` closes the socket itself on an oversized or malformed frame
  // (unmasked, bad opcode, bad UTF-8); both paths end here.
  ws.on('close', drop);
  ws.on('error', () => ws.terminate());
}

/**
 * Routes one signaling message: `join` is announced to everyone already in the
 * room, and everything else is delivered to the single peer it names.
 *
 * Only existing peers hear about a newcomer, so exactly one side creates the
 * offer and the two never collide.
 *
 * What is forwarded is rebuilt from known fields, and `from` is always the
 * DID the sender joined with — a peer cannot speak for someone else.
 */
function handleMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'join') {
    // One join per socket: a repeat would make every peer open a fresh
    // connection to us, and a changed DID would let a socket wear two names.
    if (client.did) return;
    if (!isDid(message.from)) return;

    // The first socket to claim a DID in a room keeps it. Taking it over
    // would let anyone who learns a DID receive the offers meant for it.
    // A peer that reconnects after a silent drop is refused until the
    // heartbeat reaps its old socket, and its client retries.
    if (findPeer(client.room, message.from)) {
      client.ws.close(CLOSE_DID_TAKEN, 'DID already in room');
      return;
    }

    client.did = message.from;
    relay(client, { type: 'join', from: client.did });
    return;
  }

  // Nameless sockets have nobody to speak for.
  if (!client.did) return;
  if (!ROUTED.has(message.type) || typeof message.to !== 'string') return;

  const target = findPeer(client.room, message.to);
  if (target && target !== client) {
    send(target, JSON.stringify({ type: message.type, from: client.did, to: message.to, payload: message.payload }));
  }
}

/** Sends a message to every other named peer in the sender's room. */
function relay(sender, message) {
  const payload = JSON.stringify(message);
  for (const peer of rooms.get(sender.room) ?? []) {
    if (peer !== sender && peer.did) send(peer, payload);
  }
}

function send(peer, text) {
  if (peer.ws.readyState !== peer.ws.OPEN) return;
  if (peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    peer.ws.terminate();
    return;
  }
  peer.ws.send(text);
}

function findPeer(room, did) {
  for (const peer of rooms.get(room) ?? []) {
    if (peer.did === did) return peer;
  }
  return null;
}

/** Spends one token from the socket's bucket; false once it is empty. */
function withinBudget(client) {
  const now = Date.now();
  client.tokens = Math.min(RATE_BURST, client.tokens + ((now - client.refilled) / 1000) * RATE_PER_SECOND);
  client.refilled = now;
  if (client.tokens < 1) return false;
  client.tokens -= 1;
  return true;
}

const isDid = (value) =>
  typeof value === 'string' && value.length <= MAX_DID_LENGTH && DID_PATTERN.test(value);

/**
 * Behind Fly's proxy every socket comes from the proxy, and Fly names the real
 * client in a header. Anywhere else that header is whatever the client says,
 * so it is only believed on Fly.
 */
function clientIp(req) {
  const forwarded = process.env.FLY_APP_NAME ? req.headers['fly-client-ip'] : undefined;
  return (typeof forwarded === 'string' && forwarded) || req.socket.remoteAddress || 'unknown';
}

// Heartbeat: ping everyone, and drop whoever did not answer the last ping.
// This also frees rooms and DIDs held by sockets that died without a close.
const heartbeat = setInterval(() => {
  for (const peers of rooms.values()) {
    for (const client of peers) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

const short = (room) => (room.length > 12 ? `${room.slice(0, 12)}…` : room);
const log = (message) => console.log(`[signaling] ${message}`);

server.listen(PORT, () => {
  log(`relaying on ws://localhost:${PORT} — data never touches this process`);
});
