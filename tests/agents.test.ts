/**
 * Agents acting for a person: they write under a note that says "agent", so
 * every record shows it, and no peer lets them change a space's collections
 * or who may do what. Apps they invent arrive as proposals a person adds.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { runAction } from '../src/node/actions.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { AGENT_FACT, isAgentNote } from '../src/identity/agent-note.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression, type CreateExpressionParams } from '../src/schema/expression.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { describeCollection } from '../src/records/describe.js';
import { checkRules } from '../src/records/rules.js';
import { addApp, checkApp, copyApp, createScreenBridge, reviewApp, SCREEN_CLIENT, vote, poll, type App } from '../src/schemas/index.js';
import { createWeaveAuth, type WeaveAuth } from '../src/session/auth.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { seenBy } from './helpers/as-member.js';
import { joined } from './helpers/joined.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { team } from '../src/space/presets.js';
import { memberKey } from '../src/space/space-access.js';
import { nextVersion } from '../src/records/version.js';

const open: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function person(hub: FakeHub) {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(generateSeed());
  const stores = memoryStores();
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores,
    watchIntervalMs: 0,
    network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
  });
  open.push(node);
  return { node, me, manager, stores };
}
type Person = Awaited<ReturnType<typeof person>>;

async function until(predicate: () => Promise<boolean>, ms = 4000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/** An agent key for this person, and a note from their account saying it is an agent's, for these spaces */
async function agentFor(who: Person, spaces: ReadonlyArray<string>, facts = [AGENT_FACT]) {
  const provider = who.manager.getProvider();
  const keys = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
  const note = await createLocalRootSigner(who.me, provider).delegate({
    audience: did,
    capabilities: spaces.map((id) => ({ with: `space:${id}`, can: 'expression/*' })),
    expiration: Math.floor(Date.now() / 1000) + 3600,
    facts,
  });
  return { keys, did, note: note.encoded };
}

/** A version the agent signs by hand — past every check its node would make — slipped into the person's store */
async function forgeAsAgent(who: Person, space: string, fields: Omit<CreateExpressionParams<unknown>, 'author' | 'space' | 'proof'>) {
  const agent = await agentFor(who, [space]);
  const provider = who.manager.getProvider();
  const signed = await createSigner(provider).sign(
    createExpression({ seen: await seenBy(who.node, space), ...fields, author: agent.did, space, proof: agent.note }),
    agent.keys.privateKey,
  );
  await createStorageProvider(await who.stores(`spaces/${space}`)).addExpression(signed);
  return signed;
}

/** Alice owns a team space; Bob is an editor there */
async function setup() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Climbing', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.spaces.open(space);
  await joined(bob.node, space);
  await bob.node.spaces.open(space);
  return { hub, alice, bob, space };
}

const carpool: App = {
  title: 'Carpool',
  description: 'Who drives to the gym on Saturday',
  needs: [
    {
      name: 'app.carpool.trip',
      title: 'Trip',
      schema: { type: 'object', properties: { when: { type: 'string' }, seats: { type: 'integer', minimum: 1 } }, required: ['when', 'seats'] },
      rules: { edit: 'creator', delete: 'creator' },
    },
    {
      name: 'app.carpool.seat',
      title: 'Seat',
      schema: { type: 'object', properties: {} },
      links: { trip: { to: ['app.carpool.trip'], cardinality: 'one' } },
      rules: { edit: 'creator', delete: 'creator', onePer: ['@author', 'link:trip'] },
    },
  ],
};

