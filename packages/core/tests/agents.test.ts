/**
 * Agents acting for a person: they write under a note that says "agent", so
 * every record shows it, and no peer lets them change a space's collections
 * or who may do what. Apps they invent arrive as proposals a person adds.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from 'node:vm';
import * as z from 'zod';

import { createNode } from '../src/node/node.js';
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
import { checkStoredCollection } from '../src/schema/collection-def.js';
import type { NodeCollection } from '../src/node/types.js';
import { checkRules, type CollectionRules } from '../src/records/rules.js';
import {
  addApp,
  checkApp,
  copyApp,
  createScreenBridge,
  reviewApp,
  SCREEN_CLIENT,
  screenDocument,
  screenPolicy,
  standardDefinition,
  standardSchemas,
  vote,
  poll,
  message,
  useSchemas as addSchemas,
  type App,
  type AppDefinition,
} from '../src/schemas/index.js';
import { createWeaveAuth, type WeaveAuth } from '../src/session/auth.js';
import { grantSigner, type Grant } from '../src/session/connect.js';
import { acceptAgentLink, newAgentCode, offerAgentLink, readAgentCode } from '../src/session/agent-link.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { base64UrlDecode, base64UrlEncode } from '../src/utils/encoding.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { seenBy } from './helpers/as-member.js';
import { joined } from './helpers/joined.js';
import { stored } from './helpers/stored.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { team } from '../src/space/presets.js';
import { memberKey } from '../src/space/space-access.js';
import { nextVersion } from '../src/records/version.js';
import { hold, letGo } from './helpers/hold.js';
import { isRecord } from '../src/utils/guards.js';
import { until } from './helpers/until.js';

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
async function forgeAsAgent(
  who: Person,
  space: string,
  fields: Omit<CreateExpressionParams<unknown>, 'author' | 'space' | 'proof'>,
) {
  const agent = await agentFor(who, [space]);
  const provider = who.manager.getProvider();
  const signed = await createSigner(provider).sign(
    createExpression({
      seen: await seenBy(who.node, space),
      ...fields,
      author: agent.did,
      space,
      proof: agent.note,
    }),
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
  await hold(alice.node, space);
  await joined(bob.node, space);
  await hold(bob.node, space);
  return { hub, alice, bob, space };
}

const carpool: App = {
  title: 'Carpool',
  description: 'Who drives to the gym on Saturday',
  needs: [
    {
      name: 'app.carpool.trip',
      title: 'Trip',
      schema: {
        type: 'object',
        properties: { when: { type: 'string' }, seats: { type: 'integer', minimum: 1 } },
        required: ['when', 'seats'],
      },
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
  test("what it writes counts as the person's, and every peer sees it came via an agent", async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    assert.equal(helper.did, alice.node.did);
    assert.equal(helper.sessionDid, agent.did);

    const note = await helper.records.put(space, 'app.note', { text: 'Bring chalk' });
    assert.equal(note.viaAgent, true);
    const mine = await alice.node.records.put(space, 'app.note', { text: 'Bring rope' });
    assert.equal(mine.viaAgent, undefined, "the person's own writes are not marked");

    await until(
      async () => (await bob.node.records.get(space, note.key)) !== null,
      4000,
      'the record to reach Bob',
    );
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
    assert.deepEqual(
      (await helper.spaces.list()).map((s) => s.id),
      [space],
    );
    await assert.rejects(() => helper.records.list(other), /not given this space/);
    await assert.rejects(() => helper.records.put(other, 'app.note', { text: 'x' }), /not given this space/);
  });

  test('it cannot define collections, change roles, invite, or join — those need a person', async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    await assert.rejects(
      () => helper.collections.define(space, { name: 'app.x', schema: { type: 'object' } }),
      /apps_propose/,
    );
    await assert.rejects(() => helper.spaces.invite(space), /Ask the person/);
    await assert.rejects(() => helper.spaces.setMember(space, bob.node.did, null), /Ask the person/);
    await assert.rejects(() => helper.spaces.join('anything'), /Ask the person/);
    await assert.rejects(
      () => runAction(helper, 'collections_define', { space, name: 'app.x', schema: { type: 'object' } }),
      /apps_propose/,
    );
  });

  test("it cannot change a space's key, relays or keepers — not even one it was not given", async () => {
    const { alice, space } = await setup();
    const { id: other } = await alice.node.spaces.create({ name: 'Diary', visibility: 'private' });
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    const before = (await alice.node.spaces.access(other)).key?.changes;
    for (const id of [space, other]) {
      await assert.rejects(() => helper.spaces.changeKey(id), /Ask the person/);
      await assert.rejects(() => helper.spaces.setRelays(id, ['wss://elsewhere.example']), /Ask the person/);
      await assert.rejects(() => helper.spaces.setKeepers(id, []), /Ask the person/);
    }
    assert.equal((await alice.node.spaces.access(other)).key?.changes, before);
  });

  test('a plain note will not do: the agent must be named as one', async () => {
    const { alice, space } = await setup();
    const plain = await agentFor(alice, [space], []);
    assert.equal(isAgentNote(plain.note), false);
    await assert.rejects(() => alice.node.asAgent({ keys: plain.keys, note: plain.note }), /not an agent/);
  });

  test('a definition an agent signs by hand is ignored by every peer', async () => {
    const { alice, bob, space } = await setup();
    await letGo(alice.node, space);
    const forged = await forgeAsAgent(alice, space, {
      collection: 'sys.collection',
      body: { name: 'app.sneaky', schema: { type: 'object' }, version: 1 },
      retain: true,
      version: { key: 'collection:app.sneaky', seq: 0 },
    });
    await hold(alice.node, space);
    // Refused on arrival as not a change anyone may make; even the agent's own person ignores it.
    await settle(500);
    assert.equal(
      await createStorageProvider(await bob.stores(`spaces/${space}`)).getExpression(forged.id),
      null,
    );
    assert.equal(
      (await alice.node.collections.list(space)).some((c) => c.name === 'app.sneaky' && c.version !== null),
      false,
    );
    assert.equal(
      (await bob.node.collections.list(space)).some((c) => c.name === 'app.sneaky' && c.version !== null),
      false,
    );
  });

  test('taking someone out of the space, signed by an agent, is ignored too', async () => {
    const { alice, bob, space } = await setup();
    // Bob knowing he joined is not Alice having heard it yet.
    await until(
      async () =>
        (await (await stored(alice.stores, space)).getCurrent(await memberKey(bob.node.did))) !== null,
      4000,
      "Alice to hold Bob's member record",
    );
    const held = await (await stored(alice.stores, space)).getCurrent(await memberKey(bob.node.did));
    await letGo(alice.node, space);
    await forgeAsAgent(alice, space, {
      collection: 'sys.member',
      body: { did: bob.node.did, role: null },
      retain: true,
      version: nextVersion(held!),
    });
    await hold(alice.node, space);
    await settle(500);
    assert.equal((await bob.node.spaces.access(space)).role?.name, 'editor');
    assert.equal(
      (await alice.node.spaces.access(space)).members.find((m) => m.did === bob.node.did)?.role,
      'editor',
    );
  });
});

describe('apps an agent proposes', () => {
  test('an agent proposes, a person adds, and the space then has the collections', async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });

    const proposed = z
      .object({
        key: z.string(),
        needs: z.array(z.object({ status: z.string(), summary: z.array(z.string()) })),
      })
      .parse(await runAction(helper, 'apps_propose', { space, ...carpool }));
    assert.deepEqual(
      proposed.needs.map((n) => n.status),
      ['new', 'new'],
    );
    assert.ok(
      proposed.needs[1]!.summary.includes('One seat per person per trip — adding another changes the first.'),
    );
    assert.equal(
      (await alice.node.collections.list(space)).some((c) => c.name === 'app.carpool.trip'),
      false,
      'nothing is defined yet',
    );

    // Bob sees it, and that an agent proposed it.
    await until(
      async () => (await bob.node.records.get(space, proposed.key)) !== null,
      4000,
      'the proposal to reach Bob',
    );
    const listed = z
      .array(
        z.object({
          title: z.string(),
          viaAgent: z.boolean().optional(),
          added: z.boolean(),
          proposedBy: z.string(),
        }),
      )
      .parse(await runAction(bob.node, 'apps_list', { space }));
    assert.equal(listed[0]?.title, 'Carpool');
    assert.equal(listed[0]?.viaAgent, true);
    assert.equal(listed[0]?.added, false);
    assert.equal(listed[0]?.proposedBy, alice.node.did);

    // The agent can't add it, whatever route it takes.
    await assert.rejects(() => addApp(helper, space, proposed.key), /apps_propose|can't/);

    // Bob, an editor, may define collections: he adds it.
    const review = await addApp(bob.node, space, proposed.key);
    assert.equal(review.added, true);
    const names = (await bob.node.collections.list(space))
      .filter((c) => c.version !== null)
      .map((c) => c.name);
    assert.ok(
      names.includes('app.carpool.trip') && names.includes('app.carpool.seat') && names.includes('std.app'),
    );

    // And the agent can now use it, as Alice.
    const trip = await helper.records.put(space, 'app.carpool.trip', { when: 'Saturday 9:00', seats: 3 });
    await helper.records.put(space, 'app.carpool.seat', {}, { links: [{ rel: 'trip', to: trip.key }] });
  });

  test('an update replaces the app it names: once added, the old version is not offered again', async () => {
    const { alice, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    const Listed = z.array(
      z.object({
        key: z.string(),
        added: z.boolean(),
        superseded: z.boolean(),
        updates: z.string().optional(),
      }),
    );
    const Proposed = z.object({ key: z.string() });
    const list = async () => Listed.parse(await runAction(alice.node, 'apps_list', { space }));
    const find = async (key: string) => (await list()).find((a) => a.key === key)!;
    const [trip, seat] = carpool.needs;
    assert.ok(trip && seat && isRecord(trip.schema.properties));
    const properties = trip.schema.properties;
    const withField = (field: string): App => ({
      ...carpool,
      needs: [
        { ...trip, schema: { ...trip.schema, properties: { ...properties, [field]: { type: 'string' } } } },
        seat,
      ],
    });

    const first = Proposed.parse(await runAction(helper, 'apps_propose', { space, ...carpool }));
    await addApp(alice.node, space, first.key);

    // The agent changes it: a new proposal that names the one it updates.
    const second = Proposed.parse(
      await runAction(helper, 'apps_propose', { space, ...withField('from'), updates: first.key }),
    );
    assert.equal((await find(second.key)).updates, first.key);
    assert.deepEqual(
      [(await find(first.key)).added, (await find(first.key)).superseded],
      [true, false],
      'the added app stays until its update is',
    );

    await addApp(alice.node, space, second.key);
    assert.deepEqual([(await find(first.key)).added, (await find(first.key)).superseded], [false, true]);
    assert.equal((await find(second.key)).added, true);

    // Adding the old version again would only undo the update: refused.
    await assert.rejects(() => addApp(alice.node, space, first.key), /newer version/);

    // An update to the update replaces both before it.
    const third = Proposed.parse(
      await runAction(helper, 'apps_propose', { space, ...withField('note'), updates: second.key }),
    );
    await addApp(alice.node, space, third.key);
    assert.deepEqual(
      (await list())
        .filter((a) => a.superseded)
        .map((a) => a.key)
        .sort(),
      [first.key, second.key].sort(),
    );
    await assert.rejects(() => addApp(alice.node, space, second.key), /newer version/);

    // An update must name an app that is here.
    await assert.rejects(
      () => runAction(helper, 'apps_propose', { space, ...carpool, updates: 'nothing' }),
      /names no app/,
    );
    assert.match(checkApp({ ...carpool, updates: '' })!, /updates/);
  });

  test('a proposal that changes a collection the space has says so, and says how', async () => {
    const { alice, space } = await setup();
    await alice.node.collections.define(space, { ...carpool.needs[0]!, rules: {} });
    const review = reviewApp(carpool, await alice.node.collections.list(space));
    assert.equal(review.needs[0]?.status, 'change');
    assert.deepEqual(review.needs[0]?.changes, ['changes who may do what']);
    assert.equal(review.needs[1]?.status, 'new');
  });

  test('a change to a collection another app uses names that app, and warns the agent', async () => {
    const { alice, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    const Proposed = z.object({
      key: z.string(),
      warnings: z.array(z.string()).optional(),
      needs: z.array(
        z.object({ name: z.string(), status: z.string(), usedBy: z.array(z.string()).optional() }),
      ),
    });
    const first = Proposed.parse(await runAction(helper, 'apps_propose', { space, ...carpool }));
    await addApp(alice.node, space, first.key);

    const [trip] = carpool.needs;
    assert.ok(trip);
    const rides = { title: 'Rides', needs: [{ ...trip, schema: { type: 'object', properties: {} } }] };
    const clash = Proposed.parse(await runAction(helper, 'apps_propose', { space, ...rides }));
    assert.deepEqual(clash.needs[0]?.usedBy, ['Carpool']);
    assert.match(clash.warnings?.[0] ?? '', /app\.carpool\.trip, which Carpool uses/);

    // As a new version of Carpool itself, it touches nothing else.
    const update = Proposed.parse(
      await runAction(helper, 'apps_propose', { space, ...rides, updates: first.key }),
    );
    assert.equal(update.warnings, undefined);
    assert.equal(update.needs[0]?.usedBy, undefined);
  });

  test('a standard collection by name is exactly the library’s; a look-alike std.* is refused', async () => {
    const { alice, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    const host = { name: 'meetup.host', schema: { type: 'object', properties: {} } };
    const Proposed = z.object({ key: z.string() });

    const proposed = Proposed.parse(
      await runAction(helper, 'apps_propose', {
        space,
        title: 'Meetups',
        needs: ['std.event', 'std.rsvp', host],
      }),
    );
    const record = await alice.node.records.get<App>(space, proposed.key);
    const stored = record?.body?.needs ?? [];
    assert.deepEqual(
      stored.map((n) => n.name),
      ['std.event', 'std.rsvp', 'meetup.host'],
    );
    assert.deepEqual(stored[0]?.rules, standardDefinition('std.event')?.rules);
    assert.deepEqual(stored[1]?.links, standardDefinition('std.rsvp')?.links);

    // Its own screen on a standard collection is fine; its own shape is not.
    const event = standardDefinition('std.event')!;
    await runAction(helper, 'apps_propose', {
      space,
      title: 'Calendar',
      needs: [{ ...event, screen: '<p>A month</p>' }],
    });
    await assert.rejects(
      () =>
        runAction(helper, 'apps_propose', {
          space,
          title: 'Calendar',
          needs: [{ ...event, rules: { edit: 'member' } }],
        }),
      /different shape/,
    );
    await assert.rejects(
      () => runAction(helper, 'apps_propose', { space, title: 'X', needs: ['std.made-up'] }),
      /not in the standard library/,
    );
  });

  test('collections_standard lists the library by area, and gives definitions in full', async () => {
    const { alice } = await setup();
    const Areas = z.array(
      z.object({ area: z.string(), collections: z.array(z.object({ name: z.string(), title: z.string() })) }),
    );
    const areas = Areas.parse(await runAction(alice.node, 'collections_standard', {}));
    const listed = areas.flatMap((a) => a.collections.map((c) => c.name));
    assert.equal(listed.length, standardSchemas.length);
    assert.ok(listed.includes('std.event') && listed.includes('std.list-item'));

    const Full = z.array(
      z.object({ name: z.string(), schema: z.object({}).loose(), summary: z.array(z.string()) }),
    );
    const [rsvp] = Full.parse(await runAction(alice.node, 'collections_standard', { names: ['std.rsvp'] }));
    assert.equal(rsvp?.name, 'std.rsvp');
    assert.ok(rsvp?.summary.some((line) => /One rsvp per person per event/.test(line)));
    await assert.rejects(
      () => runAction(alice.node, 'collections_standard', { names: ['std.nope'] }),
      /not in the standard library/,
    );
  });

  test('copying an app into another space proposes it there, and says where it came from', async () => {
    const { alice, space } = await setup();
    const { id: other } = await alice.node.spaces.create({ name: 'Other gym', visibility: 'public' });
    const proposed = await alice.node.records.put(space, 'std.app', carpool);
    const copy = await copyApp(alice.node, space, proposed.key, other);
    assert.equal(copy.body?.from, `${space}/${proposed.key}`);
    assert.equal(
      (await alice.node.collections.list(other)).some((c) => c.name === 'app.carpool.trip'),
      false,
    );
  });

  test("a proposal may not name the protocol's own collections, a version, or one collection twice", () => {
    assert.match(
      checkApp({ title: 'x', needs: [{ name: 'sys.role', schema: { type: 'object' } }] })!,
      /protocol's own/,
    );
    assert.match(
      checkApp({ title: 'x', needs: [{ name: 'app.a', schema: { type: 'object' }, version: 3 }] })!,
      /version/,
    );
    assert.match(checkApp({ title: 'x', needs: [carpool.needs[0], carpool.needs[0]] })!, /twice/);
    assert.match(checkApp({ title: 'x', needs: [] })!, /1–10/);
    assert.equal(checkApp(carpool), null);
  });

  test("an app made against an earlier standard definition is met by the library's current one, not offered as a change back", async () => {
    const { alice, space } = await setup();
    // std.message as it was before mentions and replies, the way an older proposal holds it.
    const earlier: AppDefinition = {
      name: message.name,
      title: 'Message',
      schema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 10000 } },
        required: ['text'],
      },
      rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
      permissions: ['moderate'],
    };
    const oldChat: App = { title: 'Old chat', needs: [earlier] };

    await alice.node.collections.define(space, earlier);
    assert.equal(reviewApp(oldChat, await alice.node.collections.list(space)).added, true);
    await addSchemas(alice.node, space, [message]); // the library skips a collection the space has
    await alice.node.collections.define(space, message); // moving it to the current one is a choice

    const now = await alice.node.collections.list(space);
    assert.equal(reviewApp(oldChat, now).added, true);
    // Its own screen is still its own: a need that brings one is a change.
    const withScreen: App = { title: 'Chat with a screen', needs: [{ ...earlier, screen: '<p>hi</p>' }] };
    const screened = reviewApp(withScreen, now).needs[0];
    assert.equal(screened?.status, 'change');
    assert.ok(screened?.changes.includes('gives it a screen'));
    // And a collection of an app's own is compared as it is.
    assert.equal(reviewApp({ ...carpool, needs: [carpool.needs[0]!] }, now).needs[0]?.status, 'new');
  });

  test('an app says what is worth hearing about, only in its own collections', async () => {
    const trips = { label: 'New trip', collection: 'app.carpool.trip' };
    const mine = {
      label: 'A seat on my trip',
      collection: 'app.carpool.seat',
      topic: { field: 'to', me: true },
    };
    assert.equal(checkApp({ ...carpool, notify: [trips, mine] }), null);
    assert.match(
      checkApp({ ...carpool, notify: [{ label: 'Any message', collection: 'std.message' }] })!,
      /not one of the app's needs/,
    );
    assert.match(checkApp({ ...carpool, notify: [{ ...trips, spaces: ['x'] }] })!, /leaves out spaces/);
    assert.match(checkApp({ ...carpool, notify: [{ ...trips, open: 'https://x.example/' }] })!, /leaves out/);
    assert.match(checkApp({ ...carpool, notify: [{ ...trips, label: '' }] })!, /label/);
    assert.match(checkApp({ ...carpool, notify: [] })!, /1–8/);
    assert.match(checkApp({ ...carpool, notify: Array.from({ length: 9 }, () => trips) })!, /1–8/);

    // A proposal keeps it, a bad one is refused, and a copy carries it along.
    const { alice, space } = await setup();
    const proposed = z
      .object({ key: z.string() })
      .parse(await runAction(alice.node, 'apps_propose', { space, ...carpool, notify: [trips] }));
    const record = await alice.node.records.get<App>(space, proposed.key);
    assert.deepEqual(record?.body?.notify, [trips]);
    await assert.rejects(
      () =>
        runAction(alice.node, 'apps_propose', {
          space,
          ...carpool,
          notify: [{ label: 'x', collection: 'std.message' }],
        }),
      /not one of the app's needs/,
    );
    const { id: other } = await alice.node.spaces.create({ name: 'Other gym', visibility: 'public' });
    const copy = await copyApp(alice.node, space, proposed.key, other);
    assert.deepEqual(copy.body?.notify, [trips]);
  });
});

describe('what a collection allows, in words', () => {
  test('a vote, from its rules', () => {
    assert.deepEqual(describeCollection(vote), [
      'Anyone in the space can add a vote.',
      'Only whoever added a vote can change or remove it.',
      'One vote per person per poll or proposal — adding another changes the first.',
      'Each vote points at one thing: a poll or a proposal (“about”).',
    ]);
  });

  test('a poll: different people change and remove, a fixed field, a permission', () => {
    assert.deepEqual(describeCollection(poll), [
      'Anyone in the space can add a poll.',
      'Only whoever added a poll can change it.',
      'Only whoever added a poll or those allowed to moderate can remove it.',
      "Once a poll is added, its “options” can't be changed.",
      'Roles in the space can be given permission to “moderate”.',
    ]);
  });

  test("one per something that isn't per person: the first one holds it, unless anyone may change it", () => {
    const seat = {
      name: 'app.chess.seat',
      title: 'Seat',
      rules: { edit: 'creator' as const, onePer: ['color'] },
    };
    assert.ok(describeCollection(seat).includes('One seat per color — whoever adds it first holds it.'));
    assert.ok(
      describeCollection({ ...seat, rules: { onePer: ['color'] } }).includes(
        'One seat per color — anyone adding another replaces the first.',
      ),
    );
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
    const samples: Record<string, CollectionRules> = {
      create: { create: 'can:post' },
      edit: { edit: 'creator' },
      delete: { delete: 'creator' },
      onePer: { onePer: ['@author'] },
      fixed: { fixed: ['x'] },
    };
    const baseline = describeCollection({ name: 'app.thing' });
    for (const rule of known) {
      assert.ok(
        rule in samples,
        `describe.ts has no sample for the rule "${rule}" — add one, and a sentence for it`,
      );
      const said = describeCollection({ name: 'app.thing', rules: samples[rule]!, permissions: ['post'] });
      assert.notDeepEqual(
        said.filter((s) => !s.includes('permission')),
        baseline,
        `the rule "${rule}" changes nothing in the summary`,
      );
    }
    // A rule from some later version, beside one this version knows.
    const later = { edit: 'creator' as const, someday: true };
    assert.throws(() => describeCollection({ name: 'app.thing', rules: later }), /No way to describe/);
  });
});

describe('an agent connected through the account home', () => {
  async function home(hub: FakeHub): Promise<WeaveAuth> {
    const accounts = createFolderAccountStore(createMemoryDirectory().handle);
    const stores = memoryStores();
    const values = new Map<string, string>([['weave.stay-signed-in', '"never"']]);
    const auth = createWeaveAuth({
      rpId: 'home.test',
      storage: {
        getItem: (k) => values.get(k) ?? null,
        setItem: (k, v) => void values.set(k, v),
        removeItem: (k) => void values.delete(k),
      },
      browser: { accounts: async () => accounts, stores: () => stores },
      network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
    });
    await auth.start();
    await auth.createAccount('Ada');
    auth.codeSaved();
    open.push({ close: () => auth.signOut() });
    return auth;
  }

  test("the home signs an agent note, kept apart from the app's own; the app going takes its agents too", async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const { node } = auth.getState().session!;
    const gym = await node.spaces.create({ name: 'Gym', visibility: 'private' });
    const origin = 'https://app.test';

    const app = await auth.grant({
      origin,
      request: { v: 1, audience: 'did:key:zApp', access: 'write' },
      spaceIds: [gym.id],
    });
    const agent = await auth.grant({
      origin,
      request: { v: 1, audience: 'did:key:zAgent', access: 'write', agent: true },
      spaceIds: [gym.id],
    });
    assert.equal(isAgentNote(app.token), false);
    assert.equal(isAgentNote(agent.token), true);
    assert.equal(agent.agent, true);
    assert.equal(agent.accountKey, undefined);
    assert.equal(auth.connections().length, 2, 'the agent does not replace the app');

    await assert.rejects(
      () =>
        auth.grant({
          origin,
          request: {
            v: 1,
            audience: 'did:key:zAgent',
            access: 'write',
            agent: true,
            create: [{ name: 'Mine', visibility: 'private' }],
          },
          spaceIds: [],
        }),
      /spaces that exist/,
    );

    await auth.disconnect(origin, { agent: true });
    assert.deepEqual(
      auth.connections().map((c) => c.audience),
      ['did:key:zApp'],
    );
    await auth.grant({
      origin,
      request: { v: 1, audience: 'did:key:zAgent2', access: 'write', agent: true },
      spaceIds: [gym.id],
    });
    await auth.disconnect(origin);
    assert.equal(auth.connections().length, 0);
  });

  test('an agent on a computer gets the whole account, for as long as asked; each is its own connection', async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const origin = 'https://app.test';
    const whole = { v: 1, access: 'write', agent: true, scope: 'account', chooseSpaces: false } as const;

    const laptop = await auth.grant({
      origin,
      request: { ...whole, audience: 'did:key:zLaptop', name: 'Agent on laptop', days: 30 },
      spaceIds: [],
    });
    const desk = await auth.grant({
      origin,
      request: { ...whole, audience: 'did:key:zDesk', name: 'Agent on desk', days: 1 },
      spaceIds: [],
    });
    assert.ok(laptop.accountKey, 'it follows the account, so spaces made later reach it');
    assert.ok(isAgentNote(laptop.token));
    assert.equal(
      laptop.contactKey,
      undefined,
      'the whole account, but never the contact key: it opens contact requests and knocks',
    );
    const app = await auth.grant({
      origin: 'https://whole.test',
      request: { v: 1, access: 'write', scope: 'account', audience: 'did:key:zWholeApp' },
      spaceIds: [],
    });
    assert.ok(app.contactKey, 'an app given the whole account does get it');
    await auth.disconnect('https://whole.test');
    const day = 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(laptop.expiresAt - (now + 30 * day)) < 60);
    assert.ok(Math.abs(desk.expiresAt - (now + day)) < 60);
    assert.equal(auth.connections().length, 2, 'a second agent does not replace the first');

    await auth.disconnect(origin, { audience: 'did:key:zLaptop' });
    assert.deepEqual(
      auth.connections().map((c) => c.name),
      ['Agent on desk'],
    );
  });
});

describe('an agent running a node of its own', () => {
  /** What `weave connect` ends up with: its own key, and the home's grant for the whole account */
  async function agentNode(
    who: { me: Person['me']; manager: Person['manager']; seed: Uint8Array },
    hub: FakeHub,
  ) {
    const provider = who.manager.getProvider();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(who.me, provider).delegate({
      audience: did,
      capabilities: [{ with: '*', can: 'expression/*' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
      facts: [AGENT_FACT],
    });
    const grant: Grant = {
      v: 1,
      did: who.me.did,
      name: 'Ada',
      token: note.encoded,
      access: 'write',
      scope: 'account',
      spaces: [],
      accountKey: base64UrlEncode(await deriveVaultKeyBytes(who.seed)),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      agent: true,
      home: 'https://home.test/connect',
    };
    const base = await createNode({
      signer: grantSigner(grant),
      sessionKey: keys,
      stores: memoryStores(),
      accountKey: base64UrlDecode(grant.accountKey!),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(base);
    return { base, node: await base.asAgent({ keys, note: note.encoded }), did };
  }

  async function accountHolder(hub: FakeHub) {
    const manager = createIdentityManager();
    const seed = generateSeed();
    const me = await manager.fromSeed(seed);
    const stores = memoryStores();
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores,
      accountKey: await deriveVaultKeyBytes(seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(node);
    return { node, me, manager, stores, seed };
  }

  test("it finds the account's spaces by itself — ones made later too — and writes in them via agent", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const before = await ada.node.spaces.create({ name: 'Before', visibility: 'private' });
    const agent = await agentNode(ada, hub);
    await until(
      async () => (await agent.node.spaces.list()).some((space) => space.id === before.id),
      4000,
      'the space made before',
    );

    const after = await ada.node.spaces.create({ name: 'After', visibility: 'private' });
    await until(
      async () => (await agent.node.spaces.list()).some((space) => space.id === after.id),
      4000,
      'the space made after',
    );

    await hold(agent.node, after.id);
    await hold(ada.node, after.id);
    const note = await agent.node.records.put(after.id, 'app.note', { text: 'from the terminal' });
    await until(
      async () => (await ada.node.records.get(after.id, note.key)) !== null,
      4000,
      'the note reaching Ada',
    );
    const seen = await ada.node.records.get(after.id, note.key);
    assert.equal(seen?.viaAgent, true);
    assert.equal(seen?.createdBy, ada.me.did);
  });

  test('it never writes the account itself: not its list of spaces, not its name', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const home = await ada.node.spaces.create({ name: 'Home', visibility: 'private' });
    const agent = await agentNode(ada, hub);
    await until(
      async () => (await agent.node.spaces.list()).length === 1,
      4000,
      'the agent following the account',
    );
    await assert.rejects(() => agent.node.spaces.leave(home.id), /can't leave spaces/);
    // Past the agent's wrapper, on the node underneath: the account's own space refuses it too.
    await assert.rejects(() => agent.base.spaces.leave(home.id), /agent can't change the account/);
    await assert.rejects(() => agent.base.account.setName('Hacked'), /agent can't change the account/);
    await settle();
    assert.deepEqual(
      (await ada.node.spaces.list()).map((space) => space.name),
      ['Home'],
    );
  });
});

describe('connecting an agent with a code', () => {
  test("the app asks the person, the terminal gets a checked agent's note", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const provider = who.manager.getProvider();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const network = { relays: [], transport: (peer: string) => hub.transport(peer, 'agent-link') };

    const stages: string[] = [];
    const offer = await offerAgentLink(network, (stage) => {
      stages.push(stage.kind);
      if (stage.kind !== 'asking') return;
      assert.equal(stage.agent.name, 'Agent on laptop');
      void (async () => {
        const note = await createLocalRootSigner(who.me, provider).delegate({
          audience: stage.agent.did,
          capabilities: [{ with: '*', can: 'expression/*' }],
          expiration: Math.floor(Date.now() / 1000) + 3600,
          facts: [AGENT_FACT],
        });
        await stage.allow({
          v: 1,
          did: who.me.did,
          name: 'Ada',
          token: note.encoded,
          access: 'write',
          scope: 'account',
          spaces: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          agent: true,
          home: 'https://home.test/connect',
        });
      })();
    });
    open.push({ close: async () => offer.stop() });

    // Someone with a different code in the same place gets nowhere.
    await assert.rejects(
      () =>
        acceptAgentLink({
          code: newAgentCode(),
          did: 'did:key:zStranger',
          name: 'x',
          network,
          findTimeoutMs: 300,
        }),
      /did not answer/,
    );

    const grant = await acceptAgentLink({
      code: `npx weave connect ${offer.code}`,
      did,
      name: 'Agent on laptop',
      network,
    });
    assert.equal(grant.did, who.me.did);
    assert.ok(isAgentNote(grant.token));
    await until(async () => stages.includes('connected'), 2000, 'the app hearing it worked');
    assert.deepEqual(stages, ['waiting', 'asking', 'connected']);
  });

  test('saying no reaches the terminal, and a note for another key is refused', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const network = { relays: [], transport: (peer: string) => hub.transport(peer, 'agent-link') };
    const offer = await offerAgentLink(network, (stage) => {
      if (stage.kind === 'asking') stage.deny('Not today.');
    });
    open.push({ close: async () => offer.stop() });
    await assert.rejects(
      () => acceptAgentLink({ code: offer.code, did: 'did:key:zLaptop', name: 'Agent', network }),
      /Not today/,
    );
    assert.throws(() => readAgentCode('wv_short'), /not a connect code/);
  });
});

/** Runs the script put in front of a screen, compiled as a function of the globals it reads so a test can hand it fakes. */
function runScreenClient(window: unknown, addEventListener: unknown, document: unknown): void {
  const script = compileFunction(SCREEN_CLIENT, ['window', 'addEventListener', 'document']);
  Reflect.apply(script, undefined, [window, addEventListener, document]);
}

describe('screens', () => {
  const board = '<!doctype html><div id="board"></div><script>weave.list("app.chess.game")</script>';

  test('a definition carries its screen to every peer; one too large is refused', async () => {
    const { alice, bob, space } = await setup();
    await alice.node.collections.define(space, {
      name: 'app.chess.game',
      schema: { type: 'object' },
      screen: board,
    });
    await until(
      async () =>
        (await bob.node.collections.list(space)).some(
          (c) => c.name === 'app.chess.game' && c.screen === board,
        ),
      4000,
      'the screen to reach Bob',
    );
    // Where it may connect travels with it, through collections_define as an agent's tools give it.
    await runAction(alice.node, 'collections_define', {
      space,
      name: 'app.chess.clock',
      schema: { type: 'object' },
      screen: board,
      network: ['https://time.example.com'],
    });
    await until(
      async () =>
        (await bob.node.collections.list(space)).find((c) => c.name === 'app.chess.clock')?.network?.[0] ===
        'https://time.example.com',
      4000,
      'its network to reach Bob',
    );
    await assert.rejects(
      () =>
        alice.node.collections.define(space, {
          name: 'app.big',
          schema: { type: 'object' },
          screen: 'x'.repeat(49 * 1024),
        }),
      /at most 48 KB/,
    );
  });

  test('a proposal that adds a screen says so, and apps_list names it', async () => {
    const { alice, space } = await setup();
    const chess: App = {
      title: 'Chess',
      needs: [{ name: 'app.chess.game', schema: { type: 'object' }, screen: board }],
    };
    const proposed = await alice.node.records.put(space, 'std.app', chess);
    const listed = z
      .array(z.object({ key: z.string(), screen: z.string().optional() }))
      .parse(await runAction(alice.node, 'apps_list', { space }));
    assert.equal(listed.find((a) => a.key === proposed.key)?.screen, 'app.chess.game');
    await alice.node.collections.define(space, { name: 'app.chess.game', schema: { type: 'object' } });
    assert.deepEqual(reviewApp(chess, await alice.node.collections.list(space)).needs[0]?.changes, [
      'gives it a screen',
    ]);
    assert.match(String(await runAction(alice.node, 'apps_screen_guide', {})), /window\.weave/);
  });

  test('the script in front of a screen sets up weave, with me readable both ways', () => {
    const port: { postMessage: () => void; onmessage: unknown } = { postMessage: () => {}, onmessage: null };
    const window: Record<string, unknown> = {
      __weave: { port, me: { did: 'did:key:zMe', name: 'Anna' }, collections: ['app.chess.game'] },
    };
    runScreenClient(window, () => {}, {});
    const weave = window.weave;
    assert.ok(isRecord(weave));
    const { me } = weave;
    assert.ok(typeof me === 'function' && 'did' in me);
    assert.equal(window.__weave, undefined, 'the port is not left lying around');
    assert.equal(me.did, 'did:key:zMe');
    assert.equal(me.name, 'Anna');
    assert.deepEqual(Reflect.apply(me, undefined, []), { did: 'did:key:zMe', name: 'Anna' });
    assert.deepEqual(weave.collections, ['app.chess.game']);
  });

  test("the script in front of a screen shows the screen's own errors, not those of a browser extension in its frame", () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const shown: string[] = [];
    const bar = {
      id: '',
      style: {},
      setAttribute: () => {},
      set textContent(text: string) {
        shown.push(text);
      },
    };
    const document = {
      getElementById: () => null,
      createElement: () => bar,
      body: { appendChild: () => {} },
    };
    const window: Record<string, unknown> = {
      __weave: { port: { postMessage: () => {} }, me: { did: 'did:key:zMe', name: 'Anna' }, collections: [] },
    };
    runScreenClient(
      window,
      (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      document,
    );

    const metamask = new Error('Failed to connect to MetaMask');
    metamask.stack =
      'Error: Failed to connect to MetaMask\n    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:1:21277)';
    listeners.unhandledrejection!({ reason: metamask });
    listeners.error!({
      message: 'Uncaught TypeError: x is undefined',
      filename: 'moz-extension://abc/content.js',
      error: null,
    });
    assert.deepEqual(shown, [], "an extension's failures are not the screen's");

    listeners.error!({
      message: 'Uncaught ReferenceError: draw is not defined',
      filename: 'about:srcdoc',
      error: new ReferenceError('draw is not defined'),
    });
    listeners.unhandledrejection!({ reason: new Error('Only whoever added a ride can change it') });
    assert.deepEqual(shown, [
      'This screen hit an error: Uncaught ReferenceError: draw is not defined',
      'This screen hit an error: Only whoever added a ride can change it',
    ]);
  });

  test('a screen reaches only the exact origins its definition names, and the review says so', () => {
    const screen = '<p>Weather for the ride</p>';
    const ride: AppDefinition = {
      name: 'app.carpool.ride',
      schema: { type: 'object' },
      screen,
      network: ['https://api.open-meteo.com'],
    };
    const need = (network?: unknown) => ({
      name: 'app.carpool.ride',
      schema: { type: 'object' },
      screen,
      ...(network === undefined ? {} : { network }),
    });
    assert.equal(
      checkStoredCollection({
        ...need(['https://api.open-meteo.com', 'wss://feed.example.com:8443']),
        version: 1,
      }),
      null,
    );
    for (const wrong of [
      ['*'],
      ['https:'],
      ['http://api.example.com'],
      ['https://api.example.com/v1'],
      ['https://API.example.com'],
      ['https://localhost'],
      ['https://a.example.com; connect-src *'],
      ['https://a.example.com', 'https://a.example.com'],
      Array.from({ length: 9 }, (_, i) => `https://h${i}.example.com`),
      'https://api.example.com',
    ]) {
      assert.notEqual(
        checkStoredCollection({ ...need(wrong), version: 1 }),
        null,
        `refuses ${JSON.stringify(wrong)}`,
      );
    }
    assert.match(
      checkStoredCollection({
        name: 'app.x.y',
        schema: { type: 'object' },
        network: ['https://api.example.com'],
        version: 1,
      }) ?? '',
      /no screen/,
    );

    // The policy written in front of the screen: nothing, or exactly those origins — never more, even if handed junk.
    assert.match(screenPolicy([]), /connect-src 'none'/);
    assert.match(
      screenPolicy(['https://api.open-meteo.com']),
      /connect-src https:\/\/api\.open-meteo\.com;.*img-src|img-src data: blob: https:\/\/api\.open-meteo\.com/,
    );
    assert.match(
      screenPolicy(['https://api.open-meteo.com']),
      /connect-src https:\/\/api\.open-meteo\.com(;|$)/,
    );
    assert.match(screenPolicy(['*']), /connect-src 'none'/);
    // Hosts allow forms in the frame (spec 06 §5.5) only because every policy sends them nowhere.
    assert.match(screenPolicy([]), /form-action 'none'/);
    assert.match(screenPolicy(['https://api.open-meteo.com']), /form-action 'none'/);
    assert.ok(
      screenDocument(screen, ['https://api.open-meteo.com']).startsWith(
        '<meta http-equiv="Content-Security-Policy"',
      ),
      'the policy comes before any script',
    );

    // Said in the review, worked out from the definition; and adding an origin later is a change someone must approve.
    const summary = describeCollection(ride);
    assert.match(
      summary.at(-1)!,
      /Its screen can connect to api\.open-meteo\.com.*Each person is asked first/,
    );
    const held: NodeCollection = {
      name: 'app.carpool.ride',
      schema: { type: 'object' },
      screen,
      version: 1,
      history: 'latest',
      links: {},
      definedBy: null,
      permissions: [],
      rules: {},
      topics: [],
      records: 0,
    };
    const review = reviewApp({ title: 'Carpool', needs: [ride] }, [held]);
    assert.deepEqual(review.needs[0]!.changes, ['lets its screen reach https://api.open-meteo.com']);
  });

  test("the bridge answers for its app's collections only, as the person looking, under the rules", async () => {
    const { alice, bob, space } = await setup();
    await alice.node.collections.define(space, {
      name: 'app.chess.game',
      schema: { type: 'object' },
      rules: { edit: 'creator' },
    });
    await alice.node.records.put(space, 'app.secret', { pin: 1234 });
    await until(
      async () =>
        (await bob.node.collections.list(space)).some(
          (c) => c.name === 'app.chess.game' && c.version !== null,
        ),
      4000,
      'the definition',
    );

    const channel = new MessageChannel();
    const bridge = createScreenBridge({
      node: bob.node,
      spaceId: space,
      collections: ['app.chess.game'],
      port: channel.port1,
    });
    const Answer = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() });
    let next = 0;
    const call = (method: string, ...args: unknown[]) =>
      new Promise<z.infer<typeof Answer>>((resolve) => {
        const id = ++next;
        const listen = (event: MessageEvent<unknown>) => {
          if (!isRecord(event.data) || event.data.id !== id) return;
          channel.port2.removeEventListener('message', listen);
          resolve(Answer.parse(event.data));
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
      const written = z.object({ mine: z.boolean(), key: z.string() }).parse(game.value);
      assert.equal(written.mine, true);
      const created = await bob.node.records.get(space, written.key);
      assert.equal(created?.root, bob.node.did, 'written as the person looking');

      // Alice's game: Bob may not change it, and the screen hears why.
      const hers = await alice.node.records.put(space, 'app.chess.game', { white: 'alice' });
      await until(async () => (await bob.node.records.get(space, hers.key)) !== null, 4000, "Alice's game");
      const refused = await call('update', hers.key, { white: 'bob' });
      assert.equal(refused.ok, false);
      assert.match(refused.error!, /whoever created it/);

      // Written by guessing: one object per call, a where, id and data. It works, and a wrong call says how to call it.
      const guessed = await call('put', { collection: 'app.chess.game', body: { status: 'open' } });
      assert.equal(guessed.ok, true);
      const listed = await call('list', { collection: 'app.chess.game', where: { status: 'open' } });
      const open = z
        .array(z.object({ id: z.string(), key: z.string(), data: z.object({ status: z.string() }) }))
        .parse(listed.value);
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
