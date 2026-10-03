import { hash } from './hash';

/**
 * An account's avatar as data: a hue and the cells of a 5×5 grid, from its
 * DID, so every app (and the extension) draws the same one. Mirrored down the
 * middle, the way identicons have always been, so it reads as a face.
 */
export function avatarCells(did: string): { hue: number; cells: Array<{ x: number; y: number }> } {
  const seed = hash(did);
  const cells: Array<{ x: number; y: number }> = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if (((seed >> (x * 5 + y)) & 1) === 0) continue;
      cells.push({ x, y });
      if (x < 2) cells.push({ x: 4 - x, y });
    }
  }
  return { hue: seed % 360, cells };
}
