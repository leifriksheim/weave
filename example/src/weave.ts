/**
 * This app's Weave setup: one sign-in flow for the page.
 *
 * Everything about accounts — where they live, the ways into them, staying
 * signed in, the node that does the work once someone is in — is the
 * protocol's. All an app decides is what it is called and where its peers
 * meet. Components reach it through `<WeaveProvider auth={auth}>` (main.tsx)
 * and the hooks in `weave-protocol/react`.
 */
import { createWeaveAuth, type WeaveSession } from 'weave-protocol/session';
import { CONFIGURED_NODES, relayUrls } from './relay';

export const auth = createWeaveAuth({
  appName: 'Weave',
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES },
});

/** The current session, for code outside React (the WebMCP tools). Null before sign-in. */
export function getSession(): WeaveSession | null {
  return auth.getState().session;
}
