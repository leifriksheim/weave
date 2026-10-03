/**
 * Liquid's rules between peers: what every device refuses, so a decision,
 * a party's position and a conflict mean the same on every device (#131).
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useSchemas } from '@weaveprotocol/core/schemas';
import type { P2PNode } from '@weaveprotocol/core';
import { createNode } from '../../../packages/core/src/node/node.js';
import { createIdentityManager } from '../../../packages/core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../../packages/core/src/identity/root-signer.js';
import { generateSeed } from '../../../packages/core/src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../../../packages/core/src/identity/did.js';
import { createSigner } from '../../../packages/core/src/schema/signer.js';
import { createExpression } from '../../../packages/core/src/schema/expression.js';
import { createStorageProvider } from '../../../packages/core/src/storage/storage-provider.js';
import { team } from '../../../packages/core/src/space/presets.js';
import { runChecks, type CheckedVersion } from '../../../packages/core/src/records/checks.js';
import { createFakeHub, type FakeHub } from '../../../packages/core/tests/helpers/fake-transport.js';
import { memoryStores } from '../../../packages/core/tests/helpers/memory-stores.js';
import { seenBy } from '../../../packages/core/tests/helpers/as-member.js';
import { hold } from '../../../packages/core/tests/helpers/hold.js';
import { joined } from '../../../packages/core/tests/helpers/joined.js';
import { until } from '../../../packages/core/tests/helpers/until.js';
import {
  ASSEMBLY,
  conflict,
  decision,
  party,
  partyBallot,
  partyRoll,
  proposal,
  vote,
  type Choice,
} from '../src/schema';

const open: P2PNode[] = [];
after(async () => {
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

/** Signs a version by hand, as a modified app could, into the writer's own copy of the space */
async function forge(who: Person, space: string, fields: Parameters<typeof createExpression>[0]) {
  const provider = who.manager.getProvider();
  const pair = await provider.generateKeyPair();
  const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const ucan = await createLocalRootSigner(who.me, provider).delegate({
    audience: keyDid,
    capabilities: [{ with: `space:${space}`, can: 'expression/write' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const signed = await createSigner(provider).sign(
    createExpression({
      seen: await seenBy(who.node, space),
      ...fields,
      author: keyDid,
      space,
      proof: ucan.encoded,
    }),
    pair.privateKey,
  );
  await createStorageProvider(await who.stores(`spaces/${space}`)).addExpression(signed);
  return signed;
}

/** Alice, Bob and Carol in an assembly; Dave joins later */
async function assembly() {
  const hub = createFakeHub({ latencyMs: 1 });
  const [alice, bob, carol, dave] = await Promise.all([person(hub), person(hub), person(hub), person(hub)]);
  const { id: space } = await alice.node.spaces.create({ name: 'Co-op', ...team, visibility: 'public' });
  await useSchemas(alice.node, space, ASSEMBLY);
  for (const who of [bob, carol]) await who.node.spaces.join(await alice.node.spaces.invite(space));
  for (const who of [alice, bob, carol]) await hold(who.node, space);
  for (const who of [bob, carol]) await joined(who.node, space);
  await until(
    async () =>
      (await carol.node.collections.list(space)).filter((c) => c.version !== null).length === ASSEMBLY.length,
    4000,
    'definitions to reach Carol',
  );
  const voters = [alice, bob, carol].map((p) => p.node.did).sort();
  await until(
    async () => (await alice.node.spaces.access(space)).members.length === 3,
    4000,
    'Alice to see everyone join',
  );
  return { hub, alice, bob, carol, dave, space, voters };
}

const about = (key: string) => ({ links: [{ rel: 'about', to: key }] });
const castBy = (who: Person, space: string, key: string, choice: Choice, via?: string) =>
  who.node.records.put(space, vote, { choice, ...(via ? { via } : {}) }, about(key));

describe('liquid: deciding a proposal', () => {
  test('a decision stands with more than half of the voters, and nothing less', async () => {
    const { alice, bob, carol, dave, space, voters } = await assembly();
    const put = await alice.node.records.put(space, proposal, { title: 'Bike racks', voters });
    const other = await alice.node.records.put(space, proposal, { title: 'Paint', voters });
    await until(async () => (await carol.node.records.get(space, other.key)) !== null, 4000, 'the proposals');

    const a = await castBy(alice, space, put.key, 'for');
    const b = await castBy(bob, space, put.key, 'for');
    const c = await castBy(carol, space, put.key, 'against');
    const elsewhere = await castBy(bob, space, other.key, 'for');
    await until(async () => (await alice.node.records.get(space, c.key)) !== null, 4000, 'the votes');

    const decide = (outcome: 'passed' | 'rejected', votes: string[], list = voters) =>
      alice.node.records.put(
        space,
        decision,
        { outcome, proposal: put.version, voters: list, votes },
        about(put.key),
      );

    await assert.rejects(decide('passed', [a.version]), /passes once as many voters as it needs/);
    await assert.rejects(
      decide('passed', [a.version, a.version]),
      /passes once as many voters as it needs/,
      'one voter cited twice is one',
    );
    await assert.rejects(decide('passed', [a.version, elsewhere.version]), /only votes on its proposal/);
    await assert.rejects(
      decide('rejected', [c.version, a.version]),
      /only votes on its proposal, by its voters, for its outcome/,
    );
    await assert.rejects(
      decide('passed', [a.version, b.version], [...voters, 'did:key:zSomeoneElse']),
      /its voters/,
    );

    // Dave joins after the proposal: his vote isn't one of its voters'.
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await joined(dave.node, space);
    await until(async () => (await dave.node.records.get(space, put.key)) !== null, 4000, 'the proposal');
    const d = await castBy(dave, space, put.key, 'for');
    await until(async () => (await alice.node.records.get(space, d.key)) !== null, 4000, 'Dave’s vote');
    await assert.rejects(decide('passed', [a.version, d.version]), /by its voters/);

    // A vote is final.
    await assert.rejects(alice.node.records.update(space, a.key, { choice: 'against' }), /is final/);
    await assert.rejects(alice.node.records.delete(space, a.key), /is final/);

    const decided = await decide('passed', [a.version, b.version]);
    await until(
      async () => (await carol.node.records.get(space, decided.key)) !== null,
      4000,
      'Carol to accept it',
    );
    // Final too: nobody takes a decision back.
    await assert.rejects(alice.node.records.delete(space, decided.key), /is final/);
  });

  test('a decision forged by hand is refused by every peer that receives it', async () => {
    const { alice, bob, space, voters } = await assembly();
    const put = await alice.node.records.put(space, proposal, { title: 'Bike racks', voters });
    const a = await castBy(alice, space, put.key, 'for');
    await until(async () => (await bob.node.records.get(space, a.key)) !== null, 4000, 'Alice’s vote');

    let rejected = '';
    bob.node.subscribe((event) => {
      if (event.type === 'rejected') rejected = event.reason;
    });
    await forge(alice, space, {
      author: '',
      collection: decision.name,
      body: { outcome: 'passed', proposal: put.version, voters, votes: [a.version] },
      links: [{ rel: 'about', to: put.key }],
      version: { key: (await decisionKey(alice, put.key)) ?? '', seq: 0 },
      retain: true,
    });
    await hold(alice.node, space);
    await until(async () => rejected !== '', 4000, 'Bob to refuse it');
    assert.match(rejected, /passes once as many voters as it needs/);
  });

  test('a decision follows the proposal’s own rule', async () => {
    const { alice, bob, carol, space, voters } = await assembly();
    // Everyone must vote for: two of three isn't enough, one against settles it.
    const put = await alice.node.records.put(space, proposal, { title: 'Sell the hall', voters, toPass: 3 });
    const a = await castBy(alice, space, put.key, 'for');
    const b = await castBy(bob, space, put.key, 'for');
    const c = await castBy(carol, space, put.key, 'against');
    await until(async () => (await alice.node.records.get(space, c.key)) !== null, 4000, 'the votes');
    const decide = (outcome: 'passed' | 'rejected', votes: string[]) =>
      alice.node.records.put(
        space,
        decision,
        { outcome, proposal: put.version, voters, votes },
        about(put.key),
      );
    await assert.rejects(decide('passed', [a.version, b.version]), /as many voters as it needs/);
    await decide('rejected', [c.version]);

    // Who votes is picked: two of the three, and one of them is enough.
    const two = [alice.node.did, bob.node.did].sort();
    const small = await alice.node.records.put(space, proposal, { title: 'Paint', voters: two, toPass: 1 });
    const mine = await castBy(alice, space, small.key, 'for');
    await alice.node.records.put(
      space,
      decision,
      { outcome: 'passed', proposal: small.version, voters: two, votes: [mine.version] },
      about(small.key),
    );
    // The rule is fixed once proposed.
    await assert.rejects(
      alice.node.records.update(space, small.key, { title: 'Paint', voters: two, toPass: 2 }),
      /toPass/,
    );
  });

  test('a proposal can’t need more votes for than it has voters', async () => {
    const { alice, space, voters } = await assembly();
    await assert.rejects(
      alice.node.records.put(space, proposal, { title: 'Too many', voters, toPass: 4 }),
      /more votes for than it has voters/,
    );
    await assert.rejects(alice.node.records.put(space, proposal, { title: 'None', voters, toPass: 0 }));
  });

  test('a proposal lists members only, each once', async () => {
    const { alice, space, voters } = await assembly();
    await assert.rejects(
      alice.node.records.put(space, proposal, { title: 'Stacked', voters: [...voters, voters[0]!] }),
      /each once/,
    );
    await assert.rejects(
      alice.node.records.put(space, proposal, {
        title: 'Outsiders',
        voters: [...voters, 'did:key:zNotHere'],
      }),
      /are members/,
    );
  });
});

describe('liquid: conflicts', () => {
  test('two first versions of one vote that disagree are a conflict; two votes that don’t, aren’t', async () => {
    const { alice, bob, space, voters } = await assembly();
    const put = await alice.node.records.put(space, proposal, { title: 'Bike racks', voters });
    await until(async () => (await bob.node.records.get(space, put.key)) !== null, 4000, 'the proposal');
    const a = await castBy(alice, space, put.key, 'for');
    const b = await castBy(bob, space, put.key, 'for');
    await until(async () => (await alice.node.records.get(space, b.key)) !== null, 4000, 'Bob’s vote');

    await assert.rejects(
      alice.node.records.put(
        space,
        conflict,
        { record: a.key, versions: [a.version, b.version] },
        about(put.key),
      ),
      /two first versions of one vote/,
    );

    // Alice signs a second first version of her vote, against, on another device.
    const twice = await forge(alice, space, {
      author: '',
      collection: vote.name,
      body: { choice: 'against' },
      links: [{ rel: 'about', to: put.key }],
      version: { key: a.key, seq: 0 },
      retain: true,
    });
    await hold(alice.node, space);
    // Both stand, as any two versions written apart do; Bob's device holds both.
    const bobStore = createStorageProvider(await bob.stores(`spaces/${space}`));
    await until(async () => (await bobStore.getExpression(twice.id)) !== null, 4000, 'the second vote');
    const proof = await bob.node.records.put(
      space,
      conflict,
      { record: a.key, versions: [a.version, twice.id] },
      about(put.key),
    );
    await until(async () => (await alice.node.records.get(space, proof.key)) !== null, 4000, 'the conflict');
  });
});

describe('liquid: parties', () => {
  test('stewards keep a party; a roll comes from a steward; a position counts members’ own votes', async () => {
    const { alice, bob, carol, space, voters } = await assembly();
    const [aliceDid, bobDid, carolDid] = [alice.node.did, bob.node.did, carol.node.did];
    await assert.rejects(
      alice.node.records.put(space, party, { name: 'Greens', members: [aliceDid], stewards: [bobDid] }),
      /Only a party’s stewards/,
    );
    const greens = await alice.node.records.put(space, party, {
      name: 'Greens',
      members: [aliceDid, bobDid, carolDid],
      stewards: [aliceDid, bobDid],
    });
    const put = await alice.node.records.put(space, proposal, { title: 'Bike racks', voters });
    await until(
      async () =>
        (await carol.node.records.get(space, put.key)) !== null &&
        (await bob.node.records.get(space, greens.key)) !== null,
      4000,
      'the party and proposal',
    );

    // Bob, a steward, may change it; Carol may not.
    await bob.node.records.update(space, greens.key, {
      name: 'The Greens',
      members: [aliceDid, bobDid, carolDid],
      stewards: [aliceDid, bobDid],
    });
    await until(
      async () =>
        (await carol.node.records.get<{ name: string }>(space, greens.key))?.body?.name === 'The Greens',
      4000,
      'Bob’s change',
    );
    const current = (await carol.node.records.get(space, greens.key))!;
    await assert.rejects(
      carol.node.records.update(space, greens.key, {
        name: 'Mine',
        members: [carolDid],
        stewards: [carolDid],
      }),
      /Only a party’s stewards/,
    );

    const links = {
      links: [
        { rel: 'party', to: greens.key },
        { rel: 'about', to: put.key },
      ],
    };
    const members = [aliceDid, bobDid, carolDid].sort();
    await assert.rejects(
      carol.node.records.put(space, partyRoll, { party: current.version, members }, links),
      /written by a steward/,
    );
    const roll = await bob.node.records.put(space, partyRoll, { party: current.version, members }, links);

    const a = await castBy(alice, space, put.key, 'for');
    const c = await castBy(carol, space, put.key, 'for', greens.key);
    await until(async () => (await bob.node.records.get(space, c.key)) !== null, 4000, 'the votes');
    const position = (votes: string[]) =>
      bob.node.records.put(space, partyBallot, { choice: 'for', roll: roll.version, members, votes }, links);
    await assert.rejects(position([a.version]), /as many members as its roll needs/);
    await assert.rejects(position([a.version, c.version]), /members’ own votes/);
    const b = await castBy(bob, space, put.key, 'for');
    const taken = await position([a.version, b.version]);
    await until(
      async () => (await carol.node.records.get(space, taken.key)) !== null,
      4000,
      'Carol to accept it',
    );
  });
});

describe('liquid: how a party decides', () => {
  test('a roll freezes the party’s share, and a position needs that many', async () => {
    const { alice, bob, carol, space, voters } = await assembly();
    const members = [alice.node.did, bob.node.did, carol.node.did].sort();
    const greens = await alice.node.records.put(space, party, {
      name: 'Greens',
      members,
      stewards: [alice.node.did],
      decides: 'everyone',
    });
    const put = await alice.node.records.put(space, proposal, { title: 'Bike racks', voters });
    const links = {
      links: [
        { rel: 'party', to: greens.key },
        { rel: 'about', to: put.key },
      ],
    };
    // Everyone of three is three: a roll saying two, or nothing, is refused.
    for (const wrong of [{ toTake: 2 }, {}, { representative: alice.node.did }])
      await assert.rejects(
        alice.node.records.put(space, partyRoll, { party: greens.version, members, ...wrong }, links),
        /freezes how the party decides/,
      );
    const roll = await alice.node.records.put(
      space,
      partyRoll,
      { party: greens.version, members, toTake: 3 },
      links,
    );
    const a = await castBy(alice, space, put.key, 'for');
    const b = await castBy(bob, space, put.key, 'for');
    await until(async () => (await alice.node.records.get(space, b.key)) !== null, 4000, 'Bob’s vote');
    await assert.rejects(
      alice.node.records.put(
        space,
        partyBallot,
        { choice: 'for', roll: roll.version, members, votes: [a.version, b.version] },
        links,
      ),
      /as many members as its roll needs/,
    );
    const c = await castBy(carol, space, put.key, 'for');
    await until(async () => (await alice.node.records.get(space, c.key)) !== null, 4000, 'Carol’s vote');
    await alice.node.records.put(
      space,
      partyBallot,
      { choice: 'for', roll: roll.version, members, votes: [a.version, b.version, c.version] },
      links,
    );
  });

  test('a representative’s own vote is the party’s position, and nobody else’s', async () => {
    const { alice, bob, carol, space, voters } = await assembly();
    const members = [alice.node.did, bob.node.did, carol.node.did].sort();
    await assert.rejects(
      alice.node.records.put(space, party, {
        name: 'Reds',
        members: [alice.node.did],
        stewards: [alice.node.did],
        decides: 'representative',
        representative: bob.node.did,
      }),
      /names one of its members/,
    );
    const reds = await alice.node.records.put(space, party, {
      name: 'Reds',
      members,
      stewards: [alice.node.did],
      decides: 'representative',
      representative: bob.node.did,
    });
    const put = await alice.node.records.put(space, proposal, { title: 'Paint', voters });
    const links = {
      links: [
        { rel: 'party', to: reds.key },
        { rel: 'about', to: put.key },
      ],
    };
    await assert.rejects(
      alice.node.records.put(
        space,
        partyRoll,
        { party: reds.version, members, representative: carol.node.did },
        links,
      ),
      /freezes how the party decides/,
    );
    const roll = await alice.node.records.put(
      space,
      partyRoll,
      { party: reds.version, members, representative: bob.node.did },
      links,
    );
    const a = await castBy(alice, space, put.key, 'against');
    const c = await castBy(carol, space, put.key, 'against');
    const b = await castBy(bob, space, put.key, 'for');
    await until(async () => (await alice.node.records.get(space, b.key)) !== null, 4000, 'the votes');
    const position = (choice: Choice, votes: string[]) =>
      alice.node.records.put(space, partyBallot, { choice, roll: roll.version, members, votes }, links);
    // Most members are against, but the representative decides.
    await assert.rejects(position('against', [a.version, c.version]), /or its representative did/);
    await position('for', [b.version]);
  });
});

describe('liquid: a decision fits in one check', () => {
  test('the largest proposal, 500 voters, decided by 251 votes, stays within the step limit', async () => {
    const voters = Array.from({ length: 500 }, (_, i) => `did:key:z${String(i).padStart(4, '0')}`);
    const cited: CheckedVersion[] = voters.slice(0, 251).map((did, i) => ({
      id: `b-vote-${i}`,
      key: `k-${i}`,
      collection: vote.name,
      seq: 0,
      author: did,
      createdAt: '2026-10-03T12:00:00.000Z',
      deleted: false,
      body: { choice: 'for' },
      links: [{ rel: 'about', to: 'proposal-key' }],
    }));
    const theProposal: CheckedVersion = {
      id: 'b-proposal',
      key: 'proposal-key',
      collection: proposal.name,
      seq: 0,
      author: voters[0]!,
      createdAt: '2026-10-03T12:00:00.000Z',
      deleted: false,
      body: { title: 'Big', voters },
      links: [],
    };
    const held = new Map([...cited, theProposal].map((v) => [v.id, v]));
    const outcome = await runChecks(decision.rules.check, {
      values: {
        body: { outcome: 'passed', proposal: theProposal.id, voters, votes: cited.map((v) => v.id) },
        links: [{ rel: 'about', to: 'proposal-key' }],
        author: voters[0],
        prev: null,
      },
      cite: async (id) => held.get(id) ?? { later: true },
      can: () => false,
      member: () => true,
    });
    assert.deepEqual(outcome, { passed: true });

    // The same, with the most a rule may ask for.
    const strict: CheckedVersion = {
      ...theProposal,
      id: 'b-strict',
      body: { title: 'Big', voters, toPass: 255 },
    };
    const most = Array.from({ length: 255 }, (_, i) => ({
      ...cited[0]!,
      id: `b-more-${i}`,
      author: voters[i]!,
    }));
    const heldStrict = new Map([...most, strict].map((v) => [v.id, v]));
    const strictOutcome = await runChecks(decision.rules.check, {
      values: {
        body: { outcome: 'passed', proposal: strict.id, voters, votes: most.map((v) => v.id) },
        links: [{ rel: 'about', to: 'proposal-key' }],
        author: voters[0],
        prev: null,
      },
      cite: async (id) => heldStrict.get(id) ?? { later: true },
      can: () => false,
      member: () => true,
    });
    assert.deepEqual(strictOutcome, { passed: true });
  });
});

/** The key a decision about a proposal must have: one per proposal */
async function decisionKey(who: Person, proposalKey: string): Promise<string | null> {
  const { onePerKey } = await import('../../../packages/core/src/records/rules.js');
  return onePerKey(decision.name, decision.rules.onePer, {
    root: who.node.did,
    links: [{ rel: 'about', to: proposalKey }],
    body: {},
  });
}
