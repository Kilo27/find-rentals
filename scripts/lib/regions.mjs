// The regions and campuses live in src/catalogue.js; this reads them for `npm run probe -- --region=cork` and
// `--campus=mic`, which check a region's or a campus's sources the way the scanner would. Limerick is today's search;
// Cork and Galway are the January 2027 pilot (#26).
import { DEFAULT_PREFS, effectiveConfig } from "../../src/config.js";
import { REGION_SEEDS, campusesInRegion, searchCampus } from "../../src/catalogue.js";

export const REGIONS = Object.fromEntries(
  Object.entries(REGION_SEEDS).map(([id, seed]) => [id, { name: seed.name, campuses: campusesInRegion(id).map((c) => c.id), config: seed }]),
);

// The search for a campus with default preferences: its region's settings and its own extra pages.
export function campusConfig(campusId) {
  const campus = searchCampus(campusId);
  if (!campus) throw new Error(`unknown campus "${campusId}" (known: ${Object.values(REGIONS).flatMap((r) => r.campuses).join(", ")})`);
  const region = REGION_SEEDS[campus.regionId];
  const config = effectiveConfig(region, campus, DEFAULT_PREFS);
  const pages = (key) => [...new Set([...config[key], ...(campus[key] ?? [])])];
  return { ...config, ulUrls: pages("ulUrls"), rentUrls: pages("rentUrls"), myhomeUrls: pages("myhomeUrls") };
}

// The search for a region, centred on its first campus.
export function regionConfig(id) {
  const region = REGIONS[id];
  if (!region) throw new Error(`unknown region "${id}" (known: ${Object.keys(REGIONS).join(", ")})`);
  return campusConfig(region.campuses[0]);
}
