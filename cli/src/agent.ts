/**
 * The terminal as an agent: `weave connect <code>` once, then `weave mcp`
 * whenever Claude Code, Claude Desktop or Cursor starts it.
 *
 * Connecting makes a key on this computer — it never leaves — and trades the
 * code from the app for an agent's note from the person's account home
 * (`src/session/agent-link.ts`). The note says "agent" and covers the whole
 * account, for as long as the person chose. Nothing here ever holds the seed.
 *
 * From then on this is a node of its own: it finds the account's spaces
 * through the account's list, meets the person's other devices over WebRTC,
 * and keeps working with every tab closed. What it writes shows "via agent",
 * and every device refuses it changing collections, roles, or the account.
 *
 * Kept in `<home>/agent/`: `key.json` (the key), `grant.json` (the note) and
 * `data/` (the spaces). Only this user can read them.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNode, folderStores, publicKeyToDid, P256_MULTICODEC, createP256Provider, type P2PNode } from '../../src/index.js';
import { grantSigner, type Grant } from '../../src/session/connect.js';
import { acceptAgentLink, checkAgentGrant } from '../../src/session/agent-link.js';
import { base64UrlDecode } from '../../src/utils/encoding.js';
import { openFsDirectory } from './fs-directory.js';

/** The relay the apps meet on unless told otherwise */
export const DEFAULT_RELAYS: ReadonlyArray<string> = ['wss://p2p-web-relay.fly.dev'];

/** Relays from `$WEAVE_RELAYS` (comma separated), or the default */
export function configuredRelays(): string[] {
  const listed = (process.env.WEAVE_RELAYS ?? '').split(',').map((relay) => relay.trim()).filter(Boolean);
  return listed.length ? listed : [...DEFAULT_RELAYS];
}

/**
 * WebRTC, which Node doesn't have: the same API over libdatachannel. Loaded
 * only here — it is a native module, and the other commands don't need it.
 */
async function enableWebRTC(): Promise<void> {
  if (typeof globalThis.RTCPeerConnection === 'function') return;
  const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = await import('node-datachannel/polyfill');
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
    const { privateKey, publicKey } = JSON.parse(await readFile(file, 'utf8')) as { privateKey: JsonWebKey; publicKey: JsonWebKey };
    keys = {
      privateKey: await subtle.importKey('jwk', privateKey, algorithm, false, ['sign']),
      publicKey: await subtle.importKey('jwk', publicKey, algorithm, true, ['verify']),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} could not be read. Delete it and connect again.`);
    const made = await subtle.generateKey(algorithm, true, ['sign', 'verify']);
    await mkdir(agentDir(home), { recursive: true, mode: 0o700 });
    const stored = { privateKey: await subtle.exportKey('jwk', made.privateKey), publicKey: await subtle.exportKey('jwk', made.publicKey) };
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
export async function loadAgentGrant(home: string): Promise<Grant | null> {
  try {
    return JSON.parse(await readFile(path.join(agentDir(home), 'grant.json'), 'utf8')) as Grant;
  } catch {
    return null;
  }
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
  if (before && before.did !== grant.did) await rm(path.join(agentDir(params.home), 'data'), { recursive: true, force: true });
  const kept = { ...grant, relays: [...new Set([...(grant.relays ?? []), ...params.relays])] };
  await writeFile(path.join(agentDir(params.home), 'grant.json'), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
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
export async function startAgentNode(home: string, options: { readonly nodes?: ReadonlyArray<string> } = {}): Promise<{ node: P2PNode; grant: Grant; close(): Promise<void> }> {
  const grant = await loadAgentGrant(home);
  if (!grant) throw new Error('No agent is connected on this computer. In the app, choose “Connect an agent” and run the command it shows.');
  if (grant.expiresAt <= Date.now() / 1000) throw new Error('The agent\'s access has run out. In the app, choose “Connect an agent” and run the new command.');
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
    network: { relays, ...(options.nodes?.length ? { nodes: options.nodes } : {}) },
  });
  // Spaces granted by name, when the grant wasn't for the whole account.
  const held = new Set((await base.spaces.list()).map((space) => space.id));
  for (const space of grant.spaces) if (!held.has(space.id)) await base.spaces.join(space.invite).catch(() => {});

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
