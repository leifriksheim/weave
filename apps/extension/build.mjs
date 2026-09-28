/**
 * Builds the extension into `dist/`, ready for "Load unpacked" or zipping.
 *
 *   npm run build            once
 *   npm run dev              rebuilds on change
 *   npm run package -- out.zip   once, for the deployed home and relay, zipped
 *
 * The protocol is bundled straight from its source in the workspace
 * (packages/core/src, through the `@weaveprotocol/source` export condition),
 * as the home does, so a change there is a rebuild away. Settings are read at build time, from the shell
 * first, then `.env.local` (yours, not committed — copy `.env.example`), or
 * `.env.production` with `--production`:
 *
 *   WEAVE_HOME     the account home offered first   (default http://localhost:5174)
 *   WEAVE_RELAYS   relays, comma separated          (default: this machine's, and the deployed one)
 *
 * The home's own relays arrive with the grant and are used as well, so an
 * extension built for one home still meets peers on another.
 */
import { build, context } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const production = args.includes('--production');
// The site offers this zip for manual installs until the extension is in the Chrome Web Store.
const zip = args.includes('--zip') ? args[args.indexOf('--zip') + 1] : undefined;
if (args.includes('--zip') && !zip) throw new Error('--zip needs a path to write to');

/** `KEY=value` lines; `#` comments and blank lines skipped, surrounding quotes dropped. */
async function readEnvFile(path) {
  const text = await readFile(here(path), 'utf8').catch(() => '');
  const values = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

const env = { ...(await readEnvFile(production ? '.env.production' : '.env.local')), ...process.env };
const setting = (name, fallback) => env[name] || fallback;

const options = {
  entryPoints: {
    worker: here('src/worker.ts'),
    offscreen: here('src/offscreen.ts'),
    welcome: here('src/welcome.ts'),
    popup: here('src/popup.ts'),
    notify: here('src/notify.ts'),
  },
  outdir: here('dist'),
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  // The protocol from the workspace, as source (packages/core/src).
  conditions: ['@weaveprotocol/source'],
  define: {
    __WEAVE_HOME__: JSON.stringify(setting('WEAVE_HOME', 'http://localhost:5174')),
    __WEAVE_RELAYS__: JSON.stringify(
      setting('WEAVE_RELAYS', 'ws://localhost:8787,wss://p2p-web-relay.fly.dev'),
    ),
  },
  logLevel: 'info',
};

console.log(`Home: ${options.define.__WEAVE_HOME__}  Relays: ${options.define.__WEAVE_RELAYS__}`);

await rm(here('dist'), { recursive: true, force: true });
await mkdir(here('dist'), { recursive: true });
await cp(here('static'), here('dist'), { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching. Load extension/dist as an unpacked extension, and reload it after a change.');
} else {
  await build(options);
  if (zip) {
    const out = resolve(process.cwd(), zip);
    await rm(out, { force: true });
    // Files at the zip's top level, so it unzips to a folder "Load unpacked" takes as is.
    execFileSync('zip', ['-rq', out, '.'], { cwd: here('dist') });
    console.log(`Zipped: ${out}`);
  }
}
