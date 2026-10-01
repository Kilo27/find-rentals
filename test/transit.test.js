import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildDataset, pickReferenceDate, serializeDataset, splitCsv, toSeconds, tuesdays } from "../scripts/lib/gtfs.mjs";
import { CAMPUSES, campusIdsFor, campusesNear } from "../src/transit/campuses.js";
import { attachTransit, createTransit, searchRadiusKm } from "../src/transit.js";
import { DEFAULT_CONFIG, ConfigError, normalizeConfig } from "../src/config.js";
import { evaluateLocation } from "../src/filter.js";
import { buildListingPayload, describeTransit } from "../src/push.js";
import { searchUrl } from "../src/daft.js";
import { UL, kmNorth } from "./helpers.js";

const config = (over = {}) => normalizeConfig({ ...DEFAULT_CONFIG, ...over });

// --- the GTFS builder ------------------------------------------------------------------------------------

const memFeed = (name, files) => ({
  name,
  has: (f) => f in files,
  lines: async function* (f) {
    for (const l of files[f].trim().split("\n")) yield l.trim();
  },
});

const HEAD_STOPS = "stop_id,stop_code,stop_name,stop_lat,stop_lon";
const HEAD_TIMES = "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type";
const times = (trip, rows) => rows.map(([stop, t, pickup = 0, drop = 0], i) => `${trip},${t},${t},${stop},${i + 1},${pickup},${drop}`).join("\n");

// A campus at UL, a bus line passing it, and the awkward cases around it.
const TEST_CAMPUSES = [
  { id: "ul", name: "UL", lat: 52.6733, lng: -8.5739, reachM: 500 },
  { id: "elsewhere", name: "Elsewhere", lat: 53.5, lng: -7.0, reachM: 400 },
];

function busFeed({ exceptions = "" } = {}) {
  return memFeed("Test Bus", {
    "agency.txt": "agency_id,agency_name\n2,Bus Éireann",
    "routes.txt": [
      "route_id,agency_id,route_short_name,route_long_name,route_type",
      "r304,2,304,UL - City Centre - Raheen,3",
      "r99,2,99,No pickups,3",
      "r98,2,98,No drop-offs,3",
      "r97,2,97,Station-distance bus,3",
    ].join("\n"),
    "stops.txt": [
      HEAD_STOPS,
      "C,100001,UL Student Ctr,52.6728,-8.5708", // at the campus
      "A,100002,Nearer stop,52.6530,-8.6000", // ~3 km out, towards the city
      "B,100003,Further stop,52.6600,-8.6400", // ~5 km out
      "Z,100004,East of campus,52.6650,-8.5400", // beyond the campus
      "A2,100012,Nearer stop (outbound side),52.6531,-8.6001",
      "B2,100013,Further stop (outbound side),52.6601,-8.6401",
      "C2,100011,UL Student Ctr (outbound),52.6729,-8.5709",
      "FAR,100005,Too far away,52.5500,-8.5000", // ~14 km
      "T,100006,Seven hundred metres,52.6733,-8.5635",
    ].join("\n"),
    "trips.txt": [
      "route_id,service_id,trip_id,trip_headsign",
      "r304,wk,t1,UL",
      "r304,wk,t1b,UL",
      "r304,wk,t2,Raheen",
      "r304,we,t3,UL",
      "r99,wk,t4,UL",
      "r98,wk,t5,UL",
      "r97,wk,t6,UL",
    ].join("\n"),
    "calendar.txt": [
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
      "wk,1,1,1,1,1,0,0,20260901,20270601",
      "we,0,0,0,0,0,1,1,20260901,20270601",
    ].join("\n"),
    "calendar_dates.txt": `service_id,date,exception_type\n${exceptions || "wk,20290101,2"}`,
    "stop_times.txt": [
      HEAD_TIMES,
      // towards the campus: B -> A -> C -> Z, twice a day, 10 minutes from A and 20 from B
      times("t1", [["FAR", "07:40:00"], ["B", "08:00:00"], ["A", "08:10:00"], ["C", "08:20:00"], ["Z", "08:25:00"]]),
      times("t1b", [["B", "17:00:00"], ["A", "17:10:00"], ["C", "17:20:00"]]),
      // away from the campus: C2 -> A2 -> B2
      times("t2", [["C2", "08:30:00"], ["A2", "08:40:00"], ["B2", "08:50:00"]]),
      // Saturday only
      times("t3", [["B", "09:00:00"], ["A", "09:10:00"], ["C", "09:20:00"]]),
      // A is drop-off only on this one
      times("t4", [["B", "10:00:00"], ["A", "10:10:00", 1, 0], ["C", "10:20:00"]]),
      // the campus stop does not let anyone off
      times("t5", [["B", "11:00:00"], ["C", "11:20:00", 0, 1]]),
      // 700 m from the campus: further than a bus stop may be
      times("t6", [["B", "12:00:00"], ["T", "12:20:00"]]),
    ].join("\n"),
  });
}

