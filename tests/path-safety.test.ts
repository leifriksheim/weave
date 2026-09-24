/**
 * Path safety — a name or a list entry is never a way out of the folder.
 *
 * The folder on disk may be synced or shared, so what is written in it is not
 * necessarily what this device wrote. These check that a hostile name, a
 * symlink, or an edited accounts.json cannot aim a read, write or delete at
 * files outside it.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { openFsDirectory } from '../cli/src/fs-directory.js';
import {
  createFolderAccountStore,
  accountDataPath,
  newAccountId,
  isAccountId,
  type AccountSummary,
} from '../src/identity/account-store.js';
import { createVault } from '../src/identity/folder-account.js';

const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-paths-'));
  temporary.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

const BAD_NAMES = ['', '.', '..', 'a/b', '../x', 'a\\b', '..\\x', 'a\0b'];

describe('the Node folder refuses names that are not one entry', () => {
  for (const name of BAD_NAMES) {
    test(`refuses ${JSON.stringify(name)}`, async () => {
      const root = await tempDir();
      const dir = await openFsDirectory(path.join(root, 'inside'));

      await assert.rejects(dir.getFileHandle(name, { create: true }), TypeError);
      await assert.rejects(dir.getDirectoryHandle(name, { create: true }), TypeError);
      await assert.rejects(dir.removeEntry(name, { recursive: true }), TypeError);
    });
  }

  test('.. does not reach the parent, even for a delete', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'precious'), 'keep me');
    const dir = await openFsDirectory(path.join(root, 'inside'));
    const sub = await dir.getDirectoryHandle('sub', { create: true });

    await assert.rejects(sub.removeEntry('..', { recursive: true }), TypeError);
    await assert.rejects(dir.removeEntry('..', { recursive: true }), TypeError);
    assert.equal(await readFile(path.join(root, 'precious'), 'utf8'), 'keep me');
  });

  test('ordinary names still work', async () => {
    const dir = await openFsDirectory(await tempDir());
    const sub = await dir.getDirectoryHandle('stores', { create: true });
    const file = await sub.getFileHandle('a.json', { create: true });
    const writable = await file.createWritable();
    await writable.write('{}');
    await writable.close();

    const keys: string[] = [];
    for await (const key of sub.keys()) keys.push(key);
    assert.deepEqual(keys, ['a.json']);
    await sub.removeEntry('a.json');
  });

  test('does not follow a symlink out of the folder', async () => {
    const root = await tempDir();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret'), 'not yours');

    const inside = path.join(root, 'inside');
    const dir = await openFsDirectory(inside);
    await symlink(outside, path.join(inside, 'link'));
    await symlink(path.join(outside, 'secret'), path.join(inside, 'file'));

    await assert.rejects(dir.getDirectoryHandle('link'), TypeError);
    await assert.rejects(dir.getDirectoryHandle('link', { create: true }), TypeError);
    await assert.rejects(dir.getFileHandle('file'), TypeError);
    await assert.rejects(dir.removeEntry('link', { recursive: true }), TypeError);

    const keys: string[] = [];
    for await (const key of dir.keys()) keys.push(key);
    assert.deepEqual(keys, [], 'a link is not listed as an entry');
    assert.deepEqual(await readdir(outside), ['secret']);
  });
});

describe('accounts.json is checked, not trusted', () => {
  function summary(id: string, dataPath = accountDataPath(id)): AccountSummary {
    return { id, name: id, did: `did:key:z${id}`, createdAt: '2026-01-01T00:00:00.000Z', dataPath };
  }

  async function withList(accounts: ReadonlyArray<unknown>) {
    const root = await tempDir();
    await writeFile(path.join(root, 'precious'), 'keep me');
    const home = path.join(root, 'home');
    const dir = await openFsDirectory(home);
    await writeFile(path.join(home, 'accounts.json'), JSON.stringify({ version: 1, accounts }));
    return { root, store: createFolderAccountStore(dir) };
  }

  test('ids look like the ones the store makes', () => {
    for (let i = 0; i < 50; i++) assert.ok(isAccountId(newAccountId()));
    for (const bad of ['', '..', '../x', 'a/b', 'ABC', 'abc-def', 'a'.repeat(13), 42, null]) {
      assert.equal(isAccountId(bad), false, JSON.stringify(bad));
    }
  });

  test('skips rows whose id or data path it would not have written', async () => {
    const good = newAccountId();
    const legacy = newAccountId();
    const { store } = await withList([
      summary(good),
      summary(legacy, 'stores'),
      summary('..', 'accounts/../stores'),
      summary('evil', '../../somewhere'),
      summary('evil2', 'accounts/someoneelse/stores/../../..'),
      summary('evil3', '/etc'),
      summary('../escape', accountDataPath('../escape')),
      null,
    ]);

    const listed = (await store.list()).map((account) => account.id).sort();
    assert.deepEqual(listed, [good, legacy].sort());
  });

  test('remove refuses an id that is not one, and deletes nothing outside', async () => {
    const { root, store } = await withList([]);

    for (const id of ['..', '../..', '', 'a/b', '../../precious']) {
      await assert.rejects(store.remove(id), TypeError);
    }
    assert.equal(await readFile(path.join(root, 'precious'), 'utf8'), 'keep me');
  });

  test('write refuses a summary pointing outside its own subtree', async () => {
    const { store } = await withList([]);
    const vault = createVault({ did: 'did:key:zx', wraps: [] });

    await assert.rejects(store.write(summary('..'), vault), TypeError);
    await assert.rejects(store.write(summary(newAccountId(), '../../somewhere'), vault), TypeError);
  });

  test('read of a bad id finds nothing rather than looking', async () => {
    const { store } = await withList([]);
    assert.equal(await store.read('../..'), null);
  });
});

describe('weave run --create off a terminal', () => {
  test('keeps the recovery code out of the log', async () => {
    const home = await tempDir();
    const main = fileURLToPath(new URL('../cli/src/main.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', main, 'run', '--create', '--port', '0'], {
      env: { ...process.env, WEAVE_HOME: home, WEAVE_PASSPHRASE: 'pw' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '';
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));

    try {
      const deadline = Date.now() + 15000;
      while (!/not printed/.test(log)) {
        if (Date.now() > deadline || child.exitCode !== null) assert.fail(`never said where the code went:\n${log}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      child.kill('SIGTERM');
    }

    assert.doesNotMatch(log, /Recovery code:/);
    const file = (await readdir(home)).find((name) => name.startsWith('recovery-code-'));
    assert.ok(file, 'the code is written to a file in the home');
    assert.match(log, new RegExp(file!));
    assert.match(await readFile(path.join(home, file!), 'utf8'), /^[0-9A-Z-]+\n$/);
    assert.equal((await stat(path.join(home, file!))).mode & 0o777, 0o600);
  });
});
