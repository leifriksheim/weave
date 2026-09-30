/**
 * Bots a host runs for the spaces it carries (spec/06-nodes-and-sessions.md, Hosts: bots).
 *
 * An admin asks for one from the app with a name and an invite for the role
 * it should hold. The host makes the bot an account of its own, in a folder
 * of its own under `bots/`, and joins with the invite; the bot then says its
 * name and that it is a bot in the space, as `weave agent --bot` does. It
 * reaches the space through the host's own socket, since the host carries it:
 * no relays, no WebRTC.
 *
 * Its rules run while its community's fund has money in it, on the host's
 * model key, within a daily cap per bot; what it spends is taken from that
 * fund (`charge`). With the fund empty, it stays a member and does nothing.
 * Removing it from the space is how it stops: it then has no rules there to
 * run.
 *
 * Unlike carrying, this is not blind: the host holds the bot's keys, so it
 * can read what the bot may read. That is what running a bot means, and the
 * app says so when one is added. The host's own node still holds no key of a
 * space; each bot is a separate node with its own account.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSpaceInvite, type P2PNode, type StorageAdapter } from '@weaveprotocol/core';
import { createAccount, openHome, unlock } from './home.js';
import { startBotNode } from './agent.js';
import { fileSpend, type Price, type Think } from './agent-chat.js';
import { runRules } from './bot-runner.js';
import { isRecord } from './json.js';

/** How the bots a host runs think */
export interface BotModel {
  readonly name: string;
  readonly price?: Price;
  /** A way to think, made fresh for each rule set off */
  readonly think: () => Think;
  /** Dollars a day each bot may spend */
  readonly dailyCap: number;
}

/** What a host keeps about a bot it runs */
interface Kept {
  readonly did: string;
  readonly name: string;
  readonly folder: string;
  /** Unlocks the bot's account: made here, kept by the host, as it runs the bot */
  readonly passphrase: string;
  /** The spaces it was asked to join */
  readonly spaces: ReadonlyArray<string>;
  readonly since: number;
}

export interface HostedBots {
  /** Makes a bot and joins the invite's space with it; its DID */
  start(name: string, invite: string): Promise<{ readonly did: string; readonly name: string }>;
  /** The bots asked to join a space */
  list(spaceId: string): Promise<ReadonlyArray<{ readonly did: string; readonly name: string }>>;
  /** Whether a bot is running its rules now */
  running(did: string): boolean;
  /** Starts or stops each bot's rules as its community's fund says: `funded` is asked with the space's id */
  sync(funded: (spaceId: string) => Promise<boolean>): Promise<void>;
  close(): Promise<void>;
}

const PREFIX = 'bot:';
const MAX_NAME = 60;

