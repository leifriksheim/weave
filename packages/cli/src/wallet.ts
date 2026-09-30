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
 * payment adds a month or a year to the date, and a home offers to add more.
 *
 * The home shows the payment as a link any wallet opens (EIP-681), and the
 * host watches its address for the transfer (`scan`), so nobody has to tell
 * it which transaction paid.
 *
 * Plain JSON-RPC over `fetch` (eth_getLogs, eth_blockNumber,
 * eth_getBlockByNumber), against any node for the network — a public one,
 * one from a provider, or one's own.
 */
import { isRecord } from './json.js';

/**
 * What the host takes from a wallet: USDC, sent straight to its own address
 * on one network, for a plan of time paid up front.
 */
export interface WalletOffer {
  /** The network, as wallets name it (EIP-155): 8453 for Base */
  readonly chainId: number;
  readonly chainName: string;
  /** A public address a wallet may use to reach the network, if it doesn't know it yet */
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** The token's contract, and its decimals */
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Where payments go: the host's own address */
  readonly to: string;
  /** Each plan's price, in whole units of the token ("36") */
  readonly plans: ReadonlyArray<{ readonly id: string; readonly label: string; readonly price: string }>;
}

/**
 * One payment to make: send exactly `amount` of the token to `to`. The amount
 * is the plan's price plus a fraction of a cent that no other open payment
 * has, which is how the host knows the transfer is this subscription's.
 */
export interface WalletPayment {
  readonly plan: string;
  readonly chainId: number;
  readonly token: string;
  readonly to: string;
  /** In the token's smallest unit, as a decimal string */
  readonly amount: string;
  readonly decimals: number;
}

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

export const isNetworkName = (name: string): name is NetworkName => Object.hasOwn(NETWORKS, name);

/** keccak256("Transfer(address,address,uint256)"), the ERC-20 transfer event */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC_DECIMALS = 6;
/** The fraction of a cent that tells payments apart: 1 to 9999 millionths of a dollar */
const MARKERS = 9999;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
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

/** A transfer of the token to the host's address, confirmed */
export interface Transfer {
  readonly tx: string;
  /** In the token's smallest unit, as a decimal string */
  readonly amount: string;
  /** When its block was made, unix seconds */
  readonly at: number;
}

export interface WalletPayments {
  readonly offer: WalletOffer;
  /** A new payment for a plan, marked with an amount that is not in `taken` */
  payment(plan: string, taken: ReadonlySet<string>): WalletPayment;
  /** A payment as a link a wallet opens (EIP-681), and as people read it */
  request(amount: string): { readonly uri: string; readonly amount: string };
  /**
   * The transfers to the host's address in the blocks after `after`, up to
   * the latest one with enough confirmations; and that block, to start from
   * next time. From the last hour when `after` is null. At most 2,000 blocks
   * a call: a later call goes on from there.
   */
  scan(after: bigint | null): Promise<{ readonly upTo: bigint; readonly transfers: ReadonlyArray<Transfer> }>;
  /** Until when a plan paid now lasts, counted on from `from` (unix seconds) */
  extend(plan: string, from: number): number;
}

