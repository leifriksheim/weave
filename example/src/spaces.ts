/**
 * The space registry: creating lists, sharing them, and joining someone else's.
 */
import { parseSpaceInvite, type SpaceRecord, type SpaceType, type SpaceVisibility } from '@p2p-web/protocol';
import { requireSession } from './protocol';

export interface NewSpace {
  readonly name: string;
  /** `personal` is yours alone; `shared` accepts writes from invited peers */
  readonly type: SpaceType;
  /** `private` encrypts every body with the space key */
  readonly visibility: SpaceVisibility;
}

/** Every space this identity knows about. */
export async function listSpaces(): Promise<ReadonlyArray<SpaceRecord>> {
  return requireSession().spaces.list();
}

/** Creates a list. A private one gets an AES key; a personal one starts with one member. */
export async function createSpace(params: NewSpace): Promise<SpaceRecord> {
  const session = requireSession();
  return session.spaces.create({ ...params, owner: session.rootDid });
}

/** Forgets a space locally, along with its key. */
export async function removeSpace(spaceId: string): Promise<void> {
  await requireSession().spaces.remove(spaceId);
}

/**
 * Builds a link that lets someone else open this list.
 *
 * The invite rides in the URL fragment, which browsers never put in a request —
 * so a private space's key reaches your friend without passing through any
 * server, including the one hosting this page.
 */
export async function createInviteLink(spaceId: string): Promise<string> {
  const session = requireSession();
  const invite = await session.spaces.createInvite(spaceId, session.rootDid);
  const { origin, pathname } = globalThis.location;
  return `${origin}${pathname}#invite=${invite}`;
}

/** Accepts an invite, storing the space (and its key) on this device. */
export async function joinFromInvite(invite: string): Promise<SpaceRecord> {
  const session = requireSession();
  return session.spaces.join(extractInvite(invite), session.rootDid);
}

/** Describes an invite without joining, so the user can see what they are accepting. */
export function previewInvite(invite: string) {
  return parseSpaceInvite(extractInvite(invite));
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
