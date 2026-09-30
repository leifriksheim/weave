/**
 * `weave` — the protocol from a terminal.
 *
 *   weave init                         create an account (prints its recovery code once)
 *   weave whoami
 *   weave spaces list | create | invite | join | leave | status
 *   weave records list | get | put | update | delete
 *   weave run                          stay up: sync every space, serve sockets and a relay
 *   weave host                         a hosting service: carry many accounts' spaces, blind
 *   weave connect <code>               connect this computer's agent, with the code from an app
 *   weave mcp                          serve the same operations to an agent over MCP (stdio)
 *   weave agent                        the connected agent on its own, with your Anthropic API key
 *   weave actions                      every operation, with its input schema
 *
 * Every data command is generated from NODE_ACTIONS: `weave records put` is the
 * `records_put` action, and its flags are that action's input fields. The same
 * list is what MCP and WebMCP expose, so the three never drift apart.
 *
 * Secrets never go on the command line, where `ps` would show them. An account
 * unlocks with WEAVE_RECOVERY_CODE or WEAVE_PASSPHRASE, a file named by
 * --code-file / --passphrase-file, or a prompt.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface as createPromiseInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  createNode,
  isValidRecoveryCode,
  NODE_ACTIONS,
  runAction,
  type NodeAction,
  type P2PNode,
} from '@weaveprotocol/core';
import { startRules, suggestedRules, type RuleTrigger } from '@weaveprotocol/core/schemas';
import {
  chooseAccount,
  createAccount,
  homePath,
  openHome,
  unlock,
  type Home,
  type Unlocked,
} from './home.js';
import { startDaemon } from './daemon.js';
import { startHost } from './host.js';
import {
  allowList,
  billingFromEnv,
  checkExposure,
  defaultHostData,
  hostKey,
  hostStores,
  mirrorFromEnv,
  presentationFromEnv,
  quotaFromEnv,
  spaceSize,
  walletFromEnv,
} from './host-setup.js';
import { PEER_CONTENT_NOTE, runMcpStdio } from './mcp.js';
import {
  configuredRelays,
  connectAgent,
  daysLeft,
  defaultAgentName,
  forgetAgent,
  hasConnectedAgent,
  loadModelKey,
  saveModelKey,
  startAgentNode,
  startBotNode,
  watchRelayRefusal,
} from './agent.js';
import {
  createAgentChat,
  DEFAULT_MODEL,
  fileSpend,
  parsePrice,
  priceOf,
  type Price,
  spendFor,
  streamingThink,
} from './agent-chat.js';
import { triggerPrompt } from './agent-rules.js';
import { openAIThink } from './agent-openai.js';
import { configSnippet, configureClients, serverCommand } from './clients.js';
import { addRule, defineStandard, loadModelSetting, setUpModel } from './guide.js';
import * as ask from './ask.js';
import { isRecord } from './json.js';
import { completeInput } from './complete.js';

const VERSION = '0.1.0';

const USAGE = `weave ${VERSION} — your spaces, from a terminal

Run "weave" alone at a terminal to pick what to do. At a terminal, anything a
command still needs is asked for: a space from your spaces, a role, a yes or
no. Anywhere else (an agent, a script, CI) nothing is ever asked: a missing
value fails at once, naming the flag that gives it. --yes answers yes ahead.

Usage:
  weave init [--name NAME] [--passphrase] [--existing]
  weave whoami
  weave spaces  list | create | invite | join | leave | status   [--flags]
  weave records list | get | put | update | delete               [--flags]
  weave run [--port 8787] [--host 127.0.0.1] [--node wss://…/peer] [--create]
  weave host [--port 8787] [--host 127.0.0.1] [--data DIR] [--free] [--allow did:key:…]
  weave connect <code> [--name NAME] [--relay wss://…] [--no-configure]
  weave disconnect
  weave mcp [--account]
  weave agent [--setup] [--model claude-opus-5-5] [--daily-cap 2] [--no-chat]
              [--provider anthropic|openai] [--base-url URL] [--price IN/OUT]
  weave agent --bot [--daily-cap-each 0.5]   an account of its own, as a bot in its spaces
  weave rule add [--space ID] [--name N] [--collection C] [--where JSON] [--every CRON]
                 [--from ROLES] [--do TEXT] [--by BOT|me]
  weave collections define --standard std.rule [--space ID]
  weave actions

Agents (Claude Code, Claude Desktop, Cursor):
  In the app, choose "Connect an agent" and run the command it shows. It
  connects this computer's agent to your account, and adds "weave" to the
  agents it finds. From then on they start "weave mcp" themselves: a node of
  its own, working with every tab closed. "weave mcp --account" serves the
  unlocked account instead, as you rather than as an agent.

  "weave agent" runs the connected agent on its own instead, chatting in this
  terminal, with your Anthropic API key (ANTHROPIC_API_KEY, or asked for once
  and kept in the agent's folder). Deleting or overwriting asks you first, and
  it stops for the day once --daily-cap dollars are spent. It also runs your
  rules (std.rule records): what to do when some records appear or change,
  or at set times. --no-chat runs only those, until stopped.

  Any server that speaks OpenAI's Chat Completions works with --provider
  openai: OpenAI, OpenRouter, DeepSeek, Kimi, or a model on your own machine
  (--base-url http://localhost:11434/v1 for Ollama, no key needed). Models
  whose price it doesn't know need --price, dollars per million tokens.
  The key comes from OPENAI_API_KEY (or ANTHROPIC_API_KEY), or is asked for.

  "weave agent --bot" runs the unlocked account itself as a bot instead: an
  account of its own that people invite to their spaces. It says it is a bot
  on its std.profile where a space keeps them, and runs the rules that name
  it (by) of members holding std.rule/instruct there.
  --daily-cap-each limits what each person who sets it off may spend a day
  (a quarter of --daily-cap unless given).

Common flags:
  --home DIR          data folder (default $WEAVE_HOME or ~/.weave) — can be the folder a browser uses
  --account NAME      which account, when the folder holds several (or $WEAVE_ACCOUNT)
  --json '{…}'        pass an action's input as JSON instead of flags

Unlocking (never as a flag value):
  WEAVE_RECOVERY_CODE / --code-file FILE   the account's recovery code
  WEAVE_PASSPHRASE / --passphrase-file FILE  a passphrase set with "init --passphrase"
  otherwise you are asked
`;

const stderr = (line: string) => process.stderr.write(`${line}\n`);
const logLine = (line: string) => stderr(`[${new Date().toISOString()}] ${line}`);

/** Serves until SIGINT or SIGTERM, then closes what was started and exits. */
async function untilStopped(running: { close(): Promise<void> }): Promise<never> {
  const stop = () => {
    stderr('shutting down');
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return new Promise(() => {});
}

/** Runs something against the unlocked account's folder, offline, printing what it returns */
async function withNode(globals: Globals, work: (node: P2PNode) => Promise<unknown>): Promise<number> {
  const unlocked = await openAccount(globals);
  const node = await createNode({
    signer: unlocked.signer,
    stores: unlocked.stores,
    accountKey: unlocked.accountKey,
    contactKey: unlocked.contactKey,
    watchIntervalMs: 0,
  });
  try {
    process.stdout.write(`${JSON.stringify(await work(node), null, 2)}\n`);
  } finally {
    await node.close();
  }
  return 0;
}

/** What `weave` alone offers at a terminal: the things people come to do, each a command */
const MENU: ReadonlyArray<{
  readonly label: string;
  readonly hint: string;
  readonly words: string[] | null;
}> = [
  { label: 'Set up an account on this computer', hint: 'weave init', words: ['init'] },
  { label: 'Invite someone to a space', hint: 'weave spaces invite', words: ['spaces', 'invite'] },
  { label: 'Join a space', hint: 'weave spaces join', words: ['spaces', 'join'] },
  { label: 'Connect an agent to my account', hint: 'weave connect', words: ['connect'] },
  { label: 'Run my agent', hint: 'weave agent', words: ['agent'] },
  { label: 'Run a bot for a community', hint: 'weave agent --bot', words: ['agent', '--bot'] },
  { label: 'Tell an agent or bot what to do, and when', hint: 'weave rule add', words: ['rule', 'add'] },
  { label: 'Every command', hint: 'weave help', words: null },
];

/** Reads a secret without showing it, at a terminal; anywhere else it has to come from the environment. */
const askSecret = (prompt: string) =>
  ask.secret(prompt.replace(/:\s*$/, ''), 'set it in the environment, as `weave help` says');

async function readSecretFile(file: string | undefined): Promise<string | undefined> {
  return file ? (await readFile(file, 'utf8')).trim() : undefined;
}

interface Globals {
  readonly home?: string;
  readonly account?: string;
  readonly codeFile?: string;
  readonly passphraseFile?: string;
  /** `--yes`: go ahead without asking first */
  readonly yes?: boolean;
}

async function openAccount(globals: Globals) {
  const home = await openHome(globals.home);
  const account = await chooseAccount(home, globals.account);

  let code = process.env.WEAVE_RECOVERY_CODE ?? (await readSecretFile(globals.codeFile));
  let passphrase = process.env.WEAVE_PASSPHRASE ?? (await readSecretFile(globals.passphraseFile));
  if (!code && !passphrase) {
    const answer = await askSecret(`Recovery code or passphrase for ${account.name}: `);
    if (isValidRecoveryCode(answer)) code = answer;
    else passphrase = answer;
  }
  return unlock(home, account, { ...(code ? { code } : {}), ...(passphrase ? { passphrase } : {}) });
}

/** Turns `--space x --limit 3 --body '{…}'` into an action's input, by its schema. */
function inputFromFlags(action: NodeAction, args: ReadonlyArray<string>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const [rawKey = '', inline] = arg.slice(2).split(/=(.*)/s, 2);

    if (rawKey === 'json') {
      const value = inline ?? args[++i];
      Object.assign(input, JSON.parse(value ?? '{}'));
      continue;
    }

    const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const spec = action.input.properties[key];
    if (!spec)
      throw new Error(
        `${action.name} has no --${rawKey}. It takes: ${
          Object.keys(action.input.properties)
            .map((k) => `--${k}`)
            .join(' ') || 'nothing'
        }`,
      );

    if (spec.type === 'boolean') {
      input[key] = inline === undefined ? true : inline === 'true';
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`--${rawKey} needs a value`);
    input[key] =
      spec.type === 'integer' || spec.type === 'number'
        ? Number(value)
        : spec.type === 'object'
          ? JSON.parse(value)
          : value;
  }
  return input;
}