describe('an agent acting for a person', () => {
  test('what it writes counts as the person\'s, and every peer sees it came via an agent', async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    assert.equal(helper.did, alice.node.did);
    assert.equal(helper.sessionDid, agent.did);

    const note = await helper.records.put(space, 'app.note', { text: 'Bring chalk' });
    assert.equal(note.viaAgent, true);
    const mine = await alice.node.records.put(space, 'app.note', { text: 'Bring rope' });
    assert.equal(mine.viaAgent, undefined, 'the person\'s own writes are not marked');

    await until(async () => (await bob.node.records.get(space, note.key)) !== null, 4000, 'the record to reach Bob');
    const seen = await bob.node.records.get(space, note.key);
    assert.equal(seen?.verified, true);
    assert.equal(seen?.root, alice.node.did);
    assert.equal(seen?.viaAgent, true);
  });

  test('it only reaches the spaces its note names', async () => {
    const { alice, space } = await setup();
    const { id: other } = await alice.node.spaces.create({ name: 'Diary', visibility: 'private' });
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    assert.deepEqual((await helper.spaces.list()).map((s) => s.id), [space]);
    await assert.rejects(() => helper.records.list(other), /not given this space/);
    await assert.rejects(() => helper.records.put(other, 'app.note', { text: 'x' }), /not given this space/);
  });

  test('it cannot define collections, change roles, invite, or join — those need a person', async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    await assert.rejects(() => helper.collections.define(space, { name: 'app.x', schema: { type: 'object' } }), /apps_propose/);
    await assert.rejects(() => helper.spaces.invite(space), /Ask the person/);
    await assert.rejects(() => helper.spaces.setMember(space, bob.node.did, null), /Ask the person/);
    await assert.rejects(() => helper.spaces.join('anything'), /Ask the person/);
    await assert.rejects(() => runAction(helper, 'collections_define', { space, name: 'app.x', schema: { type: 'object' } }), /apps_propose/);
  });

  test('a plain note will not do: the agent must be named as one', async () => {
    const { alice, space } = await setup();
    const plain = await agentFor(alice, [space], []);
    assert.equal(isAgentNote(plain.note), false);
    await assert.rejects(() => alice.node.asAgent({ keys: plain.keys, note: plain.note }), /not an agent/);
  });

  test('a definition an agent signs by hand is ignored by every peer', async () => {
    const { alice, bob, space } = await setup();
    await alice.node.spaces.close(space);
    const forged = await forgeAsAgent(alice, space, {
      collection: 'sys.collection',
      body: { name: 'app.sneaky', schema: { type: 'object' }, version: 1 },
      retain: true,
      version: { key: 'collection:app.sneaky', seq: 0 },
    });
    await alice.node.spaces.open(space);
    // Refused on arrival as not a change anyone may make; even the agent's own person ignores it.
    await settle(500);
    assert.equal(await createStorageProvider(await bob.stores(`spaces/${space}`)).getExpression(forged.id), null);
    assert.equal((await alice.node.collections.list(space)).some((c) => c.name === 'app.sneaky' && c.version !== null), false);
    assert.equal((await bob.node.collections.list(space)).some((c) => c.name === 'app.sneaky' && c.version !== null), false);
  });

  test('taking someone out of the space, signed by an agent, is ignored too', async () => {
    const { alice, bob, space } = await setup();
    const held = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(await memberKey(bob.node.did));
    assert.ok(held, 'Alice holds Bob\'s member record');
    await alice.node.spaces.close(space);
    await forgeAsAgent(alice, space, {
      collection: 'sys.member',
      body: { did: bob.node.did, role: null },
      retain: true,
      version: nextVersion(held!),
    });
    await alice.node.spaces.open(space);
    await settle(500);
    assert.equal((await bob.node.spaces.access(space)).role?.name, 'editor');
    assert.equal((await alice.node.spaces.access(space)).members.find((m) => m.did === bob.node.did)?.role, 'editor');
  });
});

