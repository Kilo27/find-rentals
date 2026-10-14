import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, DEFAULT_PREFS, PREF_KEYS, ConfigError, effectiveConfig, normalizeConfig, normalizePrefs, normalizeRegion } from "../src/config.js";
import { CAMPUS_DETAILS, REGION_SEEDS, campusesInRegion, regionCentre, searchCampus, searchCampuses } from "../src/catalogue.js";
import { collectionPlan } from "../src/regions.js";
import { chooseCampus, configOf, newSearch, resetWatching, updatePrefs, watchers } from "../src/searches.js";
import { haversineKm } from "../src/geo.js";
import { campusById } from "../src/transit/campuses.js";
import { UserError } from "../src/users.js";
import { tempStore } from "./helpers.js";

const limerick = () => normalizeRegion(REGION_SEEDS.limerick);

test("the UL campus in the Limerick region with today's default preferences is exactly today's default search (#12)", () => {
  assert.deepEqual(effectiveConfig(limerick(), searchCampus("ul"), DEFAULT_PREFS), normalizeConfig(DEFAULT_CONFIG));
});

test("an account's preferences are exactly the ones that are about the person, and everything else is ignored", () => {
  assert.deepEqual(Object.keys(DEFAULT_PREFS).sort(), [...PREF_KEYS].sort());
  const asked = normalizePrefs({ priceMax: "700", webUrls: ["https://evil.example/"], sources: ["web"], center: { lat: 1, lng: 1, label: "x" }, daftLocation: "dublin-city", intervalMinutes: 5, respectRobots: false, maxPages: 10, enabled: false });
  assert.deepEqual(Object.keys(asked).sort(), [...PREF_KEYS].sort());
  assert.equal(asked.priceMax, 700);
  const full = effectiveConfig(limerick(), searchCampus("ul"), asked);
  assert.deepEqual(full.webUrls, [], "page addresses are the admin's (#12)");
  assert.equal(full.respectRobots, true);
  assert.equal(full.maxPages, 4);
  assert.equal(full.enabled, true);
  assert.equal(full.center.label, "University of Limerick");
});

test("preferences are validated, with the campus's own limit on how far out to look", () => {
  assert.throws(() => normalizePrefs({ radiusKm: 99, priceMin: 900, priceMax: 100, stayUntil: "June" }), (e) => e instanceof ConfigError && e.errors.length >= 3);
  assert.throws(() => normalizePrefs({ sections: [] }), (e) => e.errors.join() === "choose at least one kind of place");
  assert.equal(normalizePrefs({ radiusKm: 5 }, { maxRadiusKm: 5 }).radiusKm, 5);
  assert.throws(() => normalizePrefs({ radiusKm: 6 }, { maxRadiusKm: 5 }), (e) => /radiusKm must be at most 5 for this campus/.test(e.errors.join()));
  assert.throws(() => normalizePrefs({ transitMaxKm: 8 }, { maxRadiusKm: 5 }), (e) => /transitMaxKm must be at most 5/.test(e.errors.join()));
  assert.equal(normalizePrefs({ radiusKm: 8 }).radiusKm, 8, "with no campus there is no campus limit");
});

test("the effective search never reaches past the campus's limit, even for a preference saved before the limit applied", () => {
  const tus = searchCampus("tus-limerick");
  const c = effectiveConfig(limerick(), tus, { ...DEFAULT_PREFS, radiusKm: 5, transitMaxKm: 5 });
  assert.equal(c.radiusKm, 4.5);
  assert.equal(c.transitMaxKm, 4.5);
});

test("a campus whose own position isn't what the transport rules would find is named to them", () => {
  const ul = effectiveConfig(limerick(), searchCampus("ul"), DEFAULT_PREFS);
  assert.deepEqual(ul.transitCampuses, [], "UL is the campus at its own centre, so nothing needs saying");
  for (const c of searchCampuses()) {
    const cfg = effectiveConfig(normalizeRegion(REGION_SEEDS[c.regionId]), c, DEFAULT_PREFS);
    assert.ok(campusById(c.id), c.id);
    assert.deepEqual(cfg.transitCampuses.length ? cfg.transitCampuses : [c.id], [c.id], `${c.id} is the campus its search is about`);
  }
});

