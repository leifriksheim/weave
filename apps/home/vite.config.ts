import { defaultClientConditions, defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Security headers for the deployed home (Netlify's `_headers`; vercel.json
 * sets the same).
 *
 * This page holds the account's seed while it signs, so a script that should
 * not be here is a stolen account. The policy allows only this site's own
 * scripts. Connections may go to any https:// or wss:// address: the hosts an
 * account uses are chosen at runtime (typed in, or named by a space), and the
 * home asks each one how it stands and holds a socket to it. So
 * `script-src 'self'` is what keeps a script out, not `connect-src`.
 * `frame-ancestors 'none'`: the home opens as a window of its own, never
 * inside another site.
 */
function securityHeaders(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const configured = [env.VITE_SIGNALING_URL ?? '', env.VITE_WEAVE_NODES ?? '']
    .flatMap((list) => list.split(','))
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => new URL(url).origin.replace(/^http/, 'ws'));
  const connect = [
    ...new Set(["'self'", 'https:', 'wss:', ...configured, 'ws://localhost:*', 'ws://127.0.0.1:*']),
  ];
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
 * The protocol comes from the workspace, as source: the `@weaveprotocol/source`
 * export condition points each entry at `packages/core/src`, so there is no
 * build step and edits there hot-reload here.
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    conditions: ['@weaveprotocol/source', ...defaultClientConditions],
    dedupe: ['react', 'react-dom'],
  },
  // The node's worker (src/weave-worker.ts) is a module, like the page.
  worker: { format: 'es' },
  plugins: [securityHeaders(mode), react()],
  server: { port: 5174 },
}));
