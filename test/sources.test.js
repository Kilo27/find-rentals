import test from "node:test";
import assert from "node:assert/strict";
import { createScanner } from "../src/scan.js";
import { createGeocoder, addressQueries } from "../src/geocode.js";
import { dedupe } from "../src/dedupe.js";
import { makeListing } from "../src/listing.js";
import { configure, daftPage, noSleep, rawListing, router, searchOf, tempStore, fakePusher, UL, kmNorth } from "./helpers.js";

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
  configure(store, { sources, ulUrls: [UL_LIST], rentUrls: [], myhomeUrls: [], webUrls: [], ...cfg });
  return { store, pusher };
}

const scannerFor = (store, pusher, fetchImpl) =>
  createScanner({ store, pusher, fetchImpl, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, now: () => new Date("2026-09-30T12:00:00Z") });

// Shape taken from the live portal: the list page already carries address (as the title), price,
// availability and landlord type. The advert pages themselves are an empty JavaScript shell whose
// only coordinates are one site-wide map position.
const CAMPUS_CONSTANT = { lat: 52.668738, lng: -8.576748 };
const ulCard = ({ id, address, price, avail = "Now", type = "Room in House / Apartment with other tenants", note = "" }) => `
<div class="advert"><a href="/Advert/${id}">${address}</a>
  <div>Available: ${avail} 2 LMKP${id} ${price} Full price list Locate on map Rent Includes: Electricity, Heating, Water, Bills, Wi-Fi / Internet
  ${address} ${type} Individuals Rooms (1 Available) ${avail} Flexible/ Academic year Description ${note}
  Call SMS Tel: 08************* Click to view contact info Details Add to Hot List Report As Let 0 ${type} Rent: ${price} Available ${avail} Please Wait...</div></div>`;

const UL_REAL_LIST = `<html><body><div id="results">
  ${ulCard({ id: 2001, address: "Dromroe Village, Castletroy", price: "€520 Per person per month" })}
  ${ulCard({ id: 2002, address: "The Meadows, Limerick", price: "€850 Per person per month", type: "Resident Landlord/Host Family, Room in House / Apartment with other tenants" })}
  ${ulCard({ id: 2003, address: "Garraunykee, Castleconnell", price: "€150 Per person per week" })}
  ${ulCard({ id: 2004, address: "Plassey Park Road, Castletroy", price: "€480 Per person per month", avail: "01/11/2026" })}
  ${ulCard({ id: 2005, address: "Dublin Rd, Castletroy", price: "€150 Per person per week" })}
  ${ulCard({ id: 2006, address: "Unknown Lane, Castletroy", price: "€500 Per person per month" })}
  ${ulCard({ id: 2007, address: "Mystery Place", price: "€400 Per person per month", note: "5 min from UL, close to Castletroy shops" })}
  ${ulCard({ id: 2008, address: "Weekday Room, Castletroy", price: "€300 Per person per month", note: "Monday to Friday only" })}
</div></body></html>`;

const campusShell = `<html><head><title>Student Property Details</title>
  <script>var map = {"latitude": ${CAMPUS_CONSTANT.lat}, "longitude": ${CAMPUS_CONSTANT.lng}};</script></head><body><main>Please Wait...</main></body></html>`;

