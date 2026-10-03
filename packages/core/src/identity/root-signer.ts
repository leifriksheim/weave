/**
 * @module root-signer
 * Who holds the identity key. It signs one thing: a note letting a session key
 * write until a time. Abstracting that one signature lets the key live in an
 * account home instead of the page; the seed never crosses the boundary.
 */

import type { CryptoProvider } from '../types.js';
import type { Capability, Fact, UCANToken } from './ucan.js';
import { issueUCAN } from './ucan.js';

/** What a session needs from an identity, wherever that identity is kept */
export interface RootSigner {
  /** The identity being acted for */
  readonly did: string;
  /**
   * Where the key lives. Worth showing: "your key is in your account home" and
   * "your key is in this tab" are different promises to make to someone.
   */
  readonly custody: 'local' | 'remote';
  /**
   * Signs a delegation from the identity to a session key.
   *
   * @param params.audience The session key's DID
   * @param params.capabilities What it may do
   * @param params.expiration Unix seconds after which the note is worthless
   * @param params.facts Facts the note carries — that its key is an agent's, say
   * @returns The signed token
   */
  delegate(params: {
    audience: string;
    capabilities: ReadonlyArray<Capability>;
    expiration: number;
    facts?: ReadonlyArray<Fact>;
  }): Promise<UCANToken>;
}

/**
 * A signer for a key this page is holding.
 *
 * The ordinary case: the seed was unlocked here, so the key is in memory and
 * signing is a local operation.
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
      facts?: ReadonlyArray<Fact>;
    }): Promise<UCANToken> {
      return issueUCAN(
        {
          issuer: { did: identity.did, privateKey: identity.privateKey },
          audience: params.audience,
          capabilities: params.capabilities,
          expiration: params.expiration,
          ...(params.facts?.length ? { facts: params.facts } : {}),
        },
        provider,
      );
    },
  });
}
