/**
 * Checks a built Snap the way MetaMask will.
 *
 * It reads the manifest, the bundle and the icon from disk, recomputes the
 * checksum, and compares. This is the whole of what MetaMask does on install,
 * so a pass here means the one error that cannot be debugged from the browser
 * — "manifest shasum does not match computed shasum" — will not happen.
 */
import { getSnapChecksum, VirtualFile } from '@metamask/snaps-utils';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// `resolve` so an absolute path is taken as given, rather than glued onto the
// working directory.
const root = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : here;

const manifestText = await readFile(join(root, 'snap.manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const iconPath = manifest.source?.location?.npm?.iconPath;

const computed = await getSnapChecksum({
  manifest: new VirtualFile({ path: 'snap.manifest.json', value: manifestText, result: manifest }),
  sourceCode: new VirtualFile({
    path: manifest.source.location.npm.filePath,
    value: await readFile(join(root, manifest.source.location.npm.filePath), 'utf8'),
  }),
  ...(iconPath
    ? { svgIcon: new VirtualFile({ path: iconPath, value: await readFile(join(root, iconPath), 'utf8') }) }
    : {}),
  auxiliaryFiles: [],
  localizationFiles: [],
});

const claimed = manifest.source.shasum;
console.log(`manifest claims : ${claimed}`);
console.log(`recomputed      : ${computed}`);

if (claimed !== computed) {
  console.error('\n✗ MetaMask will refuse this. Run `npm run build`.');
  process.exit(1);
}
console.log(`\n✓ checksum agrees — version ${manifest.version}`);
