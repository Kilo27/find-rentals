import test from "node:test";
import assert from "node:assert/strict";
import { createScanner } from "../src/scan.js";
import { createGeocoder, addressQueries } from "../src/geocode.js";
import { dedupe } from "../src/dedupe.js";
import { makeListing } from "../src/listing.js";
import { gatewayResponse, noSleep, rawListing, router, tempStore, fakePusher, UL, kmNorth } from "./helpers.js";

const UL_LIST = "https://www.accommodation.ul.ie/SearchResults/Print/All";
const advert = (id) => `https://www.accommodation.ul.ie/Advert/${id}`;

const meta = (km) => {
  const p = kmNorth(km);
  return `<meta property="place:location:latitude" content="${p.lat.toFixed(5)}"><meta property="place:location:longitude" content="${p.lng.toFixed(5)}">`;
};
const page = (head, body) => `<html><head>${head}</head><body><main>${body}</main></body></html>`;

const ULPAGES = {
  list: `<html><body><table>
    <tr><td><a href="/Advert/1001">Double room €650 per month</a></td><td>Castletroy</td></tr>
    <tr><td><a href="/Advert/1002">Room in student house, Plassey</a></td><td>€520 per month</td></tr>
    <tr><td><a href="/Advert/1003">Single room, Annacotty</a></td></tr>
    <tr><td><a href="/Advert/1004">Room near the college</a></td><td>€550 per month</td></tr>
    <tr><td><a href="/Advert/1005">Room, Newtown</a></td><td>€480 per month</td></tr>
  </table></body></html>`,
  1001: page(meta(0.6), "<h1>Double room €650 per month</h1><p>Double room in an owner-occupied home. Available Monday to Friday only. Location: Castletroy</p>"),
  1002: page(meta(0.8), "<h1>Room in student house, Plassey</h1><p>Available now until June 2027. Rent €520 per month. Address: 12 Plassey Village, Castletroy, Limerick</p>"),
  1003: page("", "<h1>Single room, Annacotty</h1><p>Rent €500 per month. Address: Annacotty Village, Limerick. Available now.</p>"),
  1004: page(meta(0.9), "<h1>Room near the college</h1><p>Rent €550 per month. Available from 01/11/2026. Address: Dromroe, Castletroy</p>"),
  1005: page("", "<h1>Room, Newtown</h1><p>Rent €480 per month. Available now until June 2027. Address: 3 Newtown Park, Castletroy</p>"),
};

function ulRoutes(extra = []) {
  return [
    [UL_LIST, ULPAGES.list],
    ...[1001, 1002, 1003, 1004, 1005].map((id) => [advert(id), ULPAGES[id]]),
    ...extra,
  ];
}

function nominatim(map) {
  return [
    /nominatim\.openstreetmap\.org/,
    (url) => {
      const q = decodeURIComponent(/[?&]q=([^&]+)/.exec(url)[1]);
      for (const [needle, row] of Object.entries(map)) if (q.toLowerCase().includes(needle)) return [row];
      return [];
    },
  ];
}

function setup(sources, cfg = {}, pusher = fakePusher()) {
  const { store } = tempStore();
  store.data.config = { ...store.data.config, sources, ulUrls: [UL_LIST], rentUrls: [], myhomeUrls: [], webUrls: [], ...cfg };
  return { store, pusher };
}

const scannerFor = (store, pusher, fetchImpl) =>
  createScanner({ store, pusher, fetchImpl, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, now: () => new Date("2026-09-30T12:00:00Z") });

test("UL portal: description analysis, geocoding and availability drive the decision", async () => {
  const fetchImpl = router(ulRoutes([
    nominatim({
      "annacotty village": { lat: "52.6655", lon: "-8.5170", addresstype: "village" },
      "3 newtown park": { lat: String(kmNorth(1.2).lat), lon: String(UL.lng), addresstype: "house" },
    }),
  ]));
  const { store, pusher } = setup(["ul"]);
  const run = await scannerFor(store, pusher, fetchImpl).run();

  assert.equal(run.ok, true);
  assert.equal(run.candidates, 5);
  const ids = store.data.matches.map((m) => m.id).sort();
  assert.deepEqual(ids, ["ul:1002", "ul:1005"], "owner-occupied weekday let, far Annacotty and late-available rooms are excluded");

  const m2 = store.data.matches.find((m) => m.id === "ul:1002");
  assert.equal(m2.distanceSource, "source");
  assert.ok(Math.abs(m2.distanceKm - 0.8) < 0.02);
  assert.ok(m2.flags.includes("available-now"));
  assert.equal(m2.availableTo, "2027-06-30");
  assert.equal(m2.sourceLabel, "UL Accommodation");

  const m5 = store.data.matches.find((m) => m.id === "ul:1005");
  assert.equal(m5.distanceSource, "geocoded");
  assert.ok(Math.abs(m5.distanceKm - 1.2) < 0.02);
});

