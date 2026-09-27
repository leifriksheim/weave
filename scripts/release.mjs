/**
 * `npm run release`: bump, publish both packages, push — and pick up where it
 * stopped if it didn't finish.
 *
 * The old one-liner (bumpp && npm publish && git push) bumped, committed and
 * tagged before finding out npm wasn't logged in. Running it again then
 * bumped again, or tripped over the tag it had made. This one:
 *
 * 1. checks the tree is clean, you're on main, and main has everything
 *    origin/main has — so the push at the end isn't turned away;
 * 2. checks npm knows who you are, and runs `npm login` if not — before
 *    anything is changed;
 * 3. typechecks and tests;
 * 4. looks at npm and origin: if the version is published but main never
 *    reached origin (the push failed), it only pushes; if the version isn't
 *    published yet (an earlier release stopped after bumping), it releases
 *    that version as it stands; otherwise it asks bumpp for the next one
 *    (commit + tag, local);
 * 5. publishes each package not yet on npm at that version — so a publish that
 *    failed halfway only redoes what's missing;
 * 6. pushes main and the tag, only once both are on npm.
 *
 *   npm run release              the real thing
 *   npm run release -- --dry-run everything but publishing and pushing
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const PACKAGES = [
  { name: '@weaveprotocol/core', manifest: 'packages/core/package.json' },
  { name: '@weaveprotocol/cli', manifest: 'packages/cli/package.json' },
];

/** Runs a command where you can see it (and answer it: login, OTP); throws if it fails */
function run(command, args) {
  console.log(`\n$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`\`${command} ${args.join(' ')}\` failed`);
}

/** Runs a command quietly and returns what it printed, or null if it failed */
function read(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const versionOf = (manifest) => JSON.parse(readFileSync(manifest, 'utf8')).version;
const version = () => versionOf(PACKAGES[0].manifest);
const published = (name, v) => read('npm', ['view', '--prefer-online', `${name}@${v}`, 'version']) === v;
const isAncestor = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b]).status === 0;

function main() {
  // 1. A clean tree on main.
  if (read('git', ['status', '--porcelain'])) throw new Error('The working tree has changes. Commit or stash them first.');
  const branch = read('git', ['branch', '--show-current']);
  if (branch !== 'main') throw new Error(`Releases are cut from main; this is ${branch}.`);
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  if (!isAncestor('origin/main', 'HEAD')) throw new Error('origin/main has commits this main doesn’t. Pull them first.');

  // 2. Logged in to npm, before anything changes.
  let user = read('npm', ['whoami']);
  if (!user) {
    console.log('npm doesn’t know who you are. Logging in…');
    run('npm', ['login']);
    user = read('npm', ['whoami']);
    if (!user) throw new Error('Still not logged in to npm.');
  }
  console.log(`npm: logged in as ${user}`);

  // 3. The checks.
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);

  // 4. Finish a release that stopped, or bump.
  let v = version();
  const tag = `v${v}`;
  const tagged = read('git', ['rev-list', '-n', '1', tag]);
  const missing = PACKAGES.filter((pkg) => !published(pkg.name, v));
  // The tag only leaves this machine after both publishes succeeded, so a tag
  // on origin means they did, even while npm view hasn't caught up.
  const tagOnOrigin = Boolean(tagged && read('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]));
  const done = missing.length === 0 || tagOnOrigin;
  let publish = true;
  if (tagged && done && !isAncestor(tag, 'origin/main')) {
    console.log(`\n${v} is on npm, but main never reached origin: pushing it.`);
    if (!isAncestor(tag, 'HEAD')) {
      throw new Error(`HEAD doesn't contain ${tag} (${tagged.slice(0, 7)}). Merge origin/main into it rather than rebasing, so the tag stays on main.`);
    }
    publish = false;
  } else if (!done) {
    console.log(`\n${v} isn't fully on npm yet (${missing.map((pkg) => pkg.name).join(', ')}): releasing it as it stands.`);
    for (const pkg of PACKAGES) {
      const own = versionOf(pkg.manifest);
      if (own !== v) throw new Error(`${PACKAGES[0].manifest} says ${v} but ${pkg.manifest} says ${own}. Make them match first.`);
    }
    const head = read('git', ['rev-parse', 'HEAD']);
    if (!tagged) {
      if (dryRun) console.log(`(dry run) would tag v${v}`);
      else run('git', ['tag', '--annotate', '--message', `Release v${v}`, `v${v}`]);
    } else if (tagged !== head) {
      throw new Error(
        `v${v} is tagged on ${tagged.slice(0, 7)}, but HEAD is ${head.slice(0, 7)}. ` +
          `Either move the tag to HEAD (git tag -f -a v${v} -m "Release v${v}"), or reset to the tagged commit.`,
      );
    }
  } else if (dryRun) {
    console.log(`\n${v} is on npm; a real run would ask bumpp for the next version here.`);
  } else {
    run('npx', ['bumpp']);
    v = version();
  }

  // 5. Publish what isn't there yet.
  for (const pkg of publish ? PACKAGES : []) {
    if (published(pkg.name, v)) {
      console.log(`\n${pkg.name}@${v} is already on npm.`);
      continue;
    }
    run('npm', ['publish', '--workspace', pkg.name, ...(dryRun ? ['--dry-run'] : [])]);
  }

  // 6. Only now does anything leave this machine.
  if (dryRun) console.log(`\n(dry run) would push main and v${v}`);
  else run('git', ['push', '--follow-tags', 'origin', 'main']);
  console.log(`\nReleased v${v}${dryRun ? ' (dry run)' : ''}.`);
}

try {
  main();
} catch (error) {
  console.error(`\nRelease stopped: ${error.message}\nFix that and run \`npm run release\` again — it picks up where it stopped.`);
  process.exit(1);
}
