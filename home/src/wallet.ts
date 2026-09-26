/**
 * Paying a host from a crypto wallet in this browser: MetaMask, Coinbase
 * Wallet, Rabby, Phantom — any that announce themselves (EIP-6963), or the one
 * at `window.ethereum`. The wallet only sends: its address is never kept, and
 * never becomes the account.
 */
import type { WalletOffer, WalletPayment } from '@weaveprotocol/core';

/** A wallet's standard interface (EIP-1193) */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface Wallet {
  readonly name: string;
  /** A data: URL */
  readonly icon?: string;
  readonly provider: Eip1193;
}

/** The wallets in this browser; empty when there are none */
export function findWallets(): Promise<ReadonlyArray<Wallet>> {
  return new Promise((resolve) => {
    const found = new Map<string, Wallet>();
    const announced = (event: Event) => {
      const detail = (event as CustomEvent<{ info: { uuid: string; name: string; icon?: string }; provider: Eip1193 }>).detail;
      if (detail?.info?.uuid && detail.provider) {
        found.set(detail.info.uuid, { name: detail.info.name, ...(detail.info.icon ? { icon: detail.info.icon } : {}), provider: detail.provider });
      }
    };
    window.addEventListener('eip6963:announceProvider', announced);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    // Wallets answer at once; a moment is plenty.
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', announced);
      const legacy = (window as { ethereum?: Eip1193 }).ethereum;
      if (found.size === 0 && legacy) found.set('legacy', { name: 'Browser wallet', provider: legacy });
      resolve([...found.values()]);
    }, 300);
  });
}

/** Why a wallet said no, in words */
function walletError(error: unknown): Error {
  const code = (error as { code?: number })?.code;
  if (code === 4001) return new Error('Cancelled in the wallet');
  return new Error((error as { message?: string })?.message ?? String(error));
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`;

/** ERC-20 `transfer(to, amount)`, encoded by hand: a 4-byte selector and two 32-byte words */
function transferData(to: string, amount: string): string {
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`;
}

/**
 * Asks the wallet to send the payment: connects, moves to the host's network
 * (adding it if the wallet doesn't know it), and sends the exact amount.
 * @returns The transaction's hash
 */
export async function sendPayment(wallet: Wallet, offer: WalletOffer, payment: WalletPayment): Promise<string> {
  try {
    const [from] = (await wallet.provider.request({ method: 'eth_requestAccounts' })) as string[];
    if (!from) throw new Error('The wallet shared no account');
    const chainId = hex(payment.chainId);
    try {
      await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    } catch (error) {
      // 4902: a network the wallet doesn't know yet.
      if ((error as { code?: number })?.code !== 4902) throw error;
      await wallet.provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId,
            chainName: offer.chainName,
            rpcUrls: [offer.rpcUrl],
            blockExplorerUrls: [offer.explorerUrl],
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          },
        ],
      });
    }
    return (await wallet.provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: payment.token, data: transferData(payment.to, payment.amount) }],
    })) as string;
  } catch (error) {
    throw walletError(error);
  }
}

// A payment sent but not yet counted survives a reload: the host is asked again when the page comes back.
const pendingKey = (host: string) => `weave.wallet-payment:${host}`;

export function rememberPending(host: string, tx: string): void {
  try {
    localStorage.setItem(pendingKey(host), tx);
  } catch {
    // Private windows: the claim then only happens while this page stays open.
  }
}

export function pendingPayment(host: string): string | null {
  try {
    return localStorage.getItem(pendingKey(host));
  } catch {
    return null;
  }
}

export function forgetPending(host: string): void {
  try {
    localStorage.removeItem(pendingKey(host));
  } catch {
    // Nothing kept, nothing to forget.
  }
}