test("UL portal: decisions come from the list page; advert shells and their map constant are never used", async () => {
  const fetchImpl = router([
    [UL_LIST, UL_REAL_LIST],
    [/\/Advert\/\d+/, campusShell],
    nominatim({
      "dromroe village": { lat: String(kmNorth(1.0).lat), lon: String(UL.lng), addresstype: "residential" },
      "garraunykee": { lat: "52.7300", lon: "-8.4400", addresstype: "hamlet" },
      "dublin rd": { lat: String(kmNorth(1.6).lat), lon: String(UL.lng), addresstype: "road" },
      castletroy: { lat: String(kmNorth(0.6).lat), lon: String(UL.lng), addresstype: "suburb" },
    }),
  ]);
  const { store, pusher } = setup(["ul"]);
  const run = await scannerFor(store, pusher, fetchImpl).run();

  assert.equal(run.ok, true);
  assert.equal(run.candidates, 8);
  assert.equal(fetchImpl.count(/\/Advert\/\d+/), 0, "the JavaScript shell pages are not fetched at all");

  const ids = searchOf(store).matches.map((m) => m.id).sort();
  assert.deepEqual(ids, ["ul:2001", "ul:2005", "ul:2006"], "owner-occupied, far, late, weekday-only and locationless adverts are excluded");

  for (const m of searchOf(store).matches) {
    assert.notEqual(m.distanceSource, "source", "no page coordinate was trusted");
    assert.ok(Math.abs(m.lat - CAMPUS_CONSTANT.lat) > 0.001 || Math.abs(m.lng - CAMPUS_CONSTANT.lng) > 0.001, "never the campus constant");
  }
  const by = (id) => searchOf(store).matches.find((m) => m.id === id);
  assert.equal(by("ul:2001").distanceSource, "geocoded");
  assert.ok(Math.abs(by("ul:2001").distanceKm - 1.0) < 0.05);
  assert.ok(Math.abs(by("ul:2005").distanceKm - 1.6) < 0.05);
  assert.equal(by("ul:2005").priceMonthly, 650, "weekly price converted");
  assert.equal(by("ul:2006").distanceSource, "geocoded-area");
  assert.ok(by("ul:2006").flags.includes("distance-approx"));
  assert.ok(by("ul:2001").flags.includes("available-now"));
});

test("UL portal: marketing text naming a nearby area does not make an unlocatable advert nearby", async () => {
  const fetchImpl = router([[UL_LIST, UL_REAL_LIST], nominatim({})]);
  const { store, pusher } = setup(["ul"], { unverifiedDistance: "locality" });
  await scannerFor(store, pusher, fetchImpl).run();
  assert.ok(!searchOf(store).matches.some((m) => m.id === "ul:2007"), "Mystery Place stays excluded");
});

test("a coordinate shared by many different listings is a site-wide position and is ignored, even for new listings later", async () => {
  const RENT = "https://www.rent.ie/rooms-to-rent/limerick/castletroy/";
  const cards = (ids) => `<html><body><ul>${ids.map((id) => `<li><h3><a href="/rooms-to-rent/limerick/castletroy/listing-${id}/${id}">Some Road ${id}, Somewhere</a></h3><p>€500 per month</p></li>`).join("")}</ul></body></html>`;
  const sameMap = `<meta property="place:location:latitude" content="${CAMPUS_CONSTANT.lat}"><meta property="place:location:latitude" content="${CAMPUS_CONSTANT.lat}"><meta property="place:location:longitude" content="${CAMPUS_CONSTANT.lng}">`;
  const detail = (id) => page(sameMap, `<h1>Room ${id}</h1><p>A fine room available now, bills included, quiet estate, close to everything you need.</p>`);
  let ids = [555101, 555102, 555103, 555104];
  const fetchImpl = router([
    [RENT, () => cards(ids)],
    [/rent\.ie\/rooms-to-rent\/.*\/555\d+$/, (url) => detail(url.slice(-6))],
    nominatim({ "some road 555101": { lat: String(kmNorth(0.8).lat), lon: String(UL.lng), addresstype: "road" }, "some road 555102": { lat: "52.80", lon: "-8.30", addresstype: "road" } }),
  ]);
  const { store, pusher } = setup(["rent"], { rentUrls: [RENT], unverifiedDistance: "exclude" });
  const scanner = scannerFor(store, pusher, fetchImpl);
  const run = await scanner.run();

  assert.equal(run.coordsIgnored.rent, 4, "all four carried the same map position");
  assert.deepEqual(store.data.siteConstants.rent, [`${CAMPUS_CONSTANT.lat.toFixed(4)},${CAMPUS_CONSTANT.lng.toFixed(4)}`]);
  assert.deepEqual(searchOf(store).matches.map((m) => m.id), ["rent:555101"], "the near one, located from its address; the 10 km one rejected; unlocatable ones excluded");
  assert.equal(searchOf(store).matches[0].distanceSource, "geocoded");

  ids = [555105];
  const again = await scanner.run();
  assert.equal(again.coordsIgnored.rent, 1, "alone it could not be detected as shared, but the remembered constant catches it");
});

