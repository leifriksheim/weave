/**
 * Talking to a relay's mailbox: leaving a sealed knock under a door's topic,
 * and reading what was left under one's own (`packages/relay/relay.mjs`).
 *
 * Each call opens its own short-lived socket, says one thing, waits for the
 * answer and closes. A mailbox socket never joins a room, so it names no DID,
 * and the relay can't tie a knock to the peer that left it or fetched it.
 *
 *   client → { type: 'drop', topic, blob, ttl? }       relay → { type: 'dropped', topic, id } | { type: 'refused', topic, reason }
 *   client → { type: 'fetch', topic, after? }          relay → { type: 'mail', topic, items: [{ seq, id, at, blob }], more }
 *   client → { type: 'challenge' }                     relay → { type: 'challenge', nonce }
 *   client → { type: 'purge', topic, sign, ids?, sig } relay → { type: 'purged', topic, count } | { type: 'refused', topic, reason }
 */

import { isObject } from '../utils/guards.js';

/** One sealed knock, as a relay holds it */
export interface MailItem {
  /** Increases with every drop on that relay */
  readonly seq: number;
  /** base64url SHA-256 of the blob: the same on every relay it was left at */
  readonly id: string;
  /** When it was dropped, ms, by the relay's clock */
  readonly at: number;
  readonly blob: string;
}

export interface MailboxClient {
  /**
   * Leaves a blob under a topic.
   * @throws When the relay refuses it, or can't be reached
   */
  drop(relay: string, topic: string, blob: string, ttlSeconds?: number): Promise<string>;
  /** Everything a relay holds under a topic, after a sequence number */
  fetch(relay: string, topic: string, after?: number): Promise<ReadonlyArray<MailItem>>;
  /**
   * Clears knocks from a topic — all of them, or those named — as the door's
   * owner: shows the signing key and signs the relay's challenge with it.
   */
  purge(
    relay: string,
    topic: string,
    sign: string,
    ids: ReadonlyArray<string> | null,
    signChallenge: (nonce: string) => Promise<string>,
  ): Promise<number>;
}

export interface MailboxOptions {
  /** How long to wait for a relay to answer. Default 8 seconds. */
  readonly timeoutMs?: number;
  /** The WebSocket to use. Default the global one (browsers, Node 22+). */
  readonly WebSocket?: typeof WebSocket;
}

/** At most this many pages per fetch: 16 knocks each, and a door holds 64 */
const MAX_PAGES = 8;

export function createMailboxClient(options: MailboxOptions = {}): MailboxClient {
  const timeoutMs = options.timeoutMs ?? 8000;

  /** Opens a socket, sends one message, and resolves with the first answer `pick` accepts */
  function ask<T>(
    relay: string,
    message: unknown,
    pick: (answer: Record<string, unknown>) => T | undefined,
  ): Promise<T> {
    return talk(
      relay,
      (send) => send(message),
      async (answer) => pick(answer),
    );
  }

  /**
   * Opens a socket and holds a short conversation: `start` says the first
   * thing, `hear` answers what comes back (it may `send` again) and settles it
   * by returning a value.
   */
  function talk<T>(
    relay: string,
    start: (send: (message: unknown) => void) => void,
    hear: (answer: Record<string, unknown>, send: (message: unknown) => void) => Promise<T | undefined>,
  ): Promise<T> {
    const Socket = options.WebSocket ?? globalThis.WebSocket;
    if (!Socket) return Promise.reject(new Error('No WebSocket here to reach a relay with'));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const ws = new Socket(relay);
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // already closing
        }
        return true;
      };
      const fail = (error: Error) => {
        if (settle()) reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`${relay} did not answer`)), timeoutMs);
      const say = (message: unknown) => ws.send(JSON.stringify(message));
      ws.onopen = () => start(say);
      ws.onerror = () => fail(new Error(`Could not reach ${relay}`));
      ws.onclose = () => fail(new Error(`${relay} closed the connection`));
      ws.onmessage = (event: MessageEvent) => {
        let answer: unknown;
        try {
          answer = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!isObject(answer)) return;
        hear(answer, say).then(
          (value) => {
            if (value !== undefined && settle()) resolve(value);
          },
          (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
        );
      };
    });
  }

  const client: MailboxClient = {
    drop(relay: string, topic: string, blob: string, ttlSeconds?: number) {
      return ask(
        relay,
        { type: 'drop', topic, blob, ...(ttlSeconds ? { ttl: ttlSeconds } : {}) },
        (answer) => {
          if (answer.topic !== topic) return undefined;
          if (answer.type === 'dropped' && typeof answer.id === 'string') return answer.id;
          if (answer.type === 'refused') throw new Error(`${relay} refused the knock: ${reasonOf(answer)}`);
          return undefined;
        },
      );
    },

    async fetch(relay: string, topic: string, after = 0) {
      const found: MailItem[] = [];
      let from = after;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { items, more } = await ask(relay, { type: 'fetch', topic, after: from }, (answer) =>
          answer.type === 'mail' && answer.topic === topic && Array.isArray(answer.items)
            ? { items: answer.items.filter(isMailItem), more: answer.more === true }
            : undefined,
        );
        found.push(...items);
        if (!more || items.length === 0) break;
        from = Math.max(...items.map((item) => item.seq));
      }
      return found;
    },

    purge(relay, topic, sign, ids, signChallenge) {
      return talk(
        relay,
        (send) => send({ type: 'challenge' }),
        async (answer, send) => {
          if (answer.type === 'challenge' && typeof answer.nonce === 'string') {
            send({
              type: 'purge',
              topic,
              sign,
              ...(ids ? { ids: [...ids] } : {}),
              sig: await signChallenge(answer.nonce),
            });
            return undefined;
          }
          if (answer.topic !== topic) return undefined;
          if (answer.type === 'purged' && typeof answer.count === 'number') return answer.count;
          if (answer.type === 'refused')
            throw new Error(`${relay} refused to clear the door: ${reasonOf(answer)}`);
          return undefined;
        },
      );
    },
  };
  return Object.freeze(client);
}

/** Why a relay refused; relays send a string */
function reasonOf(answer: Record<string, unknown>): string {
  return typeof answer.reason === 'string' ? answer.reason : 'no reason given';
}

function isMailItem(value: unknown): value is MailItem {
  return (
    isObject(value) &&
    Number.isSafeInteger(value.seq) &&
    typeof value.id === 'string' &&
    typeof value.at === 'number' &&
    typeof value.blob === 'string'
  );
}
