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
import { createInterface } from 'node:readline';
import { createInterface as createPromiseInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  createNode,
  isValidRecoveryCode,
  NODE_ACTIONS,
  runAction,
  type NodeAction,
  type P2PNode,
} from '@weaveprotocol/core';
import { chooseAccount, createAccount, homePath, openHome, unlock, type Home } from './home.js';
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
  walletFromEnv,
} from './host-setup.js';
import { PEER_CONTENT_NOTE, runMcpStdio } from './mcp.js';
import {
  configuredRelays,
  connectAgent,
  daysLeft,
  defaultAgentName,
  forgetAgent,
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
  knownModel,
  spendFor,
  streamingThink,
} from './agent-chat.js';
import { startWatching, suggestedIn, triggerPrompt } from './agent-watch.js';
import { configSnippet, configureClients, serverCommand } from './clients.js';

const VERSION = '0.1.0';

const USAGE = `weave ${VERSION} — your spaces, from a terminal

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
  weave agent [--model claude-opus-5-5] [--daily-cap 2] [--no-chat]
  weave agent --bot [--daily-cap-each 0.5]   an account of its own, as a bot in its spaces
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
  watches (std.watch records): what to do when some records appear or change,
  or at set times. --no-chat runs only those, until stopped.

  "weave agent --bot" runs the unlocked account itself as a bot instead: an
  account of its own that people invite to their spaces. It says it is a bot
  in every space, and runs the watches of members holding std.watch/instruct
  there, in that space only. --daily-cap-each limits what each person who
  sets it off may spend a day (a quarter of --daily-cap unless given).

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

/** Reads a line without echoing it, for secrets. */
async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(`${prompt.trim()} — no terminal to ask on; set it in the environment`);
  process.stderr.write(prompt);
  // Readline echoes what is typed to its output; this one goes nowhere.
  const nowhere = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: nowhere, terminal: true });
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stderr.write('\n');
  return answer.trim();
}

async function readSecretFile(file: string | undefined): Promise<string | undefined> {
  return file ? (await readFile(file, 'utf8')).trim() : undefined;
}

interface Globals {
  readonly home?: string;
  readonly account?: string;
  readonly codeFile?: string;
  readonly passphraseFile?: string;
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
  const globals: Record<string, string> = {};
  const rest: string[] = [];
  const names: Record<string, keyof Globals> = {
    '--home': 'home',
    '--account': 'account',
    '--code-file': 'codeFile',
    '--passphrase-file': 'passphraseFile',
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag = '', inline] = argv[i]!.split(/=(.*)/s, 2);
    const name = names[flag];
    if (name) globals[name] = inline ?? argv[++i] ?? '';
    else rest.push(argv[i]!);
  }
  return { globals, rest };
}

async function init(home: Home, args: ReadonlyArray<string>): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: { name: { type: 'string' }, passphrase: { type: 'boolean' }, existing: { type: 'boolean' } },
  });
  const name = values.name ?? 'Me';

  let code: string | undefined;
  if (values.existing) {
    code = process.env.WEAVE_RECOVERY_CODE ?? (await askSecret('Recovery code of the existing account: '));
  }
  let passphrase: string | undefined;
  if (values.passphrase) {
    passphrase = process.env.WEAVE_PASSPHRASE ?? (await askSecret('Choose a passphrase: '));
    if (!process.env.WEAVE_PASSPHRASE && (await askSecret('Again: ')) !== passphrase)
      throw new Error('Passphrases did not match');
  }

  const created = await createAccount(home, {
    name,
    ...(code ? { code } : {}),
    ...(passphrase ? { passphrase } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({ account: created.account.name, did: created.account.did, home: home.path }, null, 2)}\n`,
  );
  if (created.code) {
    stderr('');
    stderr(`Recovery code: ${created.code}`);
    stderr(
      'It is the only way back into this account. It is stored nowhere — write it down or put it in a password manager.',
    );
  }
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
 * `weave agent`: a node, a chat in this terminal, and the watches it runs. The
 * model's words go to stdout; what it does goes to stderr.
 */
