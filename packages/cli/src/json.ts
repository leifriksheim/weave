/**
 * Reading what arrived as JSON, or was thrown, without trusting its shape.
 */

/** An object whose fields can be read, each still unknown. Not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A Node system error's code, like `ENOENT`, or undefined for anything else */
export const errorCode = (error: unknown): unknown => (isRecord(error) ? error.code : undefined);
