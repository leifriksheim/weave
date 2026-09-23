import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

/**
 * Serves the WebMCP local-relay browser files (embed.js, widget.html) at
 * /webmcp/, from the installed package. They must be same-origin: the embed
 * finds widget.html next to itself.
 */
function webmcpRelayAssets(): Plugin {
  const dir = path.join(path.dirname(require.resolve('@mcp-b/webmcp-local-relay')), 'browser');
  const files = readdirSync(dir);
  const mime: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html' };
  return {
    name: 'webmcp-relay-assets',
    configureServer(server) {
      server.middlewares.use('/webmcp', (req, res, next) => {
        const file = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        if (!files.includes(file)) return next();
        res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(path.join(dir, file)));
      });
    },
    generateBundle() {
      for (const file of files) this.emitFile({ type: 'asset', fileName: `webmcp/${file}`, source: readFileSync(path.join(dir, file)) });
    },
  };
}

/**
 * The example consumes the protocol straight from source (no build step),
 * so edits in ../src hot-reload here.
 */
export default defineConfig({
  resolve: {
    alias: {
      'weave-protocol': fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    },
  },
  plugins: [webmcpRelayAssets(), react()],
  server: { port: 5173 },
});
