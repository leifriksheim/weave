/**
 * @module doors
 * Doors: how someone you share no space with can ask to become your contact.
 *
 * A DID is a name, not an address — knowing it must not be enough to reach
 * you. A **door** is an address you hand out on purpose, and can close:
 *
 * - a **door key**, derived from your contact key and the door's id
 *   (`deriveDoorKeyBytes`), which says nothing about the account behind it,
 *   and a **signing key** beside it (`deriveDoorSignKeyBytes`) that proves
 *   ownership of the door — to a relay clearing its mailbox, and to a knocker
 *   when you answer;
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
 * code   = base64url(JSON { v: 1, key, sign, relays, name? })
 * topic  = base64url(SHA-256("weave/door-topic/v1|" + sign))
 * knock  = sealFor(key, { body, sig }, "weave/knock/v1|" + key)
 * body   = { v: 1, door: key, from, name, invite, note?, at, session, proof }
 * sig    = session key signs canonical(body)
 * ```
 *
 * The relay sees a topic and a sealed blob: not whose door it is, not who
 * knocked, not what they said. See `spec/07-doors.md`.
 */
import type { CryptoProvider } from '../types.js';
import {
  contactKeyPair,
  contactPublicKey,
  isContactPublicKey,
  openSealed,
  sealFor,
  signWithScalar,
  verifyWithPoint,
} from '../identity/contact-key.js';
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
/**
 * How far a knock's own time may be from when the relay took it. A knock is
 * dropped as soon as it is signed, so its time is checked against the relay's
 * — which the knocker can't choose — and a note that ran out can't be used by
 * dating a knock back to when it was good.
 */
export const KNOCK_DROP_WINDOW_SECONDS = 600;
const MAX_NAME = 64;
const MAX_NOTE = 2000;
const MAX_INVITE = 6000;
const MAX_PROOF = 4096;

