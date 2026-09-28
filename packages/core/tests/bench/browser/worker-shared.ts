/**
 * Two tabs of one account sharing a node in a `SharedWorker`, meeting a
 * third node through a relay. Frames stand in for tabs: they share the
 * worker, and removing one ends its document as closing a tab would, with
 * its locks and its WebRTC. The node must move its connections to the tab
 * that is left, and writes must still cross both ways. Run by `run.mjs` with
 * ENTRY=worker-shared.ts.
 */
import type { P2PNode } from '../../../src/node/types.js';
import { startNodeInWorker } from '../../../src/node/worker.js';
import { createIdentityManager } from '../../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../../src/identity/root-signer.js';
import { generateSeed } from '../../../src/identity/recovery-code.js';
import { team } from '../../../src/space/presets.js';
import { isRecord } from '../../../src/utils/guards.js';

const params = new URLSearchParams(location.search);
const relay = params.get('relay') ?? 'ws://127.0.0.1:8787';
const log = (line: string) => console.log(line);

async function nodeFor(seed: Uint8Array, shared: boolean, stores: string): Promise<P2PNode> {
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
  const worker = shared
    ? new SharedWorker('/node-worker.js', { type: 'module', name: 'weave-node' }).port
    : new Worker('/node-worker.js', { type: 'module' });
  return startNodeInWorker(worker, { signer, stores: { indexedDB: stores }, network: { relays: [relay] } });
}

async function until(what: string, check: () => Promise<boolean>, ms = 30_000) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** What a tab answers: a value, or why not */
interface Answer {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

if (params.has('tab')) {
  // A tab of Alice's: does what the page asks of its node.
  let node: P2PNode | null = null;
  const run = async (op: unknown, args: ReadonlyArray<unknown>): Promise<unknown> => {
    if (op === 'start') {
      if (!(args[0] instanceof Uint8Array)) throw new Error('start takes a seed');
      node = await nodeFor(args[0], true, String(args[1]));
      return node.sessionDid;
    }
    if (!node) throw new Error('not started');
    if (op === 'create') {
      const { id: space } = await node.spaces.create({ name: 'Climbing', ...team, visibility: 'private' });
      await node.spaces.hold(space);
      return { space, invite: await node.spaces.invite(space) };
    }
    if (op === 'put')
      return (await node.records.put(String(args[0]), 'app.note', { text: String(args[1]) })).key;
    if (op === 'get') return (await node.records.get(String(args[0]), String(args[1]))) !== null;
    throw new Error(`no such op: ${String(op)}`);
  };
  addEventListener('message', (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!isRecord(message) || typeof message.id !== 'number') return;
    const { id } = message;
    const args = Array.isArray(message.args) ? message.args : [];
    void run(message.op, args).then(
      (value) => parent.postMessage({ id, ok: true, value } satisfies Answer, '*'),
      (error: unknown) => parent.postMessage({ id, ok: false, error: String(error) } satisfies Answer, '*'),
    );
  });
  parent.postMessage({ ready: true }, '*');
} else {
  const frames = new Map<HTMLIFrameElement, (message: unknown) => void>();
  addEventListener('message', (event) => {
    for (const [frame, handle] of frames) if (event.source === frame.contentWindow) handle(event.data);
  });
  let nextId = 0;
  const openTab = async () => {
    const frame = document.createElement('iframe');
    frame.src = `/?tab=1&relay=${encodeURIComponent(relay)}`;
    const waiting = new Map<number, (answer: Answer) => void>();
    const ready = new Promise<void>((resolve) => {
      frames.set(frame, (message) => {
        if (!isRecord(message)) return;
        if (message.ready === true) resolve();
        else if (typeof message.id === 'number')
          waiting.get(message.id)?.({
            id: message.id,
            ok: message.ok === true,
            value: message.value,
            error: String(message.error),
          });
      });
    });
    document.body.append(frame);
    await ready;
    const ask = (op: string, ...args: unknown[]) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++nextId;
        waiting.set(id, (answer) => (answer.ok ? resolve(answer.value) : reject(new Error(answer.error))));
        frame.contentWindow?.postMessage({ id, op, args }, '*');
      });
    const text = async (op: string, ...args: unknown[]) => String(await ask(op, ...args));
    return { ask, text, close: () => frame.remove() };
  };

  try {
    const alice = generateSeed();
    const stores = `alice-${Date.now()}`;
    const first = await openTab();
    const second = await openTab();
    const firstSession = await first.text('start', alice, stores);
    const secondSession = await second.text('start', alice, stores);
    log(firstSession === secondSession ? 'two tabs share one node' : 'failed: the tabs have a node each');

    const bob = await nodeFor(generateSeed(), false, `bob-${Date.now()}`);
    const created = await first.ask('create');
    if (!isRecord(created) || typeof created.space !== 'string' || typeof created.invite !== 'string')
      throw new Error('no space');
    const { space, invite } = created;
    await bob.spaces.join(invite);
    await bob.spaces.hold(space);
    const before = await first.text('put', space, 'Bring chalk');
    await until('the first note to reach Bob', async () => (await bob.records.get(space, before)) !== null);
    log('a write crossed while the first tab made the connection');

    first.close();
    const t = performance.now();
    const after = await second.text('put', space, 'And rope');
    await until(
      'a note to reach Bob after the first tab closed',
      async () => (await bob.records.get(space, after)) !== null,
    );
    log(
      `after the first tab closed, a write crossed through the second in ${(performance.now() - t).toFixed(0)}ms`,
    );
    const reply = (await bob.records.put(space, 'app.note', { text: 'Got it' })).key;
    await until(
      'Bob’s reply to reach the second tab',
      async () => (await second.ask('get', space, reply)) === true,
    );
    log('and back');
    await bob.close();
    log('done');
  } catch (error) {
    log(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

// A module, for the top-level await.
export {};