function findAction(
  words: ReadonlyArray<string>,
): { action: NodeAction; rest: ReadonlyArray<string> } | null {
  const [first, second] = words;
  const byPair = second ? NODE_ACTIONS.find((a) => a.name === `${first}_${second}`) : undefined;
  if (byPair) return { action: byPair, rest: words.slice(2) };
  const byName = NODE_ACTIONS.find((a) => a.name === first || a.name === first?.replace(/-/g, '_'));
  return byName ? { action: byName, rest: words.slice(1) } : null;
}

function splitGlobals(argv: ReadonlyArray<string>): { globals: Globals; rest: string[] } {
  const globals: Record<string, string | boolean> = {};
  const rest: string[] = [];
  const names: Record<string, keyof Globals> = {
    '--home': 'home',
    '--account': 'account',
    '--code-file': 'codeFile',
    '--passphrase-file': 'passphraseFile',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--yes' || argv[i] === '-y') {
      globals.yes = true;
      continue;
    }
    const [flag = '', inline] = argv[i]!.split(/=(.*)/s, 2);
    const name = names[flag];
    if (name) globals[name] = inline ?? argv[++i] ?? '';
    else rest.push(argv[i]!);
  }
  return { globals, rest };
}

/** A passphrase chosen here: typed twice, unseen, or `WEAVE_PASSPHRASE` */
async function newPassphrase(): Promise<string> {
  if (process.env.WEAVE_PASSPHRASE) return process.env.WEAVE_PASSPHRASE;
  const passphrase = await askSecret('Choose a passphrase for this computer: ');
  if ((await askSecret('Again: ')) !== passphrase) throw new Error('Passphrases did not match');
  return passphrase;
}

