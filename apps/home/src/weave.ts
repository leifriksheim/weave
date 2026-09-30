/**
 * This home's Weave setup: the sign-in flow for the account it holds.
 *
 * The home is the one place the seed is ever unlocked. Apps open it to ask for
 * access (`/connect`), and link to it for account settings (`/`).
 */
import { createWeaveAuth } from '@weaveprotocol/core/session';
import { CONFIGURED_HOSTS, CONFIGURED_NODES, relayUrls } from '@weave/app-shared/relay';

export const auth = createWeaveAuth({
  appName: 'Weave',
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES, hosts: CONFIGURED_HOSTS },
  // Checking, decrypting and syncing happen there, so the page never stutters; the seed stays here.
  // One worker for every tab, where there are shared workers (not Chrome on Android).
  worker: () =>
    typeof SharedWorker === 'function'
      ? new SharedWorker(new URL('./weave-worker.ts', import.meta.url), {
          type: 'module',
          name: 'weave-node',
        }).port
      : new Worker(new URL('./weave-worker.ts', import.meta.url), { type: 'module' }),
});
