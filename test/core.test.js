import test from "node:test";
import assert from "node:assert/strict";
import { haversineKm } from "../src/geo.js";
import { DEFAULT_CONFIG, ConfigError, normalizeConfig } from "../src/config.js";
import { fetchSection, normalizeListing, parsePriceMonthly, parseSearchPage, radiusParam, searchUrl } from "../src/daft.js";
import { createFetcher } from "../src/html.js";
import { evaluateListing } from "../src/filter.js";
import { UL, daftPage, daftQuery, httpError, kmNorth, makeFetch, noSleep, rawListing } from "./helpers.js";

const config = (over = {}) => normalizeConfig({ ...DEFAULT_CONFIG, ...over });

test("haversine: one degree of latitude is ~111 km", () => {
  assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111.19) < 0.1);
  assert.equal(haversineKm(UL.lat, UL.lng, UL.lat, UL.lng), 0);
});

test("config: defaults describe the UL brief", () => {
  const c = config();
  assert.equal(c.radiusKm, 2);
  assert.equal(c.center.label, "University of Limerick");
  assert.equal(c.excludeOwnerOccupied, true);
  assert.equal(c.stayUntil, "2027-06-30");
  assert.equal(c.needFrom, "");
  assert.equal(c.intervalMinutes, 30);
  assert.deepEqual(c.sections.sort(), ["residential-to-rent", "sharing", "student-accommodation-to-share"]);
});

test("config: form-style inputs are coerced; blanks become null", () => {
  const c = config({ radiusKm: "3.5", priceMax: "800", priceMin: "", bedsMin: "", excludeKeywords: "Owner Occupied,\n Live-in landlord " });
  assert.equal(c.radiusKm, 3.5);
  assert.equal(c.priceMax, 800);
  assert.equal(c.priceMin, null);
  assert.equal(c.bedsMin, null);
  assert.deepEqual(c.excludeKeywords, ["owner occupied", "live-in landlord"]);
});

test("config: invalid values are all reported", () => {
  assert.throws(
    () => config({ radiusKm: 99, priceMin: 900, priceMax: 100, stayUntil: "June", sections: [], intervalMinutes: 1 }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.errors.length >= 5, err.errors.join(" | "));
      return true;
    },
  );
  assert.throws(() => config({ needFrom: "2027-07-01", stayUntil: "2027-06-30" }), ConfigError);
});

const daftFetcher = (fetchImpl) => createFetcher({ fetchImpl, sleep: noSleep, politenessMs: 0, respectRobots: false });

test("config: the Daft area must look like a Daft URL name; a saved legacy location ID falls back to the default", () => {
  assert.equal(config({ daftLocation: " Castletroy-Limerick " }).daftLocation, "castletroy-limerick");
  assert.throws(() => config({ daftLocation: "../admin" }), ConfigError);
  assert.throws(() => config({ daftLocation: "" }), ConfigError);
  const legacy = normalizeConfig({ daftLocationId: "4342" });
  assert.equal(legacy.daftLocation, "university-of-limerick-limerick");
  assert.equal(legacy.daftLocationId, undefined);
});

test("daft: radius maps to the smallest covering stored radius", () => {
  assert.equal(radiusParam(0.5), 1000);
  assert.equal(radiusParam(2), 3000);
  assert.equal(radiusParam(3), 3000);
  assert.equal(radiusParam(4), 5000);
  assert.equal(radiusParam(20), 20000);
});

test("daft: owner-occupied server filter applies to room sections only", () => {
  const owner = (cfg, section) => new URL(searchUrl(cfg, section)).searchParams.get("ownerOccupied");
  assert.equal(owner(config(), "sharing"), "false");
  assert.equal(owner(config(), "student-accommodation-to-share"), "false");
  assert.equal(owner(config(), "residential-to-rent"), null);
  assert.equal(owner(config({ excludeOwnerOccupied: false }), "sharing"), null);
});

test("daft: search URL matches Daft's website format", () => {
  const u = new URL(searchUrl(config({ priceMin: 300, priceMax: 700, bedsMax: 3, leaseMinMonths: 6 }), "residential-to-rent", 3));
  assert.equal(u.origin + u.pathname, "https://www.daft.ie/property-for-rent/university-of-limerick-limerick");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    radius: "3000",
    sort: "publishDateDesc",
    page: "3",
    rentalPrice_from: "300",
    rentalPrice_to: "700",
    numBeds_to: "3",
    leaseLength_from: "6",
  });
  const sharing = new URL(searchUrl(config({ bedsMax: 3 }), "sharing"));
  assert.equal(sharing.pathname, "/sharing/university-of-limerick-limerick");
  assert.equal(sharing.searchParams.get("numBeds_to"), null, "beds only filter houses & apartments");
  assert.equal(sharing.searchParams.get("page"), null, "page 1 is the bare search URL");
});

test("daft: parseSearchPage reads the Next.js page data and rejects anything else", () => {
  assert.equal(parseSearchPage(daftPage([rawListing({ id: 1 })])).listings.length, 1);
  assert.equal(parseSearchPage("<html><title>Security Check | Daft</title></html>"), null);
  assert.equal(parseSearchPage('<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>'), null);
  assert.equal(parseSearchPage('<script id="__NEXT_DATA__" type="application/json">{not json</script>'), null);
});

