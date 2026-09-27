/**
 * This app's Weave setup.
 *
 * The app never signs anyone in and never holds a seed. It connects to the
 * person's account home, which opens in a popup, asks what the app may use,
 * and hands back a signed note for this app's own key. Components reach the
 * result through `<WeaveProvider connection={connection}>` (main.tsx) and the
 * hooks in `@weaveprotocol/core/react`.
 */
import { createWeaveConnection } from '@weaveprotocol/core/session';
import { CONFIGURED_NODES, relayUrls } from './relay';

/** The account home's connect page — ours by default; anyone can run their own */
export const HOME = import.meta.env.VITE_WEAVE_HOME ?? 'https://weave-home.netlify.app/connect';

export const connection = createWeaveConnection({
  home: HOME,
  // A browser for every space in the account, so it asks for the whole account.
  // An app that needs less asks for less: `scope: 'spaces'`, or `create` a space of its own.
  request: { name: 'Weave example', access: 'write', scope: 'account' },
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES },
});

/** The node acting for the account, for code outside React (the WebMCP tools). Null before connecting. */
export function getNode() {
  return connection.getState().node;
}
