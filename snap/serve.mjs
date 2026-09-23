/**
 * Serves the Snap for local development.
 *
 * MetaMask Flask fetches `snap.manifest.json` from here and then the bundle at
 * the path the manifest names. It does that from the extension's own context,
 * so the responses need permissive CORS — which is the one thing an ordinary
 * static file server will not give you, and the reason this exists rather than
 * `python3 -m http.server`.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8080);

const TYPES = { '.json': 'application/json', '.js': 'application/javascript', '.svg': 'image/svg+xml' };

createServer(async (request, response) => {
  // Keeps a request for ../../etc/passwd inside this directory.
  const requested = normalize(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^(\.\.[/\\])+/, '');
  const path = join(here, requested === '/' ? 'snap.manifest.json' : requested);

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  };

  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers);
    response.end();
    return;
  }

  try {
    const body = await readFile(path);
    const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';
    response.writeHead(200, { ...headers, 'Content-Type': type });
    response.end(body);
  } catch {
    response.writeHead(404, headers);
    response.end('not found');
  }
}).listen(port, () => {
  console.log(`snap served on http://localhost:${port}`);
  console.log(`point the app at it:  VITE_SNAP_ID=local:http://localhost:${port} npm run dev`);
  console.log('this needs MetaMask Flask — ordinary MetaMask only installs from npm');
});
