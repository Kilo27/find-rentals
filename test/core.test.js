import test from "node:test";
import assert from "node:assert/strict";
import { haversineKm } from "../src/geo.js";
import { DEFAULT_CONFIG, ConfigError, normalizeConfig } from "../src/config.js";
import { buildPayload, fetchSection, normalizeListing, parsePriceMonthly, shapeIdFor } from "../src/daft.js";
import { evaluateListing } from "../src/filter.js";
import { UL, gatewayResponse, httpError, kmNorth, makeFetch, rawListing } from "./helpers.js";

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

test("daft: radius maps to the smallest covering stored shape", () => {
  assert.equal(shapeIdFor("4342", 0.5), "4342_1000");
  assert.equal(shapeIdFor("4342", 2), "4342_3000");
  assert.equal(shapeIdFor("4342", 3), "4342_3000");
  assert.equal(shapeIdFor("4342", 4), "4342_5000");
  assert.equal(shapeIdFor("4342", 20), "4342_20000");
});

test("daft: owner-occupied server filter applies to room sections only", () => {
  const c = config();
  assert.deepEqual(buildPayload(c, "sharing").filters, [{ name: "ownerOccupied", values: [false] }]);
  assert.deepEqual(buildPayload(c, "student-accommodation-to-share").filters, [{ name: "ownerOccupied", values: [false] }]);
  assert.equal(buildPayload(c, "residential-to-rent").filters, undefined);
  assert.equal(buildPayload(config({ excludeOwnerOccupied: false }), "sharing").filters, undefined);
});

test("daft: payload matches the gateway format", () => {
  const p = buildPayload(config({ priceMin: 300, priceMax: 700, bedsMax: 3 }), "residential-to-rent", 50);
  assert.equal(p.section, "residential-to-rent");
  assert.deepEqual(p.geoFilter, { storedShapeIds: ["4342_3000"], geoSearchType: "STORED_SHAPES" });
  assert.deepEqual(p.paging, { from: "50", pagesize: "50" });
  assert.equal(p.sort, "publishDateDesc");
  assert.deepEqual(p.ranges, [
    { name: "rentalPrice", from: "300", to: "700" },
    { name: "numBeds", from: "0", to: "3" },
  ]);
  assert.equal(buildPayload(config({ bedsMax: 3 }), "sharing").ranges, undefined);
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

test("daft: fetchSection paginates and expands grouped sub-units", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => rawListing({ id: i + 1 }));
  const grouped = rawListing({ id: 900, extra: { prs: { subUnits: [{ id: 901, price: "€700 per month" }, { id: 902, price: "€800 per month" }] } } });
  const page2 = [grouped, rawListing({ id: 51 })];
  const fetchImpl = makeFetch((body) => (body.paging.from === "0" ? gatewayResponse(page1, 52) : gatewayResponse(page2, 52)));
  const r = await fetchSection(config({ maxPages: 4 }), "sharing", { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(r.listings.length, 50 + 2 + 1);
  assert.ok(r.listings.some((l) => l.id === "daft:901" && l.priceMonthly === 700));
  assert.ok(r.listings.some((l) => l.id === "daft:902" && l.priceMonthly === 800));
  assert.equal(fetchImpl.calls[0].opts.headers.brand, "daft");
});

test("daft: maxPages caps pagination", async () => {
  const fetchImpl = makeFetch(() => gatewayResponse(Array.from({ length: 50 }, (_, i) => rawListing({ id: i })), 500));
  await fetchSection(config({ maxPages: 2 }), "sharing", { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
});

test("daft: retries without server filters on a 4xx and reports degraded", async () => {
  const fetchImpl = makeFetch((body) => (body.filters ? httpError(400, "bad filter") : gatewayResponse([rawListing({ id: 1 })])));
  const r = await fetchSection(config(), "sharing", { fetchImpl });
  assert.equal(r.degraded, true);
  assert.equal(r.listings.length, 1);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].body.filters, undefined);
});

test("daft: 403 and 429 are not retried", async () => {
  for (const status of [403, 429, 500]) {
    const fetchImpl = makeFetch(() => httpError(status));
    await assert.rejects(fetchSection(config(), "sharing", { fetchImpl }), (e) => e.status === status);
    assert.equal(fetchImpl.calls.length, 1);
  }
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
