import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createScanner } from "../src/scan.js";
import { createScheduler } from "../src/scheduler.js";
import { createGeocoder, resolveArea } from "../src/geocode.js";
import { areasForMatches, createMapData } from "../src/mapdata.js";
import { OVERPASS_MIRRORS, buildRoutes, buildStops, overpass, simplify, stitch, transitBounds } from "../src/transit.js";
import { clusterSpots, pinLabel, placeMatches } from "../public/map-model.js";
import { UL, fakePusher, kmNorth, noSleep, router, tempStore } from "./helpers.js";

const way = (ref, pts, role = "") => ({ type: "way", ref, role, geometry: pts.map((p) => (p ? { lat: p[0], lon: p[1] } : null)) });
const rel = (id, tags, members) => ({ type: "relation", id, tags: { type: "route", ...tags }, members });
const node = (id, lat, lon, tags = {}) => ({ type: "node", id, lat, lon, tags });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

// --- transit: turning Overpass relations into lines ----------------------------------------------------------------

test("stitch joins segments end to end whichever way round they are drawn", () => {
  const lines = stitch([
    [[0, 0], [0, 1]],
    [[0, 2], [0, 1]],
    [[5, 5], [5, 6]],
  ]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], [[0, 0], [0, 1], [0, 2]]);
});

test("simplify drops points on a straight line but keeps corners", () => {
  const straight = [[52.67, -8.57], [52.671, -8.57], [52.672, -8.57]];
  assert.deepEqual(simplify(straight), [straight[0], straight[2]]);
  const bent = [[52.67, -8.57], [52.671, -8.57], [52.671, -8.56]];
  assert.equal(simplify(bent).length, 3);
});

test("buildRoutes: both directions of a route are one line, drawn once; platforms and out-of-box points are left out", () => {
  const w1 = way(1, [[52.673, -8.574], [52.674, -8.574]]);
  const w2 = way(2, [[52.674, -8.574], [52.675, -8.574]]);
  const outside = way(3, [null, [52.69, -8.5], [52.691, -8.5]]);
  const platform = way(4, [[52.6731, -8.5741], [52.6732, -8.5741]], "platform");
  const elements = [
    rel(10, { route: "bus", ref: "304", name: "304: City - Raheen", operator: "Bus Éireann", colour: "#f6861f" }, [w1, w2, outside, platform]),
    rel(11, { route: "bus", ref: "304", name: "304: Raheen - City", operator: "Bus Éireann" }, [w2, w1]),
    rel(12, { route: "bus", ref: "9", name: "Only a platform" }, [platform]),
  ];
  const routes = buildRoutes(elements, UL);
  assert.equal(routes.length, 1, "the platform-only relation has no line to draw");
  const r = routes[0];
  assert.equal(r.ref, "304");
  assert.equal(r.label, "City - Raheen", "the route number is stripped from the name");
  assert.equal(r.colour, "#f6861f", "a valid colour tag is kept");
  assert.equal(r.nearCentre, true);
  assert.equal(r.lines.length, 2, "the stitched way pair, and the run that survived outside the box");
  assert.deepEqual(r.lines[0], [[52.673, -8.574], [52.675, -8.574]]);
  assert.ok(r.lines.some((l) => l.length === 2 && l[0][0] === 52.69), "a way partly outside the box keeps its inside points");
});

