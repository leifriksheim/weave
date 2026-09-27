import { createRoot } from 'react-dom/client';
import { WeaveProvider } from '@weaveprotocol/core/react';
import { App } from './App';
import { ConnectPage } from './components/ConnectPage';
import { injectBaseStyles } from './styles';
import { auth } from './weave';

/**
 * Two pages: the account (`/`), and the page apps open to ask for access
 * (`/connect`). A phone-pairing link lands on `/`, where sign-in picks it up.
 */
const path = globalThis.location.pathname.replace(/\/+$/, '') || '/';

injectBaseStyles();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(<WeaveProvider auth={auth}>{path === '/connect' ? <ConnectPage /> : <App />}</WeaveProvider>);