test("an advert page that is a loading shell contributes no location, and is not refetched every scan", async () => {
  const RENT = "https://www.rent.ie/rooms-to-rent/limerick/castletroy/";
  const list = `<html><body><ul><li><h3><a href="/rooms-to-rent/limerick/castletroy/x/555201">9 Elm Park, Castletroy</a></h3><p>€600 per month</p></li></ul></body></html>`;
  const fetchImpl = router([
    [RENT, list],
    [/555201/, campusShell],
    nominatim({ "9 elm park": { lat: String(kmNorth(1.1).lat), lon: String(UL.lng), addresstype: "house" } }),
  ]);
  const { store, pusher } = setup(["rent"], { rentUrls: [RENT] });
  const scanner = scannerFor(store, pusher, fetchImpl);
  const run = await scanner.run();
  assert.match(run.sources[0].notes[0].warning, /JavaScript-rendered/);
  const m = searchOf(store).matches[0];
  assert.equal(m.distanceSource, "geocoded");
  assert.ok(Math.abs(m.distanceKm - 1.1) < 0.05);
  await scanner.run();
  assert.equal(fetchImpl.count(/555201/), 1, "the unusable page is remembered, not refetched");
});

test("scraped page coordinates are cross-checked against the address and corrected when they disagree", async () => {
  const RENT = "https://www.rent.ie/rooms-to-rent/limerick/castletroy/";
  const p = kmNorth(0.5);
  const list = `<html><body><div id="r"><div class="c"><a href="/rooms-to-rent/x/555301">7 Far Road, Ennis</a>
    <span data-lat="${p.lat.toFixed(5)}" data-lng="${p.lng.toFixed(5)}"></span> €700 per month</div></div></body></html>`;
  const fetchImpl = router([
    [RENT, list],
    [/555301/, page("", "<h1>7 Far Road</h1><p>A room in a shared house with three other tenants, bills included.</p>")],
    nominatim({ "7 far road": { lat: "52.84", lon: "-8.98", addresstype: "house" } }),
  ]);
  const { store, pusher } = setup(["rent"], { rentUrls: [RENT] });
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(run.matches, 0, "the card says 0.5 km but the address is in Ennis: rejected");
});

test("card-level coordinates that are unique and agree with the address are used", async () => {
  const RENT = "https://www.rent.ie/rooms-to-rent/limerick/castletroy/";
  const p = kmNorth(0.9);
  const list = `<html><body><div id="r"><div class="c"><a href="/rooms-to-rent/x/555401">3 Near Road, Castletroy</a>
    <span data-lat="${p.lat.toFixed(5)}" data-lng="${p.lng.toFixed(5)}"></span> €700 per month</div></div></body></html>`;
  const fetchImpl = router([
    [RENT, list],
    [/555401/, page("", "<h1>3 Near Road</h1><p>A room in a shared house with three other tenants, bills included.</p>")],
    nominatim({ "3 near road": { lat: String(kmNorth(0.95).lat), lon: String(UL.lng), addresstype: "house" } }),
  ]);
  const { store, pusher } = setup(["rent"], { rentUrls: [RENT] });
  await scannerFor(store, pusher, fetchImpl).run();
  const m = searchOf(store).matches[0];
  assert.equal(m.distanceSource, "source");
  assert.ok(Math.abs(m.distanceKm - 0.9) < 0.02);
});

test("price-filter chips and other junk links are not listings", async () => {
  const PAGE = "https://agent.example.ie/lettings/limerick";
  const html = `<html><body><ul><li><a href="/lettings/limerick/max-500000">Under €500k</a></li>
    <li><a href="/lettings/limerick/min-100000">€100k</a></li>
    <li><a href="/lettings/limerick/let-6600123">4 Castle Street, Limerick</a> €1,200 per month</li></ul></body></html>`;
  const fetchImpl = router([[PAGE, html], [/6600123/, page("", "<h1>4 Castle Street</h1><p>A bright apartment in the city centre, available now, bills not included.</p>")]]);
  const { store, pusher } = setup(["web"], { webUrls: [PAGE] });
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(run.candidates, 1);
});

