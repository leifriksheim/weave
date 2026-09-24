/**
 * The sign-in flow as state: creating an account, signing out and back in with
 * its password, and the mistakes it has to explain.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createWeaveAuth, type WeaveAuth, type AuthState } from '../src/session/auth.js';
import type { KeyValueStore } from '../src/session/stay-signed-in.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { memoryStores } from './helpers/memory-stores.js';

function memoryStorage(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** A flow whose "browser" is in memory, so it runs here as it would in a page. */
function testAuth(): WeaveAuth {
  const accounts = createFolderAccountStore(createMemoryDirectory().handle);
  const stores = new Map<string, ReturnType<typeof memoryStores>>();
  const storage = memoryStorage();
  // Staying signed in keeps a key in IndexedDB, which Node does not have.
  storage.setItem('weave.stay-signed-in', JSON.stringify('never'));
  return createWeaveAuth({
    rpId: 'example.test',
    storage,
    browser: {
      accounts: async () => accounts,
      stores: (account) => {
        let factory = stores.get(account.id);
        if (!factory) stores.set(account.id, (factory = memoryStores()));
        return factory;
      },
    },
  });
}

const open: WeaveAuth[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((auth) => auth.signOut()));
});

function started(): WeaveAuth {
  const auth = testAuth();
  open.push(auth);
  return auth;
}

describe('createWeaveAuth', () => {
  test('an empty place asks whether you have an account', async () => {
    const auth = started();
    await auth.start();
    assert.equal(auth.getState().stage, 'welcome');
    assert.equal(auth.getState().place?.kind, 'browser');
  });

  test('creating an account shows its password once, then goes in', async () => {
    const auth = started();
    await auth.start();
    auth.startCreating();
    await auth.createAccount('Ada');

    const made = auth.getState();
    assert.equal(made.stage, 'create');
    assert.ok(made.freshCode, 'the password is shown');
    assert.equal(made.session?.account.name, 'Ada');
    assert.equal(auth.accountPassword(), made.freshCode);

    auth.codeSaved();
    assert.equal(auth.getState().stage, 'ready');
    assert.equal(auth.getState().freshCode, null);
  });

  test('signing out and back in with the password is the same account', async () => {
    const auth = started();
    await auth.start();
    await auth.createAccount('Ada');
    const code = auth.getState().freshCode!;
    const did = auth.getState().session!.did;
    auth.codeSaved();

    const space = await auth.getState().session!.node.spaces.create({ name: 'Notes', visibility: 'private' });

    await auth.signOut();
    assert.equal(auth.getState().session, null);
    assert.equal(auth.getState().stage, 'signIn');
    assert.equal(auth.getState().accounts.length, 1);

    await auth.signInWithCode(code);
    const back = auth.getState();
    assert.equal(back.stage, 'ready');
    assert.equal(back.session?.did, did);
    assert.deepEqual((await back.session!.node.spaces.list()).map((s) => s.id), [space.id]);
  });

  test('a password for another account is refused with a reason', async () => {
    const auth = started();
    await auth.start();
    await auth.createAccount('Ada');
    auth.codeSaved();
    await auth.signOut();

    const other = testAuth();
    await other.start();
    await other.createAccount('Grace');
    const graces = other.getState().freshCode!;
    await other.signOut();

    await auth.signInWithCode(graces);
    const state: AuthState = auth.getState();
    assert.equal(state.session, null);
    assert.match(state.error?.message ?? '', /different account, not Ada/);
  });

  test('something that is not a password says what one looks like', async () => {
    const auth = started();
    await auth.start();
    await auth.signInWithCode('hunter2');
    assert.equal(auth.getState().error?.code, 'VAULT_UNLOCK_FAILED');
    assert.ok(auth.getState().error?.hint);
    assert.equal(auth.getState().busy, false);
  });

  test('subscribers hear every change', async () => {
    const auth = started();
    const stages: string[] = [];
    auth.subscribe((state) => stages.push(state.stage));
    await auth.start();
    await auth.createAccount('Ada');
    auth.codeSaved();
    assert.equal(stages.at(-1), 'ready');
    assert.ok(stages.includes('welcome'));
  });
});
