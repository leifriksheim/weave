/**
 * @module session/pairing
 * Handing an account to a phone. The desktop shows a QR code whose link
 * carries the recovery code and a relay; both sides then meet in a room
 * derived from the seed, and the desktop sends the spaces across sealed.
 * Afterwards the phone is a full peer and never needs the desktop again.
 */
import { createMesh } from '../network/mesh.js';
import type { NetworkManager } from '../network/network-manager.js';
import {
  ROOM_PREFIX,
  PAIRING_KEY_INFO,
  encodePairingTicket,
  decodePairingTicket,
  sealPairingPayload,
  openPairingPayload,
  type PairingTicket,
} from '../identity/pairing.js';
import { hkdfAesKey } from '../identity/hkdf.js';
import { seedToRecoveryCode, recoveryCodeToSeed } from '../identity/recovery-code.js';
import { concatBytes, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import { isObject } from '../utils/guards.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
import type { P2PNode } from '../node/types.js';

/**
 * Both ends of a phone pairing or an agent link: a room and a key worked out
 * from one secret, JSON sealed under that key, and an outcome settled once.
 */
export async function sealedRoom(params: {
  readonly prefix: Uint8Array;
  readonly info: Uint8Array;
  readonly secret: Uint8Array;
  /** Who this end is on the wire */
  readonly did: string;
  readonly join: (room: string) => NetworkManager;
}) {
  const key = await hkdfAesKey(params.secret, params.info);
  const net = params.join(await cidFromBytes(concatBytes(params.prefix, params.secret)));
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (done: () => void = () => {}): void => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timer);
    // A moment for the last message to leave.
    globalThis.setTimeout(() => net.disconnect(), 500);
    done();
  };
  return {
    net,
    finish,
    isSettled: () => settled,
    /** Settles with `onTimeout` after `ms`, replacing any earlier wait */
    wait: (ms: number, onTimeout: () => void): void => {
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => finish(onTimeout), ms);
    },
    send: async (to: string, type: string, value: unknown): Promise<void> => {
      const sealed = await sealPairingPayload(utf8Encode(JSON.stringify(value)), key);
      net.send(to, { type, from: params.did, payload: Array.from(sealed) });
    },
    /** What a message says, or null when it was not sealed with this secret */
    open: async (message: NetworkMessage): Promise<unknown> => {
      if (!Array.isArray(message.payload)) return null;
      try {
        return JSON.parse(utf8Decode(await openPairingPayload(new Uint8Array(message.payload), key)));
      } catch {
        return null;
      }
    },
  };
}

/** The message the desktop sends once the phone turns up */
const PAIR_MESSAGE = 'pair';

/** What the desktop hands over */
interface Handover {
  readonly spaces: ReadonlyArray<string>;
}

function isHandover(value: unknown): value is Handover {
  return isObject(value) && Array.isArray(value.spaces) && value.spaces.every((s) => typeof s === 'string');
}

export type PairingStage =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'sent'; readonly spaces: number }
  | { readonly kind: 'received'; readonly spaces: number }
  | { readonly kind: 'failed'; readonly reason: string };

/** A pairing offer the desktop is currently making */
export interface PairingOffer {
  /** The link the QR code encodes */
  readonly url: string;
  /** Stops listening. The link stops working for anyone still holding it. */
  stop(): void;
}

