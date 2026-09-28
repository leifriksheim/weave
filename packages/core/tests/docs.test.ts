/**
 * The guides in `docs/` ship in the package for app developers and their
 * agents. An agent copies what they show, so a name they import that the
 * package doesn't export, an action that doesn't exist or a link to a missing
 * guide is a bug here, not there.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { NODE_ACTIONS } from '../src/node/actions.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = join(root, 'docs');
const guides = readdirSync(docs).filter((name) => name.endsWith('.md'));
const read = (name: string) => readFileSync(join(docs, name), 'utf8');

/** `import { a, type B, c } from '@weaveprotocol/core/x'`, across lines */
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'(@weaveprotocol\/core(?:\/[a-z]+)?)'/g;

const sourceOf = (specifier: string) => {
  const entry = specifier.split('/')[2];
  return entry ? `../src/${entry}/index.js` : '../src/index.js';
};

describe('Package docs', () => {
  test('ship with the package', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    assert.ok(manifest.files.includes('docs'), 'package.json "files" must include docs');
    assert.ok(guides.includes('README.md'));
  });

  for (const guide of guides) {
    test(`${guide}: every name it imports is exported`, async () => {
      for (const [, names, specifier] of read(guide).matchAll(IMPORT)) {
        const exported = (await import(sourceOf(specifier!))) as Record<string, unknown>;
        const values = names!
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name && !name.startsWith('type '));
        for (const name of values)
          assert.ok(name in exported, `${guide} imports ${name} from ${specifier}, which doesn't export it`);
      }
    });

    test(`${guide}: every guide it links to exists`, () => {
      for (const [, target] of read(guide).matchAll(/\]\(([a-z-]+\.md)\)/g)) {
        assert.ok(existsSync(join(docs, target!)), `${guide} links to ${target}, which is missing`);
      }
    });
  }

  test('every action the agent guide names exists', () => {
    const names = new Set(NODE_ACTIONS.map((action) => action.name));
    const named = [...read('agents.md').matchAll(/`([a-z]+_[a-z_]+)`/g)].map(([, name]) => name!);
    assert.ok(named.length > 10);
    for (const name of named) assert.ok(names.has(name), `agents.md names ${name}, which is not an action`);
  });
});
