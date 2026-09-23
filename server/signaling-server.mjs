/**
 * A dumb signaling relay: zero dependencies, no state worth stealing.
 *
 * Peers connect with `?room=<spaceId>` and the relay passes join/leave notices
 * and WebRTC offers, answers and ICE candidates between members of that room.
 * It never sees expression data — that flows peer to peer over WebRTC — and it
 * cannot read a private space even if it wanted to.
 *
 *   node server/signaling-server.mjs [port]
 */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** room id -> Set of clients */
const rooms = new Map();

const server = createServer((req, res) => {
  if (req.url === '/health') {
    const peers = [...rooms.values()].reduce((total, set) => total + set.size, 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers }));
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('This endpoint speaks WebSocket only.\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const room = url.searchParams.get('room') ?? 'default';
  const client = { socket, room, id: randomUUID(), did: null, buffer: Buffer.alloc(0) };

  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(client);
  log(`peer joined room ${short(room)} (${rooms.get(room).size} present)`);

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    for (const frame of drainFrames(client)) handleMessage(client, frame);
  });

  const drop = () => {
    const peers = rooms.get(client.room);
    if (!peers?.delete(client)) return;
    if (peers.size === 0) rooms.delete(client.room);
    if (client.did) {
      relay(client, { type: 'leave', from: client.did });
    }
    log(`peer left room ${short(client.room)}`);
  };

  socket.on('close', drop);
  socket.on('error', drop);
});

/**
 * Routes one signaling message: `join` is announced to everyone already in the
 * room, and everything else is delivered to the single peer it names.
 *
 * Only existing peers hear about a newcomer, so exactly one side creates the
 * offer and the two never collide.
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
    client.did = message.from ?? null;
    relay(client, message);
    return;
  }

  if (typeof message.to === 'string') {
    const target = [...(rooms.get(client.room) ?? [])].find((peer) => peer.did === message.to);
    if (target) send(target.socket, JSON.stringify(message));
  }
}

/** Sends a message to every other peer in the sender's room. */
function relay(sender, message) {
  const payload = JSON.stringify(message);
  for (const peer of rooms.get(sender.room) ?? []) {
    if (peer !== sender) send(peer.socket, payload);
  }
}

/** Pulls complete WebSocket frames out of a client's buffer. */
function* drainFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      length = Number(client.buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskKey = masked ? client.buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (client.buffer.length < offset + length) return;

    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);

    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }

    if (opcode === 0x8) {
      client.socket.end();
      return;
    }
    if (opcode === 0x9) {
      client.socket.write(frame(payload, 0xa)); // pong
      continue;
    }
    if (opcode === 0x1) yield payload.toString('utf8');
  }
}

/** Writes a text frame (server frames are never masked). */
function send(socket, text) {
  if (socket.destroyed) return;
  socket.write(frame(Buffer.from(text, 'utf8'), 0x1));
}

function frame(payload, opcode) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

const short = (room) => (room.length > 12 ? `${room.slice(0, 12)}…` : room);
const log = (message) => console.log(`[signaling] ${message}`);

server.listen(PORT, () => {
  log(`relaying on ws://localhost:${PORT} — rooms are space ids, data never touches this process`);
});
