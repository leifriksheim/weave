/**
 * A worker script that runs a browser node: the page starts one with
 * `startNodeInWorker`, or with `worker` in `createWeaveAuth` and
 * `createWeaveConnection`. A bundler needs a file of the app's own to point
 * `new Worker` at, holding just this import:
 *
 * ```ts
 * // weave-worker.ts
 * import '@weaveprotocol/core/node-worker';
 * // the app
 * const worker = () => new Worker(new URL('./weave-worker.ts', import.meta.url), { type: 'module' });
 * ```
 */
import { runNodeWorker } from './node/worker.js';

runNodeWorker();
