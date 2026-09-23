import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectBaseStyles } from './styles';
import { discoverWallets } from './snap';
import { exposeToAgents } from './webmcp';
import { Landing, Developers } from './site/Site';

/**
 * Three pages for now: the landing page for people (`/`), the one for
 * developers (`/developers`), and the app (`/app`). A link made before the app
 * moved — an invite, or a phone-pairing code, both in the fragment — still
 * opens the app wherever it lands.
 */
const path = globalThis.location.pathname.replace(/\/+$/, '') || '/';
const carriesAppLink = /[#&](invite|pair)=/.test(globalThis.location.hash);
const page = carriesAppLink ? 'app' : path === '/' ? 'landing' : path === '/developers' ? 'developers' : 'app';

// Hover, focus and placeholder states, plus the page background — the things
// inline styles cannot express.
injectBaseStyles();

if (page === 'app') {
  // Wallets announce themselves once, on request — so ask before anything has a
  // chance to look for one.
  discoverWallets();

  // The node's operations as WebMCP tools, from the start — agents and
  // extensions read the list on load. They act for whoever signs in.
  exposeToAgents();

  // Bridges those tools to desktop MCP clients through a local relay
  // (npx @mcp-b/webmcp-local-relay). Only in the app: the landing pages have
  // no tools, and would just knock on the relay's ports.
  const relay = document.createElement('script');
  relay.src = '/webmcp/embed.js';
  relay.defer = true;
  document.body.appendChild(relay);
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(page === 'landing' ? <Landing /> : page === 'developers' ? <Developers /> : <App />);
