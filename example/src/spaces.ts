/**
 * The space registry: creating lists, sharing them, and joining someone else's.
 */
import type { InvitePreview } from 'weave-protocol';
import { requireSession } from './protocol';

/**
 * Builds a link that lets someone else open this list — to change it too, or
 * with `viewOnly`, only to read it.
 *
 * The invite rides in the URL fragment, which browsers never put in a request —
 * so a private space's key reaches your friend without passing through any
 * server, including the one hosting this page.
 */
export async function createInviteLink(spaceId: string, options: { viewOnly?: boolean } = {}): Promise<string> {
  const invite = await requireSession().node.spaces.invite(spaceId, options.viewOnly ? { write: false } : {});
  const { origin, pathname } = globalThis.location;
  return `${origin}${pathname}#invite=${invite}`;
}

/** Describes an invite without joining, so the user can see what they are accepting. */
export function previewInvite(invite: string): InvitePreview {
  return requireSession().node.spaces.preview(inviteFrom(invite));
}

/** The pending invite in this page's URL, if someone opened a share link. */
export function readInviteFromUrl(): string | null {
  const match = /[#&]invite=([^&]+)/.exec(globalThis.location.hash);
  return match?.[1] ?? null;
}

/** Drops the invite from the address bar once it has been dealt with. */
export function clearInviteFromUrl(): void {
  globalThis.history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
}

/** Accepts either a bare invite or a full share link. */
export function inviteFrom(value: string): string {
  const trimmed = value.trim();
  const match = /[#&]invite=([^&]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