test("UL portal: detail pages are cached - second scan only fetches the list", async () => {
  const fetchImpl = router(ulRoutes([nominatim({})]));
  const { store, pusher } = setup(["ul"]);
  const scanner = scannerFor(store, pusher, fetchImpl);
  await scanner.run();
  const detailCalls = fetchImpl.count(/\/Advert\/\d+/);
  assert.equal(detailCalls, 5);
  await scanner.run();
  assert.equal(fetchImpl.count(/\/Advert\/\d+/), detailCalls, "no refetch of cached adverts");
  assert.equal(fetchImpl.count(/SearchResults/), 2);
});

test("detail budget: un-enriched listings are pending, not alerted, and baseline waits", async () => {
  const fetchImpl = router(ulRoutes([nominatim({})]));
  const { store, pusher } = setup(["ul"], { maxDetailFetches: 2 });
  const scanner = scannerFor(store, pusher, fetchImpl);

  const first = await scanner.run();
  assert.equal(first.pending, 3);
  assert.equal(store.data.baselineDone, false);
  assert.equal(pusher.sent.length, 0, "no premature 'watching started'");

  const second = await scanner.run();
  assert.equal(second.pending, 1);
  const third = await scanner.run();
  assert.equal(third.pending, 0);
  assert.equal(store.data.baselineDone, true);
  assert.equal(pusher.sent.filter((p) => /Watching started/.test(p.title)).length, 1);
  assert.deepEqual(store.data.matches.map((m) => m.id).sort(), ["ul:1002", "ul:1005"]);
  assert.ok(store.data.matches.find((m) => m.id === "ul:1005").flags.includes("distance-unverified"), "no coordinates found, kept only because the address names Castletroy");
});

