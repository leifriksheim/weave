import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The example consumes the protocol straight from source (no build step),
 * so edits in ../src hot-reload here.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@p2p-web/protocol': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    },
  },
  plugins: [react()],
  server: { port: 5173 },
});
