import fs from "node:fs";
import zlib from "node:zlib";
import readline from "node:readline";

// A minimal streaming zip reader: GTFS feeds hold stop_times files of hundreds of MB,
// so entries are inflated as a stream and read line by line, never as one buffer.
// Supports stored and deflated entries (all a GTFS feed uses); not ZIP64.

function readCentralDirectory(fd, size) {
  const tailLen = Math.min(size, 65_557);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function openZip(file) {
  const fd = fs.openSync(file, "r");
  const size = fs.fstatSync(fd).size;
  const entries = readCentralDirectory(fd, size);

  function stream(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`${file} has no ${name}`);
    const local = Buffer.alloc(30);
    fs.readSync(fd, local, 0, 30, e.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("corrupt zip local header");
    const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = fs.createReadStream(file, { start, end: start + e.compressedSize - 1 });
    if (e.method === 0) return raw;
    if (e.method === 8) return raw.pipe(zlib.createInflateRaw());
    throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
  }

  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    stream,
    // Yields the lines of a text entry.
    lines: (name) => readline.createInterface({ input: stream(name), crlfDelay: Infinity }),
    close: () => fs.closeSync(fd),
  };
}
