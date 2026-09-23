/**
 * `npm run dev`: the always-on node and the example app, together.
 *
 * The node runs with the throwaway identity in cli/.env.dev (created on first
 * run) and serves the relay and /peer on port 8787, which is where
 * example/.env.development points the app. Ctrl-C stops both.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const colour = { node: '\x1b[35m', app: '\x1b[36m', reset: '\x1b[0m' };

function start(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = `${colour[name]}[${name}]${colour.reset} `;
  const forward = (stream, out) => {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stderr.write(`${prefix}exited (${code ?? 'signal'})\n`);
    stopAll(code ?? 0);
  });
  return child;
}

const children = [
  start('node', process.execPath, ['--env-file=cli/.env.dev', '--import', 'tsx', 'cli/src/main.ts', 'run', '--create'], root),
  start('app', 'npm', ['run', 'dev'], `${root}example`),
];

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
