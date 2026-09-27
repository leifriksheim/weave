/**
 * Adding `weave mcp` to the agents on this computer, so connecting is one
 * command: Claude Code (through its own `claude mcp add`), Claude Desktop and
 * Cursor (their config files). Only the ones installed are touched, and an
 * existing "weave" entry is replaced, nothing else.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The name the server is added under */
export const SERVER_NAME = 'weave';

export interface ServerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * How to start `weave mcp` the way this process was started — from npx, a
 * linked `weave`, the repo, or a compiled binary — with absolute paths, since
 * an agent starts it from anywhere, and a desktop app without the shell's PATH.
 */
export function serverCommand(home: string): ServerCommand {
  const script = process.argv[1] ?? '';
  const tail = ['mcp', '--home', home];
  // A compiled binary is its own runtime.
  if (!script || script === process.execPath || /\$bunfs|~BUN/.test(script)) return { command: process.execPath, args: tail };
  // Run from npx: its cache is temporary, so ask npx again.
  if (script.includes(`${path.sep}_npx${path.sep}`)) {
    const npx = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
    return { command: existsSync(npx) ? npx : 'npx', args: ['-y', '@weaveprotocol/cli', ...tail] };
  }
  // From the sources: Node needs tsx, found from here rather than from wherever the agent starts.
  const tsx = script.endsWith('.ts') ? import.meta.resolve('tsx') : null;
  return { command: process.execPath, args: [...(tsx ? ['--import', tsx] : []), path.resolve(script), ...tail] };
}

/** Claude Desktop's config file on this system */
function claudeDesktopConfig(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/** Puts the server in an `mcpServers` config file, keeping everything else in it */
async function addToConfigFile(file: string, server: ServerCommand): Promise<void> {
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as typeof config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} is not valid JSON, so it was left alone`);
  }
  config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: { command: server.command, args: [...server.args] } };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

export interface Configured {
  readonly client: string;
  /** What happened, for the person */
  readonly result: string;
  readonly ok: boolean;
}

/** Adds the server to every agent found on this computer. */
export async function configureClients(server: ServerCommand): Promise<ReadonlyArray<Configured>> {
  const done: Configured[] = [];

  try {
    // Replacing: `add` refuses a name that exists.
    await run('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user']).catch(() => {});
    await run('claude', ['mcp', 'add', SERVER_NAME, '--scope', 'user', '--', server.command, ...server.args]);
    done.push({ client: 'Claude Code', result: 'added — start a new session to use it', ok: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      done.push({ client: 'Claude Code', result: `could not add it: ${(error as Error).message.split('\n')[0]}`, ok: false });
    }
  }

  const desktop = claudeDesktopConfig();
  if (existsSync(path.dirname(desktop))) {
    await addToConfigFile(desktop, server).then(
      () => done.push({ client: 'Claude Desktop', result: 'added — restart it to use it', ok: true }),
      (error: Error) => done.push({ client: 'Claude Desktop', result: error.message, ok: false }),
    );
  }

  const cursor = path.join(os.homedir(), '.cursor');
  if (existsSync(cursor)) {
    await addToConfigFile(path.join(cursor, 'mcp.json'), server).then(
      () => done.push({ client: 'Cursor', result: 'added', ok: true }),
      (error: Error) => done.push({ client: 'Cursor', result: error.message, ok: false }),
    );
  }
  return done;
}

/** The config for anything else that speaks MCP */
export function configSnippet(server: ServerCommand): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: server.command, args: server.args } } }, null, 2);
}
