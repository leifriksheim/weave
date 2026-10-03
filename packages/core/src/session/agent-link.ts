/**
 * @module session/agent-link
 * Connecting an agent on a computer with one command copied from an app:
 * `weave connect wv_…`. Both sides derive a room and a key from the code's
 * random secret, as phone pairing does from the seed; the terminal says who it
 * is, the person allows it at their account home, and the app hands back an
 * agent's note. Everything is sealed, so the relay learns and changes nothing.
 */
import { createNetworkManager, type NetworkManager } from '../network/network-manager.js';
import { createMesh } from '../network/mesh.js';
import type { PeerTransport } from '../network/transport.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { didOf } from '../identity/did.js';
import { parseUCAN } from '../identity/ucan.js';
import { isAgentNote } from '../identity/agent-note.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { isObject } from '../utils/guards.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
import { checkGrant, type Grant } from './connect.js';
import { sealedRoom } from './pairing.js';

const CODE_PREFIX = 'wv_';
const SECRET_BYTES = 16;
const ROOM_PREFIX = utf8Encode('weave-agent-link-room-v1');
const KEY_INFO = utf8Encode('weave-agent-link-key-v1');

/** Messages on the link, each sealed */
const ASK = 'agent-link:ask';
const HEARD = 'agent-link:heard';
const ANSWER = 'agent-link:answer';
const DONE = 'agent-link:done';

/** Longest name an agent may give itself */
const MAX_NAME = 80;

/** Who is asking, as the terminal said */
export interface AgentAsking {
  /** The agent's key — the note is made out to it */
  readonly did: string;
  /** What the terminal calls itself, e.g. "Agent on leifs-macbook". Shown, not trusted. */
  readonly name: string;
}

/** What the app tells the terminal */
type Answer = { readonly grant: Grant } | { readonly denied: string };

// ─── The code ────────────────────────────────────────────────────────