async function runAgent(
  home: string,
  runner: Runner,
  options: { model: string; dailyCap: number; capEach: number | null; chat: boolean },
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

  let apiKey = process.env.ANTHROPIC_API_KEY?.trim() || (await loadModelKey(home));
  if (!apiKey) {
    stderr(
      'weave agent thinks with your own Anthropic API key. Make one at https://platform.claude.com/settings/keys',
    );
    apiKey = await askSecret('API key (kept in the agent folder, readable only by you): ');
    if (!apiKey) throw new Error('weave agent needs an Anthropic API key');
    await saveModelKey(home, apiKey);
  }

  // Loaded here, not at the top: it is most of the bundle, and only this command uses it.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  await mkdir(path.join(home, 'agent'), { recursive: true, mode: 0o700 });
  const spend = fileSpend(path.join(home, 'agent'));
  const client = new Anthropic({ apiKey });
  const today = async () => `$${(await spend.today()).toFixed(2)} of $${options.dailyCap.toFixed(2)} today`;
  const names = new Map<string, string>();
  const nameOf = async (space: string, did: string) => {
    if (!names.has(did)) {
      const found = (await node.spaces.profiles(space).catch(() => [])).find((p) => p.did === did);
      if (found) names.set(did, found.name);
    }
    return names.get(did) ?? did.slice(-6);
  };

  // Watches: each set off runs on its own, one at a time, with nobody at the keyboard to allow deleting.
  let queue = Promise.resolve();
  const stopWatching = startWatching({
    node,
    account: runner.account,
    ...(runner.bot ? { bot: true } : {}),
    onWatches: (watches) =>
      stderr(
        `  Watching: ${watches.length ? watches.map((w) => `“${w.body.name}”`).join(', ') : 'nothing yet'}`,
      ),
    onError: (error) => stderr(`  Watches: ${error instanceof Error ? error.message : String(error)}`),
    onTrigger: (trigger) => {
      const name = trigger.watch.body.name;
      // What someone set off is counted against them, so one person can't spend the day for everyone.
      const who = trigger.record?.root ?? null;
      queue = queue.then(async () => {
        const by = who && trigger.space ? ` by ${await nameOf(trigger.space, who)}` : '';
        if (who && who !== runner.account && options.capEach !== null) {
          const spent = await spend.today(who);
          if (spent >= options.capEach) {
            stderr(`  [${name}] set off${by}, who has used their $${options.capEach.toFixed(2)} for today`);
            return;
          }
        }
        stderr(`  [${name}] set off${by}${trigger.record ? '' : ' by the time'}`);
        const run = createAgentChat({
          node,
          think: streamingThink(client, () => {}),
          model: options.model,
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
        } catch (error) {
          stderr(`  [${name}] ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },
  });
  if (!runner.bot) {
    const waiting = (
      await Promise.all(
        (await node.spaces.list()).map((space) => suggestedIn(node, space.id, runner.account)),
      )
    ).reduce((sum, count) => sum + count, 0);
    if (waiting)
      stderr(
        `  ${waiting} watch${waiting === 1 ? '' : 'es'} the agent suggested ${waiting === 1 ? 'waits' : 'wait'} for you to save it in an app.`,
      );
  }

  const close = async () => {
    stopWatching();
    await runner.close();
  };
  if (!options.chat) {
    stderr(`weave agent: ${runner.intro}, watching. ${options.model}, ${await today()}.`);
    return untilStopped({ close });
  }

  const lines = createPromiseInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const chat = createAgentChat({
    node,
    think: streamingThink(client, (text) => process.stdout.write(text)),
    model: options.model,
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

  stderr(`weave agent: ${runner.intro}. ${options.model}, ${await today()}.`);
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
        free: { type: 'boolean' },
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
    const running = await startHost({
      key: await hostKey(data),
      stores: await hostStores(data),
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
    const code = positionals.join(' ');
    if (!code)
      throw new Error('weave connect needs the code from the app: in the app, choose "Connect an agent".');
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
        model: { type: 'string', default: process.env.WEAVE_AGENT_MODEL ?? DEFAULT_MODEL },
        'daily-cap': { type: 'string', default: '2' },
        'daily-cap-each': { type: 'string' },
        'no-chat': { type: 'boolean' },
        bot: { type: 'boolean' },
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
    if (!knownModel(values.model))
      throw new Error(`weave agent doesn't know what ${values.model} costs, so it can't keep the daily cap`);
    const home = homePath(globals.home);
    const nodes = (process.env.WEAVE_NODES ?? '')
      .split(',')
      .map((node) => node.trim())
      .filter(Boolean);
    let runner: Runner;
    if (values.bot) {
      const bot = await startBotNode(await openAccount(globals), { nodes });
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
    return runAgent(home, runner, { model: values.model, dailyCap, capEach, chat: !values['no-chat'] });
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
    const result = await runAction(node, found.action.name, inputFromFlags(found.action, found.rest));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
