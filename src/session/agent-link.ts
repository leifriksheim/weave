/**
 * @module session/agent-link
 * Connecting an agent on a computer — Claude Code, Claude Desktop, Cursor —
 * with one command the person copies from an app.
 *
 * The app shows `weave connect wv_…`. The code is a random secret, made for
 * this one connection. Both sides work out a meeting room and a key from it,
 * meet on a relay, and talk over the ordinary peer connection:
 *
 * 1. The terminal says who it is: its own key, made on that computer and never
 *    sent anywhere, and a name for the person to recognise ("Agent on
 *    leifs-macbook").
 * 2. The app shows that and waits for a click, which opens the account home.
 *    The person allows it there, and the home signs an agent's note for that
 *    key — the same note an app gets, saying "agent".
 * 3. The app hands the note back. The terminal keeps it, and from then on runs
 *    a node of its own: the app's tab can close.
 *
 * Everything said is sealed with the key from the code, so the relay — which
 * introduces the two sides and could put itself between them — learns nothing
 * and can change nothing. It is the phone pairing's arrangement
 * (`identity/pairing.ts`), with a secret made for the purpose instead of the
 * seed. The code is pasted, not typed, so it can be long enough that recording
 * the traffic and guessing it later gets nowhere; it works once, and only while
 * the app is showing it.
 */
import { createNetworkManager, type NetworkManager } from '../network/network-manager.js';
import type { PeerTransport } from '../network/transport.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { verifyUCAN, parseUCAN } from '../identity/ucan.js';
import { isAgentNote } from '../identity/agent-note.js';
import { sealPairingPayload, openPairingPayload } from '../identity/pairing.js';
import { base64UrlDecode, base64UrlEncode, concatBytes, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
import type { Grant } from './connect.js';

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

async function linkRoom(secret: Uint8Array): Promise<string> {
  return encodeURIComponent(await cidFromBytes(concatBytes(ROOM_PREFIX, secret)));
}

async function linkKey(secret: Uint8Array): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HKDF' }, false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0) as BufferSource, info: KEY_INFO as BufferSource },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(value: unknown, key: CryptoKey): Promise<number[]> {
  return Array.from(await sealPairingPayload(utf8Encode(JSON.stringify(value)), key));
}

/** What a sealed message says, or null when it wasn't sealed with this code */
async function unseal<T>(message: NetworkMessage, key: CryptoKey): Promise<T | null> {
  if (!Array.isArray(message.payload)) return null;
  try {
    return JSON.parse(utf8Decode(await openPairingPayload(new Uint8Array(message.payload as number[]), key))) as T;
  } catch {
    return null;
  }
}

interface LinkNetwork {
  /** Relays to meet on. The app's and the terminal's must share one. */
  readonly relays: ReadonlyArray<string>;
  /** A transport instead of WebRTC — for tests */
  readonly transport?: (did: string) => PeerTransport;
}

