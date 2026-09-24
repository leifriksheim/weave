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
 * Security headers for the deployed site (Netlify's `_headers`).
 *
 * The policy allows only this site's own scripts. Connections may go to any
 * secure websocket: a person may bring their own account home, and it hands
 * this app the relays it meets peers on, which nobody knew at build time.
 * That is safe to allow because this app holds no seed — the most a rogue
 * script could take is this app's own note, limited and expiring. (The
 * account home, which does hold the seed, keeps a strict list.)
 */
function securityHeaders(): Plugin {
  const connect = ["'self'", 'wss:', 'ws://localhost:*', 'ws://127.0.0.1:*'];
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // React sets inline style attributes; the base styles are one <style> tag.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    `connect-src ${connect.join(' ')}`,
    // The desktop-agent relay's widget, served from this site.
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'security-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: [
          '/*',
          `  Content-Security-Policy: ${policy}`,
          '  Referrer-Policy: no-referrer',
          '  X-Content-Type-Options: nosniff',
          '',
        ].join('\n'),
      });
    },
  };
}

/**
 * The example consumes the protocol straight from source (no build step),
 * so edits in ../src hot-reload here.
 */
export default defineConfig(() => ({
  resolve: {
    alias: [
      // weave-protocol/<entry> → ../src/<entry>/index.ts
      { find: /^weave-protocol\/(.+)$/, replacement: fileURLToPath(new URL('../src/$1/index.ts', import.meta.url)) },
      { find: /^weave-protocol$/, replacement: fileURLToPath(new URL('../src/index.ts', import.meta.url)) },
    ],
    // The protocol's React bindings sit outside this folder; they must use
    // this app's copy of React, not look for their own.
    dedupe: ['react', 'react-dom'],
  },
  plugins: [webmcpRelayAssets(), securityHeaders(), react()],
  server: { port: 5173 },
}));