/** Starts offering an account to a phone; the first relay goes in the link */
export async function offerToPhone(
  params: { node: P2PNode; seed: Uint8Array; relays: ReadonlyArray<string>; link: string },
  onStage: (stage: PairingStage) => void,
): Promise<PairingOffer> {
  const { node, seed, relays } = params;
  const relay = relays[0];
  if (!relay) throw new Error('Pairing needs a relay, and none is configured.');

  const url = `${params.link}#pair=${encodePairingTicket({ v: 1, code: seedToRecoveryCode(seed), relay })}`;
  const did = node.sessionDid;
  const { net, send } = await sealedRoom({
    prefix: ROOM_PREFIX,
    info: PAIRING_KEY_INFO,
    secret: seed,
    did,
    join: (room) => createMesh({ relays, did }).join(room),
  });

  net.on('peer-connected', (peer: PeerInfo) => {
    onStage({ kind: 'connected' });
    void (async () => {
      try {
        // Invites carry everything a peer needs to open a space, the key of a
        // private one included: pairing hands over a bundle of them.
        const invites = await Promise.all(
          (await node.spaces.list()).map((space) => node.spaces.invite(space.id)),
        );
        await send(peer.did, PAIR_MESSAGE, { spaces: invites } satisfies Handover);
        onStage({ kind: 'sent', spaces: invites.length });
      } catch (error) {
        onStage({ kind: 'failed', reason: error instanceof Error ? error.message : 'Handover failed' });
      }
    })();
  });

  net.on('error', () => {
    if (!net.isConnected()) onStage({ kind: 'failed', reason: 'Could not reach the relay from this page.' });
  });

  onStage({ kind: 'waiting' });
  await net.connect();
  return { url, stop: () => net.disconnect() };
}

/** The pairing link in this page's URL, if the phone arrived from a QR code. */
export function readPairingTicket(): PairingTicket | null {
  const match = /[#&]pair=([^&]+)/.exec(globalThis.location?.hash ?? '');
  if (!match?.[1]) return null;
  try {
    return decodePairingTicket(match[1]);
  } catch {
    return null;
  }
}

/** Drops the pairing link from the address bar once it has been used. */
export function clearPairingTicket(): void {
  if (!globalThis.location || !globalThis.history) return;
  globalThis.history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
}

/**
 * Collects the spaces from the desktop, having already signed in with the
 * code. Resolves with how many arrived, or 0 after `timeoutMs`: the identity
 * is right either way, so a timeout costs the spaces, not the account.
 */
export async function collectFromDesktop(
  node: P2PNode,
  ticket: PairingTicket,
  onStage: (stage: PairingStage) => void,
  timeoutMs = 30_000,
): Promise<number> {
  const did = node.sessionDid;
  // The relay in the ticket: the computer showing the code is on it, and the
  // phone has no configuration.
  const room = await sealedRoom({
    prefix: ROOM_PREFIX,
    info: PAIRING_KEY_INFO,
    secret: recoveryCodeToSeed(ticket.code),
    did,
    join: (name) => createMesh({ relays: [ticket.relay], did }).join(name),
  });

  return new Promise<number>((resolve) => {
    const finish = (count: number, stage: PairingStage) =>
      room.finish(() => {
        onStage(stage);
        resolve(count);
      });
    const failed = (reason: string) => finish(0, { kind: 'failed', reason });

    room.wait(timeoutMs, () => {
      onStage({
        kind: 'failed',
        reason:
          'The computer did not answer. Check the code is still showing, and that both devices are on the same network.',
      });
      resolve(0);
    });

    room.net.on('peer-connected', () => onStage({ kind: 'connected' }));
    room.net.on('message', (message: NetworkMessage) => {
      if (message.type !== PAIR_MESSAGE || !Array.isArray(message.payload)) return;
      void (async () => {
        try {
          const handover = await room.open(message);
          // Someone else in the room, or a ticket for a different account.
          if (handover === null) throw new Error('That handover was not meant for this account.');
          if (!isHandover(handover)) throw new Error('That handover could not be read.');
          for (const invite of handover.spaces) await node.spaces.join(invite);
          finish(handover.spaces.length, { kind: 'received', spaces: handover.spaces.length });
        } catch (error) {
          failed(error instanceof Error ? error.message : 'That handover could not be read.');
        }
      })();
    });

    onStage({ kind: 'waiting' });
    room.net.connect().catch(() => failed('Could not reach the relay from this phone.'));
  });
}
