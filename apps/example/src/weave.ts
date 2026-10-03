// This app's Weave setup: it never holds a seed, and connects to the person's account home instead.
import { createWeaveConnection } from '@weaveprotocol/core/session';
import { CONFIGURED_HOSTS, CONFIGURED_NODES, relayUrls } from '@weave/app-shared/relay';

/** The account home's connect page — ours by default; anyone can run their own */
const HOME = import.meta.env.VITE_WEAVE_HOME ?? 'https://weave-home.netlify.app/connect';

export const connection = createWeaveConnection({
  home: HOME,
  // A browser for every space in the account, so it asks for the whole account.
  // An app that needs less asks for less: `scope: 'spaces'`, or `create` a space of its own.
  request: {
    name: 'Weave example',
    access: 'write',
    scope: 'account',
    // No notifications here: connecting asks for none. The person turns them on later (notifications.ts).
  },
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES, hosts: CONFIGURED_HOSTS },
  // Checking, decrypting and syncing happen there, so the page never stutters. One worker for
  // every tab where there are shared workers (not Chrome on Android): the tabs share one node.
  worker: () =>
    typeof SharedWorker === 'function'
      ? new SharedWorker(new URL('./weave-worker.ts', import.meta.url), {
          type: 'module',
          name: 'weave-node',
        }).port
      : new Worker(new URL('./weave-worker.ts', import.meta.url), { type: 'module' }),
});

/** The node acting for the account, for code outside React (the WebMCP tools). Null before connecting. */
export function getNode() {
  return connection.getState().node;
}
