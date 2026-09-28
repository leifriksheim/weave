/**
 * A node used across a message port, as a page uses one running in a worker:
 * the same API, events and watches as messages, and failures that come back
 * as errors instead of calls left waiting.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';

import { createNode } from '../src/node/node.js';
import { remoteNode, remoteSigner, serveNode, serveSigner } from '../src/node/remote.js';
import { remoteTransport, serveTransport } from '../src/network/remote-transport.js';
import type { CandidateSink, PeerTransportEvents, SignalledTransport } from '../src/network/transport.js';
import { createEmitter } from '../src/utils/events.js';
import type { NodeEvent, P2PNode } from '../src/node/types.js';
import type { Typed } from '../src/query/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { AGENT_FACT } from '../src/identity/agent-note.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { until } from './helpers/until.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Both ends of a fresh channel, closed after the test */
function channel() {
  const pair = new MessageChannel();
  cleanup.push(() => {
    pair.port1.close();
    pair.port2.close();
  });
  return pair;
}

/** A node served on one end of a channel, and the node seen from the other end */
async function served() {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(generateSeed());
  const signer = createLocalRootSigner(me, manager.getProvider());
  const node = await createNode({ signer, stores: memoryStores(), watchIntervalMs: 0 });
  const channel = new MessageChannel();
  const stop = serveNode(node, channel.port1);
  const remote = await remoteNode(channel.port2);
  cleanup.push(
    () => node.close(),
    () => {
      stop();
      channel.port1.close();
      channel.port2.close();
    },
  );
  return { node, remote, manager, me };
}

interface Todo {
  readonly text: string;
  readonly done: boolean;
}

