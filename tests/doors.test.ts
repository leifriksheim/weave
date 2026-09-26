/**
 * Doors (`node.doors`, `src/doors/`): a code that says where to knock and
 * nothing about who you are; a relay mailbox that holds sealed knocks and
 * learns nothing from them; and two people who shared no space becoming
 * contacts through one.
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { createRelay, MAX_MESSAGE_BYTES } from '../server/relay.mjs';
import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { contactPublicKey, deriveContactKeyBytes, deriveDoorKeyBytes } from '../src/identity/contact-key.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { doorTopic, encodeDoorCode, knockId, openKnock, parseDoorCode, sealKnock } from '../src/doors/doors.js';
import { createMailboxClient } from '../src/network/mailbox.js';
import { AGENT_FACT } from '../src/identity/agent-note.js';
import { grantSigner } from '../src/session/connect.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';

// ─── A real relay, for the mailbox ──────────────────────────────────

let server: Server;
let relayUrl: string;
const relay = createRelay();
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

before(async () => {
  server = createServer();
  server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  relayUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  relay.close();
  server.close();
});

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
    network: { relays: [relayUrl], transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  open.push(node);
  await node.account.setName(name);
  return node;
}

async function until<T>(get: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A random, valid door key's public half, and a topic for it */
async function someDoor() {
  const key = contactPublicKey(await deriveDoorKeyBytes(await deriveContactKeyBytes(generateSeed()), 'test-door-0000000'));
  return { key, topic: await doorTopic(key) };
}

// ─── Codes ──────────────────────────────────────────────────────────