test("buildRoutes: refless rail in opposite directions merges; colours are valid and distinct near the centre", () => {
  const a = way(1, [[52.673, -8.574], [52.674, -8.574]]);
  const elements = [
    rel(1, { route: "train", name: "Galway - Limerick", colour: "red" }, [a]),
    rel(2, { route: "train", name: "Limerick - Galway" }, [a]),
    ...["304", "305", "306", "307"].map((ref, i) => rel(20 + i, { route: "bus", ref }, [way(100 + i, [[52.673 + i * 0.0001, -8.574], [52.674 + i * 0.0001, -8.574]])])),
  ];
  const routes = buildRoutes(elements, UL);
  assert.equal(routes.filter((r) => r.mode === "rail").length, 1);
  for (const r of routes) assert.match(r.colour, /^#[0-9a-f]{6}$/i, "an invalid colour name is replaced");
  const near = routes.filter((r) => r.nearCentre).map((r) => r.colour);
  assert.equal(new Set(near).size, near.length, "routes serving the centre never share a colour");
});

test("buildStops keeps named bus stops and stations, once each", () => {
  const stops = buildStops([
    node(1, 52.67, -8.57, { highway: "bus_stop", name: "UL Main Gate" }),
    node(2, 52.67, -8.57, { highway: "bus_stop", name: "duplicate position" }),
    node(3, 52.66, -8.62, { railway: "station", name: "Limerick Colbert" }),
    { type: "way", id: 9 },
  ]);
  assert.deepEqual(stops.map((s) => [s.mode, s.name]), [["bus", "UL Main Gate"], ["rail", "Limerick Colbert"]]);
});

test("transitBounds surrounds the search circle with room to pan, capped", () => {
  const b = transitBounds(UL, 2);
  assert.ok(b.north - UL.lat > 5 / 111.19 - 1e-6 && UL.lng - b.west > 0.07);
  const huge = transitBounds(UL, 20);
  assert.ok(huge.north - UL.lat < 12.1 / 111.19);
});

// --- Overpass: flaky public servers ----------------------------------------------------------------------------------

test("overpass tries the next mirror past an HTML error page and an HTTP error, then remembers the one that worked", async () => {
  const [a, b, c] = ["https://a.test/api", "https://b.test/api", "https://c.test/api"];
  const fetchImpl = router([
    [a, () => new Response("<html>Dispatcher error</html>", { status: 200 })],
    [b, () => new Response("busy", { status: 504 })],
    [c, () => json({ elements: [{ type: "node", id: 1 }] })],
  ]);
  const preferred = { url: null };
  const out = await overpass("q", { fetchImpl, mirrors: [a, b, c], preferred });
  assert.equal(out.elements.length, 1);
  assert.equal(preferred.url, c);
  assert.match(decodeURIComponent(fetchImpl.calls[0].opts.body), /^data=q$/);
  assert.match(fetchImpl.calls[0].opts.headers["User-Agent"], /RentalWatch/);

  fetchImpl.calls.length = 0;
  await overpass("q", { fetchImpl, mirrors: [a, b, c], preferred });
  assert.equal(fetchImpl.calls[0].url, c, "the mirror that worked goes first next time");
});

test("overpass rejects partial answers and reports every mirror when all fail", async () => {
  const fetchImpl = router([
    ["https://a.test/api", () => json({ elements: [], remark: "runtime error: Query timed out" })],
    ["https://b.test/api", () => json({ nothing: true })],
  ]);
  await assert.rejects(
    overpass("q", { fetchImpl, mirrors: ["https://a.test/api", "https://b.test/api"] }),
    (err) => /a\.test: incomplete/.test(err.message) && /b\.test: no elements/.test(err.message),
  );
});

// --- the cached map background -----------------------------------------------------------------------------------------

const ROUTES = [rel(10, { route: "bus", ref: "304", name: "304: City - Raheen" }, [way(1, [[52.673, -8.574], [52.676, -8.57]])])];
const STOPS = [node(1, 52.6735, -8.573, { highway: "bus_stop", name: "UL" })];
const CAMPUS_ROW = {
  lat: "52.6732", lon: "-8.5698", name: "University of Limerick", addresstype: "amenity", category: "amenity", type: "university",
  geojson: { type: "Polygon", coordinates: [[[-8.585, 52.668], [-8.556, 52.668], [-8.556, 52.677], [-8.585, 52.668]]] },
};

function mapRoutes({ overpassOk = true } = {}) {
  return router([
    [/overpass/, (_url, opts) => {
      if (!overpassOk) return new Response("busy", { status: 504 });
      return json({ elements: decodeURIComponent(opts.body).includes("relation") ? ROUTES : STOPS });
    }],
    [/nominatim/, () => [CAMPUS_ROW]],
  ]);
}

function newMapData(fetchImpl, clock) {
  const { store } = tempStore();
  const geocoder = createGeocoder({ store, fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  const mapData = createMapData({ store, fetchImpl, geocoder, now: () => clock.t });
  return { store, mapData };
}

test("map data loads in the background, is cached, and a stale copy is shown while it refreshes", async () => {
  const fetchImpl = mapRoutes();
  const clock = { t: Date.parse("2026-10-01T12:00:00Z") };
  const { store, mapData } = newMapData(fetchImpl, clock);
  const config = store.data.config;

  const first = mapData.get(config);
  assert.equal(first.transitStatus, "loading");
  assert.equal(first.transit, null);
  await mapData.settled();

  const ready = mapData.get(config);
  assert.equal(ready.transitStatus, "ready");
  assert.equal(ready.transit.routes[0].ref, "304");
  assert.equal(ready.transit.stops.length, 1);
  assert.equal(ready.campus.length, 1);
  assert.equal(ready.campus[0].type, "Polygon");
  assert.equal(fetchImpl.count(/overpass/), 2, "one query for the routes, one for the stops");
  assert.ok(Object.keys(store.data.mapCache.transit).length === 1, "kept in the store");

  mapData.get(config);
  assert.equal(fetchImpl.count(/overpass/), 2, "a fresh copy is not fetched again");

  clock.t += 8 * 24 * 3600_000;
  const stale = mapData.get(config);
  assert.equal(stale.transitStatus, "ready", "the old lines keep showing");
  await mapData.settled();
  assert.equal(fetchImpl.count(/overpass/), 4, "and a new copy was fetched behind them");
});

test("a failed fetch is reported, not retried for ten minutes, and can be retried by hand after a short wait", async () => {
  const fetchImpl = mapRoutes({ overpassOk: false });
  const clock = { t: Date.parse("2026-10-01T12:00:00Z") };
  const { store, mapData } = newMapData(fetchImpl, clock);
  const config = store.data.config;

  mapData.get(config);
  await mapData.settled();
  const failed = mapData.get(config);
  assert.equal(failed.transitStatus, "error");
  assert.match(failed.transitError, /Overpass unavailable/);
  const calls = fetchImpl.count(/overpass/);

  mapData.get(config, { retry: true });
  assert.equal(fetchImpl.count(/overpass/), calls, "a manual retry right away still waits a few seconds");

  clock.t += 5 * 60_000;
  mapData.get(config);
  assert.equal(fetchImpl.count(/overpass/), calls, "backing off");

  mapData.get(config, { retry: true });
  await mapData.settled();
  assert.ok(fetchImpl.count(/overpass/) > calls, "but a retry a few minutes later goes ahead");
});

test("areasForMatches returns each referenced area once, with a radius for places that have no outline", () => {
  const geocache = {
    "area:castletroy": { lat: 52.665, lng: -8.571, kind: "suburb", name: "Castletroy", geometry: null },
    "area:nowhere": { miss: true },
  };
  const areas = areasForMatches(
    [{ areaKey: "area:castletroy" }, { areaKey: "area:castletroy" }, { areaKey: "area:nowhere" }, { areaKey: "area:unknown" }, {}],
    geocache,
  );
  assert.deepEqual(Object.keys(areas), ["area:castletroy"]);
  assert.equal(areas["area:castletroy"].radiusM, 700);
});

// --- areas and outlines from Nominatim ----------------------------------------------------------------------------------

const SUBURB_POLYGON = { type: "Polygon", coordinates: [[[-8.5712345678, 52.6654321], [-8.56, 52.66], [-8.56, 52.67], [-8.5712345678, 52.6654321]]] };

function areaGeocoder(rows) {
  const { store } = tempStore();
  const fetchImpl = router([[/nominatim/, () => rows]]);
  return { fetchImpl, store, geo: createGeocoder({ store, fetchImpl, sleep: noSleep, minIntervalMs: 0 }) };
}

test("geocoder.area finds the named place with its outline, cached, and ignores far or missing places", async () => {
  const { geo, fetchImpl } = areaGeocoder([{ lat: "52.6654", lon: "-8.5712", name: "Castletroy", addresstype: "suburb", geojson: SUBURB_POLYGON }]);
  const budget = { geocode: 5, exhausted: false };
  const a = await geo.area("Castletroy", UL, budget);
  assert.equal(a.key, "area:castletroy");
  assert.equal(a.name, "Castletroy");
  assert.equal(a.kind, "suburb");
  assert.equal(a.geometry.type, "Polygon");
  assert.equal(a.geometry.coordinates[0][0][0], -8.57123, "coordinates are rounded to about a metre");
  assert.match(decodeURIComponent(fetchImpl.calls[0].url), /polygon_geojson=1/);
  await geo.area("Castletroy", UL, budget);
  assert.equal(fetchImpl.count(/nominatim/), 1, "second lookup is served from the cache");
  assert.equal(budget.geocode, 4);

  const point = areaGeocoder([{ lat: "52.6654", lon: "-8.5712", name: "Castletroy", addresstype: "suburb", geojson: { type: "Point", coordinates: [-8.5712, 52.6654] } }]);
  assert.equal((await point.geo.area("Castletroy", UL, { geocode: 5 })).geometry, null, "a point is no outline: the map draws a circle instead");

  const far = areaGeocoder([{ lat: "53.35", lon: "-6.26", name: "Dublin", addresstype: "city" }]);
  assert.equal(await far.geo.area("Dublin", UL, { geocode: 5 }), null);

  const tight = { geocode: 0, exhausted: false };
  assert.equal(await geo.area("Plassey", UL, tight), null);
  assert.equal(tight.exhausted, true);
});

test("geocoder.outline returns every outline of the best match close to the centre", async () => {
  const poly = (lng) => ({ type: "Polygon", coordinates: [[[lng, 52.67], [lng + 0.01, 52.67], [lng + 0.01, 52.68], [lng, 52.67]]] });
  const { geo } = areaGeocoder([
    { lat: "52.6732", lon: "-8.5698", name: "University of Limerick", geojson: poly(-8.585) },
    { lat: "52.6797", lon: "-8.5717", name: "University of Limerick", geojson: poly(-8.57) },
    { lat: "52.6729", lon: "-8.5719", name: "UL Student Life", geojson: poly(-8.572) },
    { lat: "53.35", lon: "-6.26", name: "University of Limerick", geojson: poly(-6.3) },
  ]);
  const polygons = await geo.outline("University of Limerick", UL, { geocode: 3 });
  assert.equal(polygons.length, 2);
});

test("resolveArea names the place for approximate and unlocated listings, and leaves exact ones alone", async () => {
  const asked = [];
  const geocoder = { area: async (q) => (asked.push(q), { key: `area:${q.toLowerCase()}` }) };
  const config = { geocode: true, center: UL, localityHints: ["castletroy", "plassey"] };

  const approx = { lat: 52.66, lng: -8.57, distanceSource: "geocoded-area", areaQuery: "Plassey, Limerick", title: "x", address: "" };
  await resolveArea(approx, config, geocoder, {});
  assert.equal(approx.areaKey, "area:plassey, limerick", "the query that matched is the place");

  const unlocated = { lat: null, lng: null, distanceSource: null, title: "Room in Castletroy", address: "" };
  await resolveArea(unlocated, config, geocoder, {});
  assert.equal(unlocated.areaKey, "area:castletroy", "the area name found in the address or title");

  for (const other of [
    { lat: 52.66, lng: -8.57, distanceSource: "source", title: "Castletroy", address: "" },
    { lat: null, lng: null, title: "Mystery Place", address: "" },
  ]) {
    await resolveArea(other, config, geocoder, {});
    assert.equal(other.areaKey, undefined);
  }
  await resolveArea({ lat: null, lng: null, title: "Castletroy", address: "" }, { ...config, geocode: false }, geocoder, {});
  assert.equal(asked.length, 2);
});

// --- a scan records the area ------------------------------------------------------------------------------------------------

const ulCard = (id, address) => `
<div class="advert"><a href="/Advert/${id}">${address}</a>
  <div>Available: Now 2 LMKP${id} €500 Per person per month Full price list Locate on map ${address} Room in House / Apartment with other tenants
  Individuals Rooms (1 Available) Now Flexible/ Academic year Details Add to Hot List ${address}</div></div>`;

test("a scan gives approximate and unlocated listings the area they are in, which the state endpoint then serves", async () => {
  const LIST = "https://www.accommodation.ul.ie/SearchResults/Print/All";
  const fetchImpl = router([
    [LIST, `<html><body>${ulCard(2001, "Plassey Lane, Castletroy")}${ulCard(2002, "Castletroy Mystery Park")}${ulCard(2003, "7 Elm Park, Castletroy")}</body></html>`],
    [/nominatim/, (url) => {
      const q = decodeURIComponent(/[?&]q=([^&]+)/.exec(url)[1]).toLowerCase();
      if (url.includes("polygon_geojson")) {
        return q.startsWith("castletroy") ? [{ lat: String(kmNorth(0.6).lat), lon: String(UL.lng), name: "Castletroy", addresstype: "suburb", geojson: SUBURB_POLYGON }] : [];
      }
      if (q.startsWith("7 elm park")) return [{ lat: String(kmNorth(0.8).lat), lon: String(UL.lng), addresstype: "house" }];
      return q.startsWith("castletroy,") ? [{ lat: String(kmNorth(0.6).lat), lon: String(UL.lng), addresstype: "suburb" }] : [];
    }],
  ]);
  const { store } = tempStore();
  store.data.config = { ...store.data.config, sources: ["ul"], ulUrls: [LIST], rentUrls: [], myhomeUrls: [], webUrls: [] };
  const scanner = createScanner({ store, pusher: fakePusher(), fetchImpl, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, now: () => new Date("2026-09-30T12:00:00Z") });
  const run = await scanner.run();
  assert.equal(run.ok, true);

  const by = (id) => store.data.matches.find((m) => m.id === id);
  assert.equal(by("ul:2001").distanceSource, "geocoded-area");
  assert.equal(by("ul:2001").areaKey, "area:castletroy");
  assert.equal(by("ul:2001").areaQuery, undefined, "the helper field is not stored");
  assert.equal(by("ul:2002").lat, null);
  assert.equal(by("ul:2002").areaKey, "area:castletroy", "found from the area name in its address");
  assert.equal(by("ul:2003").distanceSource, "geocoded");
  assert.equal(by("ul:2003").areaKey, undefined, "an exact address needs no area");

  const areas = areasForMatches(store.data.matches, store.data.geocache);
  assert.equal(areas["area:castletroy"].geometry.type, "Polygon");
  assert.equal(areas["area:castletroy"].name, "Castletroy");
});

// --- the API ------------------------------------------------------------------------------------------------------------------------

test("API: /api/state carries the areas, /api/map serves the map background, and the map library is served", async () => {
  const { store } = tempStore();
  store.data.matches = [{ id: "ul:1", areaKey: "area:castletroy", lat: null, lng: null }];
  store.data.geocache["area:castletroy"] = { lat: 52.665, lng: -8.571, kind: "suburb", name: "Castletroy", geometry: null, at: new Date().toISOString() };
  const pusher = fakePusher();
  const scanner = createScanner({ store, pusher, fetchImpl: router([]), sleep: noSleep, politenessMs: 0 });
  const scheduler = createScheduler({ store, scanner, startDelayMs: 3_600_000 });
  const seen = [];
  const mapData = { get: (config, opts) => (seen.push(opts ?? {}), { center: config.center, radiusKm: config.radiusKm, campus: [], transit: null, transitStatus: "loading", transitError: null }) };
  const app = createApp({ store, scanner, pusher, scheduler, mapData, password: "pw", secret: "s" });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/map`)).status, 401);
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "pw" }) });
    const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };

    const state = await (await fetch(`${base}/api/state`, { headers })).json();
    assert.equal(state.areas["area:castletroy"].radiusM, 700);

    const map = await fetch(`${base}/api/map`, { headers });
    assert.equal(map.headers.get("cache-control"), "no-store");
    assert.equal((await map.json()).transitStatus, "loading");
    const retry = await fetch(`${base}/api/map/refresh`, { method: "POST", headers });
    assert.equal(retry.status, 200);
    assert.deepEqual(seen, [{}, { retry: true }]);

    const leaflet = await fetch(`${base}/vendor/leaflet/leaflet.js`);
    assert.equal(leaflet.status, 200);
    assert.match(leaflet.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${base}/vendor/leaflet/leaflet.css`)).status, 200);
    for (const file of ["map.js", "map-model.js", "ui.js"]) assert.equal((await fetch(`${base}/${file}`)).status, 200, file);
  } finally {
    server.close();
  }
});

