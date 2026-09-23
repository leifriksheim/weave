#!/usr/bin/env node
// `weave` straight from the TypeScript sources — what `npm link` puts on your PATH.
// A compiled binary (`bun build.ts`) needs neither Node nor this file.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
