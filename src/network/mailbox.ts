/**
 * @module network/mailbox
 * Talking to a relay's mailbox: leaving a sealed knock under a door's topic,
 * and reading what was left under one's own (`server/relay.mjs`).
 *
 * Each call opens its own short-lived socket, says one thing, waits for the
 * answer and closes. A mailbox socket never joins a room, so it names no DID,
 * and the relay can't tie a knock to the peer that left it or fetched it.
 *
 *   client → { type: 'drop', topic, blob, ttl? }       relay → { type: 'dropped', topic, id } | { type: 'refused', topic, reason }
 *   client → { type: 'fetch', topic, after? }          relay → { type: 'mail', topic, items: [{ seq, id, at, blob }], more }
 */

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
   * @returns The id the relay filed it under
   * @throws When the relay refuses it, or can't be reached
   */
  drop(relay: string, topic: string, blob: string, ttlSeconds?: number): Promise<string>;
  /** Everything a relay holds under a topic, after a sequence number */
  fetch(relay: string, topic: string, after?: number): Promise<ReadonlyArray<MailItem>>;
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
  function ask<T>(relay: string, message: unknown, pick: (answer: Record<string, unknown>) => T | undefined): Promise<T> {
    const Socket = options.WebSocket ?? globalThis.WebSocket;
    if (!Socket) return Promise.reject(new Error('No WebSocket here to reach a relay with'));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const ws = new Socket(relay);
      const finish = (error: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // already closing
        }
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(() => finish(new Error(`${relay} did not answer`)), timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify(message));
      ws.onerror = () => finish(new Error(`Could not reach ${relay}`));
      ws.onclose = () => finish(new Error(`${relay} closed the connection`));
      ws.onmessage = (event: MessageEvent) => {
        let answer: unknown;
        try {
          answer = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!answer || typeof answer !== 'object') return;
        try {
          const value = pick(answer as Record<string, unknown>);
          if (value !== undefined) finish(null, value);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
    });
  }

  return Object.freeze({
    drop(relay: string, topic: string, blob: string, ttlSeconds?: number) {
      return ask(relay, { type: 'drop', topic, blob, ...(ttlSeconds ? { ttl: ttlSeconds } : {}) }, (answer) => {
        if (answer.topic !== topic) return undefined;
        if (answer.type === 'dropped' && typeof answer.id === 'string') return answer.id;
        if (answer.type === 'refused') throw new Error(`${relay} refused the knock: ${String(answer.reason ?? 'no reason given')}`);
        return undefined;
      });
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
  });
}

function isMailItem(value: unknown): value is MailItem {
  const item = value as MailItem | null;
  return (
    !!item &&
    Number.isSafeInteger(item.seq) &&
    typeof item.id === 'string' &&
    typeof item.at === 'number' &&
    typeof item.blob === 'string'
  );
}