describe('a door code', () => {
  test('carries a key, 1–3 relays and a name, and reads back from a bare code or a link', async () => {
    const { key } = await someDoor();
    const code = encodeDoorCode({ key, relays: ['wss://a.example', 'wss://b.example'], name: 'Anna' });
    assert.deepEqual(parseDoorCode(code), { v: 1, key, relays: ['wss://a.example', 'wss://b.example'], name: 'Anna' });
    assert.equal(parseDoorCode(`https://chat.example/#door=${code}`).key, key);
    assert.equal(parseDoorCode(`  ${code}\n`).key, key);
  });

  test('refuses what could not be knocked on', async () => {
    const { key } = await someDoor();
    assert.throws(() => encodeDoorCode({ key, relays: [] }), /1–3 relays/);
    assert.throws(() => encodeDoorCode({ key, relays: ['wss://a', 'wss://b', 'wss://c', 'wss://d'] }), /1–3 relays/);
    assert.throws(() => encodeDoorCode({ key, relays: ['ws://relay.example'] }), /not a wss/);
    assert.throws(() => encodeDoorCode({ key: 'not-a-point', relays: ['wss://a.example'] }), /P-256/);
    assert.throws(() => parseDoorCode('hello'), /not a door code/);
  });

  test("says nothing about the account: the door key is not the contact key, and each door's differs", async () => {
    const contactKey = await deriveContactKeyBytes(generateSeed());
    const one = contactPublicKey(await deriveDoorKeyBytes(contactKey, 'door-one-00000000'));
    const two = contactPublicKey(await deriveDoorKeyBytes(contactKey, 'door-two-00000000'));
    assert.notEqual(one, contactPublicKey(contactKey));
    assert.notEqual(one, two);
    // …and the same on every device that holds the contact key.
    assert.equal(one, contactPublicKey(await deriveDoorKeyBytes(contactKey, 'door-one-00000000')));
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
    await assert.rejects(createMailboxClient({ timeoutMs: 300 }).drop(relayUrl, 'short', 'abc'), /did not answer/);
  });

  test('takes only a few knocks on one door from one address an hour', async () => {
    const { topic } = await someDoor();
    for (let i = 0; i < 4; i++) await mailbox.drop(relayUrl, topic, `a${i}`);
    await assert.rejects(mailbox.drop(relayUrl, topic, 'a4'), /Too many knocks/);
    assert.equal((await mailbox.fetch(relayUrl, topic)).length, 4);
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
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'mail') heard.push(...message.items.map((item: { blob: string }) => item.blob));
    };
    ws.send(JSON.stringify({ type: 'fetch', topic, watch: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mailbox.drop(relayUrl, topic, 'bmV3cw');
    await until(async () => heard, (h) => h.includes('bmV3cw'), 'the watcher to hear the knock');
    ws.close();
  });
});

// ─── Knocks ─────────────────────────────────────────────────────────

describe('a knock', () => {
  test('opens only with its door, and only as from the account whose note signed it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const seed = generateSeed();
    const leif = await person(hub, 'Leif', seed);
    const anna = await person(hub, 'Anna');
    const provider = createP256Provider();
    const contactKey = await deriveContactKeyBytes(generateSeed());
    const doorKey = await deriveDoorKeyBytes(contactKey, 'door-aaaaaaaaaaaa');
    const otherDoor = await deriveDoorKeyBytes(contactKey, 'door-bbbbbbbbbbbb');
    const door = contactPublicKey(doorKey);

    // A session under Leif's account, as his node signs with: one note, straight from the root.
    const manager = createIdentityManager();
    const root = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
    const keys = await provider.generateKeyPair();
    const sessionDid = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const token = await root.delegate({
      audience: sessionDid,
      capabilities: [{ with: '*', can: 'expression/*' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const pair = await leif.spaces.create({ name: 'Leif & Anna', visibility: 'private' });
    const invite = await leif.spaces.invite(pair.id);
    const session = { did: sessionDid, key: keys.privateKey, proof: token.encoded };

    const blob = await sealKnock(door, { from: leif.did, name: 'Leif', invite, note: 'hi from the gig' }, session, provider);
    const opened = await openKnock(doorKey, blob, provider);
    assert.equal(opened?.from, leif.did);
    assert.equal(opened?.name, 'Leif');
    assert.equal(opened?.note, 'hi from the gig');
    assert.equal(opened?.pairSpace, pair.id);

    // Another door's key can't open it.
    assert.equal(await openKnock(otherDoor, blob, provider), null);
    // Claiming to be Anna under Leif's note doesn't check out.
    const forged = await sealKnock(door, { from: anna.did, name: 'Anna', invite }, session, provider);
    assert.equal(await openKnock(doorKey, forged, provider), null);
    // Nor does inviting to a space someone else made.
    const annas = await anna.spaces.create({ name: 'Not Leif’s', visibility: 'private' });
    const stolen = await sealKnock(door, { from: leif.did, name: 'Leif', invite: await anna.spaces.invite(annas.id) }, session, provider);
    assert.equal(await openKnock(doorKey, stolen, provider), null);
    // A note passed on again (root → session → another key) is not the account's own: knocks carry one link.
    const deeper = await provider.generateKeyPair();
    const deeperDid = publicKeyToDid(await provider.exportPublicKey(deeper.publicKey), P256_MULTICODEC);
    const { token: passedOn } = await leif.delegate({ audience: deeperDid, capabilities: [{ with: '*', can: 'expression/*' }] });
    const relayed = await sealKnock(door, { from: leif.did, name: 'Leif', invite }, { did: deeperDid, key: deeper.privateKey, proof: passedOn.encoded }, provider);
    assert.equal(await openKnock(doorKey, relayed, provider), null);
  });
});

// ─── Two strangers ──────────────────────────────────────────────────

describe('node.doors', () => {
  test('two people who share no space become contacts through a door code', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');

    const door = await anna.doors.open({ label: 'bio' });
    assert.equal(door.name, 'Anna');
    assert.deepEqual(door.relays, [relayUrl]);
    assert.deepEqual((await anna.doors.list()).map((d) => d.id), [door.id]);

    // Anna posts the code somewhere; Leif pastes it.
    const { space } = await leif.doors.knock(`https://chat.example/#door=${door.code}`, { note: 'We met at the gig' });
    assert.deepEqual((await leif.doors.sent()).map((k) => [k.space, k.name]), [[space, 'Anna']]);

    const [knock] = await until(() => anna.doors.knocks(), (k) => k.length === 1, 'the knock to arrive');
    assert.equal(knock!.from, leif.did);
    assert.equal(knock!.name, 'Leif');
    assert.equal(knock!.note, 'We met at the gig');
    assert.equal(knock!.pairSpace, space);
    assert.equal(knock!.door, door.id);

    const contact = await anna.doors.accept(knock!.id);
    assert.equal(contact.did, leif.did);
    assert.equal(contact.space, space);
    // Accepted: it is no longer waiting.
    assert.deepEqual(await anna.doors.knocks(), []);

    // Leif's side becomes a contact once Anna's membership reaches him.
    await leif.spaces.hold(space);
    await anna.spaces.hold(space);
    await until(() => leif.doors.sent(), (s) => s.length === 0, 'Leif to see Anna join');
    const annaForLeif = await leif.contacts.get(anna.did);
    assert.equal(annaForLeif?.space, space);
    assert.equal(annaForLeif?.name, 'Anna');
  });

  test('one relay of a door being down does not stop a knock', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const door = await anna.doors.open({ relays: ['ws://127.0.0.1:1', relayUrl] });
    await leif.doors.knock(door.code);
    await until(() => anna.doors.knocks(), (k) => k.length === 1, 'the knock through the working relay', 15_000);
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
    await until(() => anna.doors.knocks(), (k) => k.length === 2, 'both knocks');

    await anna.contacts.block(carol.did);
    assert.deepEqual((await anna.doors.knocks()).map((k) => k.from), [leif.did]);

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
    const [onLaptop] = await until(() => laptop.doors.knocks(), (k) => k.length === 1, 'the laptop to see the door and its knock', 10_000);
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
      signer: grantSigner({ v: 1, did: (await manager.fromSeed(seed)).did, name: 'Ada', token: note.encoded, access: 'write', scope: 'account', spaces: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, agent: true, home: 'https://home.test/connect' }),
      sessionKey: keys,
      stores: memoryStores(),
      accountKey: await deriveVaultKeyBytes(seed),
      contactKey: await deriveContactKeyBytes(seed),
      watchIntervalMs: 0,
      network: { relays: [relayUrl], transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(agent);
    assert.deepEqual(await agent.doors.list(), []);
    await assert.rejects(agent.doors.open(), /An agent can't use doors/);
    await assert.rejects(agent.doors.knock(door.code), /An agent can't use doors/);
    await assert.rejects(agent.doors.knocks(), /An agent can't use doors/);
  });
});
