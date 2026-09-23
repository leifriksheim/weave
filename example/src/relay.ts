/**
 * Where peers meet.
 *
 * The relay is a rendezvous, not an authority: it forwards offers and ICE
 * candidates between peers in a room and never sees an expression. But peers
 * pointed at different relays never find each other, so every view that should
 * gossip has to be given the same address — and a deployed page has to be given
 * one at all, because the development default is a process on your own machine.
 */

const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * The configured relays, comma separated.
 *
 * `ws://localhost:8787` matches `npm run signal`, which is what you want while
 * developing and never what you want once the page is deployed.
 *
 * Several is better than one. They are all used at once rather than as
 * failover, because two people who happened to pick different relays would
 * otherwise never meet — and since a relay can do nothing but introduce peers,
 * adding more costs a websocket and removes a single point of failure. A
 * torrent client ships a tracker list for exactly this reason.
 */
export const CONFIGURED_RELAYS: ReadonlyArray<string> = (
  import.meta.env.VITE_SIGNALING_URL ?? 'ws://localhost:8787'
)
  .split(',')
  .map((url: string) => url.trim())
  .filter(Boolean);

/** The first configured relay, for messages that talk about one. */
export const CONFIGURED_RELAY: string = CONFIGURED_RELAYS[0] ?? 'ws://localhost:8787';

/** Whether a hostname refers to this machine. */
function isLoopback(host: string): boolean {
  return LOOPBACK.includes(host);
}

/**
 * Whether a hostname is an address on the local network.
 *
 * Deliberately narrow. This is the one case where guessing that the relay lives
 * on the same host as the page is reasonable — you ran `vite --host` and are
 * opening it from a phone on the same Wi-Fi. Any other hostname means the page
 * is deployed somewhere, and the relay could be anywhere at all.
 */
function isPrivateLan(host: string): boolean {
  return (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.endsWith('.local')
  );
}

/** Whether this page was served over HTTPS, which forbids plain websockets. */
function pageIsSecure(): boolean {
  return globalThis.location.protocol === 'https:';
}

/**
 * The relay address to actually connect to.
 *
 * Two adjustments to what was configured, and nothing more — it will not invent
 * a relay that does not exist:
 *
 * - **Host**, only for local-network development: a relay configured as
 *   localhost, reached from a phone on the same Wi-Fi, means the machine
 *   serving the page.
 * - **Scheme**, because a page on HTTPS cannot open a `ws://` socket. Browsers
 *   block it outright, so `wss://` is the only thing worth attempting.
 *
 * @returns A websocket URL, without a trailing slash
 */
export function relayUrls(): ReadonlyArray<string> {
  return CONFIGURED_RELAYS.map(resolveRelay);
}

/** The first usable relay, for the pairing ticket, which carries only one. */
export function relayUrl(): string {
  return resolveRelay(CONFIGURED_RELAY);
}

/**
 * Adjusts one configured relay for where this page is actually running.
 * @param configured The relay as written in the environment
 * @returns A websocket URL, without a trailing slash
 */
function resolveRelay(configured: string): string {
  const relay = new URL(configured);
  const pageHost = globalThis.location.hostname;

  if (isLoopback(relay.hostname) && isPrivateLan(pageHost)) {
    relay.hostname = pageHost;
  }

  // Loopback is exempt: browsers treat http://localhost as trustworthy, so a
  // local relay still works from a secure page.
  if (pageIsSecure() && relay.protocol === 'ws:' && !isLoopback(relay.hostname)) {
    relay.protocol = 'wss:';
  }

  return relay.toString().replace(/\/$/, '');
}

/**
 * Why the relay cannot work from this page, if it cannot.
 *
 * Connecting to a relay that is not there fails slowly and silently — the app
 * looks like it is merely offline. This turns the common misconfigurations into
 * something that can be said out loud before anyone waits.
 *
 * @returns A sentence to show the user, or null when the address looks usable
 */
export function relayProblem(): string | null {
  const relay = new URL(relayUrl());
  const pageHost = globalThis.location.hostname;

  // The page is deployed, but the relay was never configured, so it still
  // points at a process on whoever's laptop built this.
  if (isLoopback(relay.hostname) && !isLoopback(pageHost) && !isPrivateLan(pageHost)) {
    return (
      'This deployment has no relay configured, so peers cannot find each other. ' +
      'Set VITE_SIGNALING_URL to a wss:// address running server/signaling-server.mjs and rebuild.'
    );
  }

  // Configured, but as a plain socket from a secure page. The browser will
  // block it before it is ever attempted.
  if (pageIsSecure() && new URL(CONFIGURED_RELAY).protocol === 'ws:' && !isLoopback(relay.hostname)) {
    return (
      `The relay is configured as ${CONFIGURED_RELAY}, which a page served over HTTPS is not ` +
      'allowed to open. It has to be reachable over wss:// — put the signaling server behind TLS.'
    );
  }

  // Development on localhost: fine for this machine, unreachable from a phone.
  if (isLoopback(relay.hostname) && isLoopback(pageHost)) {
    return null;
  }

  return null;
}

/** Whether this page is reachable from another device on the network. */
export function servedOverLan(): boolean {
  return !isLoopback(globalThis.location.hostname);
}
