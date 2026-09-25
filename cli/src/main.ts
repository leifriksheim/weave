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
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createNode, isValidRecoveryCode, NODE_ACTIONS, runAction, type NodeAction } from '../../src/index.js';
import { chooseAccount, createAccount, homePath, openHome, unlock, type Home } from './home.js';
import { startDaemon } from './daemon.js';
import { startHost } from './host.js';
import { allowList, billingFromEnv, checkExposure, defaultHostData, hostKey, hostStores, mirrorFromEnv } from './host-setup.js';
import { runMcpStdio } from './mcp.js';
import { configuredRelays, connectAgent, daysLeft, defaultAgentName, forgetAgent, startAgentNode } from './agent.js';
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
  weave actions

Agents (Claude Code, Claude Desktop, Cursor):
  In the app, choose "Connect an agent" and run the command it shows. It
  connects this computer's agent to your account, and adds "weave" to the
  agents it finds. From then on they start "weave mcp" themselves: a node of
  its own, working with every tab closed. "weave mcp --account" serves the
  unlocked account instead, as you rather than as an agent.

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

/** Reads a line without echoing it, for secrets. */
async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${prompt.trim()} — no terminal to ask on; set it in the environment`);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const muted = rl as unknown as { _writeToOutput: (text: string) => void };
  process.stderr.write(prompt);
  muted._writeToOutput = () => {};
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
    const [rawKey, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];

    if (rawKey === 'json') {
      const value = inline ?? args[++i];
      Object.assign(input, JSON.parse(value ?? '{}'));
      continue;
    }

    const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const spec = action.input.properties[key];
    if (!spec) throw new Error(`${action.name} has no --${rawKey}. It takes: ${Object.keys(action.input.properties).map((k) => `--${k}`).join(' ') || 'nothing'}`);

    if (spec.type === 'boolean') {
      input[key] = inline === undefined ? true : inline === 'true';
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`--${rawKey} needs a value`);
    input[key] = spec.type === 'integer' || spec.type === 'number' ? Number(value) : spec.type === 'object' ? JSON.parse(value) : value;
  }
  return input;
}

function findAction(words: ReadonlyArray<string>): { action: NodeAction; rest: ReadonlyArray<string> } | null {
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
    const [flag, inline] = argv[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
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
    if (!process.env.WEAVE_PASSPHRASE && (await askSecret('Again: ')) !== passphrase) throw new Error('Passphrases did not match');
  }

  const created = await createAccount(home, { name, ...(code ? { code } : {}), ...(passphrase ? { passphrase } : {}) });
  process.stdout.write(`${JSON.stringify({ account: created.account.name, did: created.account.did, home: home.path }, null, 2)}\n`);
  if (created.code) {
    stderr('');
    stderr(`Recovery code: ${created.code}`);
    stderr('It is the only way back into this account. It is stored nowhere — write it down or put it in a password manager.');
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
    const listed = NODE_ACTIONS.map(({ name, description, input, readOnly }) => ({ name, description, input, readOnly }));
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
      log: (line) => stderr(`[${new Date().toISOString()}] ${line}`),
    });
    const stop = () => {
      stderr('shutting down');
      void daemon.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise(() => {}); // until a signal
    return 0;
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
    if (!billing && !values.free) {
      throw new Error('weave host needs a way to take payments (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET), or --free to host without them.');
    }
    const running = await startHost({
      key: await hostKey(data),
      stores: await hostStores(data),
      port: Number(values.port),
      ...(values.host ? { host: values.host } : {}),
      ...(values.free ? { free: true } : {}),
      ...(allow ? { allow } : {}),
      billing,
      mirror: mirrorFromEnv(process.env),
      log: (line) => stderr(`[${new Date().toISOString()}] ${line}`),
    });
    const stop = () => {
      stderr('shutting down');
      void running.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise(() => {}); // until a signal
    return 0;
  }

  if (command === 'connect') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { name: { type: 'string' }, relay: { type: 'string', multiple: true }, 'no-configure': { type: 'boolean' } },
    });
    const code = positionals.join(' ');
    if (!code) throw new Error('weave connect needs the code from the app: in the app, choose "Connect an agent".');
    const home = homePath(globals.home);
    const grant = await connectAgent({
      home,
      code,
      name: values.name ?? defaultAgentName(),
      relays: [...new Set([...(values.relay ?? []), ...configuredRelays()])],
      log: stderr,
    });
    stderr('');
    stderr(`Connected to ${grant.name}'s account, for ${daysLeft(grant)} days. What the agent writes shows "via agent".`);
    const server = serverCommand(home);
    if (values['no-configure']) {
      stderr('Add this to your agent\'s MCP settings:');
      process.stdout.write(`${configSnippet(server)}\n`);
      return 0;
    }
    const configured = await configureClients(server);
    for (const { client, result } of configured) stderr(`  ${client}: ${result}`);
    if (!configured.some((entry) => entry.ok)) {
      stderr('No agent found on this computer to add it to. Add this to your agent\'s MCP settings:');
      process.stdout.write(`${configSnippet(server)}\n`);
    }
    return 0;
  }

  if (command === 'disconnect') {
    await forgetAgent(homePath(globals.home));
    stderr('This computer\'s agent is forgotten here. To stop its note working everywhere, disconnect it in your account home.');
    return 0;
  }

  if (command === 'mcp' && !args.includes('--account')) {
    // The connected agent: a node of its own, online, acting as the agent.
    const agent = await startAgentNode(homePath(globals.home), {
      nodes: (process.env.WEAVE_NODES ?? '').split(',').map((node) => node.trim()).filter(Boolean),
    });
    stderr(`weave mcp: an agent for ${agent.grant.name} (${agent.grant.did}), ${daysLeft(agent.grant)} days left`);
    await runMcpStdio(agent.node, { name: 'weave', version: VERSION }, { agent: true });
    await agent.close();
    // WebRTC keeps the process alive; the agent closed stdin, so it's done.
    process.exit(0);
  }

  const unlocked = await openAccount(globals);

  if (command === 'mcp') {
    // Offline: the MCP process writes to the folder; a running daemon syncs it.
    const node = await createNode({ signer: unlocked.signer, stores: unlocked.stores, accountKey: unlocked.accountKey, contactKey: unlocked.contactKey });
    stderr(`weave mcp: serving ${NODE_ACTIONS.length} tools for ${node.did}`);
    await runMcpStdio(node, { name: 'weave', version: VERSION });
    await node.close();
    return 0;
  }

  const found = command === 'whoami' ? findAction(['node_info']) : findAction([command, ...args]);
  if (!found) {
    stderr(`Unknown command "${[command, ...args].slice(0, 2).join(' ')}". Try "weave help" or "weave actions".`);
    return 2;
  }

  // One-shot commands run offline against the folder. With a daemon running on
  // the same folder, it picks the change up and syncs it.
  const node = await createNode({ signer: unlocked.signer, stores: unlocked.stores, accountKey: unlocked.accountKey, contactKey: unlocked.contactKey, watchIntervalMs: 0 });
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
