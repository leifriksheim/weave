/**
 * What `weave host` starts from: a data folder, the host's key in it, and a
 * payment provider from the environment.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createP256Provider, folderStores, type StoreFactory } from '../../src/index.js';
import { openFsDirectory } from './fs-directory.js';
import type { Billing } from './host.js';
import { createStripeBilling } from './stripe.js';

/** Where a host keeps its data unless told: `~/.weave-host` */
export function defaultHostData(): string {
  return path.join(os.homedir(), '.weave-host');
}

/**
 * The host's own key — who it is to peers, and what accounts share their
 * carry spaces with. Made once and kept in the data folder, readable by this
 * user alone: a new key would be a new host, and every account would have to
 * hand its spaces over again.
 */
export async function hostKey(data: string): Promise<CryptoKeyPair> {
  await mkdir(data, { recursive: true, mode: 0o700 });
  const file = path.join(data, 'host-key');
  let seed: Uint8Array;
  try {
    seed = new Uint8Array(Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url'));
  } catch {
    seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await writeFile(file, `${Buffer.from(seed).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  }
  const pair = await createP256Provider().deriveKeyPairFromSeed(seed);
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** The host's stores, in the data folder: its subscriptions, and a copy of every space it carries */
export async function hostStores(data: string): Promise<StoreFactory> {
  return folderStores(await openFsDirectory(path.join(data, 'store')));
}

/** Stripe, when STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set; otherwise none */
export function billingFromEnv(env: NodeJS.ProcessEnv): Billing | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
  return createStripeBilling({
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    ...(env.STRIPE_PRICE_MONTHLY ? { monthlyPrice: env.STRIPE_PRICE_MONTHLY } : {}),
    ...(env.STRIPE_PRICE_YEARLY ? { yearlyPrice: env.STRIPE_PRICE_YEARLY } : {}),
  });
}
