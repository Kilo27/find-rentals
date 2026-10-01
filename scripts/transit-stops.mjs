// Prints the stops that go on to a campus, with coordinates.
//
//   npm run stops -- ul                 every route to the University of Limerick
//   npm run stops -- ul 304 304A 310    just those routes
//   npm run stops -- --list             the campus ids
//   npm run stops -- ul --csv           as CSV (route, stop code, name, latitude, longitude, trips per weekday, minutes)
import { createTransit } from "../src/transit.js";
import { CAMPUSES } from "../src/transit/campuses.js";
import fs from "node:fs";

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("--"));
const [campusId, ...labels] = argv.filter((a) => !a.startsWith("--"));

if (!campusId || flags.includes("--list")) {
  for (const c of CAMPUSES) console.log(`${c.id.padEnd(26)} ${c.name}`);
  process.exit(campusId || flags.includes("--list") ? 0 : 1);
}

const data = JSON.parse(fs.readFileSync(new URL("../src/transit/data.json", import.meta.url), "utf8"));
const result = createTransit(data).stopsFor(campusId);
if (!result) {
  console.error(`unknown campus "${campusId}" (npm run stops -- --list)`);
  process.exit(1);
}

const routes = result.routes.filter((r) => !labels.length || labels.some((l) => l.toLowerCase() === r.label.toLowerCase()));
if (flags.includes("--csv")) {
  console.log("route,operator,stop_code,stop_name,latitude,longitude,trips_per_weekday,minutes_to_campus");
  for (const r of routes) for (const s of r.stops) console.log([r.label, r.operator, s.code, `"${s.name.replaceAll('"', '""')}"`, s.lat, s.lng, s.perDay, s.mins ?? ""].join(","));
} else {
  console.log(`${result.campus.name}  (${result.campus.lat}, ${result.campus.lng})`);
  for (const r of routes) {
    console.log(`\n${r.label}  ${r.operator} ${r.mode}  ${r.name}  - ${r.stops.length} stops heading to ${result.campus.short}`);
    for (const s of r.stops) {
      console.log(`  ${String(s.code).padEnd(7)} ${s.name.padEnd(26)} ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}  ${String(s.perDay).padStart(3)}/weekday  ${s.mins === null ? "" : `${s.mins} min`}`);
    }
  }
}
