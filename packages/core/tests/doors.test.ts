/**
 * Doors (`node.doors`, `src/doors/`): a code that says where to knock and
 * nothing about who you are; a relay mailbox that holds sealed knocks, learns
 * nothing from them, can't be filled by one address, and lets only a door's
 * owner clear it; knocks that prove who knocked, with authority to, when; and
 * two people who shared no space becoming contacts through one.
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import * as z from 'zod';

import { createRelay, MAX_MESSAGE_BYTES, type MailboxLimits } from '../../relay/relay.mjs';
import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import {
  contactPublicKey,
  deriveContactKeyBytes,
  deriveDoorKeyBytes,
  deriveDoorSignKeyBytes,
} from '../src/identity/contact-key.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import type { Capability } from '../src/identity/ucan.js';
import {
  clip,
  doorTopic,
  encodeDoorCode,
  knockId,
  openKnock,
  parseDoorCode,
  sealKnock,
  signPurge,
} from '../src/doors/doors.js';
import { createMailboxClient } from '../src/network/mailbox.js';
import { AGENT_FACT } from '../src/identity/agent-note.js';
import { grantSigner } from '../src/session/connect.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { joined } from './helpers/joined.js';
import { portOf } from './helpers/net.js';
import { isRecord } from './helpers/shape.js';

// ─── Relays, for the mailbox ────────────────────────────────────────

/** A relay on a free port. Tests all come from 127.0.0.1, so the main one allows that address plenty. */
async function startRelay(mailbox: Partial<MailboxLimits> = {}) {
  const relay = createRelay({ mailbox });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${portOf(server)}`,
    close: () => {
      relay.close();
      server.close();
    },
  };
}

let main: Awaited<ReturnType<typeof startRelay>>;
let relayUrl: string;
before(async () => {
  main = await startRelay({ dropsPerNetwork: 10_000 });
  relayUrl = main.url;
});
after(() => main.close());

const open: P2PNode[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function person(hub: FakeHub, name: string, seed = generateSeed()) {
  const manager = createIdentityManager();
  const node = await createNode({
    signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
    stores: memoryStores(),
    accountKey: await deriveVaultKeyBytes(seed),
    contactKey: await deriveContactKeyBytes(seed),
    watchIntervalMs: 0,
    network: {
      relays: [relayUrl],
      transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
    },
  });
  open.push(node);
  await node.account.setName(name);
  return node;
}

async function until<T>(
  get: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A door's keys, as its owner holds them */
async function someDoor(id = 'test-door-0000000', contactKey?: Uint8Array) {
  const contact = contactKey ?? (await deriveContactKeyBytes(generateSeed()));
  const key = await deriveDoorKeyBytes(contact, id);
  const sign = await deriveDoorSignKeyBytes(contact, id);
  const signPublic = contactPublicKey(sign);
  return { key, sign, publicKey: contactPublicKey(key), signPublic, topic: await doorTopic(signPublic) };
}

// ─── Codes ──────────────────────────────────────────────────────────

describe('a door code', () => {
  test('carries two keys, 1–3 relays and a name, and reads back from a bare code or a link', async () => {
    const { publicKey: key, signPublic: sign } = await someDoor();
    const code = encodeDoorCode({ key, sign, relays: ['wss://a.example', 'wss://b.example'], name: 'Anna' });
    assert.deepEqual(parseDoorCode(code), {
      v: 1,
      key,
      sign,
      relays: ['wss://a.example', 'wss://b.example'],
      name: 'Anna',
    });
    assert.equal(parseDoorCode(`https://chat.example/#door=${code}`).key, key);
    assert.equal(parseDoorCode(`  ${code}\n`).key, key);
  });

  test('refuses what could not be knocked on', async () => {
    const { publicKey: key, signPublic: sign } = await someDoor();
    assert.throws(() => encodeDoorCode({ key, sign, relays: [] }), /1–3 relays/);
    assert.throws(
      () => encodeDoorCode({ key, sign, relays: ['wss://a', 'wss://b', 'wss://c', 'wss://d'] }),
      /1–3 relays/,
    );
    assert.throws(() => encodeDoorCode({ key, sign, relays: ['ws://relay.example'] }), /not a wss/);
    assert.throws(() => encodeDoorCode({ key: 'not-a-point', sign, relays: ['wss://a.example'] }), /P-256/);
    assert.throws(() => encodeDoorCode({ key, sign: key, relays: ['wss://a.example'] }), /signing key/);
    assert.throws(() => parseDoorCode('hello'), /not a door code/);
  });

  test("says nothing about the account: neither key is the contact key, and each door's differ", async () => {
    const contactKey = await deriveContactKeyBytes(generateSeed());
    const one = await someDoor('door-one-00000000', contactKey);
    const two = await someDoor('door-two-00000000', contactKey);
    assert.notEqual(one.publicKey, contactPublicKey(contactKey));
    assert.notEqual(one.signPublic, contactPublicKey(contactKey));
    assert.notEqual(one.publicKey, one.signPublic);
    assert.notEqual(one.publicKey, two.publicKey);
    // …and the same on every device that holds the contact key.
    assert.equal(one.publicKey, (await someDoor('door-one-00000000', contactKey)).publicKey);
  });

  test('names are cut to length without splitting a character', () => {
    assert.equal(clip('ab😀cd', 3), 'ab😀');
    assert.equal(clip('short', 64), 'short');
  });
});

