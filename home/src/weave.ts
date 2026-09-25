/**
 * This home's Weave setup: the sign-in flow for the account it holds.
 *
 * The home is the one place the seed is ever unlocked. Apps open it to ask for
 * access (`/connect`), and link to it for account settings (`/`).
 */
import { createWeaveAuth } from '@weaveprotocol/core/session';
import { CONFIGURED_NODES, relayUrls } from './relay';

export const auth = createWeaveAuth({
  appName: 'Weave',
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES },
});
