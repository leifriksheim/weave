/**
 * Builds `p2p` as single-file executables with Bun: one for this machine and one
 * per Linux server architecture. Each carries its runtime, so a server needs
 * nothing installed.
 *
 *   bun build.ts            all targets into dist/
 *   bun build.ts --native   just this machine
 *
 * The entry has no top-level await, which `--bytecode` would reject.
 */
import { $ } from 'bun';

const native = process.argv.includes('--native');
const targets: ReadonlyArray<[string, string]> = native
  ? [['', 'p2p']]
  : [
      ['', 'p2p'],
      ['bun-linux-x64', 'p2p-linux-x64'],
      ['bun-linux-arm64', 'p2p-linux-arm64'],
    ];

for (const [target, name] of targets) {
  const targetFlag = target ? [`--target=${target}`] : [];
  await $`bun build src/main.ts --compile --minify --bytecode ${targetFlag} --outfile dist/${name}`;
  console.log(`built dist/${name}`);
}
