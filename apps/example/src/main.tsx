import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectBaseStyles } from './styles';
import { exposeToAgents } from './webmcp';
import { Developers } from './site/Site';
import { Home } from './site/Home';
import { WeaveProvider } from '@weaveprotocol/core/react';
import { connection } from './weave';

/**
 * Three pages: the front page, for communities (`/`, and `/why` for older
 * links), for developers (`/developers`), and the app (`/app`). The front page
 * leads with a group that grows its own tools, because no platform offers that.
 * A link made before the app moved — an invite, a door, or a phone-pairing
 * code, all in the fragment — still opens the app wherever it lands.
 */
const path = globalThis.location.pathname.replace(/\/+$/, '') || '/';
const carriesAppLink = /[#&](invite|door)=/.test(globalThis.location.hash);
const page = carriesAppLink ? 'app' : path === '/' || path === '/why' ? 'home' : path === '/developers' ? 'developers' : 'app';

// Hover, focus and placeholder states, plus the page background — the things
// inline styles cannot express.
injectBaseStyles();

if (page === 'app') {
  // The node's operations as WebMCP tools, from the start — agents and
  // extensions read the list on load. They act for whoever signs in.
  exposeToAgents();
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  page === 'home' ? (
    <Home />
  ) : page === 'developers' ? (
    <Developers />
  ) : (
    // Every component in the app asks this for Weave.
    <WeaveProvider connection={connection}>
      <App />
    </WeaveProvider>
  ),
);