describe('a node across a port', () => {
  test('answers as the node it stands for', async () => {
    const { node, remote } = await served();
    assert.equal(remote.did, node.did);
    assert.equal(remote.sessionDid, node.sessionDid);
    assert.equal(remote.delegation().encoded, node.delegation().encoded);
    assert.deepEqual(remote.network.status(), node.network.status());

    const { id: space } = await remote.spaces.create({ name: 'Groceries', ...team, visibility: 'private' });
    assert.deepEqual(
      (await node.spaces.list()).map((s) => s.id),
      [space],
    );
    const written = await remote.records.put(space, 'app.todo.item', { text: 'Milk', done: false });
    assert.deepEqual(
      await remote.records.get(space, written.key),
      await node.records.get(space, written.key),
    );
    const updated = await remote.records.update(space, written.key, { text: 'Milk', done: true });
    assert.notEqual(updated.version, written.version);
    assert.deepEqual(updated.body, { text: 'Milk', done: true });
  });

  test('typed collections and validators cross as their names and JSON Schema', async () => {
    const { remote } = await served();
    const { id: space } = await remote.spaces.create({ name: 'Todo', ...team, visibility: 'private' });

    const defined = await remote.collections.define(space, {
      name: 'app.todo.item',
      schema: z.object({ text: z.string(), done: z.boolean() }),
    });
    assert.deepEqual(defined.schema?.required, ['text', 'done']);

    const todos: Typed<Todo> = { name: 'app.todo.item' };
    await remote.records.put(space, todos, { text: 'Bread', done: false });
    const { records } = await remote.records.query(space, { collection: todos, where: { done: false } });
    assert.deepEqual(
      records.map((record) => record.body.text),
      ['Bread'],
    );
  });

  test('events and watches arrive as messages, and stop when asked', async () => {
    const { remote } = await served();
    const { id: space } = await remote.spaces.create({ name: 'Todo', ...team, visibility: 'private' });

    const events: NodeEvent[] = [];
    const unsubscribe = remote.subscribe((event) => events.push(event));
    const results: number[] = [];
    const stop = remote.records.watch(space, { collection: 'app.todo.item' }, (result) =>
      results.push(result.records.length),
    );
    await until(() => results.length > 0, 2000, 'the first result');

    await remote.records.put(space, 'app.todo.item', { text: 'Eggs', done: false });
    await until(() => results.at(-1) === 1, 2000, 'the watch to see the write');
    await until(
      () => events.some((event) => event.type === 'records' && event.space === space),
      2000,
      'a records event',
    );

    stop();
    unsubscribe();
    const seen = [results.length, events.length];
    await remote.records.put(space, 'app.todo.item', { text: 'Flour', done: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual([results.length, events.length], seen);
  });

  test("the node's refusals come back as errors with their messages", async () => {
    const { node, remote } = await served();
    const { id: space } = await node.spaces.create({ name: 'Todo', ...team, visibility: 'private' });
    const direct = await node.records.query(space, { collection: 'app.todo.item', limit: -1 }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(direct instanceof Error);
    await assert.rejects(() => remote.records.query(space, { collection: 'app.todo.item', limit: -1 }), {
      name: direct.name,
      message: direct.message,
    });
  });

  test('an argument that cannot be cloned is refused, not left waiting', async () => {
    const { remote } = await served();
    const { id: space } = await remote.spaces.create({ name: 'Todo', ...team, visibility: 'private' });
    await assert.rejects(() => remote.records.put(space, 'app.todo.item', { text: 'x', later: () => {} }));
    // The port still works after it.
    assert.equal((await remote.spaces.list()).length, 1);
  });

  test('previews an invite without asking the node, and holds a space until released', async () => {
    const { node, remote } = await served();
    const { id: space } = await node.spaces.create({ name: 'Climbing', ...team, visibility: 'public' });
    const invite = await remote.spaces.invite(space);
    assert.deepEqual(remote.spaces.preview(invite), node.spaces.preview(invite));

    const release = await remote.spaces.hold(space);
    await release();
    await assert.rejects(() => remote.spaces.authenticator(space), /serves no sockets/);
  });

  test('an agent started across the port writes as the person, via agent', async () => {
    const { node, remote, manager, me } = await served();
    const { id: space } = await node.spaces.create({ name: 'Climbing', ...team, visibility: 'public' });
    const provider = manager.getProvider();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(me, provider).delegate({
      audience: did,
      capabilities: [{ with: `space:${space}`, can: 'expression/*' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
      facts: [AGENT_FACT],
    });

    const agent: P2PNode = await remote.asAgent({ keys, note: note.encoded });
    assert.equal(agent.did, node.did);
    assert.equal(agent.sessionDid, did);
    const written = await agent.records.put(space, 'app.note', { text: 'Bring chalk' });
    assert.equal(written.viaAgent, true);
    await assert.rejects(() => agent.spaces.invite(space), /Ask the person/);

    // Closing the agent leaves the node it acts through running.
    await agent.close();
    assert.equal((await remote.spaces.list()).length, 1);
  });

  test('closing the remote node closes the node it stands for, and later calls fail at once', async () => {
    const { node } = await served();
    let closes = 0;
    const watched: P2PNode = {
      ...node,
      close: async () => {
        closes++;
        await node.close();
      },
    };
    const channel = new MessageChannel();
    const stop = serveNode(watched, channel.port1);
    cleanup.push(() => {
      stop();
      channel.port1.close();
      channel.port2.close();
    });
    const remote = await remoteNode(channel.port2);
    await remote.close();
    assert.equal(closes, 1);
    await assert.rejects(() => remote.spaces.list(), /closed/);
  });
});

describe("the page's signer, from a worker", () => {
  test('a node signs its sessions with a root key across the port', async () => {
    const manager = createIdentityManager();
    const me = await manager.fromSeed(generateSeed());
    const pair = channel();
    cleanup.push(serveSigner(createLocalRootSigner(me, manager.getProvider()), pair.port1));

    const signer = await remoteSigner(pair.port2);
    assert.equal(signer.did, me.did);
    assert.equal(signer.custody, 'local');
    const node = await createNode({ signer, stores: memoryStores(), watchIntervalMs: 0 });
    cleanup.push(() => node.close());
    assert.equal(node.delegation().payload.iss, me.did);
    assert.equal(node.delegation().payload.aud, node.sessionDid);
    const { id: space } = await node.spaces.create({ name: 'Diary', visibility: 'private' });
    assert.equal((await node.records.put(space, 'app.note', { text: 'hi' })).root, me.did);
  });

  test("the signer's refusal reaches the worker as an error", async () => {
    const pair = channel();
    cleanup.push(
      serveSigner(
        {
          did: 'did:key:zRefuses',
          custody: 'remote',
          delegate: () => Promise.reject(new Error('The person said no')),
        },
        pair.port1,
      ),
    );
    const signer = await remoteSigner(pair.port2);
    await assert.rejects(
      () => signer.delegate({ audience: 'did:key:zSession', capabilities: [], expiration: 0 }),
      /said no/,
    );
  });
});

/** A signalled transport that records what it is asked, and whose events the test fires */
function recordingTransport() {
  const calls: string[] = [];
  const sent: Array<[string, number[]]> = [];
  const sinks = new Map<string, CandidateSink>();
  const iceSeen: Array<ReadonlyArray<RTCIceServer>> = [];
  const events = createEmitter<PeerTransportEvents>();
  let ice: () => ReadonlyArray<RTCIceServer> = () => [];
  const transport: SignalledTransport = {
    createOffer: async (peer, onCandidate) => {
      calls.push(`offer ${peer}`);
      iceSeen.push(ice());
      sinks.set(peer, onCandidate);
      return { type: 'offer', sdp: `offer-to-${peer}` };
    },
    handleOffer: async (peer, offer, onCandidate) => {
      calls.push(`answer ${peer} ${offer.sdp}`);
      sinks.set(peer, onCandidate);
      return { type: 'answer', sdp: `answer-to-${peer}` };
    },
    handleAnswer: async (peer) => {
      calls.push(`answered ${peer}`);
      throw new Error('No connection found for peer ' + peer);
    },
    addIceCandidate: async (peer, candidate) => void calls.push(`candidate ${peer} ${candidate.candidate}`),
    send: (peer, data) => void sent.push([peer, [...data]]),
    close: (peer) => void calls.push(`close ${peer}`),
    closeAll: () => void calls.push('close all'),
    binding: (peer) => ({ local: `local-${peer}`, remote: `remote-${peer}` }),
    on: events.on,
    off: events.off,
  };
  return {
    calls,
    sent,
    sinks,
    iceSeen,
    emit: events.emit,
    create: (iceServers: () => ReadonlyArray<RTCIceServer>) => {
      ice = iceServers;
      return transport;
    },
  };
}

describe("the page's WebRTC, from a worker", () => {
  test('offers, answers and candidates go to the page; frames and events come back', async () => {
    const page = recordingTransport();
    const pair = channel();
    cleanup.push(serveTransport(pair.port1, page.create));
    const turn: RTCIceServer = { urls: 'turn:relay.test', username: 'u', credential: 'c' };
    const worker = remoteTransport(pair.port2, () => [turn]);

    const found: RTCIceCandidateInit[] = [];
    const offer = await worker.createOffer('did:key:zPeer', (candidate) => found.push(candidate));
    assert.equal(offer.sdp, 'offer-to-did:key:zPeer');
    assert.deepEqual(page.iceSeen, [[turn]], 'the ICE servers the worker knows reach the page');

    page.sinks.get('did:key:zPeer')?.({ candidate: 'candidate:1', sdpMid: '0' });
    await until(() => found.length === 1, 1000, 'the candidate');
    assert.equal(found[0]?.candidate, 'candidate:1');

    assert.equal(
      (await worker.handleOffer('did:key:zOther', { type: 'offer', sdp: 'x' }, () => {})).sdp,
      'answer-to-did:key:zOther',
    );
    await worker.addIceCandidate('did:key:zPeer', { candidate: 'candidate:2' });
    await assert.rejects(
      () => worker.handleAnswer('did:key:zPeer', { type: 'answer', sdp: 'y' }),
      /No connection found/,
    );

    const connected: string[] = [];
    const frames: number[][] = [];
    worker.on('connected', (peer) => connected.push(peer));
    worker.on('data', (_peer, data) => frames.push([...data]));
    assert.equal(worker.binding?.('did:key:zPeer'), null, 'no binding before the connection opens');
    page.emit('connected', 'did:key:zPeer');
    page.emit('data', 'did:key:zPeer', new Uint8Array([1, 2, 3]));
    await until(() => frames.length === 1, 1000, 'the frame');
    assert.deepEqual(connected, ['did:key:zPeer']);
    assert.deepEqual(frames, [[1, 2, 3]]);
    assert.deepEqual(worker.binding?.('did:key:zPeer'), {
      local: 'local-did:key:zPeer',
      remote: 'remote-did:key:zPeer',
    });

    worker.send('did:key:zPeer', new Uint8Array([4, 5]));
    worker.close('did:key:zOther');
    worker.closeAll();
    await until(() => page.calls.includes('close all'), 1000, 'close all');
    assert.deepEqual(page.sent, [['did:key:zPeer', [4, 5]]]);
    assert.deepEqual(page.calls, [
      'offer did:key:zPeer',
      'answer did:key:zOther x',
      'candidate did:key:zPeer candidate:2',
      'answered did:key:zPeer',
      'close did:key:zOther',
      'close all',
    ]);
  });
});
