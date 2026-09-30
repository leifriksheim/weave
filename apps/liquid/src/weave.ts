/**
 * This app's Weave setup.
 *
 * Liquid never signs anyone in and never holds a seed. It connects to the
 * person's account home, which asks what the app may use and hands back a
 * signed note for this app's own key.
 *
 * It asks for the whole account: an assembly is a space, and only an app
 * given the account can make one, or join one from an invite, after
 * connecting. It shows only the spaces that are assemblies (`useSpaces` with
 * `having`).
 */
import { createWeaveConnection } from '@weaveprotocol/core/session';
import { CONFIGURED_HOSTS, CONFIGURED_NODES, relayUrls } from '@weave/app-shared/relay';

const HOME = import.meta.env.VITE_WEAVE_HOME ?? 'https://weave-home.netlify.app/connect';

export const connection = createWeaveConnection({
  home: HOME,
  request: { name: 'Liquid', access: 'write', scope: 'account' },
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES, hosts: CONFIGURED_HOSTS },
  worker: () =>
    typeof SharedWorker === 'function'
      ? new SharedWorker(new URL('./weave-worker.ts', import.meta.url), {
          type: 'module',
          name: 'liquid-node',
        }).port
      : new Worker(new URL('./weave-worker.ts', import.meta.url), { type: 'module' }),
});
