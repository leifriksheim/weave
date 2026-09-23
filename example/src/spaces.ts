/**
 * The space registry: creating lists, sharing them, and joining someone else's.
 */
import type { InvitePreview, NewSpace, SpaceSummary } from '@p2p-web/protocol';
import { requireSession } from './protocol';

export type { NewSpace };

/** Every space this identity knows about. */
export async function listSpaces(): Promise<ReadonlyArray<SpaceSummary>> {
  return requireSession().node.spaces.list();
}

/** Creates a list. A private one gets an AES key; a personal one starts with one member. */
export async function createSpace(params: NewSpace): Promise<SpaceSummary> {
  return requireSession().node.spaces.create(params);
}

/** Forgets a space locally, along with its key. */
export async function removeSpace(spaceId: string): Promise<void> {
  await requireSession().node.spaces.leave(spaceId);
}

/**
 * Builds a link that lets someone else open this list.
 *
 * The invite rides in the URL fragment, which browsers never put in a request —
 * so a private space's key reaches your friend without passing through any
 * server, including the one hosting this page.
 */
export async function createInviteLink(spaceId: string): Promise<string> {
  const invite = await requireSession().node.spaces.invite(spaceId);
  const { origin, pathname } = globalThis.location;
  return `${origin}${pathname}#invite=${invite}`;
}

/** Accepts an invite, storing the space (and its key) on this device. */
export async function joinFromInvite(invite: string): Promise<SpaceSummary> {
  return requireSession().node.spaces.join(extractInvite(invite));
}

/** Describes an invite without joining, so the user can see what they are accepting. */
export function previewInvite(invite: string): InvitePreview {
  return requireSession().node.spaces.preview(extractInvite(invite));
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
function extractInvite(value: string): string {
  const trimmed = value.trim();
  const match = /[#&]invite=([^&]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
