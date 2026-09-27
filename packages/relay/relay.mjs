/**
 * The signaling relay: a dumb introducer, no state worth stealing. Run on its
 * own by `signaling-server.mjs`, and inside every always-on node
 * (`packages/cli/src/serve.ts`), so both are the same relay.
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
 *   client → { type: 'ice' }                       relay → { type: 'ice', payload: { servers, expiresAt } }
 *
 * A socket opened with `?room=<id>` is the older, one-room form: its `join`
 * names no room and means that one. Both kinds meet in the same rooms.
 *
 * Given TURN settings (`turnFromEnv`: TURN_SECRET and TURN_URLS), the relay
 * also hands out TURN passwords for a coturn server run with
 * `use-auth-secret` and the same secret: the "TURN REST API" scheme, where a
 * password is an HMAC of when it expires, so nothing is stored and nothing
 * needs revoking. They go to any socket that has joined a room, unprompted on
 * its first join and on request after, and last TURN_TTL_SECONDS (default 4
 * hours). The relay can't tell a Weave peer from anyone else, so every socket
 * from one address (one IPv6 /64) gets the same username, and a new one only
 * once half of its time is gone: asking again is free, and coturn's
 * `user-quota` caps each address instead of each second. What TURN may carry
 * in all is capped in coturn itself (`bps-capacity`, `max-bps`).
 *
 * **The mailbox.** A relay also holds sealed knocks for doors (see
 * `docs/spec/07-doors.md`), so someone can ask to become your contact while
 * you are offline. It is the one thing a relay keeps, and it keeps as little
 * as it can: an opaque blob under an opaque topic, for a few weeks at most.
 *
 *   client → { type: 'drop', topic, blob, ttl? }     relay → { type: 'dropped', topic, id } | { type: 'refused', topic, reason }
 *   client → { type: 'fetch', topic, after?, watch? } relay → { type: 'mail', topic, items: [{ seq, id, at, blob }], more }
 *   client → { type: 'unwatch', topic }
 *   client → { type: 'challenge' }                    relay → { type: 'challenge', nonce }
 *   client → { type: 'purge', topic, sign, ids?, sig } relay → { type: 'purged', topic, count } | { type: 'refused', … }
 *
 * A topic is a hash of a door's signing key, and a blob is sealed to the
 * door's other key, so the relay learns neither whose door it is nor what was
 * said. Anyone may drop or fetch — what they'd fetch opens only for the
 * door's owner. Only the owner may purge: they show the signing key whose
 * hash is the topic, and sign the relay's one-time challenge with it. The
 * relay sees who drops and who fetches by address, as it sees any socket.
 * No `join` is needed, so a mailbox socket names no DID.
 *
 * It is public, so it assumes nobody is polite: every socket gets a size cap,
 * a message budget and a heartbeat, and each IP, room and the process as a
 * whole have a ceiling. Framing is left to the `ws` server the caller brings
 * — this file has no dependencies, so whatever runs it needs nothing else.
 */

import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';

// Limits. Signaling messages are an SDP blob at most (a few KB), so these are
// generous for real peers and tight for anyone trying to fill a 256 MB VM.
/** Give the `ws` server this as its `maxPayload` */
export const MAX_MESSAGE_BYTES = 64 * 1024;
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
/** Addresses holding a TURN password at once; past this, new ones get none until old ones expire. */
const MAX_TURN_ADDRESSES = 20_000;

// Mailbox limits. A knock is an invite and a short note, sealed: a few KB.
const MAX_BLOB_LENGTH = 12_000;
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_MAIL_PER_TOPIC = 64;
const RESERVED_PER_TOPIC = 2;
const DROP_WINDOW_MS = 3600_000;
/** The mailbox's limits; a relay's operator may tighten or loosen them (`createRelay({ mailbox })`). */
export const MAILBOX_LIMITS = Object.freeze({
  /** Topics held at once */
  maxTopics: 50_000,
  /** Everything held at once, in blob characters */
  maxChars: 64 * 1024 * 1024,
  /**
   * Past `maxChars`, a reserve only topics holding fewer than two knocks may
   * use: a mailbox someone filled still takes a knock or two on every door.
   */
  reserveChars: 8 * 1024 * 1024,
  /** How long a knock is kept. A client may ask for less, never more. */
  ttlSeconds: 14 * 24 * 3600,
  /** Drops one address may make into one topic per hour: filling a door takes many addresses */
  dropsPerNetworkPerTopic: 4,
  /** Drops one address may make in all, per hour: filling the mailbox takes very many */
  dropsPerNetwork: 30,
});
const PURGE_SPKI_PREFIX = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');
const MAX_WATCHES_PER_SOCKET = 32;
/** One `mail` message stays well under what a client will take in one frame */
const MAX_PAGE_ITEMS = 16;
const MAX_PAGE_CHARS = 48 * 1024;

