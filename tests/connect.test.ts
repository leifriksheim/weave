/**
 * An app acting for an account through a grant from its home: it writes where
 * it was given access, nowhere else, and never holds the seed.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createWeaveAuth, type WeaveAuth } from '../src/session/auth.js';
import { homeAddress, startConnectedNode, type AppKey, type ConnectRequest, type Grant } from '../src/session/connect.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { parseUCAN } from '../src/identity/ucan.js';
import type { P2PNode } from '../src/node/types.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { team } from '../src/space/presets.js';
import { parseSpaceInvite } from '../src/space/space-manager.js';

async function until(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/** The account home: a signed-in flow on the hub */
async function home(hub: FakeHub): Promise<WeaveAuth> {
  const accounts = createFolderAccountStore(createMemoryDirectory().handle);
  const stores = memoryStores();
  const values = new Map<string, string>([['weave.stay-signed-in', '"never"']]);
  const auth = createWeaveAuth({
    rpId: 'home.test',
    storage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => void values.set(k, v), removeItem: (k) => void values.delete(k) },
    browser: { accounts: async () => accounts, stores: () => stores },
    network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
  });
  await auth.start();
  await auth.createAccount('Ada');
  auth.codeSaved();
  cleanup.push(() => auth.signOut());
  return auth;
}

async function appKey(): Promise<AppKey> {
  const provider = createP256Provider();
  const made = await provider.generateKeyPair();
  return {
    keys: { privateKey: made.privateKey, publicKey: made.publicKey },
    did: publicKeyToDid(await provider.exportPublicKey(made.publicKey), P256_MULTICODEC),
  };
}

async function app(hub: FakeHub, grant: Omit<Grant, 'home'>, key: AppKey): Promise<P2PNode> {
  const node = await startConnectedNode({
    grant: { ...grant, home: 'https://home.test/connect' },
    key,
    stores: memoryStores(),
    network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
  });
  cleanup.push(() => node.close());
  return node;
}