export function createHostedBots(options: {
  /** Where each bot's folder is made */
  readonly folder: string;
  /** Where the host keeps what it knows of each bot */
  readonly store: StorageAdapter;
  /** The host's own socket, `ws://127.0.0.1:<port>/peer`: how a bot reaches the spaces the host carries */
  readonly peer: () => string;
  /** Whether the host carries a space: a bot is started only in one it does */
  readonly carries: (spaceId: string) => Promise<boolean>;
  readonly model: BotModel;
  /** Takes what a bot spent, in dollars, from the fund of the space it runs in */
  readonly charge?: (spaceId: string, usd: number, bot: string) => Promise<void>;
  readonly log: (line: string) => void;
}): HostedBots {
  const { store, log } = options;
  const nodes = new Map<string, Promise<{ node: P2PNode; close(): Promise<void> }>>();
  const runners = new Map<string, () => void>();

  const read = async (did: string): Promise<Kept | null> => {
    const bytes = await store.get(`${PREFIX}${did}`);
    if (!bytes) return null;
    const kept: unknown = JSON.parse(new TextDecoder().decode(bytes));
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only `write` below puts anything here
    return isRecord(kept) && typeof kept.did === 'string' ? (kept as unknown as Kept) : null;
  };
  const write = (kept: Kept) =>
    store.put(`${PREFIX}${kept.did}`, new TextEncoder().encode(JSON.stringify(kept)));
  const all = async (): Promise<Kept[]> => {
    const found: Kept[] = [];
    for (const key of await store.list(PREFIX)) {
      const kept = await read(key.slice(PREFIX.length));
      if (kept) found.push(kept);
    }
    return found;
  };

  /** A bot's node, opened once and kept open: it holds its spaces whether or not it is paid */
  let closed = false;
  const open = async (kept: Kept) => {
    // The opening is kept, not only its result: a start and a sync reaching one bot together share one node.
    let opening = nodes.get(kept.did);
    if (!opening) {
      if (closed) throw new Error('The host is closing');
      opening = (async () => {
        const home = await openHome(kept.folder);
        const [account] = await home.accounts.list();
        if (!account) throw new Error(`No account in ${kept.folder}`);
        const unlocked = await unlock(home, account, { passphrase: kept.passphrase });
        return startBotNode(unlocked, { nodes: [options.peer()], relays: [] });
      })();
      nodes.set(kept.did, opening);
      opening.catch(() => nodes.delete(kept.did));
    }
    return (await opening).node;
  };

  // The bots made before a restart come back online.
  const reopening = all().then((bots) =>
    Promise.all(
      bots.map((kept) =>
        open(kept).catch((error: unknown) =>
          log(`bot ${kept.name} could not start: ${error instanceof Error ? error.message : String(error)}`),
        ),
      ),
    ),
  );

  return Object.freeze({
    async start(name: string, invite: string) {
      const called = name.trim().slice(0, MAX_NAME);
      if (!called) throw new Error('A bot needs a name');
      const spaceId = parseSpaceInvite(invite).space.id;
      if (!(await options.carries(spaceId)))
        throw new Error(
          'This host runs bots only in a space it keeps online: keep the space online here first',
        );
      const passphrase = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString(
        'base64url',
      );
      // A folder of its own, named for the moment it was made: two bots may share a name.
      const folder = path.join(
        options.folder,
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      );
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const home = await openHome(folder);
      const { account } = await createAccount(home, { name: called, passphrase });
      const kept: Kept = {
        did: account.did,
        name: called,
        folder,
        passphrase,
        spaces: [spaceId],
        since: Math.floor(Date.now() / 1000),
      };
      await write(kept);
      const node = await open(kept);
      await node.spaces.join(invite);
      log(`bot ${called} (${account.did}) joined space ${spaceId}`);
      return { did: account.did, name: called };
    },

    async list(spaceId: string) {
      return (await all())
        .filter((kept) => kept.spaces.includes(spaceId))
        .map(({ did, name }) => ({ did, name }));
    },

    running: (did: string) => runners.has(did),

    async sync(funded: (spaceId: string) => Promise<boolean>) {
      await reopening;
      for (const kept of await all()) {
        const space = kept.spaces[0];
        const should = !!space && (await funded(space));
        const stop = runners.get(kept.did);
        if (should && !stop) {
          const node = await open(kept).catch(() => null);
          if (!node) continue;
          const own = fileSpend(path.join(kept.folder, 'agent'));
          // What it spends counts against its daily cap, and is taken from its community's fund.
          const spend = {
            today: (who?: string) => own.today(who),
            add: async (usd: number, who?: string) => {
              await own.add(usd, who);
              if (space) await options.charge?.(space, usd, kept.did);
            },
          };
          runners.set(
            kept.did,
            runRules({
              node,
              account: kept.did,
              bot: kept.name,
              think: options.model.think,
              model: options.model.name,
              ...(options.model.price ? { price: options.model.price } : {}),
              spend,
              dailyCap: options.model.dailyCap,
              // A quarter of the day for each person who sets it off, as `weave agent --bot` does.
              capEach: options.model.dailyCap / 4,
              log: (line) => log(`bot ${kept.name}:${line}`),
            }),
          );
          log(`bot ${kept.name} runs its rules`);
        } else if (!should && stop) {
          stop();
          runners.delete(kept.did);
          log(`bot ${kept.name} stopped: its community's fund is empty`);
        }
      }
    },

    async close() {
      closed = true;
      await reopening.catch(() => {});
      for (const stop of runners.values()) stop();
      runners.clear();
      await Promise.all(
        [...nodes.values()].map((opening) => opening.then((started) => started.close()).catch(() => {})),
      );
      nodes.clear();
    },
  });
}
