import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Security headers for the deployed site.
 *
 * The app's pages carry no content security policy. Browser agents such as
 * Claude in Chrome run the code they write in the page with `eval`, which
 * `script-src 'self'` blocks, and an agent in the page is what WebMCP
 * (`src/webmcp.ts`) is for. What a policy would add is small: React escapes
 * what it renders, the one raw-HTML path for records (the JSON highlighter in
 * `QueryPlayground.tsx`) escapes too, and this app holds no seed, only its own
 * limited, expiring note. (The account home, which does hold the seed, keeps
 * a strict policy.)
 *
 * `/screen.html`, where an app's own screen runs, keeps its own `<meta>`
 * policy: inline scripts, no network. What only a header can say, who may
 * frame the site, is the one site-wide line: only this site, which frames its
 * own screen page.
 */
function securityHeaders(): Plugin {
  return {
    name: 'security-headers',
    apply: 'build',
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
  plugins: [securityHeaders(), react()],
  server: { port: 5173 },
}));