function meet(network: LinkNetwork, room: string, did: string): NetworkManager {
  return createNetworkManager({
    signalingUrls: network.relays.map((relay) => `${relay}?room=${room}`),
    did,
    introductions: false,
    ...(network.transport ? { createTransport: () => network.transport!(did) } : {}),
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
export async function offerAgentLink(network: LinkNetwork, onStage: (stage: AgentLinkStage) => void): Promise<AgentLinkOffer> {
  if (network.relays.length === 0 && !network.transport) throw new Error('Connecting an agent needs a relay, and none is configured.');
  const code = newAgentCode();
  const secret = readAgentCode(code);
  const key = await linkKey(secret);
  // A name for this end of the link, and nothing more: it signs nothing.
  const provider = createP256Provider();
  const did = publicKeyToDid(await provider.exportPublicKey((await provider.generateKeyPair()).publicKey), P256_MULTICODEC);
  const net = meet(network, await linkRoom(secret), did);

  let asked: { peer: string; agent: AgentAsking } | null = null;
  let over = false;
  const finish = (stage: AgentLinkStage) => {
    if (over) return;
    over = true;
    onStage(stage);
    globalThis.setTimeout(() => net.disconnect(), 500);
  };

  net.on('message', (message: NetworkMessage) => {
    if (over) return;
    void (async () => {
      if (message.type === ASK && !asked) {
        const said = await unseal<{ did?: unknown; name?: unknown }>(message, key);
        // Not sealed with this code: someone else in the room. Ignored.
        if (!said || typeof said.did !== 'string' || !said.did.startsWith('did:key:')) return;
        const name = typeof said.name === 'string' && said.name.trim() ? said.name.trim().slice(0, MAX_NAME) : 'An agent';
        const agent = { did: said.did, name };
        asked = { peer: message.from, agent };
        // So the terminal knows the code was right, and the person is deciding.
        net.send(message.from, { type: HEARD, from: did, payload: await seal({ heard: true }, key) });
        onStage({
          kind: 'asking',
          agent,
          allow: async (grant) => {
            if (parseUCAN(grant.token).payload.aud !== agent.did) throw new Error('That note is for a different key.');
            net.send(asked!.peer, { type: ANSWER, from: did, payload: await seal({ grant } satisfies Answer, key) });
          },
          deny: (reason = 'The person said no.') => {
            void seal({ denied: reason } satisfies Answer, key).then((payload) => {
              net.send(asked!.peer, { type: ANSWER, from: did, payload });
              finish({ kind: 'failed', reason: 'You said no. Make a new code to try again.' });
            });
          },
        });
      } else if (message.type === DONE && asked && message.from === asked.peer) {
        if (await unseal(message, key)) finish({ kind: 'connected', agent: asked.agent });
      }
    })();
  });

  onStage({ kind: 'waiting' });
  await net.connect();
  return {
    code,
    stop: () => {
      over = true;
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
  if (!grant || grant.v !== 1 || typeof grant.token !== 'string' || typeof grant.did !== 'string') {
    throw new Error('The app sent something that is not a grant.');
  }
  const verified = await verifyUCAN(grant.token, createP256Provider());
  if (!verified.valid) throw new Error(`The note does not check out: ${verified.reason ?? 'invalid'}`);
  const { payload } = parseUCAN(grant.token);
  if (payload.aud !== audience) throw new Error('The note was made out to a different key.');
  if (payload.iss !== grant.did) throw new Error('The note was not signed by the account it names.');
  if (!isAgentNote(grant.token)) throw new Error('The note is not an agent\'s. Update your account home.');
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
  const secret = readAgentCode(params.code);
  const key = await linkKey(secret);
  const net = meet(params.network, await linkRoom(secret), params.did);

  return new Promise<Grant>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number, reason: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(() => reject(new Error(reason))), ms);
    };
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A moment for the last message to leave.
      setTimeout(() => net.disconnect(), 500);
      done();
    };

    net.on('peer-connected', (peer: PeerInfo) => {
      void seal({ did: params.did, name: params.name.slice(0, MAX_NAME) }, key).then((payload) => {
        net.send(peer.did, { type: ASK, from: params.did, payload });
      });
    });

    let heard = false;
    net.on('message', (message: NetworkMessage) => {
      void (async () => {
        if (settled) return;
        // Once the app has the question, the person gets longer to answer it.
        if (message.type === HEARD && !heard && (await unseal(message, key))) {
          heard = true;
          params.onWaiting?.();
          wait(params.decideTimeoutMs ?? 10 * 60_000, 'Nobody answered in the app. Make a new code and try again.');
          return;
        }
        if (message.type !== ANSWER) return;
        const answer = await unseal<Answer & { grant?: Grant; denied?: string }>(message, key);
        if (!answer) return;
        if (typeof answer.denied === 'string') {
          finish(() => reject(new Error(answer.denied)));
          return;
        }
        try {
          await checkAgentGrant(answer.grant!, params.did);
          net.send(message.from, { type: DONE, from: params.did, payload: await seal({ ok: true }, key) });
          finish(() => resolve(answer.grant!));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      })();
    });

    wait(
      params.findTimeoutMs ?? 60_000,
      'The app did not answer. Check the “Connect an agent” window is still open, or make a new code there.',
    );
    net.connect().catch(() => finish(() => reject(new Error('Could not reach the relay.'))));
  });
}
