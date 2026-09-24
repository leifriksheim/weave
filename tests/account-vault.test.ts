/**
 * Vault tests — the lock on a data folder.
 *
 * The property that matters most is the last one in this file: several wraps
 * over one seed all unlock the same identity, which is what makes "bind a second
 * key to my account" a matter of appending to a file rather than signing a
 * delegation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryDirectory } from './helpers/memory-directory.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import {
  wrapSeedWithDeviceKey,
  unwrapSeedWithDeviceKey,
  wrapSeedWithPassphrase,
  unwrapSeedWithPassphrase,
  deriveVaultKey,
  deriveVaultKeyBytes,
  deviceWrapsFor,
  hasPassphraseWrap,
  withWrap,
  withoutWrap,
} from '../src/identity/account-vault.js';
import {
  readFolderVault,
  writeFolderVault,
  createVault,
  ACCOUNT_FILE,
} from '../src/identity/folder-account.js';
import { createEncryptedAdapter } from '../src/storage/encrypted-adapter.js';
import { createSpaceManager } from '../src/space/space-manager.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { generateSeed, seedToRecoveryCode, recoveryCodeToSeed } from '../src/identity/recovery-code.js';
import { utf8Encode, utf8Decode } from '../src/utils/encoding.js';
import { isProtocolError } from '../src/utils/errors.js';

const manager = createIdentityManager();

/** A device key, as `createDeviceKey` would make one — without the storage. */
async function deviceKey(id: string) {
  return {
    id,
    key: await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  };
}

