import fs from "node:fs";
import zlib from "node:zlib";

const BG = [15, 118, 110];
const FG = [255, 255, 255];

function inHouse(x, y) {
  // x, y in 0..1
  const roof = y >= 0.26 && y <= 0.5 && Math.abs(x - 0.5) <= ((y - 0.26) / 0.24) * 0.3;
  const body = x >= 0.3 && x <= 0.7 && y > 0.48 && y <= 0.74;
  return roof || body;
}
function inDoor(x, y) {
  return x >= 0.45 && x <= 0.55 && y >= 0.6 && y <= 0.74;
}

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 3;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (inHouse(x, y) && !inDoor(x, y)) fg++;
        }
      }
      const a = fg / (SS * SS);
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
      raw[o + 3] = 255;
    }
  }
  return raw;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(render(size))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync("public/icons", { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  fs.writeFileSync(`public/icons/${name}`, png(size));
  console.log("wrote", name);
}