test("daft: fetchSection pages by page number and expands grouped sub-units", async () => {
  const page1 = Array.from({ length: 20 }, (_, i) => rawListing({ id: i + 1 }));
  const grouped = rawListing({ id: 900, extra: { prs: { subUnits: [{ id: 901, price: "€700 per month" }, { id: 902, price: "€800 per month" }] } } });
  const page2 = [grouped, rawListing({ id: 21 })];
  const fetchImpl = makeFetch((q) => (q.page === 1 ? daftPage(page1, 22) : daftPage(page2, 22)));
  const r = await fetchSection(config({ maxPages: 4 }), "sharing", { fetcher: daftFetcher(fetchImpl) });
  assert.deepEqual(fetchImpl.calls.map((c) => daftQuery(c.url).page), [1, 2]);
  assert.equal(r.total, 22);
  assert.equal(r.listings.length, 20 + 2 + 1);
  assert.ok(r.listings.some((l) => l.id === "daft:901" && l.priceMonthly === 700));
  assert.ok(r.listings.some((l) => l.id === "daft:902" && l.priceMonthly === 800));
});

test("daft: paging stops when Daft answers with page 1 again (it ignores paging it doesn't understand)", async () => {
  const items = Array.from({ length: 20 }, (_, i) => rawListing({ id: i }));
  const fetchImpl = makeFetch(() => daftPage(items, 80, { paging: { totalResults: 80, currentPage: 1 } }));
  const r = await fetchSection(config({ maxPages: 4 }), "sharing", { fetcher: daftFetcher(fetchImpl) });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(r.listings.length, 20, "the repeated page is not counted twice");
});

test("daft: maxPages caps pagination", async () => {
  const fetchImpl = makeFetch(() => daftPage(Array.from({ length: 20 }, (_, i) => rawListing({ id: i })), 500));
  await fetchSection(config({ maxPages: 2 }), "sharing", { fetcher: daftFetcher(fetchImpl) });
  assert.equal(fetchImpl.calls.length, 2);
});

test("daft: a refused page fails with its status and the start of the page", async () => {
  const fetchImpl = makeFetch(() => httpError(403, "<html><head><title>Security Check | Daft</title></head></html>"));
  await assert.rejects(
    fetchSection(config(), "sharing", { fetcher: daftFetcher(fetchImpl) }),
    (e) => e.status === 403 && /HTTP 403 from www\.daft\.ie/.test(e.message) && /Security Check/.test(e.body),
  );
});

test("daft: a page without listing data fails closed and names the page", async () => {
  const fetchImpl = makeFetch(() => "<html><head><title>Just a moment...</title></head><body></body></html>");
  await assert.rejects(fetchSection(config(), "sharing", { fetcher: daftFetcher(fetchImpl) }), /no listing data .*Just a moment/);
});

test("daft: an area Daft doesn't recognise is an error, not a search of all of Ireland", async () => {
  const fallback = makeFetch(() => daftPage([rawListing({ id: 1 })], 2523, { canonicalUrl: "https://www.daft.ie/sharing/ireland" }));
  await assert.rejects(
    fetchSection(config({ daftLocation: "nowhere-limerick" }), "sharing", { fetcher: daftFetcher(fallback) }),
    /doesn't recognise the area "nowhere-limerick"/,
  );
  const known = makeFetch(() => daftPage([rawListing({ id: 1 })], 1, { canonicalUrl: "https://www.daft.ie/sharing/university-of-limerick-limerick" }));
  assert.equal((await fetchSection(config(), "sharing", { fetcher: daftFetcher(known) })).listings.length, 1);
});

test("daft: price parsing handles weekly, ranges of text and POA", () => {
  assert.equal(parsePriceMonthly("€650 per month"), 650);
  assert.equal(parsePriceMonthly("€1,250 per month"), 1250);
  assert.equal(parsePriceMonthly("€150 per week"), 650);
  assert.equal(parsePriceMonthly("From €900 per month"), 900);
  assert.equal(parsePriceMonthly("Price on Application"), null);
  assert.equal(parsePriceMonthly(undefined), null);
});

test("daft: normalizeListing extracts fields", () => {
  const n = normalizeListing(rawListing({ id: 7, km: 1.5, extra: { ownerOccupied: true } }).listing, "sharing");
  assert.equal(n.id, "daft:7");
  assert.equal(n.source, "daft");
  assert.equal(n.kind, "room");
  assert.equal(n.url, "https://www.daft.ie/share/room-7/7");
  assert.equal(n.priceMonthly, 650);
  assert.equal(n.beds, 1);
  assert.equal(n.ownerOccupied, true);
  assert.equal(n.image, "https://media.example/7.jpg");
  assert.ok(Math.abs(haversineKm(UL.lat, UL.lng, n.lat, n.lng) - 1.5) < 0.01);
  assert.equal(normalizeListing({ title: "no id" }, "sharing"), null);
});

