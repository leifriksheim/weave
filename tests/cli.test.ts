/**
 * CLI and daemon tests: the disk-backed folder, accounts, MCP, and the one
 * that matters — two devices that are never online together converging through
 * an always-on node.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { openFsDirectory } from '../cli/src/fs-directory.js';
import { openHome, createAccount, unlock, chooseAccount } from '../cli/src/home.js';
import { startDaemon, type Daemon } from '../cli/src/daemon.js';
import { handleMcpMessage, PERSON_ONLY } from '../cli/src/mcp.js';
import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createFolderAdapter } from '../src/storage/folder-adapter.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression } from '../src/schema/expression.js';
import { recoveryCodeToSeed } from '../src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { NODE_ACTIONS } from '../src/node/actions.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { hold } from './helpers/hold.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { createMesh } from '../src/network/mesh.js';

const run = promisify(execFile);
const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-cli-'));
  temporary.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function until(predicate: () => Promise<boolean> | boolean, ms = 5000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('a folder on disk', () => {
  test('is a drop-in for a browser directory handle', async () => {
    const dir = await openFsDirectory(await tempDir());
    const manager = createIdentityManager();
    const me = await manager.fromSeed(new Uint8Array(16).fill(7));
    const signed = await createSigner(manager.getProvider()).sign(
      createExpression({ author: me.did, collection: 'app.note', body: { text: 'on disk' } }),
      me.privateKey,
    );

    const first = createStorageProvider(await createFolderAdapter(dir, 'stores/one'));
    await first.addExpression(signed);

    // A second process opening the same folder sees it.
    const second = createStorageProvider(await createFolderAdapter(dir, 'stores/one'));
    assert.deepEqual(await second.getExpression(signed.id), signed);
    assert.equal(await second.getRootCid(), await first.getRootCid());
  });
});

describe('accounts in a home', () => {
  test('create, then unlock with the code or the passphrase — never anything else', async () => {
    const home = await openHome(await tempDir());
    const { account, code } = await createAccount(home, { name: 'Leif', passphrase: 'correct horse' });
    assert.ok(code);

    const byCode = await unlock(home, account, { code: code! });
    const byPassphrase = await unlock(home, account, { passphrase: 'correct horse' });
    assert.equal(byCode.signer.did, account.did);
    assert.equal(byPassphrase.signer.did, account.did);

    await assert.rejects(unlock(home, account, { passphrase: 'wrong' }), /does not open/);
    await assert.rejects(unlock(home, account, {}), /needs the recovery code/);

    const other = await createAccount(await openHome(await tempDir()), { name: 'Other' });
    await assert.rejects(unlock(home, account, { code: other.code! }), /different account/);
  });

  test('the seed is never written in the clear', async () => {
    const where = await tempDir();
    const home = await openHome(where);
    const { code } = await createAccount(home, { name: 'Leif', passphrase: 'pw' });
    const seedHex = Buffer.from(recoveryCodeToSeed(code!)).toString('hex');

    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(where);
    for (const file of files) {
      const text = (await import('node:fs/promises')).readFile(file, 'utf8');
      const content = await text;
      assert.equal(content.includes(code!), false, `${file} holds the code`);
      assert.equal(content.includes(seedHex), false, `${file} holds the seed`);
    }
  });
});

describe('the daemon', () => {
  let daemon: Daemon;
  let code: string;
  let signer: Awaited<ReturnType<typeof unlock>>['signer'];
  let peerUrl: string;

  before(async () => {
    const home = await openHome(await tempDir());
    ({ code } = (await createAccount(home, { name: 'Leif' })) as { code: string });
    const unlocked = await unlock(home, await chooseAccount(home), { code });
    signer = unlocked.signer;
    daemon = await startDaemon({ unlocked, port: 0, host: '127.0.0.1', rescanMs: 100 });
    peerUrl = `ws://127.0.0.1:${daemon.port}/peer`;
  });

  after(async () => {
    await daemon.close();
  });

  test('answers /health, and says nothing about whose node it is', async () => {
    const health = (await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json()) as Record<string, unknown>;
    assert.deepEqual(health, { ok: true });
  });

  test('is a relay too: peers meet through it, in several spaces over one socket', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const meshOf = (did: string) =>
      createMesh({ did, relays: [`ws://127.0.0.1:${daemon.port}`], createTransport: () => hub.signalled(did, 'daemon-relay') });
    const [a, b] = [meshOf('did:key:zA'), meshOf('did:key:zB')];
    const rooms = [a.join('one'), a.join('two'), b.join('one'), b.join('two')];
    const met = rooms.map(() => 0);
    rooms.forEach((room, i) => room.on('peer-connected', () => (met[i] = met[i]! + 1)));
    await Promise.all(rooms.map((room) => room.connect()));
    await until(() => met.every((n) => n === 1), 5000, 'both to meet in both spaces');
    for (const room of rooms) room.disconnect();
  });

  test('two devices that are never online together converge through it', async () => {
    const deviceStores = { a: memoryStores(), b: memoryStores() };
    const device = (stores: ReturnType<typeof memoryStores>) =>
      createNode({ signer, stores, watchIntervalMs: 0, network: { nodes: [peerUrl] } });

    // Device A makes a space and hands it to the daemon.
    let a: P2PNode = await device(deviceStores.a);
    const space = await a.spaces.create({ name: 'Shared', ...team, visibility: 'private' });
    const invite = await a.spaces.invite(space.id);
    await daemon.node.spaces.join(invite);
    await until(async () => (await daemon.node.spaces.status(space.id)).connection !== 'offline', 3000, 'daemon to open the space');

    // 1. A writes ten, and goes away.
    await hold(a, space.id);
    for (let i = 0; i < 10; i++) await a.records.put(space.id, 'app.todo.item', { text: `from A ${i}` });
    await until(async () => (await daemon.node.records.list(space.id)).length === 10, 5000, 'daemon to hold A’s ten');
    await a.close();

    // 2. B turns up with A long gone, and gets all ten.
    const b = await device(deviceStores.b);
    await b.spaces.join(invite);
    await hold(b, space.id);
    await until(async () => (await b.records.list(space.id)).length === 10, 5000, 'B to receive A’s ten');

    // 3. B writes five, and goes away.
    for (let i = 0; i < 5; i++) await b.records.put(space.id, 'app.todo.item', { text: `from B ${i}` });
    await until(async () => (await daemon.node.records.list(space.id)).length === 15, 5000, 'daemon to hold B’s five');
    await b.close();

    // 4. A comes back and receives B's five.
    a = await device(deviceStores.a);
    await hold(a, space.id);
    await until(async () => (await a.records.list(space.id)).length === 15, 5000, 'A to receive B’s five');
    const texts = (await a.records.list<{ text: string }>(space.id)).map((r) => r.body?.text);
    assert.ok(texts.includes('from B 4'));
    await a.close();
  });

  test('serves a space the account created elsewhere, without being told', async () => {
    // A laptop of the same account, following the registry through the node.
    const laptop = await createNode({
      signer,
      stores: memoryStores(),
      accountKey: await deriveVaultKeyBytes(recoveryCodeToSeed(code)),
      watchIntervalMs: 0,
      network: { nodes: [peerUrl] },
    });
    const space = await laptop.spaces.create({ name: 'Found by itself', visibility: 'private' });
    const written = await laptop.records.put(space.id, 'app.note', { text: 'the node never saw an invite' });

    await until(async () => (await daemon.node.spaces.get(space.id)) !== null, 5000, 'the node to join through the registry');
    await until(async () => (await daemon.node.records.get(space.id, written.key)) !== null, 5000, 'the note to reach the node');
    await laptop.close();
  });

  test('refuses a stranger to a private space, before sending anything', async () => {
    const space = await daemon.node.spaces.create({ name: 'Members only', ...team, visibility: 'private' });
    const socket = new WebSocket(`${peerUrl}?space=${space.id}`);
    const frames: string[] = [];
    socket.addEventListener('message', (event) => {
      frames.push(String(event.data));
      const challenge = JSON.parse(String(event.data));
      if (challenge.type === 'challenge') socket.send(JSON.stringify({ type: 'hello', did: 'did:key:zStranger', nonce: 'n', sig: 'forged' }));
    });
    const closed = await new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
    assert.equal(closed, 4003);
    assert.equal(frames.length, 1); // the challenge, and nothing of the space
  });

  test('refuses a peer for a space it does not hold — exactly as it refuses a stranger', async () => {
    // Challenged first either way, then the same close: a page cannot ask which spaces it holds.
    const socket = new WebSocket(`${peerUrl}?space=nope`);
    let challenged = false;
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
    socket.addEventListener('message', (event) => {
      challenged ||= JSON.parse(String(event.data)).type === 'challenge';
      socket.send(JSON.stringify({ type: 'hello', did: 'did:key:zStranger', nonce: 'n' }));
    });
    assert.equal(await closed, 4003);
    assert.equal(challenged, true);
  });
});

describe('MCP', () => {
  const info = { name: 'weave', version: 'test' };

  test('initialises, lists the node actions as tools, and calls them', async () => {
    const manager = createIdentityManager();
    const me = await manager.fromSeed(new Uint8Array(16).fill(3));
    const node = await createNode({ signer: createLocalRootSigner(me, manager.getProvider()), stores: memoryStores(), watchIntervalMs: 0 });

    const init = (await handleMcpMessage(node, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, info)) as {
      result: { protocolVersion: string; capabilities: { tools: unknown } };
    };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    assert.equal(await handleMcpMessage(node, { jsonrpc: '2.0', method: 'notifications/initialized' }, info), null);

    const list = (await handleMcpMessage(node, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, info)) as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    };
    assert.equal(list.result.tools.length, NODE_ACTIONS.length);
    assert.equal(list.result.tools.find((t) => t.name === 'records_list')?.annotations.readOnlyHint, true);

    const call = async (name: string, args: unknown) =>
      ((await handleMcpMessage(node, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, info)) as {
        result: { isError: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };
      }).result;

    const space = await call('spaces_create', { name: 'Agent made this', visibility: 'public' });
    assert.equal(space.isError, false);
    const put = await call('records_put', { space: space.structuredContent!.id, collection: 'app.agent.idea', body: { idea: 'polls' } });
    assert.equal(put.isError, false);

    const bad = await call('records_put', { space: space.structuredContent!.id });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /Missing "collection"/);

    const unknown = (await handleMcpMessage(node, { jsonrpc: '2.0', id: 4, method: 'no/such' }, info)) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
    await node.close();
  });

  test('an agent is not offered what needs a person, and is told to propose apps instead', async () => {
    const manager = createIdentityManager();
    const me = await manager.fromSeed(new Uint8Array(16).fill(4));
    const node = await createNode({ signer: createLocalRootSigner(me, manager.getProvider()), stores: memoryStores(), watchIntervalMs: 0 });
    const agent = { agent: true };

    const init = (await handleMcpMessage(node, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, info, agent)) as { result: { instructions: string } };
    assert.match(init.result.instructions, /apps_propose/);
    const list = (await handleMcpMessage(node, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, info, agent)) as { result: { tools: Array<{ name: string }> } };
    const names = list.result.tools.map((tool) => tool.name);
    for (const name of PERSON_ONLY) assert.ok(!names.includes(name), `${name} is not offered`);
    assert.ok(names.includes('apps_propose') && names.includes('records_put'));

    const refused = (await handleMcpMessage(node, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spaces_create', arguments: { name: 'x', visibility: 'public' } } }, info, agent)) as {
      error: { message: string };
    };
    assert.match(refused.error.message, /Unknown tool/);
    await node.close();
  });
});

describe('the weave command', () => {
  test('init, create and list from a real process', async () => {
    const main = fileURLToPath(new URL('../cli/src/main.ts', import.meta.url));
    const env = { ...process.env, WEAVE_HOME: await tempDir(), WEAVE_PASSPHRASE: 'pw' };
    const weave = (...args: string[]) => run(process.execPath, ['--import', 'tsx', main, ...args], { env });

    const { stderr } = await weave('init', '--name', 'Leif', '--passphrase');
    assert.match(stderr, /Recovery code: [0-9A-Z-]+/);

    const created = JSON.parse((await weave('spaces', 'create', '--name', 'Notes', '--visibility', 'private')).stdout);
    await weave('records', 'put', '--space', created.id, '--collection', 'app.note', '--body', '{"text":"hi"}');
    const listed = JSON.parse((await weave('records', 'list', '--space', created.id)).stdout);
    assert.equal(listed[0].body.text, 'hi');

    await assert.rejects(weave('records', 'put', '--space', created.id, '--nonsense', 'x'), /has no --nonsense/);
  });
});
