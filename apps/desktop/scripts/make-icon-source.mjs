import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const SIZE = 1024;
const INSET = 96;
const RADIUS = 220;
const [R, G, B] = [0x6a, 0xe3, 0x01];

function inside(x, y) {
  if (x < INSET || y < INSET || x >= SIZE - INSET || y >= SIZE - INSET) return false;
  const cx =
    x < INSET + RADIUS
      ? INSET + RADIUS
      : x >= SIZE - INSET - RADIUS
        ? SIZE - INSET - RADIUS - 1
        : x;
  const cy =
    y < INSET + RADIUS
      ? INSET + RADIUS
      : y >= SIZE - INSET - RADIUS
        ? SIZE - INSET - RADIUS - 1
        : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2;
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 4);
  raw[row] = 0;
  for (let x = 0; x < SIZE; x++) {
    const i = row + 1 + x * 4;
    if (inside(x, y)) {
      raw[i] = R;
      raw[i + 1] = G;
      raw[i + 2] = B;
      raw[i + 3] = 255;
    }
  }
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "icon-source.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