/** A new account's recovery code, shown once: at a terminal in a box, otherwise on stderr */
function showRecoveryCode(code: string): void {
  const said =
    'It is the only way back into this account, and it is stored nowhere. Write it down, or put it in a password manager.';
  if (ask.interactive()) ask.note(`${code}\n\n${said}`, 'Recovery code');
  else {
    stderr('');
    stderr(`Recovery code: ${code}`);
    stderr(said);
  }
}

async function init(home: Home, args: ReadonlyArray<string>): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: { name: { type: 'string' }, passphrase: { type: 'boolean' }, existing: { type: 'boolean' } },
  });
  ask.intro('A Weave account on this computer');
  // At a terminal, what the flags didn't say is asked; elsewhere the defaults stand, as they always have.
  const existing =
    values.existing ??
    (values.name === undefined && ask.interactive()
      ? (await ask.select({
          flag: 'existing',
          message: 'A new account, or one you already have?',
          options: [
            { value: 'new', label: 'A new account', hint: 'you get a recovery code' },
            { value: 'existing', label: 'One I already have', hint: 'with its recovery code' },
          ],
        })) === 'existing'
      : false);
  const name =
    values.name ??
    (ask.interactive()
      ? await ask.text({
          flag: 'name',
          message: existing ? 'What should it be called on this computer?' : 'What should it be called?',
          placeholder: 'Leif',
        })
      : 'Me');

  const code = existing
    ? (process.env.WEAVE_RECOVERY_CODE ?? (await askSecret('Recovery code of the existing account: ')))
    : undefined;
  const lock =
    values.passphrase ??
    (await ask.confirm(
      'Lock it with a passphrase on this computer? (Otherwise, its recovery code each time.)',
      {
        otherwise: false,
      },
    ));
  const passphrase = lock ? await newPassphrase() : undefined;

  const created = await createAccount(home, {
    name,
    ...(code ? { code } : {}),
    ...(passphrase ? { passphrase } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({ account: created.account.name, did: created.account.did, home: home.path }, null, 2)}\n`,
  );
  if (created.code) showRecoveryCode(created.code);
  ask.outro(`${created.account.name} is ready. \`weave\` shows what you can do next.`);
}

/** The bot's account, unlocked; at a terminal, made first when this folder has none */
async function botAccount(globals: Globals): Promise<Unlocked> {
  const home = await openHome(globals.home);
  if ((await home.accounts.list()).length > 0) return openAccount(globals);
  if (!ask.interactive())
    throw new Error(
      `No account in ${home.path}. Make the bot's first: weave init --name "Club Bot" --passphrase`,
    );
  ask.intro('A bot, with an account of its own');
  const name = await ask.text({ flag: 'name', message: 'What is the bot called?', placeholder: 'Club Bot' });
  const passphrase = await newPassphrase();
  const created = await createAccount(home, { name, passphrase });
  if (created.code) showRecoveryCode(created.code);
  return unlock(home, created.account, { passphrase });
}

