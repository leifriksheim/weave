/**
 * `weave` — the protocol from a terminal.
 *
 *   weave init                         create an account (prints its recovery code once)
 *   weave whoami
 *   weave spaces list | create | invite | join | leave | status
 *   weave records list | get | put | update | delete
 *   weave run                          stay up: sync every space, serve sockets and a relay
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
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createNode, isValidRecoveryCode, NODE_ACTIONS, runAction, type NodeAction } from '../../src/index.js';
import { chooseAccount, createAccount, openHome, unlock, type Home } from './home.js';
import { startDaemon } from './daemon.js';
import { runMcpStdio } from './mcp.js';

const VERSION = '0.1.0';

const USAGE = `weave ${VERSION} — your spaces, from a terminal

Usage:
  weave init [--name NAME] [--passphrase] [--existing]
  weave whoami
  weave spaces  list | create | invite | join | leave | status   [--flags]
  weave records list | get | put | update | delete               [--flags]
  weave run [--port 8787] [--host 0.0.0.0] [--node wss://…/peer] [--create]
  weave mcp
  weave actions

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
  if (code) stderr(`Recovery code: ${code}`);
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

  const unlocked = await openAccount(globals);

  if (command === 'mcp') {
    // Offline: the MCP process writes to the folder; a running daemon syncs it.
    const node = await createNode({ signer: unlocked.signer, stores: unlocked.stores, accountKey: unlocked.accountKey });
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
  const node = await createNode({ signer: unlocked.signer, stores: unlocked.stores, accountKey: unlocked.accountKey, watchIntervalMs: 0 });
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
