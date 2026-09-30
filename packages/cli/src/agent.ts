/**
 * The terminal as an agent: `weave connect <code>` once, then `weave mcp`
 * whenever Claude Code, Claude Desktop or Cursor starts it.
 *
 * Connecting makes a key on this computer — it never leaves — and trades the
 * code from the app for an agent's note from the person's account home
 * (`packages/core/src/session/agent-link.ts`). The note says "agent" and covers the whole
 * account, for as long as the person chose. Nothing here ever holds the seed.
 *
 * From then on this is a node of its own: it finds the account's spaces
 * through the account's list, meets the person's other devices over WebRTC,
 * and keeps working with every tab closed. What it writes shows "via agent",
 * and every device refuses it changing collections, roles, or the account.
 *
 * Kept in `<home>/agent/`: `key.json` (the key), `grant.json` (the note),
 * `data/` (the spaces), and for `weave agent`, `anthropic-key` (the person's
 * API key) and `spend.json` (what today cost). Only this user can read them.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLOSE_DID_TAKEN,
  createNode,
  folderStores,
  publicKeyToDid,
  P256_MULTICODEC,
  createP256Provider,
  type P2PNode,
} from '@weaveprotocol/core';
import { grantSigner, type Grant } from '@weaveprotocol/core/session';
import { acceptAgentLink, checkAgentGrant } from '@weaveprotocol/core/session';
import { base64UrlDecode } from '@weaveprotocol/core';
import { openFsDirectory } from './fs-directory.js';
import type { Unlocked } from './home.js';
import { errorCode, isRecord } from './json.js';

/** The relay the apps meet on unless told otherwise */
const DEFAULT_RELAYS: ReadonlyArray<string> = ['wss://p2p-web-relay.fly.dev'];

/** Relays from `$WEAVE_RELAYS` (comma separated), or the default */
export function configuredRelays(): string[] {
  const listed = (process.env.WEAVE_RELAYS ?? '')
    .split(',')
    .map((relay) => relay.trim())
    .filter(Boolean);
  return listed.length ? listed : [...DEFAULT_RELAYS];
}

/**
 * Hosts from `$WEAVE_HOSTS` (comma separated, `https://host`): where the
 * node looks for the account before it knows which host the account uses,
 * so on a server it finds its spaces over a host's socket without meeting a
 * device first.
 */
function configuredHosts(): string[] {
  return (process.env.WEAVE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

/**
 * WebRTC, which Node doesn't have: the same API over libdatachannel. Loaded
 * only here — it is a native module, and the other commands don't need it.
 */
async function enableWebRTC(): Promise<void> {
  if (typeof globalThis.RTCPeerConnection === 'function') return;
  const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } =
    await import('node-datachannel/polyfill');
  Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate });
}

const agentDir = (home: string) => path.join(home, 'agent');

interface Stored {
  readonly keys: CryptoKeyPair;
  readonly did: string;
}

/** This computer's agent key: made once, kept in `key.json` */
async function agentKey(home: string): Promise<Stored> {
  const file = path.join(agentDir(home), 'key.json');
  const subtle = globalThis.crypto.subtle;
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  let keys: CryptoKeyPair;
  try {
    const stored: unknown = JSON.parse(await readFile(file, 'utf8'));
    // importKey checks the rest of each key.
    if (!isRecord(stored) || !isRecord(stored.privateKey) || !isRecord(stored.publicKey))
      throw new Error('not a key pair');
    const { privateKey, publicKey } = stored;
    keys = {
      privateKey: await subtle.importKey('jwk', privateKey, algorithm, false, ['sign']),
      publicKey: await subtle.importKey('jwk', publicKey, algorithm, true, ['verify']),
    };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT')
      throw new Error(`${file} could not be read. Delete it and connect again.`);
    const made = await subtle.generateKey(algorithm, true, ['sign', 'verify']);
    await mkdir(agentDir(home), { recursive: true, mode: 0o700 });
    const stored = {
      privateKey: await subtle.exportKey('jwk', made.privateKey),
      publicKey: await subtle.exportKey('jwk', made.publicKey),
    };
    await writeFile(file, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    keys = {
      privateKey: await subtle.importKey('jwk', stored.privateKey, algorithm, false, ['sign']),
      publicKey: made.publicKey,
    };
  }
  const did = publicKeyToDid(await createP256Provider().exportPublicKey(keys.publicKey), P256_MULTICODEC);
  return { keys, did };
}

/** The grant this computer's agent was given, or null before `weave connect` */
async function loadAgentGrant(home: string): Promise<Grant | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- written by connectAgent; startAgentNode checks it with checkAgentGrant before use
    return JSON.parse(await readFile(path.join(agentDir(home), 'grant.json'), 'utf8')) as Grant;
  } catch {
    return null;
  }
}

