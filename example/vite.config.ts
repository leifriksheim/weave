import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Security policy for the deployed site.
 *
 * The app's pages carry their policy in a `<meta>` tag, added at build: only
 * this site's own scripts. Connections may go to any secure websocket: a
 * person may bring their own account home, and it hands this app the relays
 * it meets peers on, which nobody knew at build time. That is safe to allow
 * because this app holds no seed — the most a rogue script could take is this
 * app's own note, limited and expiring. (The account home, which does hold
 * the seed, keeps a strict list.)
 *
 * Not a site-wide header, because one page needs a different one:
 * `/screen.html`, where an app's own screen runs, allows its inline scripts
 * and takes the network away entirely (its own `<meta>`). Two policies on one
 * page both apply, so a site-wide one would block the screen. What only a
 * header can say — who may frame the site — is the one site-wide line: only
 * this site, which frames its own screen page.
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
    // The desktop-agent relay's widget, and apps' own screens — both served from this site.
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'security-headers',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: [
          '/*',
          "  Content-Security-Policy: frame-ancestors 'self'",
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
  plugins: [securityHeaders(), react()],
  server: { port: 5173 },
}));