// ─── The relay's mailbox ────────────────────────────────────────────

describe("the relay's mailbox", () => {
  const mailbox = createMailboxClient();

  test('holds a blob under a topic for whoever fetches it, once however often it is dropped', async () => {
    const { topic } = await someDoor();
    const id = await mailbox.drop(relayUrl, topic, 'c2VhbGVk');
    assert.equal(id, await knockId('c2VhbGVk'));
    assert.equal(await mailbox.drop(relayUrl, topic, 'c2VhbGVk'), id);
    const items = await mailbox.fetch(relayUrl, topic);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.blob, 'c2VhbGVk');
    assert.equal(items[0]!.id, id);
    assert.deepEqual(await mailbox.fetch(relayUrl, topic, items[0]!.seq), []);
  });

  test('refuses what is not a sealed blob, and topics that are not a hash', async () => {
    const { topic } = await someDoor();
    await assert.rejects(mailbox.drop(relayUrl, topic, 'not base64url!'), /refused/);
    await assert.rejects(mailbox.drop(relayUrl, topic, 'a'.repeat(12_001)), /refused/);
    // A malformed topic gets no answer at all.
    await assert.rejects(
      createMailboxClient({ timeoutMs: 300 }).drop(relayUrl, 'short', 'abc'),
      /did not answer/,
    );
  });

  test('takes only a few knocks on one door from one address an hour', async () => {
    const { topic } = await someDoor();
    for (let i = 0; i < 4; i++) await mailbox.drop(relayUrl, topic, `a${i}`);
    await assert.rejects(mailbox.drop(relayUrl, topic, 'a4'), /Too many knocks on this door/);
    assert.equal((await mailbox.fetch(relayUrl, topic)).length, 4);
  });

  test('takes only so many knocks from one address in all, whatever the topics', async () => {
    const own = await startRelay({ dropsPerNetwork: 5 });
    try {
      for (let i = 0; i < 5; i++)
        await mailbox.drop(own.url, (await someDoor(`many-topics-${i}-00000`)).topic, `b${i}`);
      await assert.rejects(
        mailbox.drop(own.url, (await someDoor('many-topics-6-00000')).topic, 'b6'),
        /Too many knocks from here/,
      );
    } finally {
      own.close();
    }
  });

  test('when full, still takes a knock or two on a door that holds fewer', async () => {
    const own = await startRelay({ maxChars: 100, reserveChars: 100 });
    try {
      const busy = (await someDoor('busy-door-00000000')).topic;
      const quiet = (await someDoor('quiet-door-0000000')).topic;
      const blob = (n: number) => `${n}`.padEnd(40, 'x');
      await mailbox.drop(own.url, busy, blob(1));
      await mailbox.drop(own.url, busy, blob(2));
      await assert.rejects(mailbox.drop(own.url, busy, blob(3)), /mailbox is full/);
      await mailbox.drop(own.url, quiet, blob(4));
    } finally {
      own.close();
    }
  });

  test('lets knocks go when their time is up', async () => {
    const { topic } = await someDoor();
    await mailbox.drop(relayUrl, topic, 'ZXhwaXJlcw', 1);
    assert.equal((await mailbox.fetch(relayUrl, topic)).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await mailbox.fetch(relayUrl, topic)).length, 0);
  });

  test('tells a watcher about a knock as it arrives', async () => {
    const { topic } = await someDoor();
    const ws = new WebSocket(relayUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    const heard: string[] = [];
    const Mail = z.object({ type: z.literal('mail'), items: z.array(z.object({ blob: z.string() })) });
    ws.onmessage = (event) => {
      const mail = Mail.safeParse(JSON.parse(String(event.data)));
      if (mail.success) heard.push(...mail.data.items.map((item) => item.blob));
    };
    ws.send(JSON.stringify({ type: 'fetch', topic, watch: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mailbox.drop(relayUrl, topic, 'bmV3cw');
    await until(
      async () => heard,
      (h) => h.includes('bmV3cw'),
      'the watcher to hear the knock',
    );
    ws.close();
  });

  test("is cleared only by the door's owner: the key that hashes to the topic, signing this socket's challenge", async () => {
    const door = await someDoor('purged-door-000000');
    const stranger = await someDoor('someone-else-00000');
    const ids = [
      await mailbox.drop(relayUrl, door.topic, 'b25l'),
      await mailbox.drop(relayUrl, door.topic, 'dHdv'),
      await mailbox.drop(relayUrl, door.topic, 'dGhyZWU'),
    ];

    // Someone else's key, or the right key and a signature over the wrong thing, clear nothing.
    await assert.rejects(
      mailbox.purge(relayUrl, door.topic, stranger.signPublic, null, (nonce) =>
        signPurge(stranger.sign, door.topic, nonce, null),
      ),
      /not this door/,
    );
    await assert.rejects(
      mailbox.purge(relayUrl, door.topic, door.signPublic, null, (nonce) =>
        signPurge(door.sign, door.topic, `${nonce}x`, null),
      ),
      /does not check out/,
    );
    assert.equal((await mailbox.fetch(relayUrl, door.topic)).length, 3);

    // One knock, then the rest.
    assert.equal(
      await mailbox.purge(relayUrl, door.topic, door.signPublic, [ids[0]!], (nonce) =>
        signPurge(door.sign, door.topic, nonce, [ids[0]!]),
      ),
      1,
    );
    assert.deepEqual(
      (await mailbox.fetch(relayUrl, door.topic)).map((item) => item.id).sort(),
      [ids[1]!, ids[2]!].sort(),
    );
    assert.equal(
      await mailbox.purge(relayUrl, door.topic, door.signPublic, null, (nonce) =>
        signPurge(door.sign, door.topic, nonce, null),
      ),
      2,
    );
    assert.deepEqual(await mailbox.fetch(relayUrl, door.topic), []);
  });

  test('a challenge is good for one purge', async () => {
    const door = await someDoor('replayed-door-0000');
    await mailbox.drop(relayUrl, door.topic, 'cmVwbGF5');
    const ws = new WebSocket(relayUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    const answers: unknown[] = [];
    ws.onmessage = (event) => answers.push(JSON.parse(String(event.data)));
    ws.send(JSON.stringify({ type: 'challenge' }));
    const [challenge] = await until(
      async () => answers,
      (a) => a.length === 1,
      'the challenge',
    );
    const { nonce } = z.object({ nonce: z.string() }).parse(challenge);
    const purge = {
      type: 'purge',
      topic: door.topic,
      sign: door.signPublic,
      ids: ['nothing'],
      sig: await signPurge(door.sign, door.topic, nonce, ['nothing']),
    };
    ws.send(JSON.stringify(purge));
    ws.send(JSON.stringify(purge));
    await until(
      async () => answers,
      (a) => a.length === 3,
      'both answers',
    );
    const typeOf = (answer: unknown) => (isRecord(answer) ? answer.type : undefined);
    assert.equal(typeOf(answers[1]), 'purged');
    assert.equal(typeOf(answers[2]), 'refused');
    ws.close();
  });
});

// ─── Knocks ─────────────────────────────────────────────────────────

describe('a knock', () => {
  /** Leif's account, a session under it with a note saying `capabilities`, and a space for two he made */
  async function leifWith(
    hub: FakeHub,
    capabilities: Capability[] = [{ with: '*', can: 'expression/*' }],
    expiresIn = 3600,
  ) {
    const seed = generateSeed();
    const leif = await person(hub, 'Leif', seed);
    const provider = createP256Provider();
    const manager = createIdentityManager();
    const root = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
    const keys = await provider.generateKeyPair();
    const sessionDid = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const token = await root.delegate({
      audience: sessionDid,
      capabilities,
      expiration: Math.floor(Date.now() / 1000) + expiresIn,
    });
    const pair = await leif.spaces.create({ name: 'Leif & Anna', visibility: 'private' });
    const invite = await leif.spaces.invite(pair.id);
    return {
      leif,
      provider,
      invite,
      pair,
      session: { did: sessionDid, key: keys.privateKey, proof: token.encoded },
    };
  }

  test('opens only with its door, and only as from the account whose note signed it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { leif, provider, invite, pair, session } = await leifWith(hub);
    const anna = await person(hub, 'Anna');
    const door = await someDoor('door-aaaaaaaaaaaa');
    const other = await someDoor('door-bbbbbbbbbbbb');

    const blob = await sealKnock(
      door.publicKey,
      { from: leif.did, name: 'Leif', invite, note: 'hi from the gig' },
      session,
      provider,
    );
    const opened = await openKnock(door.key, blob, Date.now(), provider);
    assert.equal(opened?.from, leif.did);
    assert.equal(opened?.name, 'Leif');
    assert.equal(opened?.note, 'hi from the gig');
    assert.equal(opened?.pairSpace, pair.id);

    // Another door's key can't open it.
    assert.equal(await openKnock(other.key, blob, Date.now(), provider), null);
    // Claiming to be Anna under Leif's note doesn't check out.
    const forged = await sealKnock(
      door.publicKey,
      { from: anna.did, name: 'Anna', invite },
      session,
      provider,
    );
    assert.equal(await openKnock(door.key, forged, Date.now(), provider), null);
    // Nor does inviting to a space someone else made.
    const annas = await anna.spaces.create({ name: 'Not Leif’s', visibility: 'private' });
    const stolen = await sealKnock(
      door.publicKey,
      { from: leif.did, name: 'Leif', invite: await anna.spaces.invite(annas.id) },
      session,
      provider,
    );
    assert.equal(await openKnock(door.key, stolen, Date.now(), provider), null);
    // A note passed on again (root → session → another key) is not the account's own: knocks carry one link.
    const deeper = await provider.generateKeyPair();
    const deeperDid = publicKeyToDid(await provider.exportPublicKey(deeper.publicKey), P256_MULTICODEC);
    const { token: passedOn } = await leif.delegate({
      audience: deeperDid,
      capabilities: [{ with: '*', can: 'expression/*' }],
    });
    const relayed = await sealKnock(
      door.publicKey,
      { from: leif.did, name: 'Leif', invite },
      { did: deeperDid, key: deeper.privateKey, proof: passedOn.encoded },
      provider,
    );
    assert.equal(await openKnock(door.key, relayed, Date.now(), provider), null);
  });

  test('needs a note for the whole account, to write: an app given one space, or only to read, cannot knock', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const door = await someDoor('door-cccccccccccc');
    for (const capabilities of [
      [{ with: 'space:bafyonespace', can: 'expression/*' }],
      [{ with: '*', can: 'expression/read' }],
    ]) {
      const { leif, provider, invite, session } = await leifWith(hub, capabilities);
      const blob = await sealKnock(
        door.publicKey,
        { from: leif.did, name: 'Leif', invite },
        session,
        provider,
      );
      assert.equal(await openKnock(door.key, blob, Date.now(), provider), null, JSON.stringify(capabilities));
    }
  });

  test('is judged by when the relay took it: a note that ran out cannot be used by dating a knock back', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const door = await someDoor('door-dddddddddddd');
    const seed = generateSeed();
    const leif = await person(hub, 'Leif', seed);
    const provider = createP256Provider();
    const manager = createIdentityManager();
    const root = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
    const keys = await provider.generateKeyPair();
    const sessionDid = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const pair = await leif.spaces.create({ name: 'Leif & Anna', visibility: 'private' });
    const invite = await leif.spaces.invite(pair.id);
    const realNow = Date.now;
    // An hour ago, Leif's session had a note good for half an hour, and signed a knock with it.
    Date.now = () => realNow() - 3600_000;
    let blob: string;
    try {
      const token = await root.delegate({
        audience: sessionDid,
        capabilities: [{ with: '*', can: 'expression/*' }],
        expiration: Math.floor(Date.now() / 1000) + 1800,
      });
      blob = await sealKnock(
        door.publicKey,
        { from: leif.did, name: 'Leif', invite },
        { did: sessionDid, key: keys.privateKey, proof: token.encoded },
        provider,
      );
    } finally {
      Date.now = realNow;
    }
    // Dropped then, it was a knock. Dropped now, with the note long gone, it isn't.
    assert.equal((await openKnock(door.key, blob, Date.now() - 3600_000, provider))?.from, leif.did);
    assert.equal(await openKnock(door.key, blob, Date.now(), provider), null);
  });
});