test("detail budget: un-enriched listings are pending, not alerted, and baseline waits", async () => {
  const RENT = "https://www.rent.ie/rooms-to-rent/limerick/castletroy/";
  const ids = [555501, 555502, 555503, 555504];
  const list = `<html><body><ul>${ids.map((id) => `<li><h3><a href="/rooms-to-rent/limerick/castletroy/r/${id}">${id} Quiet Road, Castletroy</a></h3><p>€500 per month</p></li>`).join("")}</ul></body></html>`;
  const fetchImpl = router([
    [RENT, list],
    [/rent\.ie\/rooms-to-rent\/.*\/5555\d\d$/, (url) => page(meta(0.5 + Number(url.slice(-2)) / 100), "<h1>Room</h1><p>A nice room in a shared house, available now, with bills included.</p>")],
  ]);
  const { store, pusher } = setup(["rent"], { rentUrls: [RENT], maxDetailFetches: 2 });
  const scanner = scannerFor(store, pusher, fetchImpl);

  const first = await scanner.run();
  assert.equal(first.pending, 2);
  assert.equal(searchOf(store).baselineDone, false);
  assert.equal(pusher.sent.length, 0, "no premature 'watching started'");
  const second = await scanner.run();
  assert.equal(second.pending, 0);
  assert.equal(searchOf(store).baselineDone, true);
  assert.equal(searchOf(store).matches.length, 4);
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
  assert.ok(store.data.debug[`limerick/ul:${UL_LIST}`].head, "raw head saved for diagnosis");
});

