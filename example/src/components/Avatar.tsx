/**
 * A visual fingerprint for an account.
 *
 * Derived from the DID, so it is the same everywhere the account appears and
 * needs nothing stored. The point is recognition rather than decoration: with
 * several accounts in one folder, a wrong one should be obvious before you have
 * read the name.
 */

/** A small deterministic hash, enough to seed a 5×5 pattern and a hue. */
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function Avatar({ did, size = 32 }: { did: string; size?: number }) {
  const seed = hash(did);
  const hue = seed % 360;
  const ink = `hsl(${hue} 62% 48%)`;
  const paper = `hsl(${hue} 46% 92%)`;

  // Mirrored down the middle, the way identicons have always been, so the
  // shape reads as a face rather than as noise.
  const cells: Array<{ x: number; y: number }> = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if (((seed >> (x * 5 + y)) & 1) === 0) continue;
      cells.push({ x, y });
      if (x < 2) cells.push({ x: 4 - x, y });
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      role="img"
      aria-label="Account avatar"
      style={{ borderRadius: size / 4, background: paper, flexShrink: 0, display: 'block' }}
    >
      {cells.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={ink} />
      ))}
    </svg>
  );
}
