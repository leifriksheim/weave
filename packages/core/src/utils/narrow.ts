/**
 * Small type guards for values whose shape is not yet known: parsed JSON,
 * messages off the wire, what a browser API hands back.
 * @module narrow
 */

import type { Expression } from '../types.js';

/**
 * Whether a value is a non-null object, so its fields can be read. Arrays pass,
 * as they do for `typeof value === 'object'`; callers that care check the fields.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether a value is a non-null object and not an array: a JSON object */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

/** `Array.isArray` for a value that is one thing or a list of them, which it narrows badly on its own */
export function isList<T>(value: T | ReadonlyArray<T>): value is ReadonlyArray<T> {
  return Array.isArray(value);
}

/**
 * `value?.[key]` for a value of unknown type, exactly as JavaScript reads it:
 * undefined for null and undefined, and a string's own `length` included.
 * Rules read fields of bodies this way, so a check gives the same answer on
 * every node whatever the body is.
 */
export function readField(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : Reflect.get(new Object(value), key);
}

/**
 * The same bytes as a view Web Crypto and `fetch` accept, which must sit on an
 * `ArrayBuffer`. Shares the memory when it already does; copies a view over a
 * `SharedArrayBuffer`, which those APIs refuse.
 */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

/**
 * Lets Node exit while a timer or channel is still pending. Browsers have no
 * `unref`, and their timers are numbers, so this does nothing there.
 */
export function unref(handle: unknown): void {
  if (hasUnref(handle)) handle.unref();
}

function hasUnref(handle: unknown): handle is { unref(): void } {
  return isRecord(handle) && typeof handle.unref === 'function';
}

/**
 * Whether a value this node read back from its own storage is an expression.
 * Checks only that it is an object with a string id: what arrives from a peer
 * goes through the validation gates, not this.
 */
export function isStoredExpression(value: unknown): value is Expression {
  return isRecord(value) && typeof value.id === 'string';
}
