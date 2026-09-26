/**
 * @module doors
 * Doors: how someone you share no space with can ask to become your contact.
 *
 * A DID is a name, not an address — knowing it must not be enough to reach
 * you. A **door** is an address you hand out on purpose, and can close:
 *
 * - a **door key**, derived from your contact key and the door's id
 *   (`deriveDoorKeyBytes`), which says nothing about the account behind it;
 * - the **relays** whose mailboxes hold knocks on it — two or three, chosen by
 *   you, so no one relay can shut it.
 *
 * Both travel in a **door code** (a link, a QR code, a line in a bio). Someone
 * with it **knocks**: makes a private space for the two of you, and leaves its
 * invite, sealed to the door key, in the door's mailboxes. The knock is signed
 * by the knocker's session key under their account's note, like a record, so
 * it proves who knocked before anyone joins anything. Opening the door is
 * joining that space.
 *
 * ```
 * code   = base64url(JSON { v: 1, key, relays, name? })
 * topic  = base64url(SHA-256("weave/door-topic/v1|" + key))
 * knock  = sealFor(key, { body, sig }, "weave/knock/v1|" + key)
 * body   = { v: 1, door: key, from, name, invite, note?, at, session, proof }
 * sig    = session key signs canonical(body)
 * ```
 *
 * The relay sees a topic and a sealed blob: not whose door it is, not who
 * knocked, not what they said. See `docs/spec/07-doors.md`.
 */
import type { CryptoProvider } from '../types.js';
import { contactKeyPair, contactPublicKey, isContactPublicKey, openSealed, sealFor } from '../identity/contact-key.js';
import { didToPublicKey } from '../identity/did.js';
import { resolveDelegationRoot, UCAN_CLOCK_SKEW_SECONDS } from '../identity/ucan.js';
import { isAgentNote } from '../identity/agent-note.js';
import { canonicalize } from '../schema/expression.js';
import { parseSpaceInvite } from '../space/space-manager.js';
import { checkSpace } from '../space/space-access.js';
import { checkRelays } from '../space/roles.js';
import { sha256 } from '../utils/hash.js';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../utils/encoding.js';

/** A door names at most this many relays: enough that one going away doesn't matter */
export const MAX_DOOR_RELAYS = 3;
/** How long a knock waits in a mailbox, and so how old one may be when opened */
export const KNOCK_TTL_SECONDS = 14 * 24 * 3600;
const MAX_KNOCK_AGE_SECONDS = 30 * 24 * 3600;
const MAX_NAME = 64;
const MAX_NOTE = 2000;
const MAX_INVITE = 6000;
const MAX_PROOF = 4096;

/** What a door code says: where to knock, and whose door the owner says it is */
export interface DoorCode {
  readonly v: 1;
  /** The door key's public half: a compressed P-256 point, base64url */
  readonly key: string;
  /** Relays whose mailboxes hold knocks on it, 1–3 */
  readonly relays: ReadonlyArray<string>;
  /** Who the owner says they are — shown to the knocker, and proves nothing */
  readonly name?: string;
}

/** What a knock carries, signed by the knocker's session key */
export interface KnockBody {
  readonly v: 1;
  /** The door knocked on: its key. Binds the knock to this door. */
  readonly door: string;
  /** The knocker's account */
  readonly from: string;
  /** The name they give */
  readonly name: string;
  /** The invite to the space for two they made */
  readonly invite: string;
  readonly note?: string;
  /** When it was signed, Unix seconds */
  readonly at: number;
  /** The session key that signed it */
  readonly session: string;
  /** The note from `from` to `session`: a UCAN whose chain ends at `from` */
  readonly proof: string;
}

/** A knock that opened and checked out */
export interface OpenedKnock {
  readonly from: string;
  readonly name: string;
  readonly note?: string;
  readonly invite: string;
  /** The id of the space for two */
  readonly pairSpace: string;
  /** When it was signed, ms */
  readonly at: number;
}

/** Encodes a door code: what goes in a link or a QR code */
export function encodeDoorCode(code: Omit<DoorCode, 'v'>): string {
  const problem = checkDoorCode({ v: 1, ...code });
  if (problem) throw new Error(problem);
  return base64UrlEncode(utf8Encode(canonicalize({ v: 1, key: code.key, relays: [...code.relays], ...(code.name ? { name: code.name } : {}) })));
}

/**
 * Reads a door code, or a link carrying one after `#door=` or `door=`.
 * @throws When it isn't one, saying why
 */
export function parseDoorCode(text: string): DoorCode {
  const trimmed = text.trim();
  const found = /(?:^|[#?&])door=([A-Za-z0-9_-]+)/.exec(trimmed);
  const raw = found ? found[1]! : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(base64UrlDecode(raw)));
  } catch {
    throw new Error('That is not a door code — it may be cut short.');
  }
  const problem = checkDoorCode(parsed);
  if (problem) throw new Error(`That door code doesn't work: ${problem}`);
  const code = parsed as DoorCode;
  return Object.freeze({ v: 1, key: code.key, relays: Object.freeze([...code.relays]), ...(code.name ? { name: code.name } : {}) });
}

