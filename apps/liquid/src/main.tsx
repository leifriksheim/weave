import { createRoot } from 'react-dom/client';
import { WeaveProvider } from '@weaveprotocol/core/react';
import { App } from './App';
import { connection } from './weave';
import { injectStyles } from './styles';

injectStyles();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <WeaveProvider connection={connection}>
    <App />
  </WeaveProvider>,
);
