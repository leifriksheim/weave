/**
 * The terminal as an agent: `weave connect <code>` trades the app's code for
 * an agent's note from the account home, signed to a key made here that never
 * leaves (`packages/core/src/session/agent-link.ts`). Then `weave mcp` and
 * `weave agent` run a node of their own as the agent, writing "via agent".
 * Kept in `<home>/agent/`, readable only by this user: `key.json`,
 * `grant.json`, `data/`, and `weave agent`'s model keys and `spend.json`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLOSE_DID_TAKEN,
  createNode,
  folderStores,
  didOf,
  DEFINE,
  roleHolds,
  type P2PNode,
} from '@weaveprotocol/core';
import { profile } from '@weaveprotocol/core/schemas';
import { grantSigner, type Grant } from '@weaveprotocol/core/session';
import { acceptAgentLink, checkAgentGrant } from '@weaveprotocol/core/session';
import { base64UrlDecode } from '@weaveprotocol/core';
import { openFsDirectory } from './fs-directory.js';
import { nodeFor, type Unlocked } from './home.js';
import { commaList, errorCode, isRecord, messageOf } from './json.js';

/** The relay the apps meet on unless told otherwise */
const DEFAULT_RELAYS: ReadonlyArray<string> = ['wss://p2p-web-relay.fly.dev'];

/** Relays from `$WEAVE_RELAYS` (comma separated), or the default */
export function configuredRelays(): string[] {
  const listed = commaList(process.env.WEAVE_RELAYS);
  return listed.length ? listed : [...DEFAULT_RELAYS];
}

/**
 * Hosts from `$WEAVE_HOSTS` (`https://host`, comma separated), where the node
 * looks for the account before it knows its host: on a server, it finds its
 * spaces over a host's socket without meeting a device first.
 */
const configuredHosts = () => commaList(process.env.WEAVE_HOSTS);

/**
 * WebRTC, which Node doesn't have: the same API over libdatachannel. Loaded
 * only here — it is a native module, and the other commands don't need it.
 */
export async function enableWebRTC(): Promise<void> {
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
  return { keys, did: await didOf(keys.publicKey) };
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
  const stopHolding = await holdEverySpace(node);
  return {
    node,
    grant,
    close: async () => {
      stopHolding();
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
 * Says a bot is one where apps keep profiles: `bot: true` on its
 * `std.profile`, an app convention. It adds `std.profile` where its role may;
 * false while the space keeps none.
 */
export async function discloseBot(node: P2PNode, space: string): Promise<boolean> {
  const collections = await node.collections.list(space);
  if (!collections.some((c) => c.name === profile.name && c.version !== null)) {
    if (!roleHolds((await node.spaces.access(space)).role, DEFINE)) return false;
    await node.collections.define(space, profile);
  }
  const mine = (await node.records.list(space, { collection: profile.name })).find(
    (record) => record.root === node.did && !record.deleted,
  );
  const body = mine && isRecord(mine.body) ? mine.body : {};
  if (body.bot === true) return true;
  await (mine
    ? node.records.update(space, mine.key, { ...body, bot: true })
    : node.records.put(space, profile.name, { bot: true }));
  return true;
}

/**
 * Gives a bot's account the name it was made with, when it says none: spaces
 * know a member, and people mention it, by the name its account says.
 */
export async function nameBot(node: P2PNode, name: string): Promise<void> {
  if (!(await node.account.profile())) await node.account.setName(name);
}

/** A bot's node: its own account, online as an agent's is, named, holding every space and saying it is a bot there */
export async function startBotNode(
  unlocked: Unlocked,
  options: {
    readonly nodes?: ReadonlyArray<string>;
    /** Relays to meet devices on, over WebRTC. Default `$WEAVE_RELAYS`; none, and it reaches only `nodes`. */
    readonly relays?: ReadonlyArray<string>;
    /** Once for each space it can't say it is a bot in yet, since the space keeps no `std.profile` */
    readonly undisclosed?: (space: string) => void;
  } = {},
): Promise<{ node: P2PNode; close(): Promise<void> }> {
  const relays = options.relays ?? configuredRelays();
  // Only a node that meets devices through relays needs WebRTC, a native module a host doesn't ship.
  if (relays.length) await enableWebRTC();
  const node = await nodeFor(unlocked, {
    network: {
      relays,
      hosts: configuredHosts(),
      ...(options.nodes?.length ? { nodes: options.nodes } : {}),
    },
  });
  await nameBot(node, unlocked.account.name);
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
  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'records' && untold.has(event.space)) tell(event.space);
  });
  const stopHolding = await holdEverySpace(node, {
    onHold: (space) => {
      untold.add(space);
      tell(space);
      // Said only once the space has had time to arrive: a `std.profile` still on its way is no reason to.
      timers.push(setTimeout(() => untold.has(space) && options.undisclosed?.(space), UNDISCLOSED_AFTER_MS));
    },
  });
  return {
    node,
    close: async () => {
      stopHolding();
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

/**
 * Holds every space the node is in, and lets go of each it leaves, so each
 * syncs while it runs rather than on first use. Looks again whenever its spaces
 * change, and every `everyMs` for spaces another process added to the same
 * folder. A space that fails to open is tried again on the next look.
 * @returns How to stop looking
 */
export async function holdEverySpace(
  node: P2PNode,
  options: {
    readonly everyMs?: number;
    readonly onHold?: (space: string) => void;
    readonly onRelease?: (space: string) => void;
    readonly log?: (line: string) => void;
  } = {},
): Promise<() => void> {
  const held = new Map<string, () => Promise<void>>();
  const look = async () => {
    const ids = new Set((await node.spaces.list()).map((space) => space.id));
    for (const id of ids) {
      if (held.has(id)) continue;
      try {
        held.set(id, await node.spaces.hold(id));
        options.onHold?.(id);
      } catch (error) {
        options.log?.(`could not open space ${id}: ${messageOf(error)}`);
      }
    }
    for (const [id, release] of held) {
      if (ids.has(id)) continue;
      held.delete(id);
      await release();
      options.onRelease?.(id);
    }
  };
  // One look at a time, and one more queued behind it for whatever changed meanwhile.
  let running = Promise.resolve();
  let queued = false;
  const lookSoon = () => {
    if (queued) return running;
    queued = true;
    running = running
      .then(() => {
        queued = false;
        return look();
      })
      .catch((error: unknown) => options.log?.(`looking for spaces failed: ${messageOf(error)}`));
    return running;
  };
  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'spaces') void lookSoon();
  });
  const timer = options.everyMs ? setInterval(() => void lookSoon(), options.everyMs) : undefined;
  await lookSoon();
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
