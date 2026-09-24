/**
 * Builds the extension into `dist/`, ready for "Load unpacked" or zipping.
 *
 *   npm run build            once
 *   npm run dev              rebuilds on change
 *
 * The protocol is bundled straight from ../src, as the home does, so a change
 * there is a rebuild away. Settings come from the environment at build time:
 *
 *   WEAVE_HOME     the account home offered first   (default http://localhost:5174)
 *   WEAVE_RELAYS   relays, comma separated          (default ws://localhost:8787)
 *
 * The home's own relays arrive with the grant and are used as well, so an
 * extension built for one home still meets peers on another.
 */
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const watch = process.argv.includes('--watch');

/** `weave-protocol/node` → ../src/node/index.ts, as in the home's Vite config */
const protocol = {
  name: 'weave-protocol',
  setup(b) {
    b.onResolve({ filter: /^weave-protocol(\/.+)?$/ }, (args) => ({
      path: here(`../src${args.path.slice('weave-protocol'.length) || ''}/index.ts`),
    }));
  },
};

const options = {
  entryPoints: {
    worker: here('src/worker.ts'),
    offscreen: here('src/offscreen.ts'),
    welcome: here('src/welcome.ts'),
    popup: here('src/popup.ts'),
  },
  outdir: here('dist'),
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  plugins: [protocol],
  define: {
    __WEAVE_HOME__: JSON.stringify(process.env.WEAVE_HOME ?? 'http://localhost:5174'),
    __WEAVE_RELAYS__: JSON.stringify(process.env.WEAVE_RELAYS ?? 'ws://localhost:8787'),
  },
  logLevel: 'info',
};

await rm(here('dist'), { recursive: true, force: true });
await mkdir(here('dist'), { recursive: true });
await cp(here('static'), here('dist'), { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching. Load extension/dist as an unpacked extension, and reload it after a change.');
} else {
  await build(options);
}
