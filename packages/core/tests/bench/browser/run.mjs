/**
 * Runs a browser bench in headless Chromium and prints what it logs: the
 * pixel bench over IndexedDB, or another page (ENTRY=idb-micro.ts,
 * ENTRY=worker-idb.ts, ENTRY=worker-relay.ts). A relay runs on the same port; pages
 * find it in `?relay=`.
 * Playwright is not a dependency of this repository: point PLAYWRIGHT at an
 * installed copy, with its Chromium downloaded. PROFILE=<file> also writes a
 * CPU profile of the page.
 *
 *   PLAYWRIGHT=<path to the playwright package> node tests/bench/browser/run.mjs [N]
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRelay, MAX_MESSAGE_BYTES } from '../../../../relay/relay.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const n = process.argv[2] ?? '1024';

const bundled = await build({
  entryPoints: [`${here}${process.env.ENTRY ?? 'pixel-idb.ts'}`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'error',
});
const script = bundled.outputFiles[0].text;
// The node's worker script, for a page that starts one (`startNodeInWorker`)
const worker = (
  await build({
    entryPoints: [`${here}../../../src/node-worker.ts`],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'error',
  })
).outputFiles[0].text;

const server = createServer((request, response) => {
  if (request.url?.startsWith('/node-worker.js')) {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    return response.end(worker);
  }
  if (request.url?.startsWith('/bench.js')) {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    return response.end(script);
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><script type="module" src="/bench.js"></script>');
});
// A relay on the same port, for pages whose nodes meet (?relay=)
const relay = createRelay({ log: () => {} });
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, clientTracking: false });
server.on('upgrade', (request, socket, head) => relay.upgrade(wss, request, socket, head));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT ?? 'playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
const finished = new Promise((resolve) => {
  page.on('console', (message) => {
    const text = message.text();
    console.log(text);
    if (text === 'done' || text.startsWith('failed')) resolve();
  });
});
// PROFILE=<file>: a CPU profile of the whole run, in the format DevTools opens.
const cdp = process.env.PROFILE ? await page.context().newCDPSession(page) : null;
if (cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
}
await page.goto(`http://127.0.0.1:${port}/?n=${n}&relay=ws://127.0.0.1:${port}`);
await finished;
if (cdp) {
  const { profile } = await cdp.send('Profiler.stop');
  (await import('node:fs')).writeFileSync(process.env.PROFILE, JSON.stringify(profile));
}
await browser.close();
relay.close();
server.close();
