/**
 * Either end of a `MessageChannel`, a `Worker`, or the scope inside one: what
 * the parts of a node that run apart talk over (`node/remote.ts`,
 * `network/remote-transport.ts`).
 */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  /** A `MessagePort` delivers nothing until started */
  start?(): void;
}
