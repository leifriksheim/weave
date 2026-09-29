/**
 * Invite links: a space, and for a private one its key, in the URL fragment —
 * which browsers never send to a server, including the one hosting this page
 * (`inviteLink` in `@weaveprotocol/core/react`).
 */
import type { P2PNode } from '@weaveprotocol/core';
import { inviteLink } from '@weaveprotocol/core/react';

/** A link that lets someone else open this space — joining with `role`, or with none, only to read it. */
export async function createInviteLink(node: P2PNode, spaceId: string, role: string | null): Promise<string> {
  return inviteLink(await node.spaces.invite(spaceId, role ? { role } : { write: false }));
}
