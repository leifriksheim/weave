/**
 * Draws the toolbar and store icons: the home's "W" in white on a black
 * rounded square. Run once after changing the drawing: `npm run icons`.
 * No image library — a signed-distance raster and a PNG writer are enough.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const PATH = [[2, 5], [7, 15], [10, 8], [13, 15], [18, 5]]; // the wordmark, in a 20×20 box

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const stroke = size <= 16 ? 2.6 : size <= 32 ? 2.4 : 2.2; // in 20-unit space: thicker when small
  const inset = size * 0.14;
  const scale = (size - 2 * inset) / 20;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // Rounded square: coverage from the distance to its edge.
      const qx = Math.max(Math.abs(cx - size / 2) - (size / 2 - radius), 0);
      const qy = Math.max(Math.abs(cy - size / 2) - (size / 2 - radius), 0);
      const square = Math.max(0, Math.min(1, radius - Math.hypot(qx, qy) + 0.5));
      // The W: coverage from the distance to the polyline, in pixels.
      const ux = (cx - inset) / scale, uy = (cy - inset) / scale + 0.5;
      let d = Infinity;
      for (let i = 0; i < PATH.length - 1; i++) d = Math.min(d, distanceToSegment(ux, uy, PATH[i], PATH[i + 1]));
      const ink = Math.max(0, Math.min(1, (stroke / 2 - d) * scale + 0.5));
      const v = Math.round(255 * ink);
      const i = (y * size + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
      pixels[i + 3] = Math.round(255 * square);
    }
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(new URL('static/icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(new URL(`static/icons/${size}.png`, import.meta.url), png(size, draw(size)));
}
console.log('Icons written to static/icons/');