/** "36" or "4.50" as the token's smallest unit */
export function toUnits(price: string): bigint {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(price.trim());
  if (!match) throw new Error(`"${price}" is not a price in dollars, like 36 or 4.50`);
  return (
    BigInt(match[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0'))
  );
}

interface Log {
  readonly address: string;
  readonly topics: ReadonlyArray<string>;
  readonly data: string;
}

interface MinedLog extends Log {
  readonly transactionHash: string;
  readonly blockNumber: string;
}

const isLog = (value: unknown): value is Log =>
  isRecord(value) &&
  typeof value.address === 'string' &&
  typeof value.data === 'string' &&
  Array.isArray(value.topics) &&
  value.topics.every((topic: unknown) => typeof topic === 'string');

const isMinedLog = (value: unknown): value is MinedLog =>
  isLog(value) &&
  isRecord(value) &&
  typeof value.transactionHash === 'string' &&
  TX_HASH.test(value.transactionHash) &&
  typeof value.blockNumber === 'string';

/** Blocks looked at, at most, in one scan; and how far back a first scan looks (an hour of Base's 2 s blocks) */
const SCAN_BLOCKS = 2000n;
const FIRST_SCAN_BLOCKS = 1800n;

/** Units of the token as people read them: 4003217 → "4.003217" */
function unitsText(units: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const fraction = (units % scale).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${units / scale}${fraction ? `.${fraction}` : ''}`;
}

/** A hex number the node sent, like a block number or a timestamp */
function quantity(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The network node: a number that is not hex');
  return value;
}

export function createWalletPayments(config: WalletConfig): WalletPayments {
  const network = NETWORKS[config.network];
  if (!network)
    throw new Error(`No such network: ${config.network}. Use ${Object.keys(NETWORKS).join(' or ')}.`);
  if (!ADDRESS.test(config.to))
    throw new Error(`"${config.to}" is not an address (0x and 40 hex characters)`);
  const call = config.fetch ?? fetch;
  const rpcUrl = config.rpcUrl ?? network.rpcUrl;
  const confirmations = config.confirmations ?? 3;
  const to = config.to.toLowerCase();
  const token = network.usdc.toLowerCase();

  const plans = [
    ...(config.yearly
      ? [{ id: 'yearly', label: 'Yearly', price: config.yearly.trim(), units: toUnits(config.yearly) }]
      : []),
    ...(config.monthly
      ? [{ id: 'monthly', label: 'Monthly', price: config.monthly.trim(), units: toUnits(config.monthly) }]
      : []),
  ];
  if (plans.length === 0) throw new Error('A wallet price is needed: monthly, yearly, or both');

  let id = 0;
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await call(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const answer: unknown = await response.json();
    const error = isRecord(answer) ? answer.error : undefined;
    if (!response.ok || error) {
      const message = isRecord(error) ? error.message : undefined;
      throw new Error(`The network node: ${typeof message === 'string' ? message : response.status}`);
    }
    return isRecord(answer) ? answer.result : undefined;
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
        if (!taken.has(amount))
          return {
            plan: plan.id,
            chainId: network.chainId,
            token: network.usdc,
            to: config.to,
            amount,
            decimals: USDC_DECIMALS,
          };
      }
      throw new Error('Too many payments are open right now; try again in a while');
    },

    request(amount) {
      return {
        uri: `ethereum:${network.usdc}@${network.chainId}/transfer?address=${config.to}&uint256=${amount}`,
        amount: `${unitsText(BigInt(amount))} ${offer.symbol} on ${network.chainName}`,
      };
    },

    async scan(after) {
      const latest = BigInt(quantity(await rpc('eth_blockNumber', []))) - BigInt(confirmations - 1);
      const from = after !== null ? after + 1n : latest > FIRST_SCAN_BLOCKS ? latest - FIRST_SCAN_BLOCKS : 0n;
      if (from > latest) return { upTo: after ?? latest, transfers: [] };
      const upTo = from + SCAN_BLOCKS - 1n < latest ? from + SCAN_BLOCKS - 1n : latest;
      const logs = await rpc('eth_getLogs', [
        {
          address: token,
          // topics[2] is the receiver, as a 32-byte word
          topics: [TRANSFER_TOPIC, null, `0x${to.slice(2).padStart(64, '0')}`],
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${upTo.toString(16)}`,
        },
      ]);
      if (!Array.isArray(logs) || !logs.every(isMinedLog))
        throw new Error('The network node: logs that do not read as logs');
      const times = new Map<string, number>();
      const transfers: Transfer[] = [];
      for (const log of logs) {
        if (log.address.toLowerCase() !== token) continue;
        let at = times.get(log.blockNumber);
        if (at === undefined) {
          const block = await rpc('eth_getBlockByNumber', [log.blockNumber, false]);
          if (!isRecord(block)) throw new Error('The network node: a block that does not read as one');
          at = Number(BigInt(quantity(block.timestamp)));
          times.set(log.blockNumber, at);
        }
        transfers.push({ tx: log.transactionHash.toLowerCase(), amount: BigInt(log.data).toString(), at });
      }
      return { upTo, transfers };
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
