/**
 * @module pairing
 * Handing an account to a phone. The QR code carries the seed; both devices
 * derive the same room and key from it, so the room can only be found by
 * someone who already has the seed (a DID is public, a seed is not).
 */

import { base64UrlEncode, base64UrlDecode, utf8Encode, utf8Decode, concatBytes } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import { protocolError } from '../utils/errors.js';
import { isRecord } from '../utils/guards.js';
import { hkdfAesKey } from './hkdf.js';
import { aesOpen, aesSeal, NONCE_BYTES } from './aes.js';

export const ROOM_PREFIX = utf8Encode('weave-pairing-room-v1');
export const PAIRING_KEY_INFO = utf8Encode('weave-pairing-key-v1');

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
 */
export async function pairingRoomId(seed: Uint8Array): Promise<string> {
  return cidFromBytes(concatBytes(ROOM_PREFIX, seed));
}

/**
 * The key the handover is encrypted with.
 *
 * Separate from the vault key and from the signing key, so that a relay
 * operator watching the room learns nothing but the size of the payload.
 */
export async function derivePairingKey(seed: Uint8Array): Promise<CryptoKey> {
  return hkdfAesKey(seed, PAIRING_KEY_INFO);
}

/**
 * Packs a ticket for a URL fragment.
 *
 * A fragment, because browsers never put one in a request — so the seed reaches
 * the phone without passing through the server hosting the page, the same way a
 * space invite carries its key.
 */
export function encodePairingTicket(ticket: PairingTicket): string {
  return base64UrlEncode(utf8Encode(JSON.stringify(ticket)));
}

function isPairingTicket(value: unknown): value is PairingTicket {
  return (
    isRecord(value) && value.v === 1 && typeof value.code === 'string' && typeof value.relay === 'string'
  );
}

/** Unpacks a ticket from a URL fragment. */
export function decodePairingTicket(encoded: string): PairingTicket {
  try {
    const ticket: unknown = JSON.parse(utf8Decode(base64UrlDecode(encoded.trim())));
    if (!isPairingTicket(ticket)) throw new Error('unexpected shape');
    return ticket;
  } catch {
    throw protocolError(
      'PAIRING_TICKET_UNREADABLE',
      'That pairing link could not be read.',
      'It may have been truncated, or produced by a different app. Show the code again.',
    );
  }
}

/** Encrypts the handover payload: nonce, then ciphertext */
export async function sealPairingPayload(plaintext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  return aesSeal(key, plaintext);
}

/** Decrypts the handover payload */
export async function openPairingPayload(sealed: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (sealed.length <= NONCE_BYTES) {
    throw protocolError('PAIRING_TICKET_UNREADABLE', 'That handover was too short to be real.');
  }
  try {
    return await aesOpen(key, sealed);
  } catch {
    // Someone else in the room, or a ticket for a different account.
    throw protocolError('PAIRING_TICKET_UNREADABLE', 'That handover was not meant for this account.');
  }
}
