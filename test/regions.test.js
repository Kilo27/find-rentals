import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { searchUrl } from "../src/daft.js";
import { campusById } from "../src/transit/campuses.js";
import { REGIONS, campusConfig, regionConfig } from "../scripts/lib/regions.mjs";

const ids = Object.keys(REGIONS);

test("every region preset is a valid config", () => {
  for (const id of ids) assert.doesNotThrow(() => normalizeConfig(regionConfig(id)), `region ${id}`);
});

test("the Limerick preset is today's default search", () => {
  assert.deepEqual(normalizeConfig(regionConfig("limerick")), normalizeConfig(DEFAULT_CONFIG));
});

test("a region's campuses exist, belong to that region and the first one is the search centre", () => {
  for (const id of ids) {
    const { name, campuses } = REGIONS[id];
    for (const c of campuses) assert.equal(campusById(c)?.region, name, `${c} in ${id}`);
    const lead = campusById(campuses[0]);
    assert.deepEqual(regionConfig(id).center, { label: lead.name, lat: lead.lat, lng: lead.lng });
  }
  assert.deepEqual(REGIONS.cork.campuses, ["ucc", "mtu-cork"]);
  assert.deepEqual(REGIONS.galway.campuses, ["uog", "atu-galway"]);
});

test("Cork and Galway have no UL accommodation board and read only Daft, Rent.ie and MyHome", () => {
  for (const id of ["cork", "galway"]) {
    const c = normalizeConfig(regionConfig(id));
    assert.deepEqual(c.sources, ["daft", "rent", "myhome"]);
    assert.deepEqual(c.ulUrls, []);
    assert.notEqual(c.daftLocation, DEFAULT_CONFIG.daftLocation);
  }
});

test("Rent.ie and MyHome pages stay in the region's county and are listed once", () => {
  for (const id of ["cork", "galway"]) {
    const c = normalizeConfig(regionConfig(id));
    assert.equal(new Set(c.rentUrls).size, c.rentUrls.length, `${id} rent duplicates`);
    for (const u of c.rentUrls) assert.match(u, new RegExp(`^https://www\\.rent\\.ie/(houses-to-let|rooms-to-rent)/${id}/[a-z-]+/$`));
    assert.ok(c.rentUrls.some((u) => u.includes("/houses-to-let/")) && c.rentUrls.some((u) => u.includes("/rooms-to-rent/")));
    assert.deepEqual(c.myhomeUrls, [`https://www.myhome.ie/rentals/${id}/property-to-rent`]);
  }
});

test("a Cork or Galway search asks Daft for its city area at 5 km, which covers both campuses", () => {
  for (const [id, area] of [["cork", "cork-city"], ["galway", "galway-city"]]) {
    const url = new URL(searchUrl(normalizeConfig(regionConfig(id)), "sharing"));
    assert.equal(url.pathname, `/sharing/${area}`);
    assert.equal(url.searchParams.get("radius"), "5000");
  }
});

test("the probe names the known regions when given an unknown one, without touching the network", () => {
  const r = spawnSync(process.execPath, ["scripts/probe-sources.mjs", "--region=nowhere"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown region "nowhere"/);
  for (const id of ids) assert.ok(r.stderr.includes(id));
});

test("an unknown region throws from regionConfig", () => {
  assert.throws(() => regionConfig("nowhere"), /unknown region "nowhere"/);
});

test("the probe can check a campus: its region's pages plus the campus's own", () => {
  const mic = normalizeConfig(campusConfig("mic"));
  assert.equal(mic.center.label, "Mary Immaculate College");
  assert.equal(mic.daftLocation, DEFAULT_CONFIG.daftLocation, "the same Daft area as the rest of Limerick");
  assert.ok(mic.rentUrls.includes(DEFAULT_CONFIG.rentUrls[0]), "the region's pages");
  assert.ok(mic.rentUrls.includes("https://www.rent.ie/houses-to-let/limerick/limerick-city-centre/"), "and the campus's own");
  assert.equal(new Set(mic.rentUrls).size, mic.rentUrls.length);
  assert.deepEqual(normalizeConfig(campusConfig("ul")).rentUrls, DEFAULT_CONFIG.rentUrls, "UL has no pages of its own beyond the region's");
});

test("the probe names the known campuses when given an unknown one, without touching the network", () => {
  const r = spawnSync(process.execPath, ["scripts/probe-sources.mjs", "--campus=nowhere"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown campus "nowhere"/);
  for (const id of ["ul", "mic", "tus-limerick", "ucc", "mtu-cork", "uog", "atu-galway"]) assert.ok(r.stderr.includes(id), id);
});