/** Whether this computer's agent was connected to an account, and its note still runs */
export async function hasConnectedAgent(home: string): Promise<boolean> {
  const grant = await loadAgentGrant(home);
  return !!grant && grant.expiresAt > Date.now() / 1000;
}

/** "Agent on leifs-macbook" — what the person sees in the app and their account */
export function defaultAgentName(): string {
  return `Agent on ${os.hostname().replace(/\.local$/, '')}`;
}

/**
 * Trades a code from the app for an agent's note, and keeps it.
 * @returns The grant, checked
 */
export async function connectAgent(params: {
  readonly home: string;
  readonly code: string;
  readonly relays: ReadonlyArray<string>;
  readonly name: string;
  readonly log: (line: string) => void;
}): Promise<Grant> {
  await enableWebRTC();
  const { did } = await agentKey(params.home);
  params.log('Looking for the app…');
  const grant = await acceptAgentLink({
    code: params.code,
    did,
    name: params.name,
    network: { relays: params.relays },
    onWaiting: () => params.log('Found it. Allow the agent in the app — it opens your account home.'),
  });

  // Another account's spaces don't belong next to this one's.
  const before = await loadAgentGrant(params.home);
  if (before && before.did !== grant.did)
    await rm(path.join(agentDir(params.home), 'data'), { recursive: true, force: true });
  const kept = { ...grant, relays: [...new Set([...(grant.relays ?? []), ...params.relays])] };
  await writeFile(path.join(agentDir(params.home), 'grant.json'), `${JSON.stringify(kept, null, 2)}\n`, {
    mode: 0o600,
  });
  return kept;
}

/** Days until a grant runs out, rounded up — "30 days" just after asking for 30 */
export function daysLeft(grant: Grant): number {
  return Math.max(0, Math.ceil((grant.expiresAt - Date.now() / 1000) / 86_400));
}

/**
 * Starts this computer's agent: a node of its own, following the account,
 * acting as the agent.
 * @throws Before `weave connect`, or once the note has run out
 */
export async function startAgentNode(
  home: string,
  options: { readonly nodes?: ReadonlyArray<string> } = {},
): Promise<{ node: P2PNode; grant: Grant; close(): Promise<void> }> {
  const grant = await loadAgentGrant(home);
  if (!grant)
    throw new Error(
      'No agent is connected on this computer. In the app, choose “Connect an agent” and run the command it shows.',
    );
  if (grant.expiresAt <= Date.now() / 1000)
    throw new Error(
      "The agent's access has run out. In the app, choose “Connect an agent” and run the new command.",
    );
  const key = await agentKey(home);
  await checkAgentGrant(grant, key.did);

  await enableWebRTC();
  const data = await openFsDirectory(path.join(agentDir(home), 'data'));
  const relays = [...new Set([...(grant.relays ?? []), ...configuredRelays()])];
  const base = await createNode({
    signer: grantSigner(grant),
    sessionKey: key.keys,
    stores: folderStores(data),
    ...(grant.accountKey ? { accountKey: base64UrlDecode(grant.accountKey) } : {}),
    network: {
      relays,
      hosts: configuredHosts(),
      ...(options.nodes?.length ? { nodes: options.nodes } : {}),
    },
  });
  // Spaces granted by name, when the grant wasn't for the whole account.
  const held = new Set((await base.spaces.list()).map((space) => space.id));
  for (const space of grant.spaces)
    if (!held.has(space.id)) await base.spaces.join(space.invite).catch(() => {});

  const node = await base.asAgent({ keys: key.keys, note: grant.token });
  // Open every space, so it syncs while the agent works rather than on first use.
  for (const space of await node.spaces.list()) void node.spaces.hold(space.id).catch(() => {});
  return {
    node,
    grant,
    close: async () => {
      await node.close().catch(() => {});
      await base.close();
    },
  };
}

/** Forgets this computer's agent: its note and its copy of the spaces. The key stays, so connecting again replaces it at the home. */
export async function forgetAgent(home: string): Promise<void> {
  await rm(path.join(agentDir(home), 'grant.json'), { force: true });
  await rm(path.join(agentDir(home), 'data'), { recursive: true, force: true });
}

/**
 * Says a bot is one, in a space whose apps keep profiles: its `std.profile`
 * there gets `bot: true`. A convention between apps, not something the
 * protocol checks. False while the space keeps no `std.profile`: there apps
 * can't tell the bot from a person, and its name has to say it.
 */