test("region settings are validated like preferences are, and only by the admin's path", () => {
  assert.doesNotThrow(() => normalizeRegion(REGION_SEEDS.cork));
  assert.throws(() => normalizeRegion({ ...REGION_SEEDS.cork, name: " " }), /name is required/);
  assert.throws(() => normalizeRegion({ ...REGION_SEEDS.cork, daftLocation: "../admin" }), ConfigError);
  assert.throws(() => normalizeRegion({ ...REGION_SEEDS.cork, sources: [] }), /select at least one source/);
  assert.throws(() => normalizeRegion({ ...REGION_SEEDS.cork, sources: ["daft", "idealista"] }), /unknown source "idealista"/);
  assert.throws(() => normalizeRegion({ ...REGION_SEEDS.cork, rentUrls: ["http://rent.ie/x/"] }), /must be a public https/);
  assert.throws(() => normalizeRegion({ ...REGION_SEEDS.cork, intervalMinutes: 1 }), ConfigError);
  assert.equal(normalizeRegion({ ...REGION_SEEDS.cork, enabled: false, sources: [] }).enabled, false, "a region that is off needs no sites");
});

test("every campus that can be chosen is in the transport catalogue, in a region that exists, with sensible limits and hints", () => {
  const all = searchCampuses();
  assert.deepEqual(all.map((c) => c.id), Object.keys(CAMPUS_DETAILS).sort((a, b) => all.findIndex((c) => c.id === a) - all.findIndex((c) => c.id === b)));
  for (const c of all) {
    assert.ok(campusById(c.id), `${c.id} is in the transport catalogue`);
    assert.ok(REGION_SEEDS[c.regionId], `${c.id} is in a region that exists`);
    assert.ok(c.defaultRadiusKm <= c.maxRadiusKm, c.id);
    assert.ok(c.localityHints.length > 0 && c.localityHints.every((h) => h === h.toLowerCase().trim()), `${c.id} hints`);
  }
  assert.deepEqual(campusesInRegion("limerick").map((c) => c.id), ["ul", "mic", "tus-limerick"]);
  assert.deepEqual(campusesInRegion("cork").map((c) => c.id), ["ucc", "mtu-cork"]);
  assert.deepEqual(campusesInRegion("galway").map((c) => c.id), ["uog", "atu-galway"]);
  assert.equal(searchCampus("tcd"), null, "Dublin has no region yet (#28)");
  assert.deepEqual(regionCentre("cork"), { label: "University College Cork", lat: 51.8935, lng: -8.4917 }, "a region is centred on its first campus");
});

test("the Limerick search reaches every Limerick campus's furthest limit from the Daft area it is centred on", () => {
  const centre = regionCentre("limerick");
  const reach = REGION_SEEDS.limerick.radiusKm;
  for (const c of campusesInRegion("limerick")) {
    assert.ok(haversineKm(centre.lat, centre.lng, c.lat, c.lng) + c.maxRadiusKm <= reach, `${c.id}: ${haversineKm(centre.lat, centre.lng, c.lat, c.lng).toFixed(2)} km away plus ${c.maxRadiusKm} km should be within ${reach} km`);
  }
});

test("a campus's own pages are read only while somebody has chosen it", () => {
  const { store } = tempStore();
  const only = collectionPlan(store, "limerick", ["ul", "ul"]);
  assert.deepEqual(only.rentUrls, store.data.regions.limerick.rentUrls, "a search that is only for UL reads exactly what it always has");

  const both = collectionPlan(store, "limerick", ["ul", "mic"]);
  assert.ok(both.rentUrls.length > only.rentUrls.length);
  assert.ok(both.rentUrls.includes("https://www.rent.ie/houses-to-let/limerick/limerick-city-centre/"));
  assert.equal(new Set(both.rentUrls).size, both.rentUrls.length, "listed once");
  assert.deepEqual(both.ulUrls, only.ulUrls);
  for (const u of both.rentUrls) assert.match(u, /^https:\/\/www\.rent\.ie\/(houses-to-let|rooms-to-rent)\/limerick\/[a-z-]+\/$/);
});

