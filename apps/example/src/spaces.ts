// Invite links carry the space, and a private one's key, in the URL fragment, which never reaches a server.
import type { P2PNode } from '@weaveprotocol/core';
import { inviteLink } from '@weaveprotocol/core/react';

/** A link that lets someone else open this space — joining with `role`, or with none, only to read it. */
export async function createInviteLink(node: P2PNode, spaceId: string, role: string | null): Promise<string> {
  return inviteLink(await node.spaces.invite(spaceId, role ? { role } : { write: false }));
}
