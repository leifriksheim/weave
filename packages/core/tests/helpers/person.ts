/**
 * A person on a fake hub: their own seed, identity and node, closed after each
 * test. And the hand-signed versions and bare keys tests forge with.
 */
import { afterEach } from 'node:test';

import { createNode } from '../../src/node/node.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { createP256Provider } from '../../src/identity/crypto-p256.js';
import { generateSeed } from '../../src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../../src/identity/did.js';
import { deriveVaultKeyBytes } from '../../src/identity/account-vault.js';
import { deriveContactKeyBytes } from '../../src/identity/contact-key.js';
import { createSigner } from '../../src/schema/signer.js';
import { createExpression, type CreateExpressionParams } from '../../src/schema/expression.js';
import { createStorageProvider } from '../../src/storage/storage-provider.js';
import type { StoreFactory } from '../../src/node/stores.js';
import type { Expression } from '../../src/types.js';
import type { FakeHub } from './fake-transport.js';
import { memoryStores } from './memory-stores.js';
import { seenBy } from './as-member.js';

/** Everything a test opened, closed after it */
export const open: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

export const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PersonOptions {
  readonly seed?: Uint8Array;
  readonly stores?: StoreFactory;
  /** Give the node the account key derived from the seed */
  readonly accountKey?: boolean;
  /** Give the node the contact key derived from the seed */
  readonly contactKey?: boolean;
  readonly relays?: string[];
  /** Set as the account's name once the node is open */
  readonly name?: string;
}

/** A node of a new account, on the hub when there is one */
export async function person(hub?: FakeHub, options: PersonOptions = {}) {
  const seed = options.seed ?? generateSeed();
  const manager = createIdentityManager();
  const me = await manager.fromSeed(seed);
  const stores = options.stores ?? memoryStores();
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores,
    watchIntervalMs: 0,
    ...(options.accountKey ? { accountKey: await deriveVaultKeyBytes(seed) } : {}),
    ...(options.contactKey ? { contactKey: await deriveContactKeyBytes(seed) } : {}),
    ...(hub
      ? {
          network: {
            ...(options.relays ? { relays: options.relays } : {}),
            transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
          },
        }
      : {}),
  });
  open.push(node);
  if (options.name) await node.account.setName(options.name);
  return { node, me, manager, stores, seed };
}
export type Person = Awaited<ReturnType<typeof person>>;

type ForgedFields = Omit<CreateExpressionParams<unknown>, 'author' | 'space' | 'proof'> &
  Partial<Pick<CreateExpressionParams<unknown>, 'author' | 'space' | 'proof'>>;

/**
 * Signs a version by hand, as a modified app or an attacker could, under a
 * key the person delegated to. Unless `keep` is false it is slipped into the
 * writer's own copy of the space, from where it syncs. `seen` defaults to
 * what the writer's node has seen.
 */
export async function forge(
  who: Person,
  space: string,
  fields: ForgedFields,
  { keep = true } = {},
): Promise<Expression> {
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
      seen: fields.seen ?? (await seenBy(who.node, space)),
      ...fields,
      author: keyDid,
      space,
      proof: ucan.encoded,
    }),
    pair.privateKey,
  );
  if (keep) await createStorageProvider(await who.stores(`spaces/${space}`)).addExpression(signed);
  return signed;
}

const provider = createP256Provider();

/** A bare P-256 key and its did:key */
export async function makeKey() {
  const pair = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  return { did, privateKey: pair.privateKey, publicKey: pair.publicKey };
}