const tramFeed = () =>
  memFeed("Test Tram", {
    "agency.txt": "agency_id,agency_name\n10000,LUAS",
    "routes.txt": ["route_id,agency_id,route_short_name,route_long_name,route_type", "g,10000,Green,Parnell - Brides Glen,0"].join("\n"),
    "stops.txt": [HEAD_STOPS, "T0,998001,Tram start,52.6600,-8.6400", "T,998002,Tram stop 700 m away,52.6733,-8.5635"].join("\n"),
    "trips.txt": ["route_id,service_id,trip_id", "g,wk,tt1"].join("\n"),
    "calendar.txt": ["service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date", "wk,1,1,1,1,1,0,0,20260901,20270601"].join("\n"),
    "stop_times.txt": [HEAD_TIMES, times("tt1", [["T0", "08:00:00"], ["T", "08:12:00"]])].join("\n"),
  });

const TODAY = new Date("2026-10-01T10:00:00Z");
const build = (feeds, extra = {}) => buildDataset({ feeds, campuses: TEST_CAMPUSES, today: TODAY, ...extra });
const route = (ds, label, campus = "ul") => ds.campuses[campus].routes.find((r) => r.label === label);
const callsOf = (ds, label, campus = "ul") => {
  const c = ds.campuses[campus];
  return Object.fromEntries(route(ds, label, campus).calls.map(([i, n, mins]) => [c.stops[i][1], { n, mins }]));
};

test("gtfs: CSV cells with quotes and commas are split correctly", () => {
  assert.deepEqual(splitCsv("a,b,,c"), ["a", "b", "", "c"]);
  assert.deepEqual(splitCsv('1,"O\'Connell St, Upper",3,"say ""hi"""'), ["1", "O'Connell St, Upper", "3", 'say "hi"']);
  assert.equal(toSeconds("25:10:30"), 25 * 3600 + 10 * 60 + 30);
  assert.equal(toSeconds(""), null);
});

test("gtfs: only stops with a later call at the campus count, in the direction of travel", async () => {
  const ds = await build([busFeed()]);
  const calls = callsOf(ds, "304");
  assert.deepEqual(Object.keys(calls).sort(), ["Further stop", "Nearer stop"], "the far side of the road and the campus stop itself are not 'towards'");
  assert.equal(calls["Nearer stop"].mins, 10);
  assert.equal(calls["Further stop"].mins, 20);
  assert.equal(route(ds, "304").name, "UL - City Centre - Raheen");
  assert.equal(route(ds, "304").operator, "Bus Éireann");
  assert.equal(route(ds, "304").mode, "bus");
});

test("gtfs: trips per weekday count only the reference weekday's services", async () => {
  const ds = await build([busFeed()]);
  const calls = callsOf(ds, "304");
  assert.equal(calls["Nearer stop"].n, 2, "two weekday trips; the Saturday-only trip is not counted");
  assert.equal(ds.feeds[0].refDate, "2026-10-06");
});

test("gtfs: the reference weekday is the fullest Tuesday, skipping one a holiday removes service from", async () => {
  const data = {
    calendar: [{ service: "wk", days: [false, true, true, true, true, true, false], start: "20260901", end: "20270601" }],
    exceptions: new Map([["20261006", [{ service: "wk", type: "2" }]]]),
    tripsPerService: new Map([["wk", 5]]),
  };
  assert.equal(pickReferenceDate(data, TODAY).date.toISOString().slice(0, 10), "2026-10-13");
  const ds = await build([busFeed({ exceptions: "wk,20261006,2" })]);
  assert.equal(ds.feeds[0].refDate, "2026-10-13");
  assert.equal(tuesdays(new Date("2026-10-06T00:00:00Z"), 2)[0].toISOString().slice(0, 10), "2026-10-06", "a Tuesday is its own first Tuesday");
});

