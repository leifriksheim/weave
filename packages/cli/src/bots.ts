/**
 * The bots kept on this computer. Each is an account of its own, in a folder
 * of its own under the home's `bots/`: never the account the home already
 * holds, and easy to list and start again (`weave bots`, `weave agent --bot`).
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { openHome } from './home.js';
import { errorCode } from './json.js';

/** A bot kept here: its account's name and DID, and the folder that holds it */
export interface KeptBot {
  readonly name: string;
  readonly did: string;
  readonly folder: string;
}

const botsFolder = (home: string) => path.join(home, 'bots');

async function folderNames(home: string): Promise<string[]> {
  try {
    return (await readdir(botsFolder(home), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/** Every bot kept under the home, by name; a folder with no account in it is not one */
export async function listBots(home: string): Promise<KeptBot[]> {
  const bots: KeptBot[] = [];
  for (const name of await folderNames(home)) {
    const folder = path.join(botsFolder(home), name);
    const [account] = await (await openHome(folder)).accounts.list();
    if (account) bots.push({ name: account.name, did: account.did, folder });
  }
  return bots.sort((a, b) => a.name.localeCompare(b.name));
}

/** The bot a person named: by its name, its folder or its DID */
export const findBot = (bots: ReadonlyArray<KeptBot>, which: string): KeptBot | undefined =>
  bots.find(
    (bot) =>
      bot.name.toLowerCase() === which.toLowerCase() ||
      path.basename(bot.folder) === which ||
      bot.did === which,
  );

/** A folder for a new bot: "Club Bot" is `bots/club-bot`, or `club-bot-2` when that is taken */
export async function newBotFolder(home: string, name: string): Promise<string> {
  const base =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'bot';
  const taken = new Set(await folderNames(home));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return path.join(botsFolder(home), slug);
}
