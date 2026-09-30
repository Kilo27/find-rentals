// Live check of every scraper: node scripts/probe-sources.mjs [daft|ul|rent|myhome|web ...] [--url=https://...]
// Prints what each source recognised so selector/markup problems are obvious. Nothing is saved or notified.
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { createFetcher } from "../src/html.js";
import { ADAPTERS } from "../src/sources/index.js";
import { analyzeListing, evaluateNonLocation } from "../src/filter.js";

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith("--url="))?.slice(6);
const wanted = args.filter((a) => !a.startsWith("--"));
const ids = wanted.length ? wanted : ["daft", "ul", "rent", "myhome"];

const config = normalizeConfig({
  ...DEFAULT_CONFIG,
  sources: ids,
  ...(urlArg ? { webUrls: [urlArg], sources: ["web"] } : {}),
});
const now = new Date();

for (const id of urlArg ? ["web"] : ids) {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    console.log(`\n== ${id}: unknown source`);
    continue;
  }
  console.log(`\n== ${adapter.label} (${id})`);
  const deps = {
    fetchImpl: fetch,
    fetcher: createFetcher({ respectRobots: config.respectRobots }),
    cache: {},
    budget: { detail: 3, geocode: 0, exhausted: false },
    now: () => Date.now(),
  };
  let result;
  try {
    result = await adapter.fetch(config, deps);
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
    for (const n of err.notes ?? []) console.log("  note:", JSON.stringify({ ...n, debug: undefined }));
    continue;
  }
  for (const n of result.notes) {
    const { debug, ...rest } = n;
    console.log("  page:", JSON.stringify(rest));
    if (debug?.head) console.log("  html head (nothing recognised):", debug.head);
    if (debug) console.log(`  bytes=${debug.bytes ?? "?"} cards=${debug.cards ?? "?"} structured=${debug.structured ?? "?"}`);
  }
  console.log(`  ${result.listings.length} listing(s); showing up to 5:`);
  for (const l of result.listings.slice(0, 5)) {
    analyzeListing(l, now);
    const ev = evaluateNonLocation(l, config, now);
    console.log(
      `   - ${l.title.slice(0, 70)} | ${l.priceText || "no price"} | coords=${l.lat !== null ? `${l.lat.toFixed(4)},${l.lng.toFixed(4)}` : "none"}` +
        ` | avail=${l.availableFrom ?? "?"}${l.availableTo ? `..${l.availableTo}` : ""} | owner=${l.ownerOccupied ?? l.ownerOccupiedText ?? "?"}` +
        ` | weekdayOnly=${l.weekdayOnly} | pending=${l.pending} | filter=${ev.ok ? "pass" : ev.reason}\n     ${l.url}`,
    );
  }
}