describe('wrapping a seed', () => {
  test('a device wrap round-trips', async () => {
    const seed = generateSeed();
    const key = await deviceKey('k1');
    const wrap = await wrapSeedWithDeviceKey(seed, key, {
      rpId: 'app-a.example',
      credentialId: 'cred-a',
    });

    assert.deepEqual(await unwrapSeedWithDeviceKey(wrap, key.key), seed);
    // The seed must not be recoverable from the file itself.
    assert.ok(!JSON.stringify(wrap).includes(seedToRecoveryCode(seed).replace(/-/g, '')));
    // Which key opens it has to be recorded, or another browser cannot tell
    // that this wrap is not for it.
    assert.equal(wrap.deviceKeyId, 'k1');
  });

  test('another device\u2019s key does not open it', async () => {
    const wrap = await wrapSeedWithDeviceKey(generateSeed(), await deviceKey('k1'), {
      rpId: 'app-a.example',
      credentialId: 'cred-a',
    });

    const stranger = await deviceKey('k2');
    await assert.rejects(
      () => unwrapSeedWithDeviceKey(wrap, stranger.key),
      (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
    );
  });

  test('a passphrase wrap round-trips, and the wrong one does not', async () => {
    const seed = generateSeed();
    const wrap = await wrapSeedWithPassphrase(seed, 'correct horse battery staple');

    assert.deepEqual(await unwrapSeedWithPassphrase(wrap, 'correct horse battery staple'), seed);
    await assert.rejects(
      () => unwrapSeedWithPassphrase(wrap, 'correct horse battery stapler'),
      (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
    );
  });

  test('wrapping the same seed twice produces different ciphertext', async () => {
    const seed = generateSeed();
    const key = await deviceKey('k1');
    const first = await wrapSeedWithDeviceKey(seed, key, { rpId: 'a' });
    const second = await wrapSeedWithDeviceKey(seed, key, { rpId: 'a' });

    assert.notEqual(first.ciphertext, second.ciphertext, 'the nonce must be fresh each time');
    assert.deepEqual(await unwrapSeedWithDeviceKey(second, key.key), seed);
  });
});

describe('the set of wraps', () => {
  test('several wraps over one seed all reach the same identity', async () => {
    // The whole point: a shortcut on one app, a shortcut on another, and a
    // passphrase are three doors into one account — no delegation involved.
    const seed = generateSeed();
    const expected = (await manager.fromSeed(seed)).did;

    const keyA = await deviceKey('ka');
    const keyB = await deviceKey('kb');
    const onA = await wrapSeedWithDeviceKey(seed, keyA, { rpId: 'app-a.example' });
    const onB = await wrapSeedWithDeviceKey(seed, keyB, { rpId: 'app-b.example' });
    const byPhrase = await wrapSeedWithPassphrase(seed, 'a passphrase');

    const fromA = await manager.fromSeed(await unwrapSeedWithDeviceKey(onA, keyA.key));
    const fromB = await manager.fromSeed(await unwrapSeedWithDeviceKey(onB, keyB.key));
    const fromPhrase = await manager.fromSeed(await unwrapSeedWithPassphrase(byPhrase, 'a passphrase'));
    // And the code, which needs no wrap because it is the seed.
    const fromCode = await manager.fromRecoveryCode(seedToRecoveryCode(seed));

    for (const identity of [fromA, fromB, fromPhrase, fromCode]) {
      assert.equal(identity.did, expected);
    }
  });

  test('only this origin’s shortcuts are offered', async () => {
    const seed = generateSeed();
    const vault = createVault({
      did: (await manager.fromSeed(seed)).did,
      wraps: [
        await wrapSeedWithDeviceKey(seed, await deviceKey('ka'), { rpId: 'app-a.example' }),
        await wrapSeedWithDeviceKey(seed, await deviceKey('kb'), { rpId: 'app-b.example' }),
        await wrapSeedWithPassphrase(seed, 'phrase'),
      ],
    });

    // The key a wrap names lives in the storage of the origin that made it, so
    // another app's wrap is not merely likely to fail — it is unreachable.
    assert.deepEqual(
      deviceWrapsFor(vault, 'app-a.example').map((wrap) => wrap.deviceKeyId),
      ['ka'],
    );
    assert.deepEqual(deviceWrapsFor(vault, 'app-c.example'), []);
    assert.equal(hasPassphraseWrap(vault), true);
  });

  test('setting up a shortcut again replaces it rather than piling up', async () => {
    const seed = generateSeed();
    let vault = createVault({
      did: (await manager.fromSeed(seed)).did,
      wraps: [await wrapSeedWithDeviceKey(seed, await deviceKey('old'), { rpId: 'a.example' })],
    });

    const replacement = await deviceKey('new');
    vault = withWrap(vault, await wrapSeedWithDeviceKey(seed, replacement, { rpId: 'a.example' }));

    assert.equal(vault.wraps.length, 1);
    assert.deepEqual(
      await unwrapSeedWithDeviceKey(deviceWrapsFor(vault, 'a.example')[0]!, replacement.key),
      seed,
    );
  });

  test('removing the last shortcut leaves the account openable by its code', async () => {
    const seed = generateSeed();
    const only = await wrapSeedWithDeviceKey(seed, await deviceKey('k'), { rpId: 'a.example' });
    const vault = createVault({ did: (await manager.fromSeed(seed)).did, wraps: [only] });

    // Wraps are shortcuts for one device, not the keys to the building — the
    // code is the seed written out and needs nothing stored to work.
    const stripped = withoutWrap(vault, only.id);
    assert.deepEqual(stripped.wraps, []);
    assert.equal(
      (await manager.fromRecoveryCode(seedToRecoveryCode(seed))).did,
      stripped.did,
    );
  });

  test('a new account starts with no shortcuts at all', () => {
    const vault = createVault({ did: 'did:key:zabc', wraps: [] });
    assert.deepEqual(vault.wraps, []);
    assert.equal(vault.did, 'did:key:zabc');
  });
});

describe('the account file', () => {
  test('writes a locked account and reads it back without the seed', async () => {
    const folder = createMemoryDirectory();
    const seed = generateSeed();
    const identity = await manager.fromSeed(seed);

    const vault = createVault({
      did: identity.did,
      label: 'Work',
      wraps: [await wrapSeedWithDeviceKey(seed, await deviceKey('k'), { rpId: 'a.example' })],
    });
    await writeFolderVault(folder.open(), vault);

    const state = await readFolderVault(folder.open());
    assert.equal(state.vault?.did, identity.did);
    assert.equal(state.label, 'Work');
    assert.equal(state.unlockedSeed, null, 'the seed must not be readable from the file');

    // Nothing in the file may spell out the seed.
    const raw = utf8Decode((await folder.open().getFileHandle(ACCOUNT_FILE).then((h) => h.getFile()).then((f) => f.arrayBuffer()).then((b) => new Uint8Array(b))));
    assert.ok(!raw.includes(seedToRecoveryCode(seed).replace(/-/g, '')));
  });

  test('recognises the older format that stored the seed in the clear', async () => {
    const folder = createMemoryDirectory();
    const seed = generateSeed();
    const code = seedToRecoveryCode(seed);

    const handle = await folder.open().getFileHandle(ACCOUNT_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(
      utf8Encode(JSON.stringify({ version: 1, label: 'Old', recoveryCode: code, did: 'did:key:zold' })),
    );
    await writable.close();

    const state = await readFolderVault(folder.open());
    assert.equal(state.vault, null);
    assert.deepEqual(state.unlockedSeed, recoveryCodeToSeed(code));
  });

  test('an empty folder reports no account', async () => {
    const state = await readFolderVault(createMemoryDirectory().open());
    assert.equal(state.vault, null);
    assert.equal(state.unlockedSeed, null);
  });
});

describe('encryption at rest', () => {
  test('a space key is unreadable in the underlying store', async () => {
    const inner = createMemoryAdapter();
    const vaultKey = await deriveVaultKey(generateSeed());
    const spaces = createSpaceManager(createEncryptedAdapter(inner, vaultKey));

    const { space } = await spaces.create({
      name: 'Grocery list',
      type: 'personal',
      visibility: 'private',
      owner: 'did:key:zowner',
    });

    // Through the adapter: ordinary reads.
    const reopened = await spaces.get(space.id);
    assert.equal(reopened?.space.name, 'Grocery list');
    assert.ok(reopened?.key, 'the space key should come back');

    // Underneath it: the name and the AES key are both sealed. This is the gap
    // that made private spaces readable to anyone holding the folder.
    const rawRecord = utf8Decode((await inner.get(`space:${space.id}`))!);
    const rawKey = utf8Decode((await inner.get(`spacekey:${space.id}`))!);
    assert.ok(!rawRecord.includes('Grocery list'));
    assert.ok(!rawKey.includes('"raw"'));
  });

  test('a different seed cannot read it', async () => {
    const inner = createMemoryAdapter();
    const spaces = createSpaceManager(
      createEncryptedAdapter(inner, await deriveVaultKey(generateSeed())),
    );
    const { space } = await spaces.create({
      name: 'Private',
      type: 'personal',
      visibility: 'private',
      owner: 'did:key:zowner',
    });

    const stranger = createSpaceManager(
      createEncryptedAdapter(inner, await deriveVaultKey(generateSeed())),
    );
    await assert.rejects(() => stranger.get(space.id));
  });

  test('values outside the sealed prefixes pass straight through', async () => {
    const inner = createMemoryAdapter();
    const adapter = createEncryptedAdapter(inner, await deriveVaultKey(generateSeed()));

    // MST nodes and the root pointer stay as they were: content addressed,
    // cheap to read, and verifiable from outside.
    await adapter.put('bafyexamplenode', utf8Encode('node bytes'));
    assert.equal(utf8Decode((await inner.get('bafyexamplenode'))!), 'node bytes');
    assert.equal(utf8Decode((await adapter.get('bafyexamplenode'))!), 'node bytes');
  });

  test('a value under a sealed prefix that was not sealed is refused', async () => {
    const inner = createMemoryAdapter();
    // Planted by someone who can write the folder but does not hold the seed.
    await inner.put('space:planted', utf8Encode('{"name":"written in the clear"}'));

    const adapter = createEncryptedAdapter(inner, await deriveVaultKey(generateSeed()));
    await assert.rejects(() => adapter.get('space:planted'));
  });

  test('a shared space\'s write secret is sealed too', async () => {
    const inner = createMemoryAdapter();
    const spaces = createSpaceManager(createEncryptedAdapter(inner, await deriveVaultKey(generateSeed())));
    await spaces.create({ name: 'Team', type: 'shared', visibility: 'private', owner: 'did:key:zowner' });

    const entries = await inner.list();
    const writes = entries.filter((key) => key.startsWith('spacewrite:'));
    assert.equal(writes.length, 1);
    // Every registry entry underneath is ciphertext, whatever its prefix.
    for (const key of entries.filter((key) => key.startsWith('space'))) {
      const raw = (await inner.get(key))!;
      assert.deepEqual([...raw.subarray(0, 5)], [...utf8Encode('weave')], `${key} is stored in the clear`);
    }
  });

  test('a sealed value moved to another entry does not open', async () => {
    const inner = createMemoryAdapter();
    const adapter = createEncryptedAdapter(inner, await deriveVaultKey(generateSeed()));
    await adapter.put('spacekey:a', utf8Encode('key of a'));
    await inner.put('spacekey:b', (await inner.get('spacekey:a'))!);
    await assert.rejects(() => adapter.get('spacekey:b'));
  });

  test('a custodian deriving the key as bytes gets the same key', async () => {
    // A Snap holds the seed and hands the page a key; the page derives its own
    // when it holds the seed itself. If these two ever drift, a folder written
    // through one is unreadable through the other.
    const seed = generateSeed();
    const inner = createMemoryAdapter();

    await createEncryptedAdapter(inner, await deriveVaultKey(seed)).put('space:x', utf8Encode('hello'));

    const fromBytes = await globalThis.crypto.subtle.importKey(
      'raw',
      await deriveVaultKeyBytes(seed),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    assert.equal(utf8Decode((await createEncryptedAdapter(inner, fromBytes).get('space:x'))!), 'hello');
  });

  test('the vault key is deterministic, and distinct per seed', async () => {
    const seed = generateSeed();
    const inner = createMemoryAdapter();

    await createEncryptedAdapter(inner, await deriveVaultKey(seed)).put(
      'space:x',
      utf8Encode('hello'),
    );
    const again = createEncryptedAdapter(inner, await deriveVaultKey(seed));
    assert.equal(utf8Decode((await again.get('space:x'))!), 'hello');
  });
});
