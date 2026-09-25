/**
 * A dumb signaling relay: one small dependency, no state worth stealing.
 *
 * A peer holds one socket and joins rooms on it — each a hash of a space's id,
 * so the relay cannot tell which space a room is — and the relay passes
 * join/leave notices and WebRTC offers, answers and ICE candidates between
 * peers that share a room. It never sees expression data — that flows peer to
 * peer over WebRTC — and it cannot read a private space even if it wanted to.
 *
 *   client → { type: 'join', from: did, room }     client → { type: 'leave', room }
 *   relay  → { type: 'join' | 'leave', from: did, room }, to the others in the room
 *   either → { type: 'offer' | 'answer' | 'candidate', to: did, payload }
 *
 * A socket opened with `?room=<id>` is the older, one-room form: its `join`
 * names no room and means that one. Both kinds meet in the same rooms.
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
const MAX_ROOMS_PER_SOCKET = 256;
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

/** room id -> Set of named clients in it */
const rooms = new Map();
/** Every open socket, named or not */
const clients = new Set();
/** ip -> number of open sockets */
const perIp = new Map();

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

  const legacyRoom = new URL(req.url ?? '/', 'http://relay').searchParams.get('room');
  const ip = clientIp(req);

  // Everything that can be refused is refused here, before a socket is opened.
  const refusal =
    legacyRoom !== null && !canEnter(legacyRoom) ? [503, 'Room full'] :
    clients.size >= MAX_CONNECTIONS ? [503, 'Relay full'] :
    (perIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP ? [429, 'Too many connections'] :
    null;
  if (refusal) {
    socket.end(`HTTP/1.1 ${refusal[0]} ${refusal[1]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => accept(ws, legacyRoom, ip));
});

/** Whether a room could take one more peer */
function canEnter(room) {
  if (typeof room !== 'string' || room.length === 0 || room.length > MAX_ROOM_LENGTH) return false;
  const peers = rooms.get(room);
  return peers ? peers.size < MAX_PEERS_PER_ROOM : rooms.size < MAX_ROOMS;
}

/**
 * Admits one socket. It is nameless until its first `join`, which fixes its
 * DID for the life of the socket.
 */
function accept(ws, legacyRoom, ip) {
  const client = { ws, legacyRoom, ip, did: null, rooms: new Set(), alive: true, tokens: RATE_BURST, refilled: Date.now() };

  clients.add(client);
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);

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
    clients.delete(client);
    const left = (perIp.get(ip) ?? 1) - 1;
    if (left > 0) perIp.set(ip, left);
    else perIp.delete(ip);
    for (const room of [...client.rooms]) leave(client, room);
  };

  // `ws` closes the socket itself on an oversized or malformed frame
  // (unmasked, bad opcode, bad UTF-8); both paths end here.
  ws.on('close', drop);
  ws.on('error', () => ws.terminate());
}

/**
 * Routes one signaling message: `join` and `leave` are announced to the others
 * in that room, and everything else is delivered to the single peer it names —
 * if it shares a room with the sender.
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
  const room = message.room ?? client.legacyRoom;

  if (message.type === 'join') {
    // A socket wears one name: a changed DID would let it wear two.
    if (client.did ? message.from !== client.did : !isDid(message.from)) return;
    if (client.rooms.has(room) || client.rooms.size >= MAX_ROOMS_PER_SOCKET || !canEnter(room)) return;

    // The first socket to claim a DID in a room keeps it. Taking it over
    // would let anyone who learns a DID receive the offers meant for it.
    // A peer that reconnects after a silent drop is refused until the
    // heartbeat reaps its old socket, and its client retries.
    if (findPeer(room, message.from)) {
      client.ws.close(CLOSE_DID_TAKEN, 'DID already in room');
      return;
    }

    client.did = message.from;
    client.rooms.add(room);
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(client);
    announce(client, room, 'join');
    log(`peer joined room ${short(room)} (${rooms.get(room).size} present)`);
    return;
  }

  if (message.type === 'leave') {
    if (client.rooms.has(room)) leave(client, room);
    return;
  }

  if (!client.did || !ROUTED.has(message.type) || typeof message.to !== 'string') return;
  for (const shared of client.rooms) {
    const target = findPeer(shared, message.to);
    if (target && target !== client) {
      send(target, JSON.stringify({ type: message.type, from: client.did, to: message.to, payload: message.payload }));
      return;
    }
  }
}

function leave(client, room) {
  client.rooms.delete(room);
  const peers = rooms.get(room);
  peers?.delete(client);
  if (peers?.size === 0) rooms.delete(room);
  announce(client, room, 'leave');
  log(`peer left room ${short(room)}`);
}

/** Tells every other peer in a room that someone came or went. */
function announce(sender, room, type) {
  const payload = JSON.stringify({ type, from: sender.did, room });
  for (const peer of rooms.get(room) ?? []) {
    if (peer !== sender) send(peer, payload);
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
  for (const client of clients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

const short = (room) => (room.length > 12 ? `${room.slice(0, 12)}…` : room);
const log = (message) => console.log(`[signaling] ${message}`);

server.listen(PORT, () => {
  log(`relaying on ws://localhost:${PORT} — data never touches this process`);
});