// ─── Two strangers ──────────────────────────────────────────────────

describe('node.doors', () => {
  /** Anna's knocks, read until `ok` — each read also writes answers she owes */
  const annaSees = (anna: P2PNode, ok: (count: number) => boolean, what: string, ms?: number) =>
    until(
      () => anna.doors.knocks(),
      (knocks) => ok(knocks.length),
      what,
      ms,
    );

  test('two people who share no space become contacts through a door code', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');

    const door = await anna.doors.open({ label: 'bio' });
    assert.equal(door.name, 'Anna');
    assert.deepEqual(door.relays, [relayUrl]);
    assert.deepEqual(
      (await anna.doors.list()).map((d) => d.id),
      [door.id],
    );

    // Anna posts the code somewhere; Leif pastes it.
    const { space } = await leif.doors.knock(`https://chat.example/#door=${door.code}`, {
      note: 'We met at the gig',
    });
    assert.deepEqual(
      (await leif.doors.sent()).map((k) => [k.space, k.name]),
      [[space, 'Anna']],
    );

    const [knock] = await annaSees(anna, (n) => n === 1, 'the knock to arrive');
    assert.equal(knock!.from, leif.did);
    assert.equal(knock!.name, 'Leif');
    assert.equal(knock!.note, 'We met at the gig');
    assert.equal(knock!.pairSpace, space);
    assert.equal(knock!.door, door.id);

    const contact = await anna.doors.accept(knock!.id);
    assert.equal(contact.did, leif.did);
    assert.equal(contact.space, space);
    // Accepted: it is no longer waiting, and it's gone from the relay.
    assert.deepEqual(await anna.doors.knocks(), []);

    // Leif's side becomes a contact once Anna's signed answer reaches him.
    await leif.spaces.hold(space);
    await anna.spaces.hold(space);
    await until(
      async () => (await anna.doors.knocks(), leif.doors.sent()),
      (sent) => sent.length === 0,
      'Anna to answer and Leif to see it',
    );
    const annaForLeif = await leif.contacts.get(anna.did);
    assert.equal(annaForLeif?.space, space);
    assert.equal(annaForLeif?.name, 'Anna');
  });

  test("whoever else the invite reached is not taken for the person behind the door, and can't join after", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const annaSeed = generateSeed();
    const anna = await person(hub, 'Anna', annaSeed);
    const leif = await person(hub, 'Leif');
    const carol = await person(hub, 'Carol');
    const dave = await person(hub, 'Dave');
    const door = await anna.doors.open();
    const { space } = await leif.doors.knock(door.code);
    await leif.spaces.hold(space);

    // Carol gets hold of the invite (say, from Anna's lost laptop) and joins first.
    const keys = await someDoor(door.id, await deriveContactKeyBytes(annaSeed));
    const [item] = await until(
      () => createMailboxClient().fetch(relayUrl, keys.topic),
      (items) => items.length === 1,
      'the knock',
    );
    const invite = (await openKnock(keys.key, item!.blob, item!.at, createP256Provider()))!.invite;
    await carol.spaces.join(invite);
    await joined(carol, space);
    await leif.doors.sent();
    assert.equal(await leif.contacts.get(carol.did), null, 'joining is not answering');

    // Anna answers: she is the contact, and the invite is closed behind her.
    const [knock] = await annaSees(anna, (n) => n === 1, 'the knock');
    await anna.doors.accept(knock!.id);
    await anna.spaces.hold(space);
    await until(
      async () => (await anna.doors.knocks(), leif.doors.sent()),
      (sent) => sent.length === 0,
      'the answer',
    );
    assert.equal((await leif.contacts.get(anna.did))?.space, space);
    assert.equal(await leif.contacts.get(carol.did), null);
    // Anyone else it reached is refused now: the space's members don't count them in.
    await dave.spaces.join(invite);
    await until(
      async () => (await dave.spaces.access(space)).role,
      (role) => role === null,
      'Dave to be refused',
      3000,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const member of [leif, anna]) {
      assert.equal(
        (await member.spaces.access(space)).members.some((m) => m.did === dave.did),
        false,
      );
    }
  });

  test('a knock can be dismissed without blocking, and a flooded door cleared without closing it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const carol = await person(hub, 'Carol');
    const door = await anna.doors.open();

    await leif.doors.knock(door.code);
    const [first] = await annaSees(anna, (n) => n === 1, 'Leif’s knock');
    await anna.doors.dismiss(first!.id);
    assert.deepEqual(await anna.doors.knocks(), []);
    assert.equal(await anna.contacts.get(leif.did), null, 'not blocked, not a contact');

    await carol.doors.knock(door.code);
    await leif.doors.knock(door.code);
    await annaSees(anna, (n) => n === 2, 'two more knocks');
    await anna.doors.clear(door.id);
    assert.deepEqual(await anna.doors.knocks(), []);
    // Still open: the code everyone has keeps working.
    await carol.doors.knock(door.code);
    await annaSees(anna, (n) => n === 1, 'a knock after clearing');
  });

  test('a knock nobody answers is let go after its time, space and all', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const door = await anna.doors.open();
    const { space } = await leif.doors.knock(door.code);
    assert.equal((await leif.doors.sent()).length, 1);
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 24 * 3600_000;
    try {
      assert.deepEqual(await leif.doors.sent(), []);
    } finally {
      Date.now = realNow;
    }
    assert.equal(await leif.spaces.get(space), null);
  });

  test('one relay of a door being down does not stop a knock', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const door = await anna.doors.open({ relays: ['ws://127.0.0.1:1', relayUrl] });
    await leif.doors.knock(door.code);
    await annaSees(anna, (n) => n === 1, 'the knock through the working relay', 15_000);
  });

  test('a knock fails, and leaves nothing behind, when no relay of the door takes it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const door = await anna.doors.open({ relays: ['ws://127.0.0.1:1'] });
    await assert.rejects(leif.doors.knock(door.code), /None of their door's relays took the knock/);
    assert.deepEqual(await leif.doors.sent(), []);
    assert.deepEqual(await leif.spaces.list(), []);
  });

  test('a closed door reads no more knocks, and knocks from blocked people stay hidden', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const carol = await person(hub, 'Carol');

    const door = await anna.doors.open();
    await leif.doors.knock(door.code);
    await carol.doors.knock(door.code);
    await annaSees(anna, (n) => n === 2, 'both knocks');

    await anna.contacts.block(carol.did);
    assert.deepEqual(
      (await anna.doors.knocks()).map((k) => k.from),
      [leif.did],
    );

    await anna.doors.close(door.id);
    assert.deepEqual(await anna.doors.list(), []);
    assert.deepEqual(await anna.doors.knocks(), []);
  });

  test('you cannot knock on your own door', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const door = await anna.doors.open();
    await assert.rejects(anna.doors.knock(door.code), /your own doors/);
  });

  test('every device of the account opens the same doors', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const seed = generateSeed();
    const phone = await person(hub, 'Anna', seed);
    const laptop = await person(hub, 'Anna', seed);
    const leif = await person(hub, 'Leif');
    const door = await phone.doors.open();
    await leif.doors.knock(door.code);
    const [onLaptop] = await annaSees(
      laptop,
      (n) => n === 1,
      'the laptop to see the door and its knock',
      10_000,
    );
    assert.equal(onLaptop!.from, leif.did);
  });

  test("an agent has no doors and can't knock, even when it was given the contact key", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const seed = generateSeed();
    const anna = await person(hub, 'Anna');
    const door = await anna.doors.open();

    const manager = createIdentityManager();
    const provider = manager.getProvider();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(await manager.fromSeed(seed), provider).delegate({
      audience: did,
      capabilities: [{ with: '*', can: 'expression/*' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
      facts: [AGENT_FACT],
    });
    const agent = await createNode({
      signer: grantSigner({
        v: 1,
        did: (await manager.fromSeed(seed)).did,
        name: 'Ada',
        token: note.encoded,
        access: 'write',
        scope: 'account',
        spaces: [],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        agent: true,
        home: 'https://home.test/connect',
      }),
      sessionKey: keys,
      stores: memoryStores(),
      accountKey: await deriveVaultKeyBytes(seed),
      contactKey: await deriveContactKeyBytes(seed),
      watchIntervalMs: 0,
      network: {
        relays: [relayUrl],
        transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
      },
    });
    open.push(agent);
    assert.deepEqual(await agent.doors.list(), []);
    await assert.rejects(agent.doors.open(), /An agent can't use doors/);
    await assert.rejects(agent.doors.knock(door.code), /An agent can't use doors/);
    await assert.rejects(agent.doors.knocks(), /An agent can't use doors/);
  });
});
