/**
 * The pay page's way to every wallet that isn't in this browser: phone
 * wallets by QR code, desktop wallet apps. WalletConnect, through Reown
 * AppKit, the WalletConnect team's own library.
 *
 * Built into `pay/dist/walletconnect.js` (`npm run bundle:pay`) and loaded
 * only on a host's pay page, only when the host was given a WalletConnect
 * project id. Browser wallets don't need it: the page finds those itself
 * (EIP-6963). No adapter: AppKit's own WalletConnect provider is enough to
 * send one transfer, and it answers the same requests a browser wallet does.
 */
import { createAppKit } from '@reown/appkit';
import { base, baseSepolia } from '@reown/appkit/networks';

/** A wallet's standard interface (EIP-1193) */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface ConnectOptions {
  readonly projectId: string;
  /** 8453 for Base, 84532 for Base Sepolia */
  readonly chainId: number;
  /** The host's name, which the wallet shows */
  readonly name: string;
}

let modal: ReturnType<typeof createAppKit> | null = null;

/** Opens WalletConnect's wallet list; resolves with the wallet once the person connected one */
export async function connect(options: ConnectOptions): Promise<Eip1193> {
  const network = options.chainId === base.id ? base : baseSepolia;
  modal ??= createAppKit({
    projectId: options.projectId,
    networks: [network],
    defaultNetwork: network,
    metadata: { name: options.name, description: `Pay ${options.name}`, url: location.origin, icons: [] },
    // Only connecting: no sign-in by email, swaps, buying crypto or tracking.
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, receive: false, history: false },
  });
  const ready = () => {
    const provider = modal!.getWalletProvider() as Eip1193 | undefined;
    return modal!.getIsConnectedState() && provider ? provider : null;
  };
  const already = ready();
  if (already) return already;

  return new Promise((resolve, reject) => {
    let opened = false;
    const stop = () => {
      offAccount();
      offState();
    };
    const offAccount = modal!.subscribeAccount(() => {
      const provider = ready();
      if (!provider) return;
      stop();
      void modal!.close();
      resolve(provider);
    });
    const offState = modal!.subscribeState((state) => {
      if (state.open) opened = true;
      else if (opened && !ready()) {
        stop();
        reject(Object.assign(new Error('Closed without connecting a wallet'), { code: 4001 }));
      }
    });
    void modal!.open({ view: 'Connect' });
  });
}
