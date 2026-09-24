/**
 * Invite links: a space, and for a private one its key, in the URL fragment —
 * which browsers never send to a server, including the one hosting this page.
 */
import type { InvitePreview, P2PNode } from 'weave-protocol';

/** A link that lets someone else open this space — to change it too, or with `viewOnly`, only to read it. */
export async function createInviteLink(node: P2PNode, spaceId: string, options: { viewOnly?: boolean } = {}): Promise<string> {
  const invite = await node.spaces.invite(spaceId, options.viewOnly ? { write: false } : {});
  const { origin, pathname } = globalThis.location;
  return `${origin}${pathname}#invite=${invite}`;
}

/** Describes an invite without joining, so the person can see what they are accepting. */
export function previewInvite(node: P2PNode, invite: string): InvitePreview {
  return node.spaces.preview(inviteFrom(invite));
}

/** The pending invite in this page's URL, if someone opened a share link. */
export function readInviteFromUrl(): string | null {
  return /[#&]invite=([^&]+)/.exec(globalThis.location.hash)?.[1] ?? null;
}

/** Drops the invite from the address bar once it has been dealt with. */
export function clearInviteFromUrl(): void {
  globalThis.history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
}

/** Accepts either a bare invite or a full share link. */
export function inviteFrom(value: string): string {
  const trimmed = value.trim();
  return /[#&]invite=([^&]+)/.exec(trimmed)?.[1] ?? trimmed;
}