test("daft: nested ownerOccupied field is detected, absent is null", () => {
  assert.equal(normalizeListing({ id: 1, sharing: { ownerOccupied: "Yes" } }, "sharing").ownerOccupied, true);
  assert.equal(normalizeListing({ id: 1, sharing: { owner_occupied: false } }, "sharing").ownerOccupied, false);
  assert.equal(normalizeListing({ id: 1 }, "sharing").ownerOccupied, null);
});

const ev = (over, cfg) => {
  const l = normalizeListing(rawListing(over).listing, over.section ?? "sharing");
  return evaluateListing(l, config(cfg));
};

test("filter: distance is enforced exactly", () => {
  assert.equal(ev({ km: 1.9 }).ok, true);
  const far = ev({ km: 2.1 });
  assert.equal(far.ok, false);
  assert.equal(far.reason, "too far");
  assert.equal(ev({ km: 2.1 }, { radiusKm: 3 }).ok, true);
  const d = ev({ km: 1 }).distanceKm;
  assert.ok(Math.abs(d - 1) < 0.01);
});

test("filter: listings without coordinates follow the unverified-distance policy", () => {
  const mk = (title) => normalizeListing({ id: 5, title, price: "€500 per month" }, "sharing");
  const nearby = mk("Room in Castletroy, Co. Limerick");
  const r = evaluateListing(nearby, config());
  assert.equal(r.ok, true);
  assert.ok(r.flags.includes("distance-unverified"));
  assert.equal(evaluateListing(mk("Room in Ennis"), config()).reason, "no location");
  assert.equal(evaluateListing(mk("Room in Ennis"), config({ unverifiedDistance: "include" })).ok, true);
  assert.equal(evaluateListing(nearby, config({ unverifiedDistance: "exclude" })).reason, "no location");
});

test("filter: locality hints match the address or title only, never marketing text", () => {
  const mk = (title, text) => ({ ...normalizeListing({ id: 9, title, price: "€500 per month", description: text }, "sharing") });
  assert.equal(evaluateListing(mk("Mystery Place", "5 min from UL, close to Castletroy"), config()).reason, "no location");
  assert.equal(evaluateListing(mk("Room on Plassey Road", ""), config()).ok, true);
  assert.ok(!config().localityHints.includes("university of limerick"));
});

test("filter: owner-occupied by field, keyword, and when toggled off", () => {
  assert.equal(ev({ extra: { ownerOccupied: true } }).reason, "owner occupied");
  assert.match(ev({ title: "Double room, owner-occupied house" }).reason, /owner occupied/);
  assert.match(ev({ title: "Live-in landlord, quiet house" }).reason, /owner occupied/);
  assert.equal(ev({ extra: { ownerOccupied: true } }, { excludeOwnerOccupied: false }).ok, true);
  assert.equal(ev({ title: "Owner occupied room" }, { excludeOwnerOccupied: false }).ok, true);
});

test("filter: custom exclude/include keywords", () => {
  assert.equal(ev({ title: "Room with smoking allowed" }, { excludeKeywords: ["smoking"] }).ok, false);
  assert.equal(ev({ title: "Quiet room" }, { includeKeywords: ["ensuite"] }).ok, false);
  assert.equal(ev({ title: "Ensuite room" }, { includeKeywords: ["ensuite"] }).ok, true);
});

test("filter: price and beds (beds only for whole properties)", () => {
  assert.equal(ev({ price: "€900 per month" }, { priceMax: 800 }).reason, "above max price");
  assert.equal(ev({ price: "€100 per week" }, { priceMax: 800 }).ok, true);
  assert.equal(ev({ price: "Price on Application" }, { priceMax: 800 }).ok, true);
  assert.equal(ev({ section: "residential-to-rent" }, { bedsMin: 2 }).reason, "too few beds");
  assert.equal(ev({ section: "sharing" }, { bedsMin: 2 }).ok, true);
});

test("filter: flags short-term wording and unknown owner-occupancy", () => {
  const r = ev({ title: "Room available until June, short term OK" });
  assert.ok(r.flags.includes("short-term"));
  assert.ok(r.flags.includes("owner-occupied-unknown"));
  assert.ok(!ev({ section: "residential-to-rent" }).flags.includes("owner-occupied-unknown"));
  assert.ok(!ev({ extra: { ownerOccupied: false } }).flags.includes("owner-occupied-unknown"));
});

test("sanity: kmNorth helper", () => {
  const p = kmNorth(2);
  assert.ok(Math.abs(haversineKm(UL.lat, UL.lng, p.lat, p.lng) - 2) < 0.001);
});

import { makeListing } from "../src/listing.js";

test("makeListing never accepts 0,0 or non-finite values as a location", () => {
  const base = { source: "x", sourceLabel: "X", externalId: "1", url: "https://x.ie/1", title: "T" };
  assert.equal(makeListing({ ...base, lat: 0, lng: 0 }).lat, null);
  assert.equal(makeListing({ ...base, lat: NaN, lng: -8.5 }).lat, null);
  assert.equal(makeListing({ ...base, lat: 52.67, lng: -8.57 }).distanceSource, "source");
});