test("UL portal: a robots.txt disallow is respected and reported", async () => {
  const fetchImpl = router([["https://www.accommodation.ul.ie/robots.txt", "User-agent: *\nDisallow: /SearchResults/"], ...ulRoutes()]);
  const { store, pusher } = setup(["ul"]);
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(run.ok, false);
  assert.match(run.error, /robots\.txt/);
  assert.equal(fetchImpl.count(/\/Advert\//), 0);
});

test("UL portal: a layout change yields a warning, not garbage", async () => {
  const fetchImpl = router([[UL_LIST, `<html><body>${"<div>Something entirely different</div>".repeat(200)}</body></html>`]]);
  const { store, pusher } = setup(["ul"]);
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(run.ok, true);
  assert.equal(run.matches, 0);
  assert.match(run.sources[0].notes[0].warning, /no listings were recognised/);
  assert.ok(store.data.debug[`ul:${UL_LIST}`].head, "raw head saved for diagnosis");
});

test("a source that keeps returning nothing usable triggers a health alert, then recovery", async () => {
  let good = false;
  const fetchImpl = router([[UL_LIST, () => (good ? ULPAGES.list : `<html><body>${"<p>blocked</p>".repeat(400)}</body></html>`)], ...ulRoutes().slice(1)]);
  const { store, pusher } = setup(["ul", "daft"], { sections: ["sharing"] });
  fetchImpl.calls.length = 0;
  const daftOk = router([["https://gateway.daft.ie/api/v2/ads/listings", gatewayResponse([])]]);
  const combined = async (url, opts) => (url.includes("gateway.daft.ie") ? daftOk(url, opts) : fetchImpl(url, opts));
  const scanner = scannerFor(store, pusher, combined);
  for (let i = 0; i < 6; i++) await scanner.run();
  assert.equal(pusher.sent.filter((p) => /looks broken/.test(p.title)).length, 1);
  assert.match(pusher.sent.find((p) => /looks broken/.test(p.title)).title, /UL Accommodation/);
  good = true;
  pusher.sent.length = 0;
  await scanner.run();
  assert.ok(pusher.sent.some((p) => /working again/.test(p.title)));
});

const RENT_LIST = "https://www.rent.ie/rooms-to-rent/limerick/castletroy/";
const RENT_PAGE = `<html><body><ul>
  <li><h3><a href="/rooms-to-rent/limerick/castletroy/14-plassey-park/555001">14 Plassey Park, Castletroy</a></h3><p>€650 per month</p></li>
  <li><h3><a href="/rooms-to-rent/limerick/castletroy/dromroe-village/555002">Dromroe Village room</a></h3><p>€480 per month</p></li>
</ul></body></html>`;

test("same property on Daft and Rent.ie is alerted once, with a cross-link", async () => {
  const p = kmNorth(0.7);
  const daftItem = rawListing({ id: 77, km: 0.7, title: "Room 14, Plassey Park, Castletroy, Co. Limerick", price: "€650 per month", extra: { seoFriendlyPath: "/share/plassey/77" } });
  const fetchImpl = router([
    ["https://gateway.daft.ie/api/v2/ads/listings", gatewayResponse([daftItem])],
    [RENT_LIST, RENT_PAGE],
    [/rent\.ie\/rooms-to-rent\/limerick\/castletroy\/14-plassey-park\/555001/, page(`<meta property="place:location:latitude" content="${p.lat.toFixed(5)}"><meta property="place:location:longitude" content="${p.lng.toFixed(5)}">`, "<h1>14 Plassey Park, Castletroy</h1><p>€650 per month. Available now.</p>")],
    [/rent\.ie\/rooms-to-rent\/limerick\/castletroy\/dromroe-village\/555002/, page(meta(1.5), "<h1>Dromroe Village room</h1><p>€480 per month. Available now.</p>")],
  ]);
  const { store, pusher } = setup(["daft", "rent"], { sections: ["sharing"], rentUrls: [RENT_LIST] });
  const scanner = scannerFor(store, pusher, fetchImpl);
  const run = await scanner.run();

  assert.equal(run.candidates, 3);
  assert.equal(run.matches, 2, "Plassey Park merged; Dromroe separate");
  const merged = store.data.matches.find((m) => m.title.includes("Plassey"));
  assert.equal(merged.source, "daft", "Daft wins ties (API coordinates)");
  assert.deepEqual(merged.alsoOn.map((a) => a.label), ["Rent.ie"]);
  assert.ok(store.data.seen["daft:77"] && store.data.seen["rent:555001"], "both ids marked seen");

  // the Daft copy vanishes: the Rent.ie copy must NOT re-alert as new
  pusher.sent.length = 0;
  const gone = router([
    ["https://gateway.daft.ie/api/v2/ads/listings", gatewayResponse([])],
    [RENT_LIST, RENT_PAGE],
    [/555001/, page(meta(0.7), "<h1>14 Plassey Park, Castletroy</h1><p>€650 per month. Available now.</p>")],
    [/555002/, page(meta(1.5), "<h1>Dromroe Village room</h1><p>€480 per month</p>")],
  ]);
  await scannerFor(store, pusher, gone).run();
  assert.equal(pusher.sent.length, 0);
});

test("a new Rent.ie listing alerts with source, distance and availability", async () => {
  let items = RENT_PAGE;
  const fetchImpl = router([
    [RENT_LIST, () => items],
    [/555001/, page(meta(0.7), "<h1>14 Plassey Park, Castletroy</h1><p>€650 per month. Available now.</p>")],
    [/555002/, page(meta(1.5), "<h1>Dromroe Village room</h1><p>€480 per month. Available now until June 2027.</p>")],
    [/555003/, page(meta(1.0), "<h1>Newtown flat</h1><p>€900 per month. Available from 05/10/2026.</p>")],
  ]);
  const { store, pusher } = setup(["rent"], { rentUrls: [RENT_LIST] });
  const scanner = scannerFor(store, pusher, fetchImpl);
  await scanner.run();
  pusher.sent.length = 0;
  items = RENT_PAGE.replace("</ul>", `<li><h3><a href="/rooms-to-rent/limerick/castletroy/newtown-flat/555003">Newtown flat</a></h3><p>€900 per month</p></li></ul>`);
  await scanner.run();
  assert.equal(pusher.sent.length, 1);
  assert.match(pusher.sent[0].title, /^€900\/mo · Newtown flat/);
  assert.match(pusher.sent[0].body, /1\.0 km from University of Limerick · Rent\.ie · from 2026-10-05/);
});

test("404 on a guessed URL is reported as skipped, not as a failure", async () => {
  const fetchImpl = router([[RENT_LIST, RENT_PAGE], [/555001/, page(meta(0.7), "<h1>x</h1><p>€650 per month</p>")], [/555002/, page(meta(0.7), "<h1>y</h1><p>€480 per month</p>")]]);
  const { store, pusher } = setup(["rent"], { rentUrls: [RENT_LIST, "https://www.rent.ie/houses-to-rent/limerick/castletroy/"] });
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(run.ok, true);
  assert.match(run.sources[0].notes[1].skipped, /404/);
  assert.equal(run.matches, 2);
});

test("structured data sources (MyHome-style Next.js JSON) are scraped with coordinates", async () => {
  const MYHOME = "https://www.myhome.ie/rentals/limerick/property-to-rent";
  const p = kmNorth(1.1);
  const data = { props: { pageProps: { results: [
    { id: 4400123, price: 1450, displayAddress: "7 Elm Park, Castletroy", url: "/rentals/brochure/7-elm-park/4400123", latitude: p.lat, longitude: p.lng, bedrooms: 3 },
    { id: 4400124, price: 1600, displayAddress: "Far Away House, Ennis", url: "/rentals/brochure/far/4400124", latitude: 52.84, longitude: -8.98, bedrooms: 3 },
  ] } } };
  const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></head><body>${"<p>x</p>".repeat(50)}</body></html>`;
  const fetchImpl = router([[MYHOME, html], [/4400123|4400124/, page("", "<h1>Brochure</h1><p>Available now. €1450 per month</p>")]]);
  const { store, pusher } = setup(["myhome"], { myhomeUrls: [MYHOME] });
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(run.candidates, 2);
  assert.deepEqual(store.data.matches.map((m) => m.id), ["myhome:4400123"]);
  assert.equal(store.data.matches[0].kind, "property");
});

test("geocoder: caches results, rejects far matches, falls back to area, honours budget", async () => {
  const { store } = tempStore();
  const fetchImpl = router([nominatim({
    "14 plassey park": { lat: "52.6700", lon: "-8.5700", addresstype: "house" },
    "castletroy": { lat: "52.6690", lon: "-8.5500", addresstype: "suburb" },
    "dublin street": { lat: "53.35", lon: "-6.26", addresstype: "road" },
  })]);
  const geo = createGeocoder({ store, fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  const budget = { geocode: 10, exhausted: false };

  const exact = await geo.geocode("14 Plassey Park, Castletroy", UL, budget);
  assert.deepEqual([exact.lat, exact.coarse], [52.67, false]);
  const again = await geo.geocode("14 Plassey Park, Castletroy", UL, budget);
  assert.equal(again.lat, 52.67);
  assert.equal(fetchImpl.count(/nominatim/), 1, "second lookup served from cache");

  const fallback = await geo.geocode("99 Unknown Road, Castletroy", UL, budget);
  assert.equal(fallback.coarse, true, "fell back to the area");
  assert.equal(await geo.geocode("Dublin Street", UL, budget), null, "beyond 40 km of the centre is rejected");

  const tight = { geocode: 0, exhausted: false };
  assert.equal(await geo.geocode("Brand New Place, Somewhere", UL, tight), null);
  assert.equal(tight.exhausted, true);
});

test("address queries strip room descriptors and prices", () => {
  assert.deepEqual(addressQueries({ address: "", title: "Double room, 14 Plassey Park, Castletroy" }), ["14 Plassey Park, Castletroy"]);
  assert.deepEqual(addressQueries({ address: "12 Plassey Village, Castletroy", title: "Room €500 per month" }), ["12 Plassey Village, Castletroy"]);
  assert.deepEqual(addressQueries({ address: "", title: "Double room €650 per month" }), []);
});

const L = (over) => makeListing({ source: "daft", sourceLabel: "Daft.ie", externalId: Math.random().toString(36).slice(2), url: `https://x.ie/${Math.random()}`, title: "Room", priceText: "€650 per month", ...over });

test("dedupe: cross-site copies merge; same-site ads, different houses and different prices do not", () => {
  const a = L({ source: "daft", title: "14 Plassey Park, Castletroy", lat: 52.67, lng: -8.57 });
  const b = L({ source: "rent", sourceLabel: "Rent.ie", title: "Room 14 Plassey Park Castletroy", lat: 52.67003, lng: -8.57002 });
  const sameSite = L({ source: "daft", title: "14 Plassey Park, Castletroy", lat: 52.67, lng: -8.57 });
  const otherHouse = L({ source: "rent", sourceLabel: "Rent.ie", title: "16 Plassey Park, Castletroy", lat: 52.67003, lng: -8.57002 });
  const otherPrice = L({ source: "myhome", sourceLabel: "MyHome.ie", title: "14 Plassey Park, Castletroy", priceText: "€900 per month", lat: 52.67, lng: -8.57 });

  const out = dedupe([a, b, sameSite, otherHouse, otherPrice]);
  assert.equal(out.length, 4);
  const merged = out.find((o) => o.memberIds.includes(a.id));
  assert.deepEqual(merged.memberIds.sort(), [a.id, b.id].sort());
  assert.equal(merged.alsoOn[0].label, "Rent.ie");
});

test("dedupe: listing with real coordinates beats a geocoded copy; identical URLs always merge", () => {
  const geocoded = L({ source: "daft", title: "5 Elm Park, Castletroy" });
  geocoded.lat = 52.67; geocoded.lng = -8.57; geocoded.distanceSource = "geocoded";
  const real = L({ source: "rent", sourceLabel: "Rent.ie", title: "5 Elm Park Castletroy", lat: 52.67001, lng: -8.57001 });
  assert.equal(dedupe([geocoded, real])[0].source, "rent");
  const u1 = L({ url: "https://www.rent.ie/a/1/", source: "rent" });
  const u2 = L({ url: "https://rent.ie/a/1", source: "rent", title: "Different title", priceText: "€1 per month" });
  assert.equal(dedupe([u1, u2]).length, 1);
});
