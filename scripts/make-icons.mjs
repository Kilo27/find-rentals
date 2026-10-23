import fs from "node:fs";
import zlib from "node:zlib";

// The Home Screen icon: a column of ads in newsprint on ink, one line gone over with the highlighter, as the app marks
// what's new. Everything sits inside the middle 80%, so Android can crop it to any shape (the icon is also "maskable").
const INK = [20, 20, 20];
const PAPER = [240, 239, 234];
const HIGHLIGHT = [247, 233, 51];

const LINE = 0.034; // half the thickness of a line of type
const LEFT = 0.25;
const LINES = [
  { y: 0.33, to: 0.75 },
  { y: 0.45, to: 0.63, marked: true },
  { y: 0.57, to: 0.75 },
  { y: 0.69, to: 0.55 },
];

// A line of type: a bar with round ends.
function onLine(x, y, line) {
  const dx = x < LEFT ? LEFT - x : x > line.to ? x - line.to : 0;
  const dy = y - line.y;
  return dx * dx + dy * dy <= LINE * LINE;
}

// The highlighter's stroke: a band leaning forward and climbing a little to the right, as a hand draws it.
function inSwipe(x, y) {
  const rise = (x - 0.2) * 0.04;
  const top = 0.388 - rise;
  const bottom = 0.514 - rise;
  if (y < top || y > bottom) return false;
  // The chisel tip leaves slightly slanted ends.
  const lean = (bottom - y) * 0.1;
  return x >= 0.2 + lean && x <= 0.685 + lean;
}

function colourAt(x, y) {
  const marked = LINES.find((l) => l.marked);
  if (onLine(x, y, marked)) return INK;
  if (inSwipe(x, y)) return HIGHLIGHT;
  if (LINES.some((l) => !l.marked && onLine(x, y, l))) return PAPER;
  return INK;
}

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colourAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          for (let i = 0; i < 3; i++) sum[i] += c[i];
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(sum[i] / (SS * SS));
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

// Provenance, kept in the file: drawn by this script, not generated or sourced.
const ORIGIN = "Drawn by scripts/make-icons.mjs (ASAP accommodation): a highlighted line in a column of ads.";

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from(`Source\0${ORIGIN}`, "latin1")),
    chunk("IDAT", zlib.deflateSync(render(size))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync("public/icons", { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  fs.writeFileSync(`public/icons/${name}`, png(size));
  console.log("wrote", name);
}