describe('connecting an app to an account home', () => {
  test('the grant is a note from the account to the app key, for the chosen spaces only', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    const groceries = await node.spaces.create({ name: 'Groceries', visibility: 'private' });
    await node.spaces.create({ name: 'Diary', visibility: 'private' });
    const key = await appKey();

    const request: ConnectRequest = { v: 1, audience: key.did, name: 'Todo', access: 'write' };
    const grant = await auth.grant({ origin: 'https://todo.test', request, spaceIds: [groceries.id] });

    const { payload } = parseUCAN(grant.token);
    assert.equal(payload.iss, auth.getState().session!.did);
    assert.equal(payload.aud, key.did);
    assert.deepEqual(payload.att, [{ with: `space:${groceries.id}`, can: 'expression/*' }]);
    assert.deepEqual(grant.spaces.map((space) => space.name), ['Groceries']);
    assert.equal(auth.connections()[0]?.origin, 'https://todo.test');
  });

  test('the app writes in its space, and the account sees it; it cannot write anywhere else', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode, did } = auth.getState().session!;
    const groceries = await homeNode.spaces.create({ name: 'Groceries', visibility: 'private' });
    const key = await appKey();

    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: { v: 1, audience: key.did, access: 'write' },
      spaceIds: [groceries.id],
    });
    const todo = await app(hub, grant, key);
    assert.equal(todo.did, did, 'the app acts for the account');
    assert.equal(todo.sessionDid, key.did, 'with its own key');

    const milk = await todo.records.put(groceries.id, 'app.todo.item', { text: 'milk' });
    await homeNode.spaces.open(groceries.id);
    await until(async () => (await homeNode.records.get(groceries.id, milk.key)) !== null, 3000, 'the record to reach the home');
    const seen = await homeNode.records.get(groceries.id, milk.key);
    assert.equal(seen?.verified, true);
    assert.equal(seen?.root, did);

    // A space the app makes for itself is outside the note.
    const own = await todo.spaces.create({ name: 'Mine', visibility: 'private' }).catch(() => null);
    if (own) await assert.rejects(() => todo.records.put(own.id, 'app.todo.item', { text: 'nope' }));
  });

  test('spaces the app asked for are made by the home, in the account', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: { v: 1, audience: key.did, access: 'write', create: [{ name: 'Todos', visibility: 'private' }] },
      spaceIds: [],
    });
    assert.equal(grant.spaces[0]?.name, 'Todos');
    const listed = await auth.getState().session!.node.spaces.list();
    assert.ok(listed.some((space) => space.id === grant.spaces[0]?.id), 'the account holds it');

    const todo = await app(hub, grant, key);
    await todo.records.put(grant.spaces[0]!.id, 'app.todo.item', { text: 'first' });
  });

  test('read access carries no write: the app cannot change a thing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const shared = await auth.getState().session!.node.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://viewer.test',
      request: { v: 1, audience: key.did, access: 'read' },
      spaceIds: [shared.id],
    });
    const viewer = await app(hub, grant, key);
    await assert.rejects(() => viewer.records.put(shared.id, 'app.note', { text: 'hi' }));
  });

  test('whole-account access: the app sees every space, and a space it makes lands in the account', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const diary = await homeNode.spaces.create({ name: 'Diary', visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://browser.test',
      request: { v: 1, audience: key.did, access: 'write', scope: 'account' },
      spaceIds: [],
    });
    assert.equal(grant.scope, 'account');
    assert.ok(grant.accountKey);
    assert.deepEqual(parseUCAN(grant.token).payload.att, [{ with: '*', can: 'expression/*' }]);

    const browser = await app(hub, grant, key);
    await until(async () => (await browser.spaces.list()).some((space) => space.id === diary.id), 3000, 'the account list to reach the app');
    await browser.records.put(diary.id, 'app.note', { text: 'dear diary' });

    const made = await browser.spaces.create({ name: 'Made by the app', visibility: 'private' });
    await browser.records.put(made.id, 'app.note', { text: 'mine' });
    await until(async () => (await homeNode.spaces.list()).some((space) => space.id === made.id), 3000, 'the new space to reach the home');
    assert.equal(auth.connections()[0]?.scope, 'account');
  });

  test('disconnecting forgets the app', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const key = await appKey();
    await auth.grant({ origin: 'https://todo.test', request: { v: 1, audience: key.did, access: 'read' }, spaceIds: [] });
    await auth.disconnect('https://todo.test');
    assert.deepEqual(auth.connections(), []);
  });

  test('disconnecting revokes the note: the app stops counting at once, and what it wrote before stays', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({ origin: 'https://todo.test', request: { v: 1, audience: key.did, access: 'write' }, spaceIds: [shared.id] });
    // The app holds no secret of the space's: what lets it write is the note alone.
    assert.equal(parseSpaceInvite(grant.spaces[0]!.invite).invite, undefined);

    const todo = await app(hub, grant, key);
    const before = await todo.records.put(shared.id, 'app.todo.item', { text: 'before' });
    await homeNode.spaces.open(shared.id);
    await until(async () => (await homeNode.records.get(shared.id, before.key)) !== null, 3000, 'the app’s record to reach the home');

    await auth.disconnect('https://todo.test');
    assert.deepEqual(auth.connections(), []);
    await until(
      async () => todo.records.put(shared.id, 'app.todo.item', { text: 'after' }).then(() => false, (error: Error) => /revoked/.test(error.message)),
      3000,
      'the revoke to reach the app',
    );
    assert.equal((await homeNode.records.get(shared.id, before.key))?.verified, true);
  });
});

describe('an account home typed by a person', () => {
  test('a bare address becomes its https connect page', () => {
    assert.equal(homeAddress('weave.example.com'), 'https://weave.example.com/connect');
    assert.equal(homeAddress(' https://weave.example.com/ '), 'https://weave.example.com/connect');
    assert.equal(homeAddress('https://me.example/weave/connect#x'), 'https://me.example/weave/connect');
  });

  test('plain http only for this machine', () => {
    assert.equal(homeAddress('localhost:5174'), 'http://localhost:5174/connect');
    assert.throws(() => homeAddress('http://weave.example.com'), /https/);
  });

  test('something that is not an address says so', () => {
    assert.throws(() => homeAddress(''), /address/);
    assert.throws(() => homeAddress('not a url at all'), /not a web address/);
  });

  test('the grant carries the home\'s relays', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const accounts = createFolderAccountStore(createMemoryDirectory().handle);
    const stores = memoryStores();
    const values = new Map<string, string>([['weave.stay-signed-in', '"never"']]);
    const auth = createWeaveAuth({
      rpId: 'home.test',
      storage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => void values.set(k, v), removeItem: (k) => void values.delete(k) },
      browser: { accounts: async () => accounts, stores: () => stores },
      network: { relays: ['wss://relay.of-the-home.test'], transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
    });
    await auth.start();
    await auth.createAccount('Ada');
    cleanup.push(() => auth.signOut());
    const key = await appKey();
    const grant = await auth.grant({ origin: 'https://todo.test', request: { v: 1, audience: key.did, access: 'read' }, spaceIds: [] });
    assert.deepEqual(grant.relays, ['wss://relay.of-the-home.test']);
  });
});
