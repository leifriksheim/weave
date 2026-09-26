/**
 * What `weave host` starts from: a data folder, the host's key in it, and a
 * payment provider from the environment.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createP256Provider, createS3BlobStore, folderStores, type BlobStore, type StoreFactory } from '../../src/index.js';
import { openFsDirectory } from './fs-directory.js';
import type { Billing } from './host.js';
import { createStripeBilling } from './stripe.js';
import { createWalletPayments, NETWORKS, type NetworkName, type WalletPayments } from './wallet.js';

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

/**
 * Wallet payments, when WEAVE_WALLET_ADDRESS is set: USDC to that address, at
 * WEAVE_WALLET_MONTHLY and/or WEAVE_WALLET_YEARLY dollars, on
 * WEAVE_WALLET_NETWORK (base, or base-sepolia to try it; default base), read
 * through WEAVE_WALLET_RPC (default: the network's public node). None otherwise.
 */
export function walletFromEnv(env: NodeJS.ProcessEnv): WalletPayments | null {
  if (!env.WEAVE_WALLET_ADDRESS) return null;
  const network = (env.WEAVE_WALLET_NETWORK ?? 'base') as NetworkName;
  if (!(network in NETWORKS)) throw new Error(`WEAVE_WALLET_NETWORK must be ${Object.keys(NETWORKS).join(' or ')}, not "${network}"`);
  if (!env.WEAVE_WALLET_MONTHLY && !env.WEAVE_WALLET_YEARLY) {
    throw new Error('Wallet payments need a price: WEAVE_WALLET_MONTHLY, WEAVE_WALLET_YEARLY, or both, in dollars (like 4 and 36)');
  }
  return createWalletPayments({
    network,
    to: env.WEAVE_WALLET_ADDRESS,
    ...(env.WEAVE_WALLET_MONTHLY ? { monthly: env.WEAVE_WALLET_MONTHLY } : {}),
    ...(env.WEAVE_WALLET_YEARLY ? { yearly: env.WEAVE_WALLET_YEARLY } : {}),
    ...(env.WEAVE_WALLET_RPC ? { rpcUrl: env.WEAVE_WALLET_RPC } : {}),
  });
}

/**
 * How the host presents itself, from WEAVE_HOST_NAME, WEAVE_HOST_PRICE (text
 * for people; default from the wallet prices), WEAVE_HOST_TERMS (an address),
 * WEAVE_HOST_URL (its public https:// address, where Stripe sends people back
 * to; default from each request) and WEAVE_WALLETCONNECT_PROJECT_ID (the pay
 * page then reaches every wallet, not only the browser's).
 */
export function presentationFromEnv(env: NodeJS.ProcessEnv): {
  name?: string;
  price?: string;
  terms?: string;
  publicUrl?: string;
  walletConnectProjectId?: string;
} {
  const url = env.WEAVE_HOST_URL?.trim();
  if (url && !/^https?:\/\/[^/]+\/?$/.test(url)) throw new Error(`WEAVE_HOST_URL must be an address like https://host.example, not "${url}"`);
  return {
    ...(env.WEAVE_HOST_NAME ? { name: env.WEAVE_HOST_NAME } : {}),
    ...(env.WEAVE_HOST_PRICE ? { price: env.WEAVE_HOST_PRICE } : {}),
    ...(env.WEAVE_HOST_TERMS ? { terms: env.WEAVE_HOST_TERMS } : {}),
    ...(url ? { publicUrl: url.replace(/\/$/, '') } : {}),
    ...(env.WEAVE_WALLETCONNECT_PROJECT_ID ? { walletConnectProjectId: env.WEAVE_WALLETCONNECT_PROJECT_ID } : {}),
  };
}

/**
 * The host's bucket, from WEAVE_S3_ENDPOINT, WEAVE_S3_BUCKET,
 * WEAVE_S3_ACCESS_KEY_ID and WEAVE_S3_SECRET_ACCESS_KEY (WEAVE_S3_REGION and
 * WEAVE_S3_PREFIX optional) — Cloudflare R2, or any S3-compatible store.
 * None when they are not set: the host keeps everything on its own disk.
 */
export function mirrorFromEnv(env: NodeJS.ProcessEnv): BlobStore | null {
  const { WEAVE_S3_ENDPOINT, WEAVE_S3_BUCKET, WEAVE_S3_ACCESS_KEY_ID, WEAVE_S3_SECRET_ACCESS_KEY } = env;
  if (!WEAVE_S3_ENDPOINT || !WEAVE_S3_BUCKET || !WEAVE_S3_ACCESS_KEY_ID || !WEAVE_S3_SECRET_ACCESS_KEY) return null;
  return createS3BlobStore({
    endpoint: WEAVE_S3_ENDPOINT,
    bucket: WEAVE_S3_BUCKET,
    accessKeyId: WEAVE_S3_ACCESS_KEY_ID,
    secretAccessKey: WEAVE_S3_SECRET_ACCESS_KEY,
    ...(env.WEAVE_S3_REGION ? { region: env.WEAVE_S3_REGION } : {}),
    ...(env.WEAVE_S3_PREFIX ? { prefix: env.WEAVE_S3_PREFIX } : {}),
  });
}

/** Whether an address only this machine can reach */
const isLoopback = (host: string | undefined) => !host || ['127.0.0.1', 'localhost', '::1'].includes(host);

/**
 * The accounts a host carries for, from `--allow` and WEAVE_HOST_ALLOW
 * (comma separated): account DIDs, as the home shows them. None: any.
 */
export function allowList(flags: ReadonlyArray<string> | undefined, env: NodeJS.ProcessEnv): ReadonlyArray<string> | null {
  const named = [...(flags ?? []), ...(env.WEAVE_HOST_ALLOW ?? '').split(',')].map((did) => did.trim()).filter(Boolean);
  if (named.length === 0) return null;
  const wrong = named.find((did) => !/^did:key:z[1-9A-HJ-NP-Za-km-z]{1,120}$/.test(did));
  if (wrong) throw new Error(`"${wrong}" is not an account DID — copy it from the account home (Settings, under your name).`);
  return [...new Set(named)];
}

/**
 * Refuses a free host anyone could reach and use: every subscription counts as
 * paid there, so a stranger could fill its disk. On this machine alone, or
 * limited to named accounts, it is fine.
 */
export function checkExposure(options: { readonly host?: string; readonly free?: boolean; readonly allow: ReadonlyArray<string> | null }): void {
  if (!options.free || options.allow || isLoopback(options.host)) return;
  throw new Error(
    `A free host on ${options.host} would carry spaces for anyone who finds it. Name the accounts it is for with --allow did:key:… (or WEAVE_HOST_ALLOW), or keep it on this machine.`,
  );
}