test("an account's search: its own campus and preferences make its complete search, and none of them is shared", () => {
  const { store } = tempStore();
  const a = newSearch({ campus: "ul" });
  const b = newSearch({ campus: "ucc", prefs: { ...DEFAULT_PREFS, priceMax: 600 } });
  a.seen.x = { firstSeenAt: "2026-10-01T00:00:00Z" };
  assert.deepEqual(b.seen, {});
  assert.equal(configOf(store, a).center.label, "University of Limerick");
  assert.equal(configOf(store, b).center.label, "University College Cork");
  assert.equal(configOf(store, b).priceMax, 600);
  assert.equal(configOf(store, a).priceMax, null);
  assert.equal(configOf(store, newSearch()), null, "no campus, no search");
  store.data.regions.cork.enabled = false;
  assert.equal(configOf(store, b).enabled, false, "a region that is switched off is paused for everyone in it");
});

test("choosing a campus moves the account there, starts watching afresh only if the place changed, and keeps its preferences", () => {
  const search = newSearch({ campus: "ul", prefs: { ...DEFAULT_PREFS, priceMax: 600, radiusKm: 5 } });
  Object.assign(search, { baselineDone: true, baselineScans: 2, seen: { a: {} }, matches: [{ id: "a" }], reviews: { a: { status: "seen", at: "2026-10-01T00:00:00Z" } }, lastRun: { ok: true } });
  const rev = search.rev;

  assert.deepEqual({ ...chooseCampus(search, "ul"), campus: undefined }, { campus: undefined, moved: false });
  assert.equal(search.baselineDone, true);
  assert.equal(search.rev, rev);

  const { campus, moved } = chooseCampus(search, "tus-limerick");
  assert.equal(campus.id, "tus-limerick");
  assert.equal(moved, true);
  assert.deepEqual([search.seen, search.matches, search.baselineDone, search.baselineScans, search.lastRun], [{}, [], false, 0, null]);
  assert.equal(search.rev, rev + 1, "a scan already under way for the old campus can tell");
  assert.equal(search.prefs.priceMax, 600, "preferences travel");
  assert.equal(search.prefs.radiusKm, 4.5, "except that the new campus's limit applies");
  assert.deepEqual(Object.keys(search.reviews), ["a"], "verdicts are about listings, which are the same wherever you look");

  for (const bad of [undefined, null, "", "hogwarts", "tcd", 3, {}]) assert.throws(() => chooseCampus(search, bad), UserError, String(bad));
  assert.equal(search.campus, "tus-limerick");
  resetWatching(search);
  assert.equal(search.rev, rev + 2);
});

test("saving preferences turns validation failures into messages and leaves the account as it was", () => {
  const search = newSearch({ campus: "ul" });
  updatePrefs(search, { priceMax: "650", excludeKeywords: "noisy" });
  assert.equal(search.prefs.priceMax, 650);
  assert.deepEqual(search.prefs.excludeKeywords, ["noisy"]);
  const before = JSON.stringify(search.prefs);
  assert.throws(() => updatePrefs(search, { radiusKm: 6 }), (e) => e instanceof UserError && /at most 5 for this campus/.test(e.message));
  assert.throws(() => updatePrefs(search, { priceMin: 5, priceMax: 1 }), UserError);
  assert.equal(JSON.stringify(search.prefs), before);
});

test("watchers are the accounts that exist and have a campus, in a region if one is asked for", async () => {
  const { store } = tempStore();
  store.data.users.push({ username: "bob" }, { username: "carol" });
  store.data.searches.bob = newSearch({ campus: "ucc" });
  store.data.searches.carol = newSearch();
  store.data.searches.ghost = newSearch({ campus: "ul" });
  assert.deepEqual(watchers(store).map((w) => w.owner), ["@admin", "bob"], "carol has no campus and ghost is no account");
  assert.deepEqual(watchers(store, "cork").map((w) => w.owner), ["bob"]);
  assert.deepEqual(watchers(store, "galway"), []);
});
