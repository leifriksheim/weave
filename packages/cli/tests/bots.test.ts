/**
 * Where `weave agent --bot` keeps its bots: each in a folder of its own under
 * the home's `bots/`, never the account the home itself holds.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findBot, listBots, newBotFolder } from '../src/bots.js';
import { createAccount, openHome } from '../src/home.js';

const made: string[] = [];
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-bots-'));
  made.push(dir);
  return dir;
}

async function makeBot(home: string, name: string) {
  const folder = await newBotFolder(home, name);
  await createAccount(await openHome(folder), { name });
  return folder;
}

describe('bots kept in a home', () => {
  test('are none in a home that holds only its own account', async () => {
    const home = await tempHome();
    await createAccount(await openHome(home), { name: 'Node' });
    assert.deepEqual(await listBots(home), []);
  });

  test('each get a folder named after them, listed by name and found by name, folder or DID', async () => {
    const home = await tempHome();
    await createAccount(await openHome(home), { name: 'Node' });
    const club = await makeBot(home, 'Club Bot');
    const again = await makeBot(home, 'Club Bot');
    await makeBot(home, 'Årsmøte 🤖');
    await mkdir(path.join(home, 'bots', 'empty'), { recursive: true });

    assert.equal(path.relative(home, club), path.join('bots', 'club-bot'));
    assert.equal(path.relative(home, again), path.join('bots', 'club-bot-2'));
    const bots = await listBots(home);
    assert.deepEqual(
      bots.map((bot) => [bot.name, path.basename(bot.folder)]),
      [
        ['Årsmøte 🤖', 'arsm-te'],
        ['Club Bot', 'club-bot'],
        ['Club Bot', 'club-bot-2'],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
      'a folder with no account in it is not a bot, and the home’s own account is not one',
    );
    const second = bots.find((bot) => bot.folder === again)!;
    assert.equal(findBot(bots, 'club bot')?.folder, club);
    assert.equal(findBot(bots, 'club-bot-2'), second);
    assert.equal(findBot(bots, second.did), second);
    assert.equal(findBot(bots, 'Nobody'), undefined);
  });
});
