// Rebuilds src/transit/data.json, the list of bus, tram and train stops that go on to each university campus.
//
//   npm run transit                    download Transport for Ireland's GTFS feeds and rebuild
//   npm run transit -- --dir=./gtfs    use feed zips already in that folder (kept between runs)
//   npm run transit -- --max-km=15     keep stops up to 15 km from a campus (default 12)
//
// The feeds are ~90 MB in total and change a few times a year; the app never needs them at run time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { CAMPUSES } from "../src/transit/campuses.js";
import { buildDataset, serializeDataset } from "./lib/gtfs.mjs";
import { openZip } from "./lib/zip.mjs";

const BASE = "https://www.transportforireland.ie/transitData/Data";
const FEEDS = [
  { name: "Bus Éireann", file: "GTFS_Bus_Eireann.zip" },
  { name: "Dublin Bus", file: "GTFS_Dublin_Bus.zip" },
  { name: "Go-Ahead Ireland", file: "GTFS_GoAhead.zip" },
  { name: "Luas", file: "GTFS_LUAS.zip" },
  { name: "Irish Rail", file: "GTFS_Irish_Rail.zip" },
];

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const dir = path.resolve(args.dir ?? path.join(os.tmpdir(), "rental-watch-gtfs"));
const out = path.resolve(args.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "transit", "data.json"));
const maxKm = Number(args["max-km"] ?? 12);

fs.mkdirSync(dir, { recursive: true });

async function download(file) {
  const dest = path.join(dir, file);
  if (fs.existsSync(dest) && !args.refresh) return dest;
  console.log(`downloading ${BASE}/${file} ...`);
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${dest}.part`));
  fs.renameSync(`${dest}.part`, dest);
  console.log(`  ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB`);
  return dest;
}

const feeds = [];
const zips = [];
for (const f of FEEDS) {
  const zip = openZip(await download(f.file));
  zips.push(zip);
  feeds.push({ name: f.name, has: (n) => zip.has(n), lines: (n) => zip.lines(n) });
}

const started = Date.now();
const dataset = await buildDataset({ feeds, campuses: CAMPUSES, maxKm, log: (m) => console.log(m) });
for (const z of zips) z.close();

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, serializeDataset(dataset));
console.log(`\nwrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB) in ${Math.round((Date.now() - started) / 1000)}s\n`);
for (const c of CAMPUSES) {
  const d = dataset.campuses[c.id];
  const labels = d.routes.map((r) => r.label);
  console.log(`${c.id.padEnd(26)} ${String(d.stops.length).padStart(5)} stops  ${labels.length ? labels.slice(0, 14).join(" ") + (labels.length > 14 ? ` ... (+${labels.length - 14})` : "") : "(no direct services found)"}`);
}