/** A new code: `wv_` and 128 random bits */
export function newAgentCode(): string {
  return CODE_PREFIX + base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/**
 * The secret in a code, for anything a person might paste — surrounding
 * spaces, quotes, the whole command.
 * @throws When there is no code in it
 */
export function readAgentCode(input: string): Uint8Array {
  const match = /wv_([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(input);
  const secret = match ? base64UrlDecode(match[1]!) : null;
  if (!secret || secret.length !== SECRET_BYTES) {
    throw new Error('That is not a connect code. Copy the whole command from “Connect an agent” in the app.');
  }
  return secret;
}

interface LinkNetwork {
  /** Relays to meet on. The app's and the terminal's must share one. */
  readonly relays: ReadonlyArray<string>;
  /** A transport instead of WebRTC — for tests */
  readonly transport?: (did: string) => PeerTransport;
}

/** The room and key for a code, met on the relays (or the test transport) */
function meet(network: LinkNetwork, secret: Uint8Array, did: string) {
  return sealedRoom({
    prefix: ROOM_PREFIX,
    info: KEY_INFO,
    secret,
    did,
    join: (room): NetworkManager =>
      network.transport
        ? createNetworkManager({ did, createTransport: () => network.transport!(did) })
        : createMesh({ relays: network.relays, did, introductions: false }).join(room),
  });
}

// ─── The app's side ──────────────────────────────────────────────────

export type AgentLinkStage =
  | { readonly kind: 'waiting' }
  /** The terminal is there. Call `allow` from a click (it opens the home), or `deny`. */
  | {
      readonly kind: 'asking';
      readonly agent: AgentAsking;
      allow(grant: Grant): Promise<void>;
      deny(reason?: string): void;
    }
  | { readonly kind: 'connected'; readonly agent: AgentAsking }
  | { readonly kind: 'failed'; readonly reason: string };

export interface AgentLinkOffer {
  /** What the person pastes: `wv_…` */
  readonly code: string;
  /** Stops listening. The code stops working. */
  stop(): void;
}

/**
 * Starts offering a connection to an agent on a computer. Keep it running
 * while the code is on screen; the first terminal that shows up with the code
 * is the one asked about, and nobody after it.
 */
export async function offerAgentLink(
  network: LinkNetwork,
  onStage: (stage: AgentLinkStage) => void,
): Promise<AgentLinkOffer> {
  if (network.relays.length === 0 && !network.transport)
    throw new Error('Connecting an agent needs a relay, and none is configured.');
  const code = newAgentCode();
  // A name for this end of the link, and nothing more: it signs nothing.
  const did = await didOf((await createP256Provider().generateKeyPair()).publicKey);
  const room = await meet(network, readAgentCode(code), did);
  const { net } = room;

  let asked: { peer: string; agent: AgentAsking } | null = null;
  const finish = (stage: AgentLinkStage) => room.finish(() => onStage(stage));

  net.on('message', (message: NetworkMessage) => {
    if (room.isSettled()) return;
    void (async () => {
      if (message.type === ASK && !asked) {
        const said = await room.open(message);
        // Not sealed with this code: someone else in the room. Ignored.
        if (!isObject(said) || typeof said.did !== 'string' || !said.did.startsWith('did:key:')) return;
        const name =
          typeof said.name === 'string' && said.name.trim()
            ? said.name.trim().slice(0, MAX_NAME)
            : 'An agent';
        const agent = { did: said.did, name };
        const peer = message.from;
        asked = { peer, agent };
        // So the terminal knows the code was right, and the person is deciding.
        await room.send(peer, HEARD, { heard: true });
        onStage({
          kind: 'asking',
          agent,
          allow: async (grant) => {
            if (parseUCAN(grant.token).payload.aud !== agent.did)
              throw new Error('That note is for a different key.');
            await room.send(peer, ANSWER, { grant } satisfies Answer);
          },
          deny: (reason = 'The person said no.') => {
            void room
              .send(peer, ANSWER, { denied: reason } satisfies Answer)
              .then(() => finish({ kind: 'failed', reason: 'You said no. Make a new code to try again.' }));
          },
        });
      } else if (message.type === DONE && asked && message.from === asked.peer) {
        if (await room.open(message)) finish({ kind: 'connected', agent: asked.agent });
      }
    })();
  });

  onStage({ kind: 'waiting' });
  await net.connect();
  return {
    code,
    stop: () => {
      room.finish();
      net.disconnect();
    },
  };
}

// ─── The terminal's side ─────────────────────────────────────────────

/**
 * Checks a grant the way the terminal must: a valid agent's note, from the
 * account it names, made out to this key.
 * @throws When it does not check out
 */
export async function checkAgentGrant(grant: Grant, audience: string): Promise<void> {
  await checkGrant(grant, audience);
  if (!isAgentNote(grant.token)) throw new Error("The note is not an agent's. Update your account home.");
}

/**
 * Connects this terminal as an agent, with the code from the app.
 *
 * @param params.did This agent's key — the note will be made out to it
 * @param params.name What the person sees, e.g. "Agent on leifs-macbook"
 * @param params.onWaiting Told once the app has heard, and the person is deciding
 * @returns The grant, checked
 * @throws When the code is wrong or stale, the person says no, or nothing answers in time
 */
export async function acceptAgentLink(params: {
  readonly code: string;
  readonly did: string;
  readonly name: string;
  readonly network: LinkNetwork;
  readonly onWaiting?: () => void;
  /** How long to wait for the app to answer at all. Default 60 s. */
  readonly findTimeoutMs?: number;
  /** How long the person has to decide. Default 10 minutes. */
  readonly decideTimeoutMs?: number;
}): Promise<Grant> {
  const room = await meet(params.network, readAgentCode(params.code), params.did);
  return new Promise<Grant>((resolve, reject) => {
    const settle = (done: () => void) => room.finish(done);
    const failWith = (reason: string) => settle(() => reject(new Error(reason)));

    room.net.on('peer-connected', (peer: PeerInfo) => {
      void room.send(peer.did, ASK, { did: params.did, name: params.name.slice(0, MAX_NAME) });
    });

    let heard = false;
    room.net.on('message', (message: NetworkMessage) => {
      void (async () => {
        if (room.isSettled()) return;
        // Once the app has the question, the person gets longer to answer it.
        if (message.type === HEARD && !heard && (await room.open(message))) {
          heard = true;
          params.onWaiting?.();
          room.wait(params.decideTimeoutMs ?? 10 * 60_000, () =>
            reject(new Error('Nobody answered in the app. Make a new code and try again.')),
          );
          return;
        }
        if (message.type !== ANSWER) return;
        const answer = await room.open(message);
        if (!isObject(answer)) return;
        if (typeof answer.denied === 'string') {
          failWith(answer.denied);
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkAgentGrant checks it
          const grant = answer.grant as Grant;
          await checkAgentGrant(grant, params.did);
          await room.send(message.from, DONE, { ok: true });
          settle(() => resolve(grant));
        } catch (error) {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      })();
    });

    room.wait(params.findTimeoutMs ?? 60_000, () =>
      reject(
        new Error(
          'The app did not answer. Check the “Connect an agent” window is still open, or make a new code there.',
        ),
      ),
    );
    room.net.connect().catch(() => failWith('Could not reach the relay.'));
  });
}