describe('apps an agent proposes', () => {
  test('an agent proposes, a person adds, and the space then has the collections', async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });

    const proposed = (await runAction(helper, 'apps_propose', { space, ...carpool })) as { key: string; needs: Array<{ status: string; summary: string[] }> };
    assert.deepEqual(proposed.needs.map((n) => n.status), ['new', 'new']);
    assert.ok(proposed.needs[1]!.summary.includes('One seat per person per trip — adding another changes the first.'));
    assert.equal((await alice.node.collections.list(space)).some((c) => c.name === 'app.carpool.trip'), false, 'nothing is defined yet');

    // Bob sees it, and that an agent proposed it.
    await until(async () => (await bob.node.records.get(space, proposed.key)) !== null, 4000, 'the proposal to reach Bob');
    const listed = (await runAction(bob.node, 'apps_list', { space })) as Array<{ title: string; viaAgent?: boolean; added: boolean; proposedBy: string }>;
    assert.equal(listed[0]?.title, 'Carpool');
    assert.equal(listed[0]?.viaAgent, true);
    assert.equal(listed[0]?.added, false);
    assert.equal(listed[0]?.proposedBy, alice.node.did);

    // The agent can't add it, whatever route it takes.
    await assert.rejects(() => addApp(helper, space, proposed.key), /apps_propose|can't/);

    // Bob, an editor, may define collections: he adds it.
    const review = await addApp(bob.node, space, proposed.key);
    assert.equal(review.added, true);
    const names = (await bob.node.collections.list(space)).filter((c) => c.version !== null).map((c) => c.name);
    assert.ok(names.includes('app.carpool.trip') && names.includes('app.carpool.seat') && names.includes('std.app'));

    // And the agent can now use it, as Alice.
    const trip = await helper.records.put(space, 'app.carpool.trip', { when: 'Saturday 9:00', seats: 3 });
    await helper.records.put(space, 'app.carpool.seat', {}, { links: [{ rel: 'trip', to: trip.key }] });
  });

  test('a proposal that changes a collection the space has says so, and says how', async () => {
    const { alice, space } = await setup();
    await alice.node.collections.define(space, { ...carpool.needs[0]!, rules: {} });
    const review = reviewApp(carpool, await alice.node.collections.list(space));
    assert.equal(review.needs[0]?.status, 'change');
    assert.deepEqual(review.needs[0]?.changes, ['changes who may do what']);
    assert.equal(review.needs[1]?.status, 'new');
  });

  test('copying an app into another space proposes it there, and says where it came from', async () => {
    const { alice, space } = await setup();
    const { id: other } = await alice.node.spaces.create({ name: 'Other gym', visibility: 'public' });
    const proposed = await alice.node.records.put(space, 'std.app', carpool);
    const copy = await copyApp(alice.node, space, proposed.key, other);
    assert.equal(copy.body?.from, `${space}/${proposed.key}`);
    assert.equal((await alice.node.collections.list(other)).some((c) => c.name === 'app.carpool.trip'), false);
  });

  test('a proposal may not name the protocol\'s own collections, a version, or one collection twice', () => {
    assert.match(checkApp({ title: 'x', needs: [{ name: 'sys.role', schema: { type: 'object' } }] })!, /protocol's own/);
    assert.match(checkApp({ title: 'x', needs: [{ name: 'app.a', schema: { type: 'object' }, version: 3 }] })!, /version/);
    assert.match(checkApp({ title: 'x', needs: [carpool.needs[0], carpool.needs[0]] })!, /twice/);
    assert.match(checkApp({ title: 'x', needs: [] })!, /1–10/);
    assert.equal(checkApp(carpool), null);
  });
});

