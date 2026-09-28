/**
 * Small type guards for values whose shape is not yet known: parsed JSON,
 * messages off the wire, what a browser API hands back.
 * @module guards
 */

import type { Expression } from '../types.js';

/** A plain object's fields, to be checked one by one. Not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Anything `typeof` calls an object, arrays included — for checks that were
 * written as `typeof x === 'object' && x !== null` and must keep meaning that.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The same bytes as a view Web Crypto accepts. A view on an ArrayBuffer is
 * rewrapped without copying; anything else (a SharedArrayBuffer, another
 * realm's buffer) is copied.
 */
export function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

/** The bytes of a BufferSource, as a view rather than a copy */
export function bytesFrom(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

/**
 * Whether a credential is what a passkey ceremony returns. Checked by shape
 * rather than `instanceof`, since password managers answer with their own objects.
 */
export function isPublicKeyCredential(credential: Credential | null): credential is PublicKeyCredential {
  return (
    credential !== null &&
    'rawId' in credential &&
    'response' in credential &&
    'getClientExtensionResults' in credential
  );
}

/**
 * Lets a timer or channel stop holding a Node process open. Browsers have no
 * such thing, and their timers are numbers.
 */
export function unref(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null || !('unref' in handle)) return;
  const { unref: release } = handle;
  if (typeof release === 'function') Reflect.apply(release, handle, []);
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
 * Whether a value this node read back from its own storage is an expression.
 * Checks only that it is an object with a string id: what arrives from a peer
 * goes through the validation gates, not this.
 */
export function isStoredExpression(value: unknown): value is Expression {
  return isObject(value) && typeof value.id === 'string';
}
