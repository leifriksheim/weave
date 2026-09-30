/**
 * A host under load: what it costs to carry many spaces, to price hosting by.
 *
 *   node --conditions=@weaveprotocol/source --import tsx tests/bench/host-load.ts [spaces] [accounts] [records]
 *
 * Defaults: 1,000 spaces over 20 accounts, 20 records each. `weave host
 * --free` runs in a child process on a data folder of its own, so its memory
 * is measured apart from the accounts' nodes, which run here and reach it at
 * the socket its description names. Reports, for the host process: how long
 * until it carries every space, its memory and disk while carrying them, and
 * how long a restart takes to open them all again, with its memory after.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createNode } from '../../../core/src/node/node.js';
import type { P2PNode } from '../../../core/src/node/types.js';
import { createIdentityManager } from '../../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../../core/src/identity/root-signer.js';
import { generateSeed } from '../../../core/src/identity/recovery-code.js';
import { deriveVaultKeyBytes } from '../../../core/src/identity/account-vault.js';
import { memoryStores } from '../../../core/tests/helpers/memory-stores.js';
import { spaceSize } from '../../src/host-setup.js';

const [spaces = 1000, accounts = 20, records = 20] = process.argv.slice(2).map(Number);
const PORT = 18_700 + Math.floor(Math.random() * 200);
const url = `http://127.0.0.1:${PORT}`;
const cli = path.resolve(import.meta.dirname, '../../src/main.ts');

const rssMb = (pid: number) =>
  Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString()) / 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 600_000): Promise<number> {
  const started = Date.now();
  while (!(await ok())) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
  return (Date.now() - started) / 1000;
}

function startHostProcess(data: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--conditions=@weaveprotocol/source', '--import', 'tsx', cli, 'host', '--free', '--port', String(PORT)],
    { env: { ...process.env, WEAVE_HOST_DATA: data }, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return child;
}

async function hostUp(): Promise<boolean> {
  return fetch(`${url}/health`).then(
    (response) => response.ok,
    () => false,
  );
}

async function carried(data: string): Promise<{ count: number; bytes: number }> {
  const size = spaceSize(data);
  const dir = path.join(data, 'store', 'spaces');
  const ids = await import('node:fs/promises').then((fs) => fs.readdir(dir).catch(() => []));
  let bytes = 0;
  for (const id of ids) bytes += await size(id);
  return { count: ids.length, bytes };
}

async function account(): Promise<P2PNode> {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const identity = await manager.fromSeed(seed);
  return createNode({
    signer: createLocalRootSigner(identity, manager.getProvider()),
    stores: memoryStores(),
    accountKey: await deriveVaultKeyBytes(seed),
    watchIntervalMs: 0,
    network: {},
  });
}

const data = await mkdtemp(path.join(os.tmpdir(), 'weave-host-load-'));
let host = startHostProcess(data);
const nodes: P2PNode[] = [];
try {
  await waitFor('the host to start', hostUp, 60_000);
  const idle = rssMb(host.pid!);
  console.log(`host started, ${idle.toFixed(0)} MB with nothing carried`);

  const perAccount = Math.ceil(spaces / accounts);
  const made = Date.now();
  for (let a = 0; a < accounts; a++) {
    const node = await account();
    nodes.push(node);
    for (let s = 0; s < perAccount && a * perAccount + s < spaces; s++) {
      const { id } = await node.spaces.create({ name: `Space ${a}.${s}`, visibility: 'private' });
      for (let r = 0; r < records; r++)
        await node.records.put(id, 'note', { text: `Record ${r} of a space under load, about a line long.` });
    }
    await node.hosting.use(url);
  }
  console.log(
    `${spaces} spaces, ${spaces * records} records, made in ${((Date.now() - made) / 1000).toFixed(0)} s`,
  );

  // Each account's carry space, registry and contacts, besides the spaces themselves.
  const expected = spaces + accounts * 3;
  const took = await waitFor(
    'the host to carry every space',
    async () => (await carried(data)).count >= expected,
  );
  let last = -1;
  await waitFor('the host to take in every record', async () => {
    const { bytes } = await carried(data);
    const settled = bytes === last;
    last = bytes;
    if (!settled) await sleep(2000);
    return settled;
  });
  const loaded = await carried(data);
  const busy = rssMb(host.pid!);
  console.log(
    `carrying ${loaded.count} spaces after ${took.toFixed(0)} s: ${busy.toFixed(0)} MB memory, ${mb(loaded.bytes)} on disk, ` +
      `${((busy - idle) / loaded.count).toFixed(2)} MB and ${(loaded.bytes / loaded.count / 1000).toFixed(1)} KB a space`,
  );

  await Promise.all(nodes.splice(0).map((node) => node.close()));
  host.kill('SIGTERM');
  await new Promise((resolve) => host.once('exit', resolve));
  const restarted = Date.now();
  host = startHostProcess(data);
  await waitFor('the host to start again', hostUp, 600_000);
  const coldStart = (Date.now() - restarted) / 1000;
  await sleep(5000);
  console.log(
    `restarted with every space open in ${coldStart.toFixed(0)} s: ${rssMb(host.pid!).toFixed(0)} MB memory, no peers`,
  );
} finally {
  await Promise.all(nodes.map((node) => node.close().catch(() => {})));
  host.kill('SIGTERM');
  await rm(data, { recursive: true, force: true });
}