test("gtfs: no pickup at a stop, no drop-off at the campus, and stops beyond the distance cap are ignored", async () => {
  const ds = await build([busFeed()]);
  assert.deepEqual(Object.keys(callsOf(ds, "99")).sort(), ["Further stop"], "A is drop-off only on route 99");
  assert.equal(route(ds, "98"), undefined, "nobody can get off at the campus on route 98");
  assert.ok(!("Too far away" in callsOf(ds, "304")), "14 km out is beyond the 12 km cap");
  const wide = await build([busFeed()], { maxKm: 20 });
  assert.ok("Too far away" in callsOf(wide, "304"));
});

test("gtfs: a tram stop 700 m from the campus counts, a bus stop that far away does not", async () => {
  const ds = await build([busFeed(), tramFeed()]);
  assert.equal(route(ds, "97"), undefined, "bus reach is the campus's 500 m");
  const green = route(ds, "Green Line");
  assert.equal(green.mode, "tram");
  assert.equal(green.operator, "Luas");
  assert.equal(ds.campuses.ul.stops[green.calls[0][0]][1], "Tram start");
  assert.equal(green.calls[0][2], 12);
});

test("gtfs: campuses nothing serves come out empty, and the file round-trips", async () => {
  const ds = await build([busFeed()]);
  assert.deepEqual(ds.campuses.elsewhere, { stops: [], routes: [] });
  assert.deepEqual(JSON.parse(serializeDataset(ds)), JSON.parse(JSON.stringify(ds)));
});

// --- looking up a home's transport links --------------------------------------------------------------------

function fakeData() {
  return {
    generated: "2026-10-01",
    campuses: {
      ul: {
        stops: [
          ["601", "Near stop", UL.lat - 0.027, UL.lng], // ~3 km south of the campus
          ["602", "Other side", UL.lat - 0.0271, UL.lng + 0.0001],
          ["603", "Rare service", UL.lat - 0.027, UL.lng + 0.003],
          ["604", "Far stop", UL.lat - 0.045, UL.lng],
        ],
        routes: [
          { label: "304A", mode: "bus", operator: "Bus Éireann", name: "Raheen - Bus Station - UL", calls: [[0, 38, 14], [1, 38, 14], [3, 38, 40]] },
          { label: "310", mode: "bus", operator: "Bus Éireann", name: "Sarsfield St - Tech Park", calls: [[0, 35, 12], [2, 2, 12]] },
        ],
      },
    },
  };
}

test("transit: finds the nearest stop per route within walking distance that is frequent and quick enough", () => {
  const t = createTransit(fakeData());
  const r = t.access(UL.lat - 0.027, UL.lng, config()); // standing at the near stop
  assert.equal(r.good, true);
  const [campus] = r.campuses;
  assert.equal(campus.id, "ul");
  assert.deepEqual(campus.options.map((o) => o.label), ["304A", "310"]);
  assert.equal(campus.options[0].stop, "Near stop", "the nearer of the two 304A stops");
  assert.equal(campus.options[0].distM, 0);
  assert.equal(campus.options[0].mins, 14);
  assert.equal(campus.options[0].lat, UL.lat - 0.027);
  assert.equal(campus.short, "UL");
});

test("transit: stops that are too far to walk, too rare, or too slow do not count", () => {
  const t = createTransit(fakeData());
  const at = (lat, lng, over = {}) => t.access(lat, lng, config(over));
  assert.equal(at(UL.lat - 0.027 + 0.012, UL.lng).good, false, "1.3 km from the nearest stop");
  assert.equal(at(UL.lat - 0.027, UL.lng + 0.003).campuses[0].options.some((o) => o.stop === "Rare service"), false, "2 trips a day is not easy access");
  assert.equal(at(UL.lat - 0.045, UL.lng).good, false, "40 minutes on the bus is more than the 30 minute limit");
  assert.equal(at(UL.lat - 0.045, UL.lng, { transitMaxRideMin: 45 }).good, true);
  assert.equal(at(UL.lat - 0.027 + 0.012, UL.lng, { transitWalkM: 1500 }).good, true);
  assert.equal(at(UL.lat - 0.027, UL.lng + 0.003, { transitMinPerDay: 1 }).campuses[0].options.some((o) => o.stop === "Rare service"), true);
});

