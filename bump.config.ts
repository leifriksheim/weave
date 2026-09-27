import { defineConfig } from 'bumpp';

/**
 * Both packages share one version. bumpp asks for the next one, writes it to
 * both, refreshes the lockfile, and commits and tags it (`v0.1.2`), locally.
 * `npm run release` (scripts/release.mjs) runs it only when the current
 * version is already on npm, then publishes and pushes.
 */
export default defineConfig({
  files: ['package.json', 'cli/package.json'],
  install: true,
  // The lockfile `install` refreshed goes in the same commit. The tree is clean beforehand (gitCheck), so it's the only other change.
  all: true,
  commit: 'Release v%s',
  tag: 'v%s',
  // Pushed only once both are published, so a failed publish leaves nothing half-released on GitHub.
  push: false,
  gitCheck: true,
});
