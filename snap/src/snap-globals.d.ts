/**
 * The slice of the MetaMask Snaps runtime this Snap uses.
 *
 * Declared here rather than taken from `@metamask/snaps-sdk`, for the same
 * reason the File System Access types are declared by hand: it keeps the Snap
 * dependency-free, and writing the contract out makes the surface we depend on
 * obvious — which matters when that surface is the whole reason the Snap can
 * hold a secret at all.
 */

declare global {
  /** What MetaMask injects into the Snap's sandbox */
  const snap: {
    request(args: { method: string; params?: unknown }): Promise<unknown>;
  };

  /** The Snap's entry point. MetaMask calls this for every RPC request. */
  interface OnRpcRequestArgs {
    /** The site that made the call. The Snap decides what each one may do. */
    readonly origin: string;
    readonly request: { readonly method: string; readonly params?: unknown };
  }
}

export {};