/** At a terminal, a bot in no spaces yet joins one, from an invite someone who runs it made */
async function joinFirstSpace(node: P2PNode): Promise<void> {
  if ((await node.spaces.list()).length > 0) return;
  if (!ask.interactive()) {
    stderr(
      "The bot is in no spaces yet. Join one: weave spaces join --invite '…', with an invite from an admin.",
    );
    return;
  }
  ask.note(
    'An admin of the space makes an invite for it, with the role it should hold:\nin the app, People & roles; or `weave spaces invite`.',
    'Invite the bot',
  );
  const invite = await ask.text({
    flag: 'invite',
    message: 'Paste the invite',
    placeholder: 'https://…#invite=…',
  });
  const preview = node.spaces.preview(invite);
  if (
    !(await ask.confirm(`Join “${preview.space.name}”${preview.role ? ` as ${preview.role}` : ''}?`, {
      otherwise: true,
    }))
  )
    return;
  await node.spaces.join(invite);
  ask.note(
    `It does what the space's rules naming it ask. Someone who may instruct it there adds them:\nweave rule add --by ${node.did}, or Automations in an app.`,
    `Joined ${preview.space.name}`,
  );
}

/**
 * `run --create`: make an account on first start, locked with WEAVE_PASSPHRASE.
 * For dev nodes and fresh servers; does nothing once the home has an account.
 */
async function createIfEmpty(globals: Globals): Promise<void> {
  const home = await openHome(globals.home);
  if ((await home.accounts.list()).length > 0) return;
  const passphrase = process.env.WEAVE_PASSPHRASE;
  if (!passphrase) throw new Error('--create needs WEAVE_PASSPHRASE, to lock the new account with');
  const { account, code } = await createAccount(home, { name: 'Node', passphrase });
  stderr(`Created account "${account.name}" (${account.did}) in ${home.path}`);
  if (!code) return;

  // On a server stderr is a log — journald, Fly, a file someone tails — and a
  // code there is a code anyone who reads the logs holds. Only a person at a
  // terminal is shown it; otherwise it goes in a file only this user can read.
  if (process.stderr.isTTY) {
    stderr(`Recovery code: ${code}`);
    return;
  }
  const file = path.join(home.path, `recovery-code-${account.id}.txt`);
  await writeFile(file, `${code}\n`, { mode: 0o600, flag: 'wx' });
  stderr(`The recovery code was not printed, because this output is not a terminal. It is in ${file}`);
  stderr('Copy it somewhere safe — a password manager — and then delete that file.');
}

/**
 * `weave agent`: the connected agent's node, and a chat with it in this
 * terminal. The model's words go to stdout; what it does goes to stderr.
 */
/** Which model thinks, where, and at what price */
interface ModelChoice {
  /** `anthropic`, or `openai` for any server that speaks Chat Completions */
  readonly provider: 'anthropic' | 'openai';
  readonly name: string;
  /** Another server than the provider's own: `http://localhost:11434/v1`, `https://api.deepseek.com` */
  readonly baseUrl?: string;
  readonly price: Price;
}

/** Whether an address is this machine: a model there asks for no key */
const isLoopback = (url: string) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Who `weave agent` runs as: a person's connected agent, or a bot with an account of its own */
interface Runner {
  readonly node: P2PNode;
  /** The account it acts for, or the bot's own */
  readonly account: string;
  /** Said when it starts: "an agent for Leif, 29 days left", "Club Bot, a bot" */
  readonly intro: string;
  /** The bot's name, when it is one */
  readonly bot?: string;
  close(): Promise<void>;
}

/**
 * `weave agent`: a node, a chat in this terminal, and the rules it runs. The
 * model's words go to stdout; what it does goes to stderr.
 */
