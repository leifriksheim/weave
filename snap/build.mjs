/**
 * Bundles the Snap and stamps its checksum into the manifest.
 *
 * MetaMask refuses a bundle whose checksum does not match the one the manifest
 * claims — that is what stops a registry serving different code to different
 * people.
 *
 * The checksum is **not** a hash of the bundle. It covers the manifest itself
 * (minus the checksum field), the source, and the icon, hashed in a defined
 * order. Reimplementing that by hand is a good way to publish something
 * MetaMask will reject, so this uses the official function.
 */
import { build } from 'esbuild';
import { getSnapChecksum, VirtualFile } from '@metamask/snaps-utils';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, 'dist', 'bundle.js');
const manifestPath = join(here, 'snap.manifest.json');

await mkdir(join(here, 'dist'), { recursive: true });

await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  bundle: true,
  outfile: bundlePath,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // The sandbox is hardened, so anything not bundled is simply absent.
  external: [],
  minify: false,
  logLevel: 'info',
});

// esbuild's CJS output already puts `onRpcRequest` on module.exports — and it
// does so with `Object.defineProperty(..., { get })`, a getter with no setter.
// Appending an assignment on top of that throws under the sandbox's strict
// mode ("cannot set property ... which has only a getter"), so there is
// deliberately nothing to add here.
const sourceCode = await readFile(bundlePath, 'utf8');

const manifestText = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);
const iconPath = manifest.source?.location?.npm?.iconPath;

const shasum = await getSnapChecksum({
  manifest: new VirtualFile({ path: 'snap.manifest.json', value: manifestText, result: manifest }),
  sourceCode: new VirtualFile({ path: manifest.source.location.npm.filePath, value: sourceCode }),
  ...(iconPath
    ? { svgIcon: new VirtualFile({ path: iconPath, value: await readFile(join(here, iconPath), 'utf8') }) }
    : {}),
  auxiliaryFiles: [],
  localizationFiles: [],
});

manifest.source.shasum = shasum;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// Load it the way MetaMask will. This is cheap and catches the whole class of
// "the bundle is valid JavaScript that explodes on import" — which a checksum
// says nothing about.
const loaded = await import(`file://${bundlePath}`);
const handler = loaded.default?.onRpcRequest ?? loaded.onRpcRequest;
if (typeof handler !== 'function') {
  throw new Error('The bundle does not export onRpcRequest as a function.');
}

console.log(`\nbundled, checksum ${shasum}`);
console.log('exports onRpcRequest ✓');
