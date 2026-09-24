import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
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
 * The page holds the account's seed in memory once someone signs in, so a
 * script that should not be there is a stolen account. The policy allows only
 * this site's own scripts, and connections only to the relays and nodes the
 * build was configured with — plus this machine, for a local node and the
 * desktop-agent relay. Anything else a rogue script tried to send the seed to
 * is refused by the browser.
 */
function securityHeaders(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const configured = [env.VITE_SIGNALING_URL ?? '', env.VITE_WEAVE_NODES ?? '']
    .flatMap((list) => list.split(','))
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => new URL(url).origin.replace(/^http/, 'ws'));
  const connect = [...new Set(["'self'", ...configured, 'ws://localhost:*', 'ws://127.0.0.1:*'])];
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
export default defineConfig(({ mode }) => ({
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
  plugins: [webmcpRelayAssets(), securityHeaders(mode), react()],
  server: { port: 5173 },
}));