describe('what a collection allows, in words', () => {
  test('a vote, from its rules', () => {
    assert.deepEqual(describeCollection(vote), [
      'Anyone in the space can add a vote.',
      'Only whoever added a vote can change or remove it.',
      'One vote per person per poll — adding another changes the first.',
      'Each vote points at one thing: a poll (“about”).',
    ]);
  });

  test('a poll: different people change and remove, a fixed field, a permission', () => {
    assert.deepEqual(describeCollection(poll), [
      'Anyone in the space can add a poll.',
      'Only whoever added a poll can change it.',
      'Only whoever added a poll or those allowed to moderate can remove it.',
      'Once a poll is added, its “options” can\'t be changed.',
      'Roles in the space can be given permission to “moderate”.',
    ]);
  });

  test('one per something that isn\'t per person: the first one holds it, unless anyone may change it', () => {
    const seat = { name: 'app.chess.seat', title: 'Seat', rules: { edit: 'creator' as const, onePer: ['color'] } };
    assert.ok(describeCollection(seat).includes('One seat per color — whoever adds it first holds it.'));
    assert.ok(describeCollection({ ...seat, rules: { onePer: ['color'] } }).includes('One seat per color — anyone adding another replaces the first.'));
  });

  test('no rules still says something: the defaults', () => {
    assert.deepEqual(describeCollection({ name: 'app.note' }), [
      'Anyone in the space can add a note.',
      'Anyone in the space can change or remove any note.',
    ]);
  });

  test('every rule the protocol accepts adds a sentence, and one it does not know is refused', () => {
    // The rule names checkRules lists in its error — the source of truth for what a rule can be.
    const known = /use ([^)]+)\)/.exec(checkRules({ nope: 1 })!)![1]!.split(', ');
    const samples: Record<string, unknown> = { create: 'creator', edit: 'creator', delete: 'creator', onePer: ['@author'], fixed: ['x'] };
    const baseline = describeCollection({ name: 'app.thing' });
    for (const rule of known) {
      assert.ok(rule in samples, `describe.ts has no sample for the rule "${rule}" — add one, and a sentence for it`);
      const said = describeCollection({ name: 'app.thing', rules: { [rule]: rule === 'create' ? 'can:post' : samples[rule] } as never, permissions: ['post'] });
      assert.notDeepEqual(said.filter((s) => !s.includes('permission')), baseline, `the rule "${rule}" changes nothing in the summary`);
    }
    assert.throws(() => describeCollection({ name: 'app.thing', rules: { someday: true } as never }), /No way to describe/);
  });
});

describe('an agent connected through the account home', () => {
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
    open.push({ close: () => auth.signOut() });
    return auth;
  }

  test('the home signs an agent note, kept apart from the app\'s own; the app going takes its agent too', async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const { node } = auth.getState().session!;
    const gym = await node.spaces.create({ name: 'Gym', visibility: 'private' });
    const origin = 'https://app.test';

    const app = await auth.grant({ origin, request: { v: 1, audience: 'did:key:zApp', access: 'write' }, spaceIds: [gym.id] });
    const agent = await auth.grant({ origin, request: { v: 1, audience: 'did:key:zAgent', access: 'write', agent: true }, spaceIds: [gym.id] });
    assert.equal(isAgentNote(app.token), false);
    assert.equal(isAgentNote(agent.token), true);
    assert.equal(agent.agent, true);
    assert.equal(agent.accountKey, undefined);
    assert.equal(auth.connections().length, 2, 'the agent does not replace the app');

    await assert.rejects(
      () => auth.grant({ origin, request: { v: 1, audience: 'did:key:zAgent', access: 'write', agent: true, scope: 'account' }, spaceIds: [] }),
      /chosen spaces only/,
    );

    await auth.disconnect(origin, { agent: true });
    assert.deepEqual(auth.connections().map((c) => c.audience), ['did:key:zApp']);
    await auth.grant({ origin, request: { v: 1, audience: 'did:key:zAgent2', access: 'write', agent: true }, spaceIds: [gym.id] });
    await auth.disconnect(origin);
    assert.equal(auth.connections().length, 0);
  });
});

void (null as unknown as P2PNode);