test("transit: campuses are the ticked ones, or whichever is at the search centre", () => {
  assert.deepEqual(campusIdsFor(config()), ["ul"]);
  assert.deepEqual(campusIdsFor(config({ transitCampuses: ["tcd", "ucd"] })), ["tcd", "ucd"]);
  const trinity = campusIdsFor(config({ center: { label: "Trinity", lat: 53.3438, lng: -6.2546 } }));
  assert.ok(trinity.includes("tcd") && !trinity.includes("ucd"), "the campuses within a kilometre of the centre");
  assert.deepEqual(campusIdsFor(config({ center: { label: "A bit south of UL", lat: 52.652, lng: -8.5739 } })), ["ul"], "or else the nearest within 5 km");
  assert.deepEqual(campusIdsFor(config({ center: { label: "Middle of nowhere", lat: 53.0, lng: -8.0 } })), []);
  assert.deepEqual(campusesNear(UL.lat, UL.lng, 0.1), ["ul"]);
  const t = createTransit(fakeData());
  assert.equal(t.access(UL.lat - 0.027, UL.lng, config({ transitCampuses: ["tcd"] })).good, false, "no data for a ticked campus is just 'no access'");
});

test("transit: attachTransit leaves area-level and unlocated listings alone", () => {
  const t = createTransit(fakeData());
  const base = { lat: UL.lat - 0.027, lng: UL.lng, distanceSource: "source" };
  const a = { ...base };
  attachTransit(a, config(), t);
  assert.equal(a.transit.good, true);
  const coarse = { ...base, distanceSource: "geocoded-area" };
  attachTransit(coarse, config(), t);
  assert.equal(coarse.transit, null);
  const none = { lat: null, lng: null };
  attachTransit(none, config(), t);
  assert.equal(none.transit, null);
  const off = { ...base };
  attachTransit(off, config({ transitEnabled: false }), t);
  assert.equal(off.transit, null);
  const noData = { ...base };
  attachTransit(noData, config(), null);
  assert.equal(noData.transit, null);
});

// --- what it does to the search --------------------------------------------------------------------------------

const located = (km, over = {}) => ({ ...kmNorth(km), distanceSource: "source", title: "House", address: "", ...over });
const withTransit = {
  good: true,
  campuses: [{ id: "ul", name: "University of Limerick", short: "UL", options: [{ label: "304A", mode: "bus", operator: "Bus Éireann", stop: "Stop", code: "1", lat: 0, lng: 0, distM: 250, perDay: 38, mins: 14 }] }],
};

test("filter: beyond the radius is accepted only with a direct service, and only up to the outer limit", () => {
  const near = evaluateLocation(located(1.5), config());
  assert.equal(near.ok, true);
  assert.deepEqual(near.flags, []);

  const via = evaluateLocation(located(3.5, { transit: withTransit }), config());
  assert.equal(via.ok, true);
  assert.deepEqual(via.flags, ["transit-access"]);
  assert.ok(Math.abs(via.distanceKm - 3.5) < 0.01);

  assert.equal(evaluateLocation(located(3.5), config()).reason, "too far", "no service, no exception");
  assert.equal(evaluateLocation(located(6, { transit: withTransit }), config()).reason, "too far", "past the 5 km outer limit");
  assert.equal(evaluateLocation(located(6, { transit: withTransit }), config({ transitMaxKm: 8 })).ok, true);
  assert.equal(evaluateLocation(located(3.5, { transit: withTransit }), config({ transitEnabled: false })).reason, "too far");
  assert.equal(evaluateLocation(located(3.5, { transit: withTransit, distanceSource: "geocoded-area" }), config()).reason, "too far", "an area-level guess never earns the exception");
});

test("daft: the search area widens to the outer limit only when transport can earn the exception", () => {
  const radius = (cfg) => new URL(searchUrl(config(cfg), "sharing")).searchParams.get("radius");
  assert.equal(searchRadiusKm(config()), 5);
  assert.equal(radius({}), "5000");
  assert.equal(radius({ transitMaxKm: 8 }), "10000");
  assert.equal(radius({ transitEnabled: false }), "3000");
  assert.equal(radius({ center: { label: "Nowhere", lat: 53.0, lng: -8.0 } }), "3000", "no campus there, nothing to be near");
  assert.equal(radius({ radiusKm: 6 }), "10000", "never narrower than the radius itself");
});

test("push: a listing accepted for its transport link says which service and how far", () => {
  const listing = { id: "daft:1", title: "House", priceText: "€900", priceMonthly: 900, sourceLabel: "Daft.ie", distanceKm: 3.5, flags: ["transit-access"], transit: withTransit, url: "https://x" };
  assert.equal(describeTransit(withTransit), "304A 250 m away, 14 min to UL");
  assert.match(buildListingPayload(listing, config()).body, /3\.5 km from University of Limerick · 304A 250 m away, 14 min to UL · Daft\.ie/);
  assert.doesNotMatch(buildListingPayload({ ...listing, flags: [] }, config()).body, /304A/, "homes inside the radius keep the short notification");
  assert.equal(describeTransit(null), null);
});