/** Only these are passed from one peer to another; join and leave come from us. */
const ROUTED = new Set(['offer', 'answer', 'candidate']);
const DID_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

/** A close code a client can tell apart from a network drop. */
const CLOSE_DID_TAKEN = 4009;

/**
 * TURN settings from the environment, or undefined when there are none.
 * @param {Record<string, string | undefined>} env
 * @returns {{ secret: string, urls: string[], ttlSeconds: number } | undefined}
 */
export function turnFromEnv(env) {
  const secret = env.TURN_SECRET ?? '';
  const urls = (env.TURN_URLS ?? '').split(',').map((url) => url.trim()).filter(Boolean);
  if (!secret || urls.length === 0) return undefined;
  return { secret, urls, ttlSeconds: Number(env.TURN_TTL_SECONDS ?? 4 * 3600) };
}

/**
 * A relay. Hand it upgrade requests: it refuses what it must before a socket
 * is opened, and otherwise opens one with the `ws` server given.
 *
 * @param {{
 *   turn?: { secret: string, urls: string[], ttlSeconds: number },
 *   log?: (message: string) => void,
 *   mailbox?: Partial<typeof MAILBOX_LIMITS>,
 * }} [options]
 */
export function createRelay(options = {}) {
  const { turn } = options;
  const limits = { ...MAILBOX_LIMITS, ...options.mailbox };
  const log = options.log ?? (() => {});

  /** room id -> Set of named clients in it */
  const rooms = new Map();
  /** Every open socket, named or not */
  const clients = new Set();
  /** ip -> number of open sockets */
  const perIp = new Map();
  /** network -> the TURN password its sockets share: { username, credential, expires } */
  const turnByNetwork = new Map();
  /** topic -> its knocks, oldest first: [{ seq, id, at, expires, blob }] */
  const mailbox = new Map();
  /** topic -> sockets watching it */
  const watchers = new Map();
  /** `network|topic`, and `network` alone -> { count, since }: drops in the current hour */
  const dropsBy = new Map();
  let mailChars = 0;
  let mailSeq = 0;

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
    const client = { ws, legacyRoom, ip, did: null, rooms: new Set(), watching: new Set(), nonce: null, alive: true, tokens: RATE_BURST, refilled: Date.now() };

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
      for (const topic of [...client.watching]) unwatch(client, topic);
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

      const first = !client.did;
      client.did = message.from;
      client.rooms.add(room);
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(client);
      announce(client, room, 'join');
      if (first) offerTurn(client);
      log(`peer joined room ${short(room)} (${rooms.get(room).size} present)`);
      return;
    }

    if (message.type === 'drop' || message.type === 'fetch' || message.type === 'unwatch' || message.type === 'challenge' || message.type === 'purge') {
      handleMail(client, message);
      return;
    }

    if (message.type === 'ice') {
      if (client.did) offerTurn(client);
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

  /**
   * The mailbox: `drop` leaves a sealed blob under a topic, `fetch` reads a
   * topic's blobs after a sequence number (and, with `watch`, hears of new
   * ones as they come), `unwatch` stops that.
   */
  function handleMail(client, message) {
    if (message.type === 'challenge') {
      client.nonce = randomBytes(18).toString('base64url');
      send(client, JSON.stringify({ type: 'challenge', nonce: client.nonce }));
      return;
    }
    const { topic } = message;
    if (typeof topic !== 'string' || !TOPIC_PATTERN.test(topic)) return;

    if (message.type === 'unwatch') {
      unwatch(client, topic);
      return;
    }

    if (message.type === 'purge') {
      purge(client, message);
      return;
    }

    if (message.type === 'fetch') {
      const after = Number.isSafeInteger(message.after) ? message.after : 0;
      if (message.watch === true && !client.watching.has(topic) && client.watching.size < MAX_WATCHES_PER_SOCKET) {
        client.watching.add(topic);
        if (!watchers.has(topic)) watchers.set(topic, new Set());
        watchers.get(topic).add(client);
      }
      const now = Date.now();
      const items = [];
      let chars = 0;
      let more = false;
      for (const item of mailbox.get(topic) ?? []) {
        if (item.seq <= after || item.expires <= now) continue;
        if (items.length >= MAX_PAGE_ITEMS || chars + item.blob.length > MAX_PAGE_CHARS) {
          more = true;
          break;
        }
        items.push(mailItem(item));
        chars += item.blob.length;
      }
      send(client, JSON.stringify({ type: 'mail', topic, items, more }));
      return;
    }

    // drop
    const refuse = (reason) => send(client, JSON.stringify({ type: 'refused', topic, reason }));
    const { blob } = message;
    if (typeof blob !== 'string' || blob.length === 0 || blob.length > MAX_BLOB_LENGTH || !/^[A-Za-z0-9_-]+$/.test(blob)) {
      refuse('A knock is base64url, at most 12000 characters');
      return;
    }
    const id = createHash('sha256').update(blob).digest('base64url');
    const held = mailbox.get(topic) ?? [];
    // The same knock twice is one knock: a sender retrying costs nothing.
    if (held.some((item) => item.id === id)) {
      send(client, JSON.stringify({ type: 'dropped', topic, id }));
      return;
    }
    const now = Date.now();
    const network = networkOf(client.ip);
    const here = countOf(`${network}|${topic}`, now);
    const everywhere = countOf(network, now);
    if (here >= limits.dropsPerNetworkPerTopic) return refuse('Too many knocks on this door from here; try later');
    if (everywhere >= limits.dropsPerNetwork) return refuse('Too many knocks from here; try later');
    if (held.length >= MAX_MAIL_PER_TOPIC) return refuse('This door is full');
    if (!mailbox.has(topic) && mailbox.size >= limits.maxTopics) return refuse('The mailbox is full');
    const room = held.length < RESERVED_PER_TOPIC ? limits.maxChars + limits.reserveChars : limits.maxChars;
    if (mailChars + blob.length > room) return refuse('The mailbox is full');

    const ttl = Number.isFinite(message.ttl) && message.ttl > 0 ? Math.min(message.ttl, limits.ttlSeconds) : limits.ttlSeconds;
    const item = { seq: ++mailSeq, id, at: now, expires: now + ttl * 1000, blob };
    held.push(item);
    mailbox.set(topic, held);
    mailChars += blob.length;
    counted(`${network}|${topic}`, now);
    counted(network, now);
    send(client, JSON.stringify({ type: 'dropped', topic, id }));
    const news = JSON.stringify({ type: 'mail', topic, items: [mailItem(item)], more: false });
    for (const watcher of watchers.get(topic) ?? []) {
      if (watcher !== client) send(watcher, news);
    }
  }

  const mailItem = ({ seq, id, at, blob }) => ({ seq, id, at, blob });

  /** Drops counted under a key in the current hour */
  function countOf(key, now) {
    const recent = dropsBy.get(key);
    return recent && now - recent.since < DROP_WINDOW_MS ? recent.count : 0;
  }

  function counted(key, now) {
    const recent = dropsBy.get(key);
    if (recent && now - recent.since < DROP_WINDOW_MS) recent.count += 1;
    else dropsBy.set(key, { count: 1, since: now });
  }

  /**
   * Clears a topic's knocks, all or some, for whoever proves they own the
   * door: the signing key they show hashes to the topic, and they signed this
   * socket's challenge with it. The challenge is used up either way.
   */
  function purge(client, message) {
    const { topic, sign, sig } = message;
    const refuse = (reason) => send(client, JSON.stringify({ type: 'refused', topic, reason }));
    const nonce = client.nonce;
    client.nonce = null;
    const ids = message.ids === undefined ? null : message.ids;
    if (!nonce) return refuse('Ask for a challenge first');
    if (typeof sign !== 'string' || !/^[A-Za-z0-9_-]{44}$/.test(sign) || typeof sig !== 'string' || sig.length > 200) return refuse('Not a purge');
    if (ids !== null && (!Array.isArray(ids) || ids.length > MAX_MAIL_PER_TOPIC || !ids.every((id) => typeof id === 'string' && id.length <= 64))) {
      return refuse('Not a purge');
    }
    if (createHash('sha256').update(`weave/door-topic/v1|${sign}`).digest('base64url') !== topic) return refuse('That key is not this door’s');
    let good = false;
    try {
      const key = createPublicKey({ key: Buffer.concat([PURGE_SPKI_PREFIX, Buffer.from(sign, 'base64url')]), format: 'der', type: 'spki' });
      const signed = `weave/door-purge/v1|${topic}|${nonce}|${ids ? [...ids].sort().join(',') : '*'}`;
      good = verify('sha256', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    } catch {
      good = false;
    }
    if (!good) return refuse('The signature does not check out');
    const held = mailbox.get(topic) ?? [];
    const gone = ids === null ? held : held.filter((item) => ids.includes(item.id));
    for (const item of gone) mailChars -= item.blob.length;
    const kept = ids === null ? [] : held.filter((item) => !ids.includes(item.id));
    if (kept.length === 0) mailbox.delete(topic);
    else mailbox.set(topic, kept);
    send(client, JSON.stringify({ type: 'purged', topic, count: gone.length }));
  }

  function unwatch(client, topic) {
    client.watching.delete(topic);
    const watching = watchers.get(topic);
    watching?.delete(client);
    if (watching?.size === 0) watchers.delete(topic);
  }

  /** Lets go of knocks past their time, and of drop counts past their hour */
  function sweepMail() {
    const now = Date.now();
    for (const [topic, held] of mailbox) {
      const kept = held.filter((item) => item.expires > now);
      for (const item of held) if (item.expires <= now) mailChars -= item.blob.length;
      if (kept.length === 0) mailbox.delete(topic);
      else if (kept.length !== held.length) mailbox.set(topic, kept);
    }
    for (const [key, recent] of dropsBy) {
      if (now - recent.since >= DROP_WINDOW_MS) dropsBy.delete(key);
    }
  }

  /**
   * Sends a socket TURN servers, with the password its address already holds
   * while that has more than half its time left, and a new one otherwise.
   */
  function offerTurn(client) {
    if (!turn) return;
    const network = networkOf(client.ip);
    const now = Math.floor(Date.now() / 1000);
    let held = turnByNetwork.get(network);
    if (!held || held.expires - now < turn.ttlSeconds / 2) {
      if (!held && turnByNetwork.size >= MAX_TURN_ADDRESSES) return;
      const expires = now + turn.ttlSeconds;
      // coturn reads the part before the colon as the expiry; the rest names the holder, not who they are.
      const username = `${expires}:${randomBytes(9).toString('base64url')}`;
      const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
      held = { username, credential, expires };
      turnByNetwork.set(network, held);
    }
    const { username, credential, expires } = held;
    send(client, JSON.stringify({ type: 'ice', payload: { servers: [{ urls: turn.urls, username, credential }], expiresAt: expires * 1000 } }));
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

  // Heartbeat: ping everyone, and drop whoever did not answer the last ping.
  // This also frees rooms and DIDs held by sockets that died without a close.
  const heartbeat = setInterval(() => {
    const now = Date.now() / 1000;
    for (const [network, held] of turnByNetwork) {
      if (held.expires <= now) turnByNetwork.delete(network);
    }
    sweepMail();
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

  return {
    /**
     * Takes an HTTP upgrade request. Everything that can be refused is refused
     * here, before a socket is opened.
     *
     * @param {import('ws').WebSocketServer} wss A `ws` server made with `noServer: true` and `maxPayload: MAX_MESSAGE_BYTES`
     */
    upgrade(wss, req, socket, head) {
      socket.on('error', () => socket.destroy());
      const legacyRoom = new URL(req.url ?? '/', 'http://relay').searchParams.get('room');
      const ip = clientIp(req);
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
    },

    /** Drops every socket and stops the heartbeat */
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.terminate();
    },
  };
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

/**
 * What one household or phone holds: an IPv4 address, or an IPv6 /64, since
 * one IPv6 connection is usually handed a whole /64 to pick addresses from.
 */
function networkOf(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('%')[0].toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

const short = (room) => (room.length > 12 ? `${room.slice(0, 12)}…` : room);
