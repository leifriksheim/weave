import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectBaseStyles } from './styles';
import { discoverWallets } from './snap';
import { exposeToAgents } from './webmcp';

// Hover, focus and placeholder states, plus the page background — the things
// inline styles cannot express.
injectBaseStyles();

// Wallets announce themselves once, on request — so ask before anything has a
// chance to look for one.
discoverWallets();

// The node's operations as WebMCP tools, from the start — agents and
// extensions read the list on load. They act for whoever signs in.
exposeToAgents();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(<App />);
