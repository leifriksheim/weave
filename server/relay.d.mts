/** Types for `relay.mjs`, for the always-on node that runs it (`cli/src/serve.ts`). */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';

export declare const MAX_MESSAGE_BYTES: number;

/** One knock the mailbox holds, as `fetch` returns it */
export interface MailItem {
  /** Increases with every drop on this relay; fetch `after` the last one seen */
  readonly seq: number;
  /** base64url SHA-256 of the blob */
  readonly id: string;
  /** When it was dropped, ms */
  readonly at: number;
  readonly blob: string;
}

export interface TurnSettings {
  readonly secret: string;
  readonly urls: ReadonlyArray<string>;
  readonly ttlSeconds: number;
}

export declare function turnFromEnv(env: Record<string, string | undefined>): TurnSettings | undefined;

export interface Relay {
  upgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export declare function createRelay(options?: { readonly turn?: TurnSettings; readonly log?: (message: string) => void }): Relay;