export async function discloseBot(node: P2PNode, space: string): Promise<boolean> {
  const collections = await node.collections.list(space);
  if (!collections.some((c) => c.name === 'std.profile' && c.version !== null)) return false;
  const mine = (await node.records.list(space, { collection: 'std.profile' })).find(
    (record) => record.root === node.did && !record.deleted,
  );
  const body = mine && isRecord(mine.body) ? mine.body : {};
  if (body.bot === true) return true;
  await (mine
    ? node.records.update(space, mine.key, { ...body, bot: true })
    : node.records.put(space, 'std.profile', { bot: true }));
  return true;
}

/**
 * Gives a bot's account the name it was made with, when the account says
 * none. A space knows a member by the name their account says, and people
 * type it after "@"; the name given at `weave agent --bot` is kept only in
 * the bot's folder until then, and without it every space shows the bot by
 * the tail of its DID. A name the account already says is left alone.
 */
export async function nameBot(node: P2PNode, name: string): Promise<void> {
  if (!(await node.account.profile())) await node.account.setName(name);
}

/**
 * A bot's node: an account of its own, unlocked here, online the way an
 * agent is (relays and WebRTC), named (`nameBot`), and holding every space it
 * is in, where it says it is a bot (`discloseBot`).
 */
export async function startBotNode(
  unlocked: Unlocked,
  options: {
    readonly nodes?: ReadonlyArray<string>;
    /** Once for each space it can't say it is a bot in yet, since the space keeps no `std.profile` */
    readonly undisclosed?: (space: string) => void;
  } = {},
): Promise<{ node: P2PNode; close(): Promise<void> }> {
  await enableWebRTC();
  const node = await createNode({
    signer: unlocked.signer,
    stores: unlocked.stores,
    accountKey: unlocked.accountKey,
    contactKey: unlocked.contactKey,
    network: {
      relays: configuredRelays(),
      hosts: configuredHosts(),
      ...(options.nodes?.length ? { nodes: options.nodes } : {}),
    },
  });
  await nameBot(node, unlocked.account.name);
  const held = new Set<string>();
  // Spaces it has not said it is a bot in: tried again as their records change, since `std.profile` may arrive later.
  const untold = new Set<string>();
  const trying = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const tell = (space: string) => {
    if (trying.has(space)) return;
    trying.add(space);
    void discloseBot(node, space)
      .then((told) => told && untold.delete(space))
      .catch(() => {})
      .finally(() => trying.delete(space));
  };
  const holdAll = async () => {
    for (const space of await node.spaces.list()) {
      if (held.has(space.id)) continue;
      held.add(space.id);
      untold.add(space.id);
      void node.spaces
        .hold(space.id)
        .then(() => tell(space.id))
        .catch(() => {});
      // Said only once the space has had time to arrive: a `std.profile` still on its way is no reason to.
      timers.push(
        setTimeout(() => untold.has(space.id) && options.undisclosed?.(space.id), UNDISCLOSED_AFTER_MS),
      );
    }
  };
  // A space joined while it runs is held, and told, too.
  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'spaces') void holdAll();
    if (event.type === 'records' && untold.has(event.space)) tell(event.space);
  });
  await holdAll();
  return {
    node,
    close: async () => {
      timers.forEach(clearTimeout);
      unsubscribe();
      await node.close();
    },
  };
}

/** How long a bot waits for a space's `std.profile` before saying it can't disclose itself there */
const UNDISCLOSED_AFTER_MS = 20_000;

/** Where a provider's API key is kept: `anthropic-key`, `openai-key` */
const modelKeyFile = (home: string, provider: string) => path.join(agentDir(home), `${provider}-key`);

/** The API key `weave agent` was given for a provider, or null before it asked */
export async function loadModelKey(home: string, provider = 'anthropic'): Promise<string | null> {
  try {
    return (await readFile(modelKeyFile(home, provider), 'utf8')).trim() || null;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** Keeps the API key next to the agent's own key, readable only by this user */
export async function saveModelKey(home: string, key: string, provider = 'anthropic'): Promise<void> {
  await mkdir(agentDir(home), { recursive: true, mode: 0o700 });
  await writeFile(modelKeyFile(home, provider), `${key}\n`, { mode: 0o600 });
}

/**
 * Calls `onChange(true)` when every relay refused this agent because another
 * process with the same agent key holds the room, and `onChange(false)` once
 * one lets it in again. Otherwise it would sit there looking connected (#55).
 */
export function watchRelayRefusal(node: P2PNode, onChange: (refused: boolean) => void): () => void {
  let refused = false;
  return node.subscribe((event) => {
    if (event.type !== 'network') return;
    const relays = node.network.status().relays;
    const now = relays.length > 0 && relays.every((relay) => relay.closeCode === CLOSE_DID_TAKEN);
    if (now === refused) return;
    refused = now;
    onChange(now);
  });
}
