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

const PASSWORD = 'correct horse battery';

/** Makes an account the whole way: name, recovery code, password. Returns its recovery code. */
async function createAccount(auth: WeaveAuth, name: string, password = PASSWORD): Promise<string> {
  await auth.createAccount(name);
  const code = auth.getState().freshCode!;
  auth.codeSaved();
  assert.equal(await auth.setPassword(password), true, auth.getState().error?.message);
  return code;
}

describe('createWeaveAuth', () => {
  test('an empty place asks whether you have an account', async () => {
    const auth = started();
    await auth.start();
    assert.equal(auth.getState().stage, 'welcome');
    assert.equal(auth.getState().place?.kind, 'browser');
  });

  test('creating an account shows the recovery code, then asks for an everyday way in', async () => {
    const auth = started();
    await auth.start();
    auth.startCreating();
    await auth.createAccount('Ada');

    const made = auth.getState();
    assert.equal(made.stage, 'recovery');
    assert.equal(made.setup, 'new');
    assert.ok(made.freshCode, 'the recovery code is shown');
    assert.equal(made.session?.account.name, 'Ada');
    assert.equal(auth.recoveryCode(), made.freshCode);

    auth.codeSaved();
    assert.equal(auth.getState().stage, 'unlock', 'a passkey or password is not optional');
    assert.equal(auth.getState().freshCode, null);

    assert.equal(await auth.setPassword(PASSWORD), true);
    // No pod to offer here: Node cannot open folders.
    assert.equal(auth.getState().stage, 'ready');
    assert.equal(auth.getState().setup, null);
    assert.equal(auth.getState().entry?.hasPassword, true);
  });

  test('a short password is refused, and the flow waits', async () => {
    const auth = started();
    await auth.start();
    await auth.createAccount('Ada');
    auth.codeSaved();

    assert.equal(await auth.setPassword('short'), false);
    assert.equal(auth.getState().stage, 'unlock');
    assert.match(auth.getState().error?.message ?? '', /at least 10/);
  });

  test('signing out and back in with the password is the same account', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    const did = auth.getState().session!.did;

    const space = await auth.getState().session!.node.spaces.create({ name: 'Notes', visibility: 'private' });

    await auth.signOut();
    assert.equal(auth.getState().session, null);
    assert.equal(auth.getState().stage, 'signIn');
    assert.equal(auth.getState().entry?.hasPassword, true);

    await auth.signInWithPassword(PASSWORD);
    const back = auth.getState();
    assert.equal(back.stage, 'ready');
    assert.equal(back.session?.did, did);
    assert.deepEqual((await back.session!.node.spaces.list()).map((s) => s.id), [space.id]);
  });

  test('a wrong password is refused', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    await auth.signOut();

    await auth.signInWithPassword('not the password');
    assert.equal(auth.getState().session, null);
    assert.equal(auth.getState().error?.code, 'VAULT_UNLOCK_FAILED');
  });

  test('changing the password stops the old one working', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    assert.equal(await auth.setPassword('a different one entirely'), true);
    assert.equal(auth.getState().entry?.vault.wraps.filter((wrap) => wrap.kind === 'passphrase').length, 1);
    await auth.signOut();

    await auth.signInWithPassword(PASSWORD);
    assert.equal(auth.getState().session, null);
    await auth.signInWithPassword('a different one entirely');
    assert.equal(auth.getState().stage, 'ready');
  });

  test('the recovery code still opens an account that has a password, straight in', async () => {
    const auth = started();
    await auth.start();
    const code = await createAccount(auth, 'Ada');
    await auth.signOut();

    auth.showRestore();
    await auth.signInWithCode(code);
    assert.equal(auth.getState().stage, 'ready');
  });

  test('restoring on a new device goes on to set up a way in there', async () => {
    const auth = started();
    await auth.start();
    const code = await createAccount(auth, 'Ada');
    const did = auth.getState().session!.did;

    const elsewhere = started();
    await elsewhere.start();
    elsewhere.showExisting();
    assert.equal(elsewhere.getState().stage, 'existing');
    elsewhere.showRestore();
    await elsewhere.signInWithCode(code);

    const restored = elsewhere.getState();
    assert.equal(restored.session?.did, did);
    assert.equal(restored.stage, 'recovery', 'a reminder to keep the code apart from the password about to be set');
    assert.equal(restored.setup, 'restored');
    elsewhere.codeSaved();
    assert.equal(elsewhere.getState().stage, 'unlock');
    await elsewhere.setPassword(PASSWORD);
    assert.equal(elsewhere.getState().stage, 'ready');
  });

  test('a recovery code filled into the password field still opens the account', async () => {
    // Before passwords, the recovery code was the login, and managers still fill it.
    const auth = started();
    await auth.start();
    await auth.createAccount('Ada');
    const code = auth.getState().freshCode!;
    const did = auth.getState().session!.did;
    await auth.signOut();

    await auth.signInWithPassword(code);
    assert.equal(auth.getState().session?.did, did);
    assert.equal(auth.getState().stage, 'recovery');
  });

  test('a recovery code for another account is refused with a reason', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
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

  test('something that is not a recovery code says what one looks like', async () => {
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
    await createAccount(auth, 'Ada');
    assert.equal(stages.at(-1), 'ready');
    for (const stage of ['welcome', 'recovery', 'unlock']) assert.ok(stages.includes(stage), stage);
  });
});

describe('passwords beside the CLI', () => {
  test('setting a password keeps the CLI passphrase, and either opens the account', async () => {
    const { wrapSeedWithPassphrase, CLI_PASSPHRASE_LABEL } = await import('../src/identity/account-vault.js');
    const { recoveryCodeToSeed } = await import('../src/identity/recovery-code.js');
    const auth = started();
    await auth.start();
    const code = await createAccount(auth, 'Ada');
    const { place, session } = auth.getState();
    const vault = (await place!.store.read(session!.account.id))!;
    const cli = await wrapSeedWithPassphrase(recoveryCodeToSeed(code), 'unattended secret', CLI_PASSPHRASE_LABEL);
    await place!.store.write(session!.account, { ...vault, wraps: [...vault.wraps, cli] });

    assert.equal(await auth.setPassword('a brand new password'), true);
    const labels = auth.getState().entry!.vault.wraps.filter((wrap) => wrap.kind === 'passphrase').map((wrap) => wrap.label);
    assert.deepEqual(labels.sort(), [CLI_PASSPHRASE_LABEL, 'Password'].sort());

    await auth.signOut();
    await auth.signInWithPassword('unattended secret');
    assert.equal(auth.getState().stage, 'ready');
    await auth.signOut();
    await auth.signInWithPassword('a brand new password');
    assert.equal(auth.getState().stage, 'ready');
  });
});
