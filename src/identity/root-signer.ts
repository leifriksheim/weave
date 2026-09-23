/**
 * @module root-signer
 * Who holds the identity key, and how a session gets permission from it.
 *
 * The root key signs exactly one thing: a note saying "this session key may
 * write for me, until this time". Everything else is signed by the session key.
 * That one signature is the only reason an app needs the identity at all — so
 * it is the only thing that has to be abstracted for the key to live somewhere
 * other than the page.
 *
 * Somewhere else means a MetaMask Snap, or an extension, or anything that will
 * hold a secret and answer questions about it. The page asks for a delegation
 * and gets back a token; the seed never crosses the boundary.
 *
 * Everything downstream — DIDs, expressions, validation, sync — is unchanged by
 * this, because none of it ever sees the root key either.
 */

import type { CryptoProvider } from '../types.js';
import type { Capability, UCANToken } from './ucan.js';
import { issueUCAN } from './ucan.js';

/** What a session needs from an identity, wherever that identity is kept */
export interface RootSigner {
  /** The identity being acted for */
  readonly did: string;
  /**
   * Where the key lives. Worth showing: "your key is in MetaMask" and "your key
   * is in this tab" are different promises to make to someone.
   */
  readonly custody: 'local' | 'remote';
  /**
   * Signs a delegation from the identity to a session key.
   *
   * @param params.audience The session key's DID
   * @param params.capabilities What it may do
   * @param params.expiration Unix seconds after which the note is worthless
   * @returns The signed token
   */
  delegate(params: {
    audience: string;
    capabilities: ReadonlyArray<Capability>;
    expiration: number;
  }): Promise<UCANToken>;
}

/**
 * A signer for a key this page is holding.
 *
 * The ordinary case: the seed was unlocked here, so the key is in memory and
 * signing is a local operation.
 *
 * @param identity The unlocked identity
 * @param provider Crypto provider for signing
 * @returns A signer over it
 */
export function createLocalRootSigner(
  identity: { did: string; privateKey: CryptoKey },
  provider: CryptoProvider,
): RootSigner {
  return Object.freeze({
    did: identity.did,
    custody: 'local' as const,

    async delegate(params: {
      audience: string;
      capabilities: ReadonlyArray<Capability>;
      expiration: number;
    }): Promise<UCANToken> {
      return issueUCAN(
        {
          issuer: { did: identity.did, privateKey: identity.privateKey },
          audience: params.audience,
          capabilities: params.capabilities,
          expiration: params.expiration,
        },
        provider,
      );
    },
  });
}
