import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The protocol comes from the workspace, as source: the `@weaveprotocol/source`
 * export condition points each entry at `packages/core/src`, so there is no
 * build step and edits there hot-reload here.
 */
export default defineConfig(() => ({
  resolve: {
    conditions: ['@weaveprotocol/source', ...defaultClientConditions],
    // The protocol's React bindings sit outside this folder; they must use
    // this app's copy of React, not look for their own.
    dedupe: ['react', 'react-dom'],
  },
  // The node's worker (src/weave-worker.ts) is a module, like the page.
  worker: { format: 'es' },
  plugins: [react()],
  server: { port: 5190 },
}));