test("the default Overpass mirrors are all https", () => {
  for (const url of OVERPASS_MIRRORS) assert.match(url, /^https:\/\/.+\/api\/interpreter$/);
});

// --- the map page's grouping --------------------------------------------------------------------------------------------------

const listing = (over) => ({ id: "x", url: "https://x.ie/1", title: "Room", priceMonthly: 600, lat: null, lng: null, distanceSource: null, ...over });

test("placeMatches: exact spots, named areas, approximate points, and the unplaceable", () => {
  const areas = { "area:castletroy": { name: "Castletroy", lat: 52.665, lng: -8.571, radiusM: 700, geometry: null } };
  const { spots, zones, unplaced } = placeMatches(
    [
      listing({ id: "a", lat: 52.67, lng: -8.57, distanceSource: "source" }),
      listing({ id: "b", lat: 52.67, lng: -8.57, distanceSource: "geocoded" }),
      listing({ id: "c", lat: 52.665, lng: -8.571, distanceSource: "geocoded-area", areaKey: "area:castletroy" }),
      listing({ id: "d", areaKey: "area:castletroy" }),
      listing({ id: "e", lat: 52.68, lng: -8.58, distanceSource: "geocoded-area" }),
      listing({ id: "f" }),
    ],
    areas,
  );
  assert.deepEqual(spots.map((s) => s.items.map((m) => m.id)), [["a", "b"]], "listings at one spot share a marker");
  assert.equal(zones.length, 2);
  const named = zones.find((z) => z.name === "Castletroy");
  assert.deepEqual(named.items.map((m) => m.id), ["c", "d"], "an area-only position is never drawn as a pin");
  assert.equal(named.radiusM, 700);
  assert.equal(zones.find((z) => z.name === "").radiusM, 500, "an area that could not be named is a circle around the approximate point");
  assert.deepEqual(unplaced.map((m) => m.id), ["f"]);
});

test("clusterSpots merges markers that would overlap on screen and leaves distant ones alone", () => {
  const spot = (key, lat, lng) => ({ kind: "spot", key, lat, lng, items: [listing({ id: key })] });
  const project = (lat, lng) => ({ x: lng * 100000, y: -lat * 100000 });
  const out = clusterSpots([spot("a", 52.67, -8.57), spot("b", 52.67001, -8.57001), spot("c", 52.68, -8.56)], project, 44);
  assert.equal(out.length, 2);
  const merged = out.find((c) => c.spots.length === 2);
  assert.deepEqual(merged.items.map((m) => m.id).sort(), ["a", "b"]);
  assert.ok(Math.abs(merged.lat - 52.670005) < 1e-6);
  const alone = out.find((c) => c.spots.length === 1);
  assert.equal(alone.lat, 52.68);
});

test("pinLabel shows the lowest price, with a plus for groups", () => {
  assert.equal(pinLabel([listing({ priceMonthly: 1200 })]), "€1,200");
  assert.equal(pinLabel([listing({ priceMonthly: 900 }), listing({ priceMonthly: 600 })]), "€600+");
  assert.equal(pinLabel([listing({ priceMonthly: null })]), "€?");
});
