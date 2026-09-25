import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Security headers for the deployed home (Netlify's `_headers`; vercel.json
 * sets the same).
 *
 * This page holds the account's seed while it signs, so a script that should
 * not be here is a stolen account. The policy allows only this site's own
 * scripts, and connections only to the relays and nodes the build was
 * configured with. `frame-ancestors 'none'`: the home opens as a window of its
 * own, never inside another site.
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
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    `connect-src ${connect.join(' ')}`,
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
        source: ['/*', `  Content-Security-Policy: ${policy}`, '  Referrer-Policy: no-referrer', '  X-Content-Type-Options: nosniff', ''].join('\n'),
      });
    },
  };
}

/**
 * The home consumes the protocol straight from source (no build step), so
 * edits in ../src hot-reload here.
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: [
      { find: /^@weaveprotocol\/core\/(.+)$/, replacement: fileURLToPath(new URL('../src/$1/index.ts', import.meta.url)) },
      { find: /^@weaveprotocol\/core$/, replacement: fileURLToPath(new URL('../src/index.ts', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  plugins: [securityHeaders(mode), react()],
  server: { port: 5174 },
}));