/** Why a value is not a door code, or null */
export function checkDoorCode(value: unknown): string | null {
  const code = value as Partial<DoorCode> | null;
  if (!code || typeof code !== 'object' || code.v !== 1) return 'it is not a version 1 door';
  if (!isContactPublicKey(code.key)) return 'its key is not a P-256 public key';
  if (!Array.isArray(code.relays) || code.relays.length === 0 || code.relays.length > MAX_DOOR_RELAYS) {
    return `it names 1–${MAX_DOOR_RELAYS} relays`;
  }
  const relays = checkRelays(code.relays);
  if (relays) return relays;
  if (code.name !== undefined && (typeof code.name !== 'string' || code.name.length > MAX_NAME)) return `its name is text of at most ${MAX_NAME} characters`;
  return null;
}

/** The mailbox topic of a door: a hash of its key, so the relay can't tell whose door it is */
export async function doorTopic(key: string): Promise<string> {
  return base64UrlEncode(await sha256(utf8Encode(`weave/door-topic/v1|${key}`)));
}

/** A knock's id: the hash of its sealed blob, as relays file it */
export async function knockId(blob: string): Promise<string> {
  return base64UrlEncode(await sha256(utf8Encode(blob)));
}

const knockContext = (door: string) => `weave/knock/v1|${door}`;

/**
 * Makes a knock: the body, signed by the session key, sealed to the door key.
 * @returns The sealed blob, for relays' mailboxes
 */
export async function sealKnock(
  door: string,
  knock: { readonly from: string; readonly name: string; readonly invite: string; readonly note?: string },
  session: { readonly did: string; readonly key: CryptoKey; readonly proof: string },
  provider: CryptoProvider,
): Promise<string> {
  const note = knock.note?.trim().slice(0, MAX_NOTE);
  const body: KnockBody = {
    v: 1,
    door,
    from: knock.from,
    name: knock.name.trim().slice(0, MAX_NAME) || 'Someone',
    invite: knock.invite,
    ...(note ? { note } : {}),
    at: Math.floor(Date.now() / 1000),
    session: session.did,
    proof: session.proof,
  };
  const sig = base64UrlEncode(await provider.sign(session.key, utf8Encode(canonicalize(body))));
  return sealFor(door, { body, sig }, knockContext(door));
}

/**
 * Opens a knock left on a door, and checks it through: sealed to this door,
 * signed by a session key its account's note vouches for, not by an agent,
 * recent, and carrying an invite to a private space that account made.
 * @param doorKey The door key's private scalar (`deriveDoorKeyBytes`)
 * @returns The knock, or null when it is anything less
 */
export async function openKnock(doorKey: Uint8Array, blob: string, provider: CryptoProvider): Promise<OpenedKnock | null> {
  const door = contactPublicKey(doorKey);
  const opened = (await openSealed((await contactKeyPair(doorKey)).privateKey, blob, knockContext(door))) as {
    body?: KnockBody;
    sig?: unknown;
  } | null;
  const body = opened?.body;
  if (!body || typeof opened.sig !== 'string') return null;
  if (body.v !== 1 || body.door !== door) return null;
  if (typeof body.from !== 'string' || typeof body.session !== 'string' || typeof body.name !== 'string') return null;
  if (typeof body.invite !== 'string' || body.invite.length > MAX_INVITE) return null;
  if (typeof body.proof !== 'string' || body.proof.length > MAX_PROOF) return null;
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > MAX_NOTE)) return null;
  if (!Number.isSafeInteger(body.at)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (body.at > now + UCAN_CLOCK_SKEW_SECONDS || body.at < now - MAX_KNOCK_AGE_SECONDS) return null;

  // Signed by the session key it names…
  let signed = false;
  try {
    const key = await provider.importPublicKey(didToPublicKey(body.session).publicKeyBytes);
    signed = await provider.verify(key, base64UrlDecode(opened.sig), utf8Encode(canonicalize(body)));
  } catch {
    return null;
  }
  if (!signed) return null;
  // …which the account it claims had delegated to when it signed. Agents never knock.
  if (isAgentNote(body.proof)) return null;
  const chain = await resolveDelegationRoot(body.proof, () => null, provider, { at: body.at }).catch(() => null);
  if (!chain?.valid || chain.audience !== body.session || chain.rootDid !== body.from) return null;

  // A private space the knocker made, with its key: anything else isn't a space for two from them.
  let invited;
  try {
    invited = parseSpaceInvite(body.invite);
  } catch {
    return null;
  }
  if (invited.space.creator !== body.from || invited.space.visibility !== 'private' || !invited.key) return null;
  if ((await checkSpace(invited.space)) !== null) return null;

  return Object.freeze({
    from: body.from,
    name: body.name.slice(0, MAX_NAME) || 'Someone',
    ...(body.note ? { note: body.note } : {}),
    invite: body.invite,
    pairSpace: invited.space.id,
    at: body.at * 1000,
  });
}
