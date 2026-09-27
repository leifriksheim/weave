import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectBaseStyles } from './styles';
import { exposeToAgents } from './webmcp';
import { Landing, Developers } from './site/Site';
import { WeaveProvider } from '@weaveprotocol/core/react';
import { connection } from './weave';

/**
 * Three pages: the landing page, for developers (`/`, and `/developers` for
 * older links), why Weave, for people (`/why`), and the app (`/app`). People
 * mostly meet Weave inside an app, so the front page speaks to whoever builds
 * one. A link made before the app
 * moved — an invite, or a phone-pairing code, both in the fragment — still
 * opens the app wherever it lands.
 */
const path = globalThis.location.pathname.replace(/\/+$/, '') || '/';
const carriesAppLink = /[#&]invite=/.test(globalThis.location.hash);
const page = carriesAppLink ? 'app' : path === '/' || path === '/developers' ? 'developers' : path === '/why' ? 'why' : 'app';

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
  page === 'why' ? (
    <Landing />
  ) : page === 'developers' ? (
    <Developers />
  ) : (
    // Every component in the app asks this for Weave.
    <WeaveProvider connection={connection}>
      <App />
    </WeaveProvider>
  ),
);
