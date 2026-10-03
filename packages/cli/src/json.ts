/**
 * Reading what arrived as JSON, in the environment, or was thrown, without trusting its shape.
 */

/** An object whose fields can be read, each still unknown. Not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A Node system error's code, like `ENOENT`, or undefined for anything else */
export const errorCode = (error: unknown): unknown => (isRecord(error) ? error.code : undefined);

/** What was thrown, as a line to show */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The items of a comma separated list, like `$WEAVE_RELAYS`, trimmed, without empty ones */
export const commaList = (text = ''): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
