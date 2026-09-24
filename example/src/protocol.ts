/**
 * This app's sign-in flow, made once for the page.
 *
 * Everything about accounts — where they live, the ways into them, staying
 * signed in, the node that does the work once someone is in — is the
 * protocol's (`createWeaveAuth`). What stays here is this app's configuration,
 * and a way for code outside React to reach the current session.
 */
import {
  createIdentityManager,
  validateDelegationChain,
  publicKeyToDid,
  P256_MULTICODEC,
  type UCANToken,
} from 'weave-protocol';
import { createWeaveAuth, type WeaveSession } from 'weave-protocol/session';
import { CONFIGURED_NODES, relayUrls } from './relay';

export const auth = createWeaveAuth({
  appName: 'Weave',
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES },
});

export type Session = WeaveSession;

/** The current session, or null before sign-in. */
export function getSession(): Session | null {
  return auth.getState().session;
}

/** The current session, or a thrown error if there is none. */
export function requireSession(): Session {
  const session = getSession();
  if (!session) throw new Error('Not signed in — start a session first');
  return session;
}

// ─── Sub-delegation demo ───────────────────────────────────────────────

/** A read-only capability handed down from the session key to a guest key */
export interface GuestDelegation {
  readonly guestDid: string;
  readonly token: UCANToken;
  /** Whether root → session → guest validates as a chain */
  readonly chainValid: boolean;
  readonly reason?: string;
}

/**
 * Attenuates the session's capability down to read-only and hands it to a fresh
 * key, then validates the resulting two-link chain back to the root identity.
 */
export async function delegateToGuest(spaceId: string): Promise<GuestDelegation> {
  const { node } = requireSession();
  const provider = createIdentityManager().getProvider();

  const guestKeys = await provider.generateKeyPair();
  const guestDid = publicKeyToDid(await provider.exportPublicKey(guestKeys.publicKey), P256_MULTICODEC);

  const { token, proofs } = await node.delegate({
    audience: guestDid,
    capabilities: [{ with: `space:${spaceId}`, can: 'expression/read' }],
  });

  const chain = await validateDelegationChain(token.encoded, proofs, provider);
  return { guestDid, token, chainValid: chain.valid, ...(chain.reason ? { reason: chain.reason } : {}) };
}