test("config: transport settings are validated", () => {
  const c = config();
  assert.deepEqual([c.transitEnabled, c.transitCampuses, c.transitMaxKm, c.transitWalkM, c.transitMaxRideMin, c.transitMinPerDay], [true, [], 5, 500, 30, 10]);
  assert.deepEqual(config({ transitCampuses: ["ul", "ul", "mic"] }).transitCampuses, ["ul", "mic"]);
  assert.throws(() => config({ transitCampuses: ["hogwarts"] }), (e) => e instanceof ConfigError && /unknown campus "hogwarts"/.test(e.errors.join()));
  assert.throws(() => config({ transitWalkM: 5, transitMaxRideMin: 500, transitMinPerDay: 0, transitMaxKm: 99 }), (e) => e.errors.length === 4);
  assert.equal(config({ transitWalkM: "750" }).transitWalkM, 750);
});

// --- the packaged data ---------------------------------------------------------------------------------------

const packaged = JSON.parse(fs.readFileSync(new URL("../src/transit/data.json", import.meta.url), "utf8"));

test("data: every campus is in the packaged data and every stop is a real Irish location", () => {
  for (const c of CAMPUSES) {
    const d = packaged.campuses[c.id];
    assert.ok(d, `${c.id} missing: run npm run transit`);
    for (const [code, name, lat, lng] of d.stops) {
      assert.ok(name && lat > 51.3 && lat < 55.5 && lng > -10.7 && lng < -5.3, `${c.id} ${code} ${name} ${lat},${lng}`);
    }
    for (const r of d.routes) {
      for (const [si, perDay, mins] of r.calls) {
        assert.ok(d.stops[si], `${c.id} ${r.label} points at a stop that exists`);
        assert.ok(perDay >= 1 && (mins === null || (mins >= 0 && mins <= packaged.limits.maxRideMin)));
      }
    }
  }
});

test("data: Limerick's 304, 304A and 310 reach UL, with stops in the city and out towards the suburbs", () => {
  const ul = createTransit(packaged).stopsFor("ul");
  for (const label of ["304", "304A", "310"]) {
    const r = ul.routes.find((x) => x.label === label);
    assert.ok(r, `${label} serves UL`);
    assert.equal(r.operator, "Bus Éireann");
    assert.ok(r.stops.length >= 15, `${label} has ${r.stops.length} stops`);
    assert.ok(r.stops.some((s) => /Courthse|William|Sarsfield/i.test(s.name)), `${label} calls in the city centre`);
    assert.ok(Math.max(...r.stops.map((s) => s.mins ?? 0)) >= 15, `${label} starts well away from UL`);
  }
  const plassey = ul.routes.find((r) => r.label === "304").stops.find((s) => /Plassey/.test(s.name));
  assert.ok(plassey && plassey.code === "607611", "stop numbers are the ones printed on the poles");
});

test("data: a house on the 304 corridor a few km out gets access, one on the far side of campus does not", () => {
  const t = createTransit(packaged);
  const cfg = config();
  const claughaun = t.access(52.6589, -8.5964, cfg); // beside the Claughaun GAA stop, ~1.7 km from UL
  assert.ok(claughaun.good);
  assert.ok(claughaun.campuses[0].options.some((o) => o.label === "304"));
  assert.equal(t.access(52.6292, -8.6618, cfg).good, false, "Raheen is a 50 minute ride, more than the default 30");
  assert.equal(t.access(52.6292, -8.6618, config({ transitMaxRideMin: 60 })).good, true);
  assert.equal(t.access(52.72, -8.57, cfg).good, false, "no stop within 500 m north of the campus");
});

test("data: Dublin, Cork and Galway campuses include trams, trains and buses as well as Bus Éireann", () => {
  const modes = (id) => new Set(createTransit(packaged).stopsFor(id).routes.map((r) => `${r.operator}/${r.mode}`));
  const tcd = modes("tcd");
  for (const m of ["Dublin Bus/bus", "Luas/tram", "Irish Rail/rail"]) assert.ok(tcd.has(m), `Trinity has ${m}`);
  assert.ok(modes("maynooth").has("Irish Rail/rail"));
  assert.ok(modes("ucc").has("Bus Éireann/bus"));
  assert.ok(modes("uog").has("Bus Éireann/bus"));
});
