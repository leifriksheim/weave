/**
 * Handing this account to a phone.
 *
 * The desktop shows a QR code. The phone's camera reads it — no scanner in the
 * app, because both iOS and Android recognise a URL in a QR natively — and opens
 * a link whose fragment carries the recovery code and the address of the relay.
 *
 * That gets the phone the identity. It still does not know which lists exist,
 * and it never will from the code alone: a folder is unreadable to it, and the
 * list of lists plus their keys is far too big for a camera to read reliably. So
 * both sides derive the same private room from the seed, meet there over the
 * ordinary peer connection, and the desktop sends the lists across encrypted.
 *
 * Afterwards the phone is a full peer. It holds its own replica, syncs with
 * anyone in the space, and never refers to the desktop again — which is the
 * difference between this and the phone-is-the-real-device pairing that
 * messaging apps do.
 */
import {
  createNetworkManager,
  pairingRoomId,
  derivePairingKey,
  encodePairingTicket,
  decodePairingTicket,
  sealPairingPayload,
  openPairingPayload,
  seedToRecoveryCode,
  recoveryCodeToSeed,
  utf8Encode,
  utf8Decode,
  type NetworkMessage,
  type PairingTicket,
  type PeerInfo,
} from '@p2p-web/protocol';
import { getSessionSeed, requireSession } from './protocol';
import { relayUrl, relayUrls, relayProblem, servedOverLan } from './relay';

export { relayProblem, servedOverLan };

/** The message the desktop sends once the phone turns up */
const PAIR_MESSAGE = 'pair';

/** What the desktop hands over */
interface Handover {
  readonly spaces: ReadonlyArray<string>;
}

export type PairingStage =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'sent'; readonly spaces: number }
  | { readonly kind: 'received'; readonly spaces: number }
  | { readonly kind: 'failed'; readonly reason: string };

/** Whether this session can be handed to a phone at all. */
export function canPairPhone(): boolean {
  return getSessionSeed() !== null;
}

/** A pairing offer the desktop is currently making */
export interface PairingOffer {
  /** The link the QR code encodes */
  readonly url: string;
  /** Stops listening. The link stops working for anyone still holding it. */
  stop(): void;
}

/**
 * Starts offering this account to a phone.
 *
 * @param onStage Called as the handover progresses
 * @returns The link to put in a QR code, and a way to stop
 */
export async function offerToPhone(onStage: (stage: PairingStage) => void): Promise<PairingOffer> {
  const session = requireSession();
  const seed = getSessionSeed();
  if (!seed) {
    throw new Error('This sign-in has no code to hand on — use a folder or a recovery code.');
  }

  const relay = relayUrl();
  const ticket: PairingTicket = { v: 1, code: seedToRecoveryCode(seed), relay };
  const { origin, pathname } = globalThis.location;
  const url = `${origin}${pathname}#pair=${encodePairingTicket(ticket)}`;

  const key = await derivePairingKey(seed);
  const room = encodeURIComponent(await pairingRoomId(seed));
  const network = createNetworkManager({
    signalingUrls: relayUrls().map((url) => `${url}?room=${room}`),
    did: session.sessionDid,
  });

  network.on('peer-connected', (peer: PeerInfo) => {
    onStage({ kind: 'connected' });

    void (async () => {
      try {
        // Invites already carry everything a peer needs to open a list,
        // including the key for a private one. Pairing is handing over a
        // bundle of them at once.
        const spaces = await session.node.spaces.list();
        const invites = await Promise.all(spaces.map((space) => session.node.spaces.invite(space.id)));

        const sealed = await sealPairingPayload(
          utf8Encode(JSON.stringify({ spaces: invites } satisfies Handover)),
          key,
        );

        network.send(peer.did, {
          type: PAIR_MESSAGE,
          from: session.sessionDid,
          payload: Array.from(sealed),
        });
        onStage({ kind: 'sent', spaces: invites.length });
      } catch (error) {
        onStage({ kind: 'failed', reason: error instanceof Error ? error.message : 'Handover failed' });
      }
    })();
  });

  network.on('error', () => {
    if (!network.isConnected()) {
      onStage({ kind: 'failed', reason: 'Could not reach the relay from this page.' });
    }
  });

  onStage({ kind: 'waiting' });
  await network.connect();

  return { url, stop: () => network.disconnect() };
}

/** The pairing link in this page's URL, if the phone arrived from a QR code. */
export function readPairingTicket(): PairingTicket | null {
  const match = /[#&]pair=([^&]+)/.exec(globalThis.location.hash);
  if (!match?.[1]) return null;
  try {
    return decodePairingTicket(match[1]);
  } catch {
    return null;
  }
}

/** Drops the pairing link from the address bar once it has been used. */
export function clearPairingTicket(): void {
  globalThis.history.replaceState(
    null,
    '',
    globalThis.location.pathname + globalThis.location.search,
  );
}

/**
 * Collects the lists from the desktop, having already signed in with the code.
 *
 * Resolves once they have arrived, or after `timeoutMs` with nothing — the
 * desktop may have closed the QR, or the two devices may not be able to reach
 * each other. The identity is already correct either way, so a timeout costs
 * the lists, not the account.
 *
 * @param ticket The ticket from the URL
 * @param onStage Called as the handover progresses
 * @param timeoutMs How long to wait for the desktop
 * @returns How many lists arrived
 */
export async function collectFromDesktop(
  ticket: PairingTicket,
  onStage: (stage: PairingStage) => void,
  timeoutMs: number = 30_000,
): Promise<number> {
  const session = requireSession();
  const seed = recoveryCodeToSeed(ticket.code);
  const key = await derivePairingKey(seed);

  // The phone uses the relay named in the ticket: it is the one the computer
  // showing the code is definitely on, and the phone has no configuration.
  const network = createNetworkManager({
    signalingUrl: `${ticket.relay}?room=${encodeURIComponent(await pairingRoomId(seed))}`,
    did: session.sessionDid,
  });

  return new Promise<number>((resolve) => {
    let settled = false;

    const finish = (count: number, stage: PairingStage) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      network.disconnect();
      onStage(stage);
      resolve(count);
    };

    const timer = globalThis.setTimeout(
      () =>
        finish(0, {
          kind: 'failed',
          reason: 'The computer did not answer. Check the code is still showing, and that both devices are on the same network.',
        }),
      timeoutMs,
    );

    network.on('peer-connected', () => onStage({ kind: 'connected' }));

    network.on('message', (message: NetworkMessage) => {
      if (message.type !== PAIR_MESSAGE || !Array.isArray(message.payload)) return;

      void (async () => {
        try {
          const opened = await openPairingPayload(new Uint8Array(message.payload as number[]), key);
          const { spaces } = JSON.parse(utf8Decode(opened)) as Handover;

          for (const invite of spaces) {
            await session.node.spaces.join(invite);
          }
          finish(spaces.length, { kind: 'received', spaces: spaces.length });
        } catch (error) {
          finish(0, {
            kind: 'failed',
            reason: error instanceof Error ? error.message : 'That handover could not be read.',
          });
        }
      })();
    });

    onStage({ kind: 'waiting' });
    network.connect().catch(() =>
      finish(0, { kind: 'failed', reason: 'Could not reach the relay from this phone.' }),
    );
  });
}
