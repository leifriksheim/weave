/**
 * A small deterministic hash (32-bit FNV-1a), enough to seed a pattern or a
 * hue, so something derived from an id looks the same everywhere it appears.
 */
export function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