async function runAgent(
  home: string,
  runner: Runner,
  options: { model: ModelChoice; dailyCap: number; capEach: number | null; chat: boolean },
): Promise<number> {
  const { node } = runner;
  watchRelayRefusal(node, (refused) =>
    stderr(
      refused
        ? 'The relay refused this node: another `weave agent`, `weave mcp` or `weave run` with the same --home is ' +
            'connected. Stop that one (`ps aux | grep weave`) and start this again.'
        : 'Connected to the relay.',
    ),
  );

  const { model } = options;
  const openai = model.provider === 'openai';
  const local = !!model.baseUrl && isLoopback(model.baseUrl);
  let apiKey =
    (openai
      ? (process.env.OPENAI_API_KEY ?? process.env.WEAVE_AGENT_API_KEY)
      : (process.env.ANTHROPIC_API_KEY ?? process.env.WEAVE_AGENT_API_KEY)
    )?.trim() || (await loadModelKey(home, model.provider));
  // A model on your own machine usually asks for no key.
  if (!apiKey && !local) {
    stderr(
      openai
        ? `weave agent thinks with your own API key at ${model.baseUrl ?? 'api.openai.com'}.`
        : 'weave agent thinks with your own Anthropic API key. Make one at https://platform.claude.com/settings/keys',
    );
    apiKey = await askSecret('API key (kept in the agent folder, readable only by you): ');
    if (!apiKey) throw new Error('weave agent needs an API key');
    await saveModelKey(home, apiKey, model.provider);
  }

  await mkdir(path.join(home, 'agent'), { recursive: true, mode: 0o700 });
  const spend = fileSpend(path.join(home, 'agent'));
  // The SDK is loaded here, not at the top: it is most of the bundle, and only this command uses it.
  const thinking = openai
    ? (write: (text: string) => void) =>
        openAIThink({ baseUrl: model.baseUrl ?? 'https://api.openai.com/v1', apiKey: apiKey ?? '', write })
    : await (async () => {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey, ...(model.baseUrl ? { baseURL: model.baseUrl } : {}) });
        return (write: (text: string) => void) => streamingThink(client, write);
      })();
  const modelOptions = {
    model: model.name,
    price: model.price,
    // Anthropic's own additions only at Anthropic.
    ...(openai || model.baseUrl ? { plain: true } : {}),
  };
  const today = async () => `$${(await spend.today()).toFixed(2)} of $${options.dailyCap.toFixed(2)} today`;
  const names = new Map<string, string>();
  const nameOf = async (space: string, did: string) => {
    if (!names.has(did)) {
      const found = (await node.spaces.profiles(space).catch(() => [])).find((p) => p.did === did);
      if (found) names.set(did, found.name);
    }
    return names.get(did) ?? did.slice(-6);
  };

  // Rules that ask: each set off runs on its own, one at a time, with nobody at the keyboard to allow deleting.
  let queue: Promise<unknown> = Promise.resolve();
  const answer = async (trigger: RuleTrigger): Promise<{ did: string; ok: boolean }> => {
    const name = trigger.rule.body.name;
    const space = trigger.rule.space;
    // What someone set off is counted against them, so one person can't spend the day for everyone.
    const who = trigger.match?.record.createdBy ?? null;
    const by = who ? ` by ${await nameOf(space, who)}` : '';
    if (who && who !== runner.account && options.capEach !== null) {
      const spent = await spend.today(who);
      if (spent >= options.capEach) {
        const did = `Set off${by}, who has used their $${options.capEach.toFixed(2)} for today`;
        stderr(`  [${name}] ${did}`);
        return { did, ok: false };
      }
    }
    stderr(`  [${name}] set off${by}${trigger.match ? '' : ' by the time'}`);
    const run = createAgentChat({
      node,
      think: thinking(() => {}),
      ...modelOptions,
      spend: who ? spendFor(spend, who) : spend,
      dailyCap: options.dailyCap,
      confirm: async () => false,
      log: (line) => stderr(`  [${name}] ${line}`),
      maxSteps: 15,
      unattended: true,
      ...(runner.bot ? { bot: runner.bot } : {}),
    });
    try {
      const { cost, text } = await run.say(triggerPrompt(trigger, PEER_CONTENT_NOTE));
      stderr(`  [${name}] ${text || 'Done.'} · $${cost.toFixed(3)} · ${await today()}`);
      return { did: text || 'Done.', ok: true };
    } catch (error) {
      const did = error instanceof Error ? error.message : String(error);
      stderr(`  [${name}] ${did}`);
      return { did, ok: false };
    }
  };
  const stopRules = startRules(node, {
    account: runner.account,
    ...(runner.bot ? { bot: true } : {}),
    // A person's app may run the same rules; the earlier of two claims acts.
    claimMs: 1500,
    ask: (trigger) => {
      const turn = queue.then(() => answer(trigger));
      queue = turn.catch(() => {});
      return turn;
    },
    onRules: (rules) =>
      stderr(`  Rules: ${rules.length ? rules.map((r) => `“${r.body.name}”`).join(', ') : 'none yet'}`),
    onRun: (trigger, run) => {
      if (trigger.rule.body.then.kind !== 'ask') stderr(`  [${trigger.rule.body.name}] ${run.did}`);
    },
    onError: (error) => stderr(`  Rules: ${error instanceof Error ? error.message : String(error)}`),
  });
  if (!runner.bot) {
    const waiting = (
      await Promise.all(
        (await node.spaces.list()).map((space) => suggestedRules(node, space.id, runner.account)),
      )
    ).reduce((sum, count) => sum + count, 0);
    if (waiting)
      stderr(
        `  ${waiting} rule${waiting === 1 ? '' : 's'} the agent suggested ${waiting === 1 ? 'waits' : 'wait'} for you to save it in an app.`,
      );
  }

  const close = async () => {
    stopRules();
    await runner.close();
  };
  if (!options.chat) {
    stderr(`weave agent: ${runner.intro}, running rules. ${options.model.name}, ${await today()}.`);
    return untilStopped({ close });
  }

  const lines = createPromiseInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const chat = createAgentChat({
    node,
    think: thinking((text) => process.stdout.write(text)),
    ...modelOptions,
    spend,
    dailyCap: options.dailyCap,
    // Piped input can't answer for the person, so it never allows what deletes.
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false;
      const answer = await lines.question(`\n${question} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    },
    log: (line) => stderr(`  ${line}`),
    ...(runner.bot ? { bot: runner.bot } : {}),
  });

  stderr(`weave agent: ${runner.intro}. ${options.model.name}, ${await today()}.`);
  stderr('Say what you need. Ctrl-D to stop.');
  lines.setPrompt('\n› ');
  lines.prompt();
  for await (const line of lines) {
    if (line.trim()) {
      try {
        const { cost, tools } = await chat.say(line);
        process.stdout.write('\n');
        stderr(`  ${tools} tool call${tools === 1 ? '' : 's'} · $${cost.toFixed(3)} · ${await today()}`);
      } catch (error) {
        stderr(`  ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    lines.prompt();
  }
  await close();
  // WebRTC keeps the process alive; the person closed stdin, so it's done.
  process.exit(0);
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const { globals, rest } = splitGlobals(argv);
  const [command, ...args] = rest;

  // Nothing asked for, at a terminal: what people come here to do, to pick from.
  if (!command && ask.interactive()) {
    const picked = await ask.select({
      flag: 'command',
      message: 'What would you like to do?',
      options: MENU.map(({ label, hint }, index) => ({ value: String(index), label, hint })),
    });
    const words = MENU[Number(picked)]?.words;
    if (!words) {
      process.stdout.write(USAGE);
      return 0;
    }
    return main([...argv, ...words]);
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === '--version' || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'actions') {
    const listed = NODE_ACTIONS.map(({ name, description, input, readOnly }) => ({
      name,
      description,
      input,
      readOnly,
    }));
    process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
    return 0;
  }
  if (command === 'init') {
    await init(await openHome(globals.home), args);
    return 0;
  }

  if (command === 'run') {
    const { values } = parseArgs({
      args,
      options: {
        port: { type: 'string', default: process.env.PORT ?? '8787' },
        host: { type: 'string' },
        node: { type: 'string', multiple: true },
        create: { type: 'boolean' },
      },
    });
    if (values.create) await createIfEmpty(globals);
    const unlocked = await openAccount(globals);
    const daemon = await startDaemon({
      unlocked,
      port: Number(values.port),
      ...(values.host ? { host: values.host } : {}),
      ...(values.node ? { nodes: values.node } : {}),
      log: logLine,
    });
    return untilStopped(daemon);
  }

  if (command === 'host') {
    const { values } = parseArgs({
      args,
      options: {
        port: { type: 'string', default: process.env.PORT ?? '8787' },
        host: { type: 'string' },
        data: { type: 'string', default: process.env.WEAVE_HOST_DATA ?? defaultHostData() },
        free: { type: 'boolean', default: process.env.WEAVE_HOST_FREE === '1' },
        allow: { type: 'string', multiple: true },
      },
    });
    const data = path.resolve(values.data);
    const allow = allowList(values.allow, process.env);
    checkExposure({ ...(values.host ? { host: values.host } : {}), free: !!values.free, allow });
    const billing = billingFromEnv(process.env);
    const wallet = walletFromEnv(process.env);
    if (!billing && !wallet && !values.free) {
      throw new Error(
        'weave host needs a way to take payments — Stripe (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET), a wallet (WEAVE_WALLET_ADDRESS), or both — or --free to host without them.',
      );
    }
    const quotaBytes = quotaFromEnv(process.env, !!values.free);
    const running = await startHost({
      key: await hostKey(data),
      stores: await hostStores(data),
      measure: spaceSize(data),
      ...(quotaBytes ? { quotaBytes } : {}),
      port: Number(values.port),
      ...(values.host ? { host: values.host } : {}),
      ...(values.free ? { free: true } : {}),
      ...(allow ? { allow } : {}),
      ...presentationFromEnv(process.env),
      billing,
      wallet,
      mirror: mirrorFromEnv(process.env),
      log: logLine,
    });
    return untilStopped(running);
  }

  if (command === 'connect') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        name: { type: 'string' },
        relay: { type: 'string', multiple: true },
        'no-configure': { type: 'boolean' },
      },
    });
    const code =
      positionals.join(' ') ||
      (await ask.text({
        flag: 'code',
        message: 'The code from the app (in the app: Connect an agent)',
        placeholder: 'wv_…',
        hint: 'Give it as `weave connect wv_…`: in the app, choose "Connect an agent".',
      }));
    const home = homePath(globals.home);
    const grant = await connectAgent({
      home,
      code,
      name: values.name ?? defaultAgentName(),
      relays: [...new Set([...(values.relay ?? []), ...configuredRelays()])],
      log: stderr,
    });
    stderr('');
    stderr(
      `Connected to ${grant.name}'s account, for ${daysLeft(grant)} days. What the agent writes shows "via agent".`,
    );
    const server = serverCommand(home);
    if (values['no-configure']) {
      stderr("Add this to your agent's MCP settings:");
      process.stdout.write(`${configSnippet(server)}\n`);
      return 0;
    }
    const configured = await configureClients(server);
    for (const { client, result } of configured) stderr(`  ${client}: ${result}`);
    if (!configured.some((entry) => entry.ok)) {
      stderr("No agent found on this computer to add it to. Add this to your agent's MCP settings:");
      process.stdout.write(`${configSnippet(server)}\n`);
    }
    return 0;
  }

  if (command === 'disconnect') {
    await forgetAgent(homePath(globals.home));
    stderr(
      "This computer's agent is forgotten here. To stop its note working everywhere, disconnect it in your account home.",
    );
    return 0;
  }

  if (command === 'mcp' && !args.includes('--account')) {
    // The connected agent: a node of its own, online, acting as the agent.
    const agent = await startAgentNode(homePath(globals.home), {
      nodes: (process.env.WEAVE_NODES ?? '')
        .split(',')
        .map((node) => node.trim())
        .filter(Boolean),
    });
    stderr(
      `weave mcp: an agent for ${agent.grant.name} (${agent.grant.did}), ${daysLeft(agent.grant)} days left`,
    );
    // Every agent process on this computer signs with the one agent key, and a relay lets one
    // of them in; the rest would otherwise sit there looking connected (#55).
    watchRelayRefusal(agent.node, (refused) =>
      stderr(
        refused
          ? 'weave mcp: the relay refused this agent: another `weave mcp` or `weave agent` with the same --home ' +
              'is connected. Writes are kept here and sync once that one stops (`ps aux | grep weave`).'
          : 'weave mcp: connected to the relay.',
      ),
    );
    await runMcpStdio(agent.node, { name: 'weave', version: VERSION }, { agent: true });
    await agent.close();
    // WebRTC keeps the process alive; the agent closed stdin, so it's done.
    process.exit(0);
  }

  if (command === 'agent') {
    const { values } = parseArgs({
      args,
      options: {
        model: { type: 'string' },
        provider: { type: 'string' },
        'base-url': { type: 'string' },
        price: { type: 'string' },
        'daily-cap': { type: 'string', default: '2' },
        'daily-cap-each': { type: 'string' },
        'no-chat': { type: 'boolean' },
        bot: { type: 'boolean' },
        setup: { type: 'boolean' },
      },
    });
    const dollars = (flag: string, value: string) => {
      const usd = Number(value);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error(`--${flag} is dollars a day, a number above 0`);
      return usd;
    };
    const dailyCap = dollars('daily-cap', values['daily-cap']);
    // A bot answers anyone who can set it off, so each of them gets a share by default.
    const each = values['daily-cap-each'] ?? (values.bot ? String(dailyCap / 4) : undefined);
    const capEach = each === undefined ? null : dollars('daily-cap-each', each);
    const home = homePath(globals.home);
    // A person's agent needs connecting first: at a terminal, with the code from the app, here and now.
    if (!values.bot && !(await hasConnectedAgent(home)) && ask.interactive()) {
      ask.intro('Connect an agent to your account');
      ask.note('In the app, open the account menu and choose “Connect an agent”. It shows a code.', 'First');
      const code = await ask.text({ flag: 'code', message: 'The code', placeholder: 'wv_…' });
      const grant = await connectAgent({
        home,
        code,
        name: defaultAgentName(),
        relays: configuredRelays(),
        log: stderr,
      });
      ask.note(`Connected to ${grant.name}'s account, for ${daysLeft(grant)} days.`, 'Connected');
    }
    // Flags, then the environment, then what setup kept; at a terminal with none of them, setup asks.
    const told =
      values.provider ?? values.model ?? process.env.WEAVE_AGENT_PROVIDER ?? process.env.WEAVE_AGENT_MODEL;
    await mkdir(path.join(home, 'agent'), { recursive: true, mode: 0o700 });
    const kept =
      values.setup || (!told && ask.interactive() && !(await loadModelSetting(home)))
        ? await setUpModel(home, (model) => priceOf(model) !== null)
        : told
          ? null
          : await loadModelSetting(home);
    const provider = values.provider ?? process.env.WEAVE_AGENT_PROVIDER ?? kept?.provider ?? 'anthropic';
    if (provider !== 'anthropic' && provider !== 'openai')
      throw new Error('--provider is anthropic, or openai for any server that speaks Chat Completions');
    const name =
      values.model ??
      process.env.WEAVE_AGENT_MODEL ??
      kept?.model ??
      (provider === 'anthropic' ? DEFAULT_MODEL : undefined);
    if (!name)
      throw new Error('With --provider openai, say which model: --model gpt-5.5, deepseek-v4-pro, …');
    const baseUrl = values['base-url'] ?? process.env.WEAVE_AGENT_BASE_URL ?? kept?.baseUrl;
    const priceText = values.price ?? process.env.WEAVE_AGENT_PRICE ?? kept?.price;
    const price = priceText ? parsePrice(priceText) : priceOf(name);
    if (priceText && !price)
      throw new Error(
        '--price is dollars per million tokens, input/output or input/output/cached, like 0.15/0.60',
      );
    if (!price)
      throw new Error(
        `weave agent doesn't know what ${name} costs, so it can't keep the daily cap. ` +
          'Give --price in dollars per million tokens, like --price 0.15/0.60 (0/0 for a model on your machine).',
      );
    const model: ModelChoice = { provider, name, price, ...(baseUrl ? { baseUrl } : {}) };
    const nodes = (process.env.WEAVE_NODES ?? '')
      .split(',')
      .map((node) => node.trim())
      .filter(Boolean);
    let runner: Runner;
    if (values.bot) {
      const bot = await startBotNode(await botAccount(globals), { nodes });
      await joinFirstSpace(bot.node);
      const name = (await bot.node.account.profile())?.name ?? 'Bot';
      runner = {
        node: bot.node,
        account: bot.node.did,
        intro: `${name}, a bot`,
        bot: name,
        close: () => bot.close(),
      };
    } else {
      const agent = await startAgentNode(home, { nodes });
      runner = {
        node: agent.node,
        account: agent.grant.did,
        intro: `an agent for ${agent.grant.name}, ${daysLeft(agent.grant)} days left`,
        close: () => agent.close(),
      };
    }
    return runAgent(home, runner, { model, dailyCap, capEach, chat: !values['no-chat'] });
  }

  if (command === 'rule' && args[0] === 'add') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        space: { type: 'string' },
        name: { type: 'string' },
        collection: { type: 'string' },
        where: { type: 'string' },
        every: { type: 'string' },
        do: { type: 'string' },
        from: { type: 'string' },
        by: { type: 'string' },
      },
    });
    return withNode(globals, async (node) => addRule(node, values));
  }
  const standard = command === 'collections' && args[0] === 'define' ? args.indexOf('--standard') : -1;
  if (standard !== -1) {
    const name = args[standard + 1];
    if (!name) throw new Error('--standard needs a name, like std.rule');
    const spaceAt = args.indexOf('--space');
    return withNode(globals, (node) =>
      defineStandard(node, name, spaceAt === -1 ? undefined : args[spaceAt + 1]),
    );
  }

  // Named before the account is opened, so a mistyped command, or one this
  // version doesn't have, says so instead of asking for an account.
  const found =
    command === 'mcp'
      ? null
      : command === 'whoami'
        ? findAction(['node_info'])
        : findAction([command, ...args]);
  if (command !== 'mcp' && !found) {
    stderr(
      `Unknown command "${[command, ...args].slice(0, 2).join(' ')}". Try "weave help" or "weave actions".`,
    );
    return 2;
  }

  const unlocked = await openAccount(globals);

  if (command === 'mcp') {
    // Offline: the MCP process writes to the folder; a running daemon syncs it.
    const node = await createNode({
      signer: unlocked.signer,
      stores: unlocked.stores,
      accountKey: unlocked.accountKey,
      contactKey: unlocked.contactKey,
    });
    stderr(`weave mcp: serving ${NODE_ACTIONS.length} tools for ${node.did}`);
    await runMcpStdio(node, { name: 'weave', version: VERSION });
    await node.close();
    return 0;
  }

  if (!found) return 2;

  // One-shot commands run offline against the folder. With a daemon running on
  // the same folder, it picks the change up and syncs it.
  const node = await createNode({
    signer: unlocked.signer,
    stores: unlocked.stores,
    accountKey: unlocked.accountKey,
    contactKey: unlocked.contactKey,
    watchIntervalMs: 0,
  });
  try {
    const { action } = found;
    // What the flags left out is asked for at a terminal, or refused naming its flag.
    const input = await completeInput(node, action, inputFromFlags(action, found.rest));
    if (action.name === 'spaces_join' && typeof input.invite === 'string') {
      const preview = node.spaces.preview(input.invite);
      if (
        !(await ask.confirm(
          `Join “${preview.space.name}”${preview.role ? ` as ${preview.role}` : ', to read it'}?`,
          {
            ...(globals.yes ? { yes: true } : {}),
            otherwise: true,
          },
        ))
      )
        return 1;
    } else if (
      action.destructive &&
      !(await ask.confirm(`${action.description.split(/\.\s/)[0]?.replace(/\.$/, '')}. Go ahead?`, {
        ...(globals.yes ? { yes: true } : {}),
        // With nobody to ask, it runs, as it always has: an agent or a script said so.
        otherwise: true,
      }))
    )
      return 1;
    const result = await runAction(node, action.name, input);
    // An invite read by a person is the invite alone, whole on one line to copy; to a program, JSON.
    if (
      action.name === 'spaces_invite' &&
      isRecord(result) &&
      typeof result.invite === 'string' &&
      process.stdout.isTTY
    ) {
      ask.note(
        'Anyone holding it can join, and read everything in a private space: send it only to them.',
        'The invite',
      );
      process.stdout.write(`${result.invite}\n`);
    } else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await node.close();
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    stderr(`weave: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
