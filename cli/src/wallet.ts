/**
 * Payments from a crypto wallet, with no company in between: USDC sent
 * straight to the host's own address, and the host reading the network to
 * see it arrive. The same shape as x402 (a price, a payment, a check on the
 * chain), without a facilitator.
 *
 * How a payment is tied to a subscription: the host asks for the plan's price
 * plus a fraction of a cent that no other open payment has (36.004217 USDC).
 * The transfer carrying exactly that amount, made after it was asked for, is
 * that subscription's. The wallet only sends — its address never becomes an
 * account, and the host keeps no address, only the transaction's hash so it
 * is never counted twice.
 *
 * Time is paid up front: a wallet can't be charged again each month, so a
 * payment adds a month or a year to the date, and the home offers to add more
 * before it runs out.
 *
 * Plain JSON-RPC over `fetch` (eth_getTransactionReceipt, eth_blockNumber,
 * eth_getBlockByNumber), against any node for the network — a public one,
 * one from a provider, or one's own.
 */
import type { WalletOffer, WalletPayment } from '../../src/index.js';

/** The networks a host can take USDC on (Circle's own USDC, not a bridged one) */
export const NETWORKS = {
  base: {
    chainId: 8453,
    chainName: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  'base-sepolia': {
    chainId: 84532,
    chainName: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
} as const;
export type NetworkName = keyof typeof NETWORKS;

/** keccak256("Transfer(address,address,uint256)"), the ERC-20 transfer event */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC_DECIMALS = 6;
/** The fraction of a cent that tells payments apart: 1 to 9999 millionths of a dollar */
const MARKERS = 9999;

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface WalletConfig {
  readonly network: NetworkName;
  /** The host's address, where payments go */
  readonly to: string;
  /** Prices in dollars ("4", "36"); a plan without one isn't offered */
  readonly monthly?: string;
  readonly yearly?: string;
  /** The node the host reads the network from. Default: the network's public one. */
  readonly rpcUrl?: string;
  /** Blocks on top of the payment's before it counts. Default 3 (a few seconds on Base). */
  readonly confirmations?: number;
  /** For tests */
  readonly fetch?: typeof fetch;
}

/** What a transaction turned out to be */
export type TransferCheck =
  | { readonly state: 'waiting' }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'sent'; readonly amounts: ReadonlyArray<string>; readonly at: number };

export interface WalletPayments {
  readonly offer: WalletOffer;
  /** A new payment for a plan, marked with an amount that is not in `taken` */
  payment(plan: string, taken: ReadonlySet<string>): WalletPayment;
  /** What a transaction sent to the host's address in USDC, once confirmed */
  check(tx: string): Promise<TransferCheck>;
  /** Until when a plan paid now lasts, counted on from `from` (unix seconds) */
  extend(plan: string, from: number): number;
}

/** "36" or "4.50" as the token's smallest unit */
export function toUnits(price: string): bigint {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(price.trim());
  if (!match) throw new Error(`"${price}" is not a price in dollars, like 36 or 4.50`);
  return BigInt(match[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0'));
}

export function createWalletPayments(config: WalletConfig): WalletPayments {
  const network = NETWORKS[config.network];
  if (!network) throw new Error(`No such network: ${config.network}. Use ${Object.keys(NETWORKS).join(' or ')}.`);
  if (!ADDRESS.test(config.to)) throw new Error(`"${config.to}" is not an address (0x and 40 hex characters)`);
  const call = config.fetch ?? fetch;
  const rpcUrl = config.rpcUrl ?? network.rpcUrl;
  const confirmations = config.confirmations ?? 3;
  const to = config.to.toLowerCase();
  const token = network.usdc.toLowerCase();

  const plans = [
    ...(config.yearly ? [{ id: 'yearly', label: 'Yearly', price: config.yearly.trim(), units: toUnits(config.yearly) }] : []),
    ...(config.monthly ? [{ id: 'monthly', label: 'Monthly', price: config.monthly.trim(), units: toUnits(config.monthly) }] : []),
  ];
  if (plans.length === 0) throw new Error('A wallet price is needed: monthly, yearly, or both');

  let id = 0;
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await call(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const answer = (await response.json()) as { result?: T; error?: { message?: string } };
    if (!response.ok || answer.error) throw new Error(`The network node: ${answer.error?.message ?? response.status}`);
    return answer.result as T;
  }

  const offer: WalletOffer = Object.freeze({
    chainId: network.chainId,
    chainName: network.chainName,
    rpcUrl: network.rpcUrl,
    explorerUrl: network.explorerUrl,
    token: network.usdc,
    symbol: 'USDC',
    decimals: USDC_DECIMALS,
    to: config.to,
    plans: plans.map(({ id, label, price }) => ({ id, label, price })),
  });

  const payments: WalletPayments = {
    offer,

    payment(planId, taken) {
      const plan = plans.find((known) => known.id === planId);
      if (!plan) throw new Error(`No such plan: ${planId}`);
      // Random, so the amount says nothing about how many others are paying.
      for (let tries = 0; tries < 200; tries++) {
        const marker = BigInt(1 + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! % MARKERS));
        const amount = (plan.units + marker).toString();
        if (!taken.has(amount)) return { plan: plan.id, chainId: network.chainId, token: network.usdc, to: config.to, amount, decimals: USDC_DECIMALS };
      }
      throw new Error('Too many payments are open right now; try again in a while');
    },

    async check(tx) {
      if (!TX_HASH.test(tx)) return { state: 'failed', reason: 'That is not a transaction hash' };
      const receipt = await rpc<{
        status: string;
        blockNumber: string;
        logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>;
      } | null>('eth_getTransactionReceipt', [tx]);
      if (!receipt) return { state: 'waiting' };
      if (receipt.status !== '0x1') return { state: 'failed', reason: 'That transaction failed on the network' };
      const latest = BigInt(await rpc<string>('eth_blockNumber', []));
      if (latest - BigInt(receipt.blockNumber) + 1n < BigInt(confirmations)) return { state: 'waiting' };
      const amounts = receipt.logs
        .filter(
          (log) =>
            log.address.toLowerCase() === token &&
            log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
            // topics[2] is the receiver, as a 32-byte word
            log.topics[2]?.toLowerCase() === `0x${to.slice(2).padStart(64, '0')}`,
        )
        .map((log) => BigInt(log.data).toString());
      if (amounts.length === 0) return { state: 'failed', reason: `That transaction sent no ${offer.symbol} to this host` };
      const block = await rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [receipt.blockNumber, false]);
      if (!block) return { state: 'waiting' };
      return { state: 'sent', amounts, at: Number(BigInt(block.timestamp)) };
    },

    extend(planId, from) {
      const date = new Date(from * 1000);
      if (planId === 'yearly') date.setUTCFullYear(date.getUTCFullYear() + 1);
      else if (planId === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1);
      else throw new Error(`No such plan: ${planId}`);
      return Math.floor(date.getTime() / 1000);
    },
  };
  return Object.freeze(payments);
}
