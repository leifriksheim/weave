import { avatarCells } from './avatar-cells';

/**
 * A visual fingerprint for an account.
 *
 * Derived from the DID, so it is the same everywhere the account appears and
 * needs nothing stored. The point is recognition rather than decoration: with
 * several accounts in one folder, a wrong one should be obvious before you have
 * read the name.
 */
export function Avatar({ did, size = 32 }: { did: string; size?: number }) {
  const { hue, cells } = avatarCells(did);
  const ink = `hsl(${hue} 62% 48%)`;
  const paper = `hsl(${hue} 46% 92%)`;

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