describe('screens', () => {
  const board = '<!doctype html><div id="board"></div><script>weave.list("app.chess.game")</script>';

  test('a definition carries its screen to every peer; one too large is refused', async () => {
    const { alice, bob, space } = await setup();
    await alice.node.collections.define(space, { name: 'app.chess.game', schema: { type: 'object' }, screen: board });
    await until(async () => (await bob.node.collections.list(space)).some((c) => c.name === 'app.chess.game' && c.screen === board), 4000, 'the screen to reach Bob');
    await assert.rejects(
      () => alice.node.collections.define(space, { name: 'app.big', schema: { type: 'object' }, screen: 'x'.repeat(49 * 1024) }),
      /at most 48 KB/,
    );
  });

  test('a proposal that adds a screen says so, and apps_list names it', async () => {
    const { alice, space } = await setup();
    const chess: App = { title: 'Chess', needs: [{ name: 'app.chess.game', schema: { type: 'object' }, screen: board }] };
    const proposed = await alice.node.records.put(space, 'std.app', chess);
    const listed = (await runAction(alice.node, 'apps_list', { space })) as Array<{ key: string; screen?: string }>;
    assert.equal(listed.find((a) => a.key === proposed.key)?.screen, 'app.chess.game');
    await alice.node.collections.define(space, { name: 'app.chess.game', schema: { type: 'object' } });
    assert.deepEqual(reviewApp(chess, await alice.node.collections.list(space)).needs[0]?.changes, ['gives it a screen']);
    assert.match(String(await runAction(alice.node, 'apps_screen_guide', {})), /window\.weave/);
  });

  test('the script in front of a screen sets up weave, with me readable both ways', () => {
    const port = { postMessage: () => {}, onmessage: null as unknown };
    const window: Record<string, unknown> = { __weave: { port, me: { did: 'did:key:zMe', name: 'Anna' }, collections: ['app.chess.game'] } };
    new Function('window', 'addEventListener', 'document', SCREEN_CLIENT)(window, () => {}, {});
    const weave = window.weave as { me: { did: string; name: string } & (() => { did: string; name: string }); collections: string[] };
    assert.equal(window.__weave, undefined, 'the port is not left lying around');
    assert.equal(weave.me.did, 'did:key:zMe');
    assert.equal(weave.me.name, 'Anna');
    assert.deepEqual(weave.me(), { did: 'did:key:zMe', name: 'Anna' });
    assert.deepEqual(weave.collections, ['app.chess.game']);
  });

  test('the bridge answers for its app\'s collections only, as the person looking, under the rules', async () => {
    const { alice, bob, space } = await setup();
    await alice.node.collections.define(space, { name: 'app.chess.game', schema: { type: 'object' }, rules: { edit: 'creator' } });
    await alice.node.records.put(space, 'app.secret', { pin: 1234 });
    await until(async () => (await bob.node.collections.list(space)).some((c) => c.name === 'app.chess.game' && c.version !== null), 4000, 'the definition');

    const channel = new MessageChannel();
    const bridge = createScreenBridge({ node: bob.node, spaceId: space, collections: ['app.chess.game'], port: channel.port1 });
    let next = 0;
    const call = (method: string, ...args: unknown[]) =>
      new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
        const id = ++next;
        const listen = (event: MessageEvent) => {
          if (event.data?.id !== id) return;
          channel.port2.removeEventListener('message', listen);
          resolve(event.data);
        };
        channel.port2.addEventListener('message', listen);
        channel.port2.start();
        channel.port2.postMessage({ id, method, args });
      });
    try {
      const secret = await call('list', 'app.secret');
      assert.equal(secret.ok, false);
      assert.match(secret.error!, /can't use/);

      const game = await call('put', 'app.chess.game', { white: 'bob' });
      assert.equal(game.ok, true);
      assert.equal((game.value as { mine: boolean }).mine, true);
      const created = await bob.node.records.get(space, (game.value as { key: string }).key);
      assert.equal(created?.root, bob.node.did, 'written as the person looking');

      // Alice's game: Bob may not change it, and the screen hears why.
      const hers = await alice.node.records.put(space, 'app.chess.game', { white: 'alice' });
      await until(async () => (await bob.node.records.get(space, hers.key)) !== null, 4000, 'Alice\'s game');
      const refused = await call('update', hers.key, { white: 'bob' });
      assert.equal(refused.ok, false);
      assert.match(refused.error!, /whoever created it/);

      // Written by guessing: one object per call, a where, id and data. It works, and a wrong call says how to call it.
      const guessed = await call('put', { collection: 'app.chess.game', body: { status: 'open' } });
      assert.equal(guessed.ok, true);
      const listed = await call('list', { collection: 'app.chess.game', where: { status: 'open' } });
      const open = listed.value as Array<{ id: string; key: string; data: { status: string } }>;
      assert.equal(open.length, 1);
      assert.equal(open[0]!.id, open[0]!.key);
      assert.equal(open[0]!.data.status, 'open');
      const wrong = await call('list', 42);
      assert.match(wrong.error!, /Name the collection as text, like weave\.list\("app\.chess\.game"\)/);
    } finally {
      bridge.close();
      channel.port2.close();
    }
  });
});