/** What a door code says: where to knock, and whose door the owner says it is */
export interface DoorCode {
  readonly v: 1;
  /** The door key's public half: a compressed P-256 point, base64url. Knocks are sealed to it. */
  readonly key: string;
  /** The door's signing key's public half, likewise. Its hash is the door's topic. */
  readonly sign: string;
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

/** Cuts text to at most `max` characters without splitting one (a surrogate pair stays whole) */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** Encodes a door code: what goes in a link or a QR code */
export function encodeDoorCode(code: Omit<DoorCode, 'v'>): string {
  const problem = checkDoorCode({ v: 1, ...code });
  if (problem) throw new Error(problem);
  return base64UrlEncode(
    utf8Encode(
      canonicalize({
        v: 1,
        key: code.key,
        sign: code.sign,
        relays: [...code.relays],
        ...(code.name ? { name: code.name } : {}),
      }),
    ),
  );
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
  return Object.freeze({
    v: 1,
    key: code.key,
    sign: code.sign,
    relays: Object.freeze([...code.relays]),
    ...(code.name ? { name: code.name } : {}),
  });
}

/** Why a value is not a door code, or null */
export function checkDoorCode(value: unknown): string | null {
  const code = value as Partial<DoorCode> | null;
  if (!code || typeof code !== 'object' || code.v !== 1) return 'it is not a version 1 door';
  if (!isContactPublicKey(code.key)) return 'its key is not a P-256 public key';
  if (!isContactPublicKey(code.sign) || code.sign === code.key)
    return 'its signing key is not a P-256 public key of its own';
  if (!Array.isArray(code.relays) || code.relays.length === 0 || code.relays.length > MAX_DOOR_RELAYS) {
    return `it names 1–${MAX_DOOR_RELAYS} relays`;
  }
  const relays = checkRelays(code.relays);
  if (relays) return relays;
  if (code.name !== undefined && (typeof code.name !== 'string' || Array.from(code.name).length > MAX_NAME))
    return `its name is text of at most ${MAX_NAME} characters`;
  return null;
}

/**
 * The mailbox topic of a door: a hash of its signing key. The relay can't tell
 * whose door it is, and can check that whoever clears it holds that key.
 */
export async function doorTopic(sign: string): Promise<string> {
  return base64UrlEncode(await sha256(utf8Encode(`weave/door-topic/v1|${sign}`)));
}

/**
 * What a door's owner signs to clear knocks from a relay's mailbox: the topic,
 * the relay's one-time challenge, and which knocks (`*` for all of them).
 */
export const purgeMessage = (topic: string, nonce: string, ids: ReadonlyArray<string> | null) =>
  utf8Encode(`weave/door-purge/v1|${topic}|${nonce}|${ids ? [...ids].sort().join(',') : '*'}`);

/** Signs a relay's purge challenge with the door's signing key */
export function signPurge(
  signKey: Uint8Array,
  topic: string,
  nonce: string,
  ids: ReadonlyArray<string> | null,
): Promise<string> {
  return signWithScalar(signKey, purgeMessage(topic, nonce, ids));
}

/**
 * The answer to a knock: the door's owner, signing with the door's signing key
 * that the account which joined the space for two is theirs. Without it,
 * whoever joined first — someone the invite was passed on to — would be taken
 * for the person behind the door.
 */
const answerMessage = (pairSpace: string, did: string) =>
  utf8Encode(`weave/knock-answer/v1|${pairSpace}|${did}`);

export function signAnswer(signKey: Uint8Array, pairSpace: string, did: string): Promise<string> {
  return signWithScalar(signKey, answerMessage(pairSpace, did));
}

export function checkAnswer(
  sign: string,
  pairSpace: string,
  did: string,
  signature: string,
): Promise<boolean> {
  return verifyWithPoint(sign, answerMessage(pairSpace, did), signature);
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
  const note = knock.note ? clip(knock.note.trim(), MAX_NOTE) : undefined;
  const body: KnockBody = {
    v: 1,
    door,
    from: knock.from,
    name: clip(knock.name.trim(), MAX_NAME) || 'Someone',
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
 * Opens a knock left on a door, and checks it through: sealed to this door;
 * signed by a session key that its account's note vouches for, for the whole
 * account and not by an agent; signed when the relay took it; recent; and
 * carrying an invite to a private space that account made.
 * @param doorKey The door key's private scalar (`deriveDoorKeyBytes`)
 * @param receivedAt When the relay took it, ms, as `fetch` says
 * @returns The knock, or null when it is anything less
 */
export async function openKnock(
  doorKey: Uint8Array,
  blob: string,
  receivedAt: number,
  provider: CryptoProvider,
): Promise<OpenedKnock | null> {
  const door = contactPublicKey(doorKey);
  const opened = (await openSealed((await contactKeyPair(doorKey)).privateKey, blob, knockContext(door))) as {
    body?: KnockBody;
    sig?: unknown;
  } | null;
  const body = opened?.body;
  if (!body || typeof opened.sig !== 'string') return null;
  if (body.v !== 1 || body.door !== door) return null;
  if (typeof body.from !== 'string' || typeof body.session !== 'string' || typeof body.name !== 'string')
    return null;
  if (Array.from(body.name).length > MAX_NAME) return null;
  if (typeof body.invite !== 'string' || body.invite.length > MAX_INVITE) return null;
  if (typeof body.proof !== 'string' || body.proof.length > MAX_PROOF) return null;
  if (body.note !== undefined && (typeof body.note !== 'string' || Array.from(body.note).length > MAX_NOTE))
    return null;
  if (!Number.isSafeInteger(body.at) || !Number.isFinite(receivedAt)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (body.at > now + UCAN_CLOCK_SKEW_SECONDS || body.at < now - KNOCK_TTL_SECONDS) return null;
  // Signed when it was dropped, not dated back to when a note was still good.
  const dropped = Math.floor(receivedAt / 1000);
  if (body.at > dropped + UCAN_CLOCK_SKEW_SECONDS || body.at < dropped - KNOCK_DROP_WINDOW_SECONDS)
    return null;

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
  const chain = await resolveDelegationRoot(body.proof, () => null, provider, { at: body.at }).catch(
    () => null,
  );
  if (!chain?.valid || chain.audience !== body.session || chain.rootDid !== body.from) return null;
  // Knocking makes a space and hands out its invite: only a note for the whole
  // account, to write, may. An app given one space, or only to read, may not.
  if (
    !chain.capabilities.some(
      (capability) =>
        capability.with === '*' && (capability.can === 'expression/*' || capability.can === '*'),
    )
  )
    return null;

  // A private space the knocker made, with its key: anything else isn't a space for two from them.
  let invited;
  try {
    invited = parseSpaceInvite(body.invite);
  } catch {
    return null;
  }
  if (invited.space.creator !== body.from || invited.space.visibility !== 'private' || !invited.key)
    return null;
  if ((await checkSpace(invited.space)) !== null) return null;

  return Object.freeze({
    from: body.from,
    name: clip(body.name, MAX_NAME) || 'Someone',
    ...(body.note ? { note: body.note } : {}),
    invite: body.invite,
    pairSpace: invited.space.id,
    at: body.at * 1000,
  });
}
