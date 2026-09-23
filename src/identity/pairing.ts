/**
 * @module pairing
 * Handing an account to a phone.
 *
 * A phone cannot open a folder — no mobile browser has the File System Access
 * API — so it keeps its own copy of the data, like any other peer. What it needs
 * from the desktop is two things: who you are, and which lists exist.
 *
 * The first fits in a QR code. The second does not, and does not need to: once
 * both sides know the seed they can each work out the same private meeting room
 * and the same key, meet there over the ordinary peer connection, and hand the
 * list of lists across encrypted. So the code stays small enough for a phone
 * camera to read from across a desk.
 *
 * Deriving the room from the *seed* rather than from the DID matters. A DID
 * appears in every expression the account has ever signed, so a room named after
 * one would be a room anyone could find. A room named after the seed can only be
 * found by someone who already has it.
 *
 * What this is not: the phone does not become a satellite of the desktop. It
 * derives the same identity and becomes a full peer, syncing with anyone in the
 * space. The desktop was a bootstrap, and can go offline immediately afterwards.
 */

import { base64UrlEncode, base64UrlDecode, utf8Encode, utf8Decode, concatBytes } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import { protocolError } from '../utils/errors.js';

const ROOM_PREFIX = utf8Encode('p2p-pairing-room-v1');
const PAIRING_KEY_INFO = utf8Encode('p2p-pairing-key-v1');
const IV_BYTES = 12;

/** What the QR code carries */
export interface PairingTicket {
  readonly v: 1;
  /** The recovery code — the seed, in the form that survives a camera */
  readonly code: string;
  /** Where to meet. Must be an address the phone can actually reach. */
  readonly relay: string;
}

/**
 * The room both devices meet in.
 *
 * Derived from the seed, so finding it already requires the secret. Both sides
 * compute it independently and neither has to send it.
 *
 * @param seed The account seed
 * @returns An opaque room id for the signaling relay
 */
export async function pairingRoomId(seed: Uint8Array): Promise<string> {
  return cidFromBytes(concatBytes(ROOM_PREFIX, seed));
}

/**
 * The key the handover is encrypted with.
 *
 * Separate from the vault key and from the signing key, so that a relay
 * operator watching the room learns nothing but the size of the payload.
 *
 * @param seed The account seed
 * @returns An AES-GCM key
 */
export async function derivePairingKey(seed: Uint8Array): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    seed as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0) as BufferSource,
      info: PAIRING_KEY_INFO as BufferSource,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Packs a ticket for a URL fragment.
 *
 * A fragment, because browsers never put one in a request — so the seed reaches
 * the phone without passing through the server hosting the page, the same way a
 * space invite carries its key.
 *
 * @param ticket What the phone needs to know
 * @returns A compact string for after the `#`
 */
export function encodePairingTicket(ticket: PairingTicket): string {
  return base64UrlEncode(utf8Encode(JSON.stringify(ticket)));
}

/**
 * Unpacks a ticket from a URL fragment.
 * @param encoded The string after `#pair=`
 * @returns The ticket it stands for
 */
export function decodePairingTicket(encoded: string): PairingTicket {
  try {
    const ticket = JSON.parse(utf8Decode(base64UrlDecode(encoded.trim()))) as PairingTicket;
    if (ticket?.v !== 1 || typeof ticket.code !== 'string' || typeof ticket.relay !== 'string') {
      throw new Error('unexpected shape');
    }
    return ticket;
  } catch {
    throw protocolError(
      'PAIRING_TICKET_UNREADABLE',
      'That pairing link could not be read.',
      'It may have been truncated, or produced by a different app. Show the code again.',
    );
  }
}

/**
 * Encrypts the handover payload.
 * @param plaintext What to send
 * @param key From {@link derivePairingKey}
 * @returns Nonce followed by ciphertext
 */
export async function sealPairingPayload(plaintext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return concatBytes(iv, new Uint8Array(ciphertext));
}

/**
 * Decrypts the handover payload.
 * @param sealed What arrived
 * @param key From {@link derivePairingKey}
 * @returns The plaintext
 */
export async function openPairingPayload(sealed: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (sealed.length <= IV_BYTES) {
    throw protocolError('PAIRING_TICKET_UNREADABLE', 'That handover was too short to be real.');
  }

  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.slice(0, IV_BYTES) as BufferSource },
      key,
      sealed.slice(IV_BYTES) as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    // Someone else in the room, or a ticket for a different account.
    throw protocolError(
      'PAIRING_TICKET_UNREADABLE',
      'That handover was not meant for this account.',
    );
  }
}