test("a source that keeps returning nothing usable triggers a health alert, then recovery", async () => {
  let good = false;
  const fetchImpl = router([[UL_LIST, () => (good ? ULPAGES.list : `<html><body>${"<p>blocked</p>".repeat(400)}</body></html>`)], ...ulRoutes().slice(1)]);
  const { store, pusher } = setup(["ul", "daft"], { sections: ["sharing"] });
  fetchImpl.calls.length = 0;
  const daftOk = router([[/^https:\/\/www\.daft\.ie\/sharing\//, daftPage([])]]);
  const combined = async (url, opts) => (url.includes("www.daft.ie") ? daftOk(url, opts) : fetchImpl(url, opts));
  const scanner = scannerFor(store, pusher, combined);
  for (let i = 0; i < 6; i++) await scanner.run();
  assert.equal(pusher.ops().filter((p) => /looks broken/.test(p.title)).length, 1);
  assert.match(pusher.ops().find((p) => /looks broken/.test(p.title)).title, /UL Accommodation/);
  assert.ok(!pusher.sent.some((p) => /looks broken/.test(p.title)), "only the admin is told a source is broken");
  good = true;
  pusher.sent.length = 0;
  pusher.sentToOwner.length = 0;
  await scanner.run();
  assert.ok(pusher.ops().some((p) => /working again/.test(p.title)));
  assert.ok(!pusher.sent.some((p) => /working again/.test(p.title)));
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
    [/^https:\/\/www\.daft\.ie\/sharing\//, daftPage([daftItem])],
    [RENT_LIST, RENT_PAGE],
    [/rent\.ie\/rooms-to-rent\/limerick\/castletroy\/14-plassey-park\/555001/, page(`<meta property="place:location:latitude" content="${p.lat.toFixed(5)}"><meta property="place:location:longitude" content="${p.lng.toFixed(5)}">`, "<h1>14 Plassey Park, Castletroy</h1><p>€650 per month. Available now.</p>")],
    [/rent\.ie\/rooms-to-rent\/limerick\/castletroy\/dromroe-village\/555002/, page(meta(1.5), "<h1>Dromroe Village room</h1><p>€480 per month. Available now.</p>")],
  ]);
  const { store, pusher } = setup(["daft", "rent"], { sections: ["sharing"], rentUrls: [RENT_LIST] });
  const scanner = scannerFor(store, pusher, fetchImpl);
  const run = await scanner.run();

  assert.equal(run.candidates, 3);
  assert.equal(run.matches, 2, "Plassey Park merged; Dromroe separate");
  const merged = searchOf(store).matches.find((m) => m.title.includes("Plassey"));
  assert.equal(merged.source, "daft", "Daft wins ties (API coordinates)");
  assert.deepEqual(merged.alsoOn.map((a) => a.label), ["Rent.ie"]);
  assert.ok(searchOf(store).seen["daft:77"] && searchOf(store).seen["rent:555001"], "both ids marked seen");

  // the Daft copy vanishes: the Rent.ie copy must NOT re-alert as new
  pusher.sent.length = 0;
  const gone = router([
    [/^https:\/\/www\.daft\.ie\/sharing\//, daftPage([])],
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
  assert.deepEqual(searchOf(store).matches.map((m) => m.id), ["myhome:4400123"]);
  assert.equal(searchOf(store).matches[0].kind, "property");
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

test("upgrade: stale cache entries from the old code (loading shells with the campus constant) are purged, healthy ones kept", async () => {
  const fetchImpl = router([[UL_LIST, UL_REAL_LIST], nominatim({})]);
  const { store, pusher } = setup(["ul"]);
  const polluted = { at: new Date().toISOString(), detail: { title: "Student Property Details", text: "Please Wait...", lat: CAMPUS_CONSTANT.lat, lng: CAMPUS_CONSTANT.lng, address: "", priceText: "", image: null }, lastSeen: new Date().toISOString() };
  const healthy = { at: new Date().toISOString(), detail: { title: "Real", text: "A perfectly good description of a room with enough words in it to be useful.", lat: 52.67, lng: -8.57, address: "", priceText: "€500", image: null }, lastSeen: new Date().toISOString() };
  store.data.pageCache = { "ul:999": polluted, "rent:1": { ...polluted }, "rent:2": healthy };
  await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(store.data.pageCache["ul:999"], undefined);
  assert.equal(store.data.pageCache["rent:1"], undefined, "a tiny 'Please Wait' entry is removed for any source");
  assert.ok(store.data.pageCache["rent:2"], "a healthy entry survives");
});

test("MyHome-style list JSON with null coordinates falls through to the real ones on each advert page", async () => {
  const MYHOME = "https://www.myhome.ie/rentals/limerick/property-to-rent";
  const rows = [
    { id: 7001, price: 1200, displayAddress: "5 Near Close, Castletroy", url: "/rentals/brochure/5-near-close/7001", latitude: null, longitude: null },
    { id: 7002, price: 2500, displayAddress: "35 Far Quay, Corbally", url: "/rentals/brochure/35-far-quay/7002", latitude: null, longitude: null },
    { id: 7003, price: 900, displayAddress: "9 Other Road, Rathkeale", url: "/rentals/brochure/9-other-road/7003", latitude: null, longitude: null },
  ];
  const listHtml = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { results: rows } })}</script></head><body>${"<p>x</p>".repeat(40)}
    ${rows.map((r) => `<a href="${r.url}">${r.displayAddress}</a> €${r.price} / month`).join("\n")}</body></html>`;
  const d = (km, text) => page(`<meta property="place:location:latitude" content="${kmNorth(km).lat.toFixed(5)}"><meta property="place:location:longitude" content="${kmNorth(km).lng.toFixed(5)}">`, `<h1>Brochure</h1><p>${text} A bright property with good transport links and all amenities nearby, available now.</p>`);
  const fetchImpl = router([
    [MYHOME, listHtml],
    [/7001/, d(0.8, "Near.")],
    [/7002/, d(3.0, "Far.")],
    [/7003/, d(22, "Other.")],
  ]);
  const { store, pusher } = setup(["myhome"], { myhomeUrls: [MYHOME] });
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.deepEqual(run.coordsIgnored, {}, "no phantom shared 0,0 coordinate");
  assert.deepEqual(searchOf(store).matches.map((m) => m.id), ["myhome:7001"], "3.0 km and 22 km are outside 2 km");
  assert.equal(searchOf(store).matches[0].distanceSource, "source");
  assert.ok(Math.abs(searchOf(store).matches[0].distanceKm - 0.8) < 0.02);
});

test("an empty trailing results page is normal, not a layout warning", async () => {
  const WEB = "https://lettings.example.ie/rooms/castletroy/";
  const p1 = `<html><body><ul><li><h3><a href="/rooms/castletroy/a/555701">1 Quiet Road, Castletroy</a></h3><p>€500 per month</p></li></ul></body></html>`;
  const empty = `<html><body>${"<p>That's everything for now, check back soon for more rooms in your area.</p>".repeat(40)}</body></html>`;
  const fetchImpl = router([
    [WEB, p1],
    [`${WEB}?page=2`, empty],
    [/555701/, page(meta(0.7), "<h1>Room</h1><p>A nice room in a shared house, available now, with bills included.</p>")],
  ]);
  const { store, pusher } = setup(["web"], { webUrls: [WEB] });
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(fetchImpl.count(/\?page=2$/), 1);
  assert.equal(run.sources[0].notes[0].warning, undefined);
  assert.equal(run.matches, 1);
});

test("Rent.ie reads only its first results page: ?page= is ignored there and its own pagination is robots-disallowed", async () => {
  const RENT = "https://www.rent.ie/rooms-to-rent/limerick/castletroy/";
  const p1 = `<html><body><ul><li><h3><a href="/rooms-to-rent/1-Quiet-Road-Castletroy-Co-Limerick/6555801/">1 Quiet Road, Castletroy</a></h3><p>€500 per month</p></li></ul></body></html>`;
  const fetchImpl = router([
    [RENT, p1],
    [/6555801/, page(meta(0.7), "<h1>Room</h1><p>A nice room in a shared house, available now, with bills included.</p>")],
  ]);
  const { store, pusher } = setup(["rent"], { rentUrls: [RENT] });
  const run = await scannerFor(store, pusher, fetchImpl).run();
  assert.equal(fetchImpl.count(/page/), 0);
  assert.equal(run.matches, 1);
});

test("list data carrying literal 0,0 or NaN coordinates still gets the advert page's real ones (the live MyHome case)", async () => {
  const MYHOME = "https://www.myhome.ie/rentals/limerick/property-to-rent";
  const rows = [
    { id: 7101, price: 1200, displayAddress: "5 Near Close, Castletroy", url: "/rentals/brochure/5-near-close/7101", latitude: 0, longitude: 0 },
    { id: 7102, price: 2500, displayAddress: "35 Far Quay, Corbally", url: "/rentals/brochure/35-far-quay/7102", latitude: 0, longitude: 0 },
  ];
  const jsonLd = { "@type": "Apartment", name: "7 Jsonld Road, Castletroy", url: "/rentals/brochure/7-jsonld/7103", offers: { price: "1100" }, geo: { latitude: null, longitude: null } };
  const listHtml = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { results: rows } })}</script>
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>${"<p>x</p>".repeat(40)}
    ${rows.map((r) => `<a href="${r.url}">${r.displayAddress}</a> €${r.price} / month`).join("\n")}</body></html>`;
  const d = (km) => page(`<meta property="place:location:latitude" content="${kmNorth(km).lat.toFixed(5)}"><meta property="place:location:longitude" content="${kmNorth(km).lng.toFixed(5)}">`, "<h1>Brochure</h1><p>A bright property with good transport links and all amenities nearby, available now.</p>");
  const fetchImpl = router([[MYHOME, listHtml], [/7101/, d(0.8)], [/7102/, d(3.0)], [/7103/, d(1.2)]]);
  const { store, pusher } = setup(["myhome"], { myhomeUrls: [MYHOME] });
  const run = await scannerFor(store, pusher, fetchImpl).run();

  assert.equal(run.candidates, 3);
  assert.deepEqual(searchOf(store).matches.map((m) => m.id).sort(), ["myhome:7101", "myhome:7103"], "the 3.0 km one is rejected on its real coordinates");
  for (const m of searchOf(store).matches) assert.equal(m.distanceSource, "source", `${m.id} uses the advert page's coordinates, not a guess`);
  assert.ok(Math.abs(searchOf(store).matches.find((m) => m.id === "myhome:7101").distanceKm - 0.8) < 0.02);
  assert.ok(Math.abs(searchOf(store).matches.find((m) => m.id === "myhome:7103").distanceKm - 1.2) < 0.02);
});
