/** Whether a value is an object whose fields can be read: for narrowing parsed JSON. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
