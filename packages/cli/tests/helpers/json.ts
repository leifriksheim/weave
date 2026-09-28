/** Reads a field deep inside parsed JSON, or undefined where the path isn't there */
export function at(value: unknown, ...path: ReadonlyArray<string | number>): unknown {
  let here = value;
  for (const key of path)
    here = typeof here === 'object' && here !== null ? Reflect.get(here, key) : undefined;
  return here;
}

/** The address a fake `fetch` was asked for */
export const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : String(input);

/** The body a fake `fetch` was sent; every caller here sends a string */
export const bodyOf = (init?: RequestInit): string => (typeof init?.body === 'string' ? init.body : '');
