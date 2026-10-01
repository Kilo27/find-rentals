import test from "node:test";
import assert from "node:assert/strict";
import {
  SourceError,
  candidatesFromEmbeddedJson,
  candidatesFromJsonLd,
  coordsFromHtml,
  createFetcher,
  externalIdFromUrl,
  extractCards,
  extractEmbeddedJson,
  extractJsonLd,
  isAllowed,
  isSafeUrl,
  load,
  parseDetailPage,
  parseRobots,
} from "../src/html.js";
import { router } from "./helpers.js";

const UL = { lat: 52.6733, lng: -8.5739 };

test("isSafeUrl blocks private targets and plain http", () => {
  assert.equal(isSafeUrl("https://www.rent.ie/x"), true);
  for (const u of ["http://www.rent.ie/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://db.railway.internal/x", "https://[::1]/x", "ftp://x.ie/y", "not a url"]) {
    assert.equal(isSafeUrl(u, false), false, u);
  }
  assert.equal(isSafeUrl("http://127.0.0.1:4010/x", true), true);
});

const ROBOTS = `
User-agent: *
Disallow: /private/
Disallow: /search?
Allow: /search?q=ok
Disallow: /*.json$

User-agent: rentalwatch
Disallow: /blocked-for-us/
`;

test("robots.txt: specific group wins over *, longest rule wins, wildcards work", () => {
  const generic = parseRobots(ROBOTS, "otherbot");
  assert.equal(isAllowed(generic, "/private/x"), false);
  assert.equal(isAllowed(generic, "/search?page=2"), false);
  assert.equal(isAllowed(generic, "/search?q=ok"), true, "Allow is longer than Disallow prefix");
  assert.equal(isAllowed(generic, "/data.json"), false);
  assert.equal(isAllowed(generic, "/rooms/123"), true);

  const ours = parseRobots(ROBOTS, "rentalwatch");
  assert.equal(isAllowed(ours, "/private/x"), true, "our group does not disallow /private/");
  assert.equal(isAllowed(ours, "/blocked-for-us/x"), false);
  assert.deepEqual(parseRobots("", "x"), []);
});

test("fetcher: honours robots.txt, treats 404 as allow and 5xx as disallow", async () => {
  const f1 = createFetcher({
    politenessMs: 0,
    fetchImpl: router([
      ["https://a.example.ie/robots.txt", "User-agent: *\nDisallow: /nope/"],
      [/a\.example\.ie\/ok/, "<html>ok</html>"],
    ]),
  });
  assert.equal((await f1.get("https://a.example.ie/ok")).html, "<html>ok</html>");
  await assert.rejects(f1.get("https://a.example.ie/nope/x"), (e) => e instanceof SourceError && e.code === "robots");

  const f2 = createFetcher({ politenessMs: 0, fetchImpl: router([[/b\.example\.ie\/ok/, "<html>b</html>"]]) });
  assert.equal((await f2.get("https://b.example.ie/ok")).html, "<html>b</html>");

  const f3 = createFetcher({
    politenessMs: 0,
    fetchImpl: router([
      ["https://c.example.ie/robots.txt", () => new Response("err", { status: 503 })],
      [/c\.example\.ie\/ok/, "<html>c</html>"],
    ]),
  });
  await assert.rejects(f3.get("https://c.example.ie/ok"), (e) => e.code === "robots");

  const f4 = createFetcher({ politenessMs: 0, respectRobots: false, fetchImpl: router([["https://d.example.ie/x", "<html>d</html>"]]) });
  assert.equal((await f4.get("https://d.example.ie/x")).status, 200);
});

test("fetcher: per-host politeness delay and HTTP errors", async () => {
  let t = 1000;
  const sleeps = [];
  const f = createFetcher({
    politenessMs: 1000,
    respectRobots: false,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    fetchImpl: router([[/x\.example\.ie\/p/, "<html></html>"]]),
  });
  await f.get("https://x.example.ie/p1");
  await f.get("https://x.example.ie/p2");
  assert.deepEqual(sleeps, [1000]);
  await assert.rejects(f.get("https://x.example.ie/missing"), (e) => e.status === 404);
  await assert.rejects(f.get("http://x.example.ie/p1"), (e) => e.code === "unsafe-url");
});

test("fetcher: names itself honestly, never as Chrome (Cloudflare refuses a fake browser from any network)", async () => {
  const fetchImpl = router([[/x\.example\.ie/, "<html></html>"]]);
  await createFetcher({ politenessMs: 0, respectRobots: false, fetchImpl }).get("https://x.example.ie/p");
  const ua = fetchImpl.calls[0].opts.headers["User-Agent"];
  assert.match(ua, /RentalWatch\/1\.0/);
  assert.doesNotMatch(ua, /Chrome\/|Safari\/|AppleWebKit/);
});

test("fetcher: an HTTP error keeps the start of the page, so a bot wall can be told apart", async () => {
  const fetchImpl = router([[/x\.example\.ie/, () => new Response(`<html><title>Security Check | Rent.ie</title>${"x".repeat(1000)}</html>`, { status: 403 })]]);
  const f = createFetcher({ politenessMs: 0, respectRobots: false, fetchImpl });
  await assert.rejects(f.get("https://x.example.ie/p"), (e) => e.status === 403 && /Security Check/.test(e.body) && e.body.length === 300);
});

const CARDS = `<html><body>
<ul class="results">
  <li class="r"><a href="/rooms-to-rent/limerick/castletroy/14-plassey-park/555001"><img src="/img/1.jpg"></a>
    <h3><a href="/rooms-to-rent/limerick/castletroy/14-plassey-park/555001">14 Plassey Park, Castletroy</a></h3>
    <p>€650 per month</p><p>1 bedroom</p></li>
  <li class="r"><div><a href="/rooms-to-rent/limerick/castletroy/dromroe-village/555002">Dromroe Village</a>
    <span>€150 per week</span></div></li>
  <li><a href="/about-us">About us</a></li>
</ul></body></html>`;

test("extractCards finds one card per listing link without class names", () => {
  const $ = load(CARDS);
  const cards = extractCards($, "https://www.rent.ie/rooms-to-rent/limerick/castletroy/", /\d{5,}\/?$/);
  assert.equal(cards.length, 2);
  const a = cards.find((c) => c.url.endsWith("555001"));
  assert.equal(a.title, "14 Plassey Park, Castletroy");
  assert.equal(a.priceText, "€650 per month");
  assert.equal(a.bedsText, "1 Bed");
  assert.equal(a.image, "https://www.rent.ie/img/1.jpg");
  const b = cards.find((c) => c.url.endsWith("555002"));
  assert.equal(b.priceText, "€150 per week");
  assert.ok(!b.text.includes("Plassey"), "cards must not bleed into each other");
});

test("extractCards handles table rows", () => {
  const $ = load(`<table><tr><td><a href="/Advert/1001">Double room</a></td><td>€650</td></tr><tr><td><a href="/Advert/1002">Single room</a></td><td>€500</td></tr></table>`);
  const cards = extractCards($, "https://www.accommodation.ul.ie/SearchResults/Print/All", /\/Advert\/\d+/i);
  assert.deepEqual(cards.map((c) => [c.title, c.priceText]), [["Double room", "€650"], ["Single room", "€500"]]);
});

test("JSON-LD listings are extracted", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
    {"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Apartment","name":"2 bed apartment, Plassey","url":"/p/777001","offers":{"price":"1200","priceCurrency":"EUR"},"geo":{"latitude":52.671,"longitude":-8.571},"address":{"streetAddress":"5 Plassey Rd","addressLocality":"Castletroy"},"numberOfBedrooms":2}}]}]}</script>`;
  const $ = load(html);
  const c = candidatesFromJsonLd(extractJsonLd($), "https://www.myhome.ie/rentals/limerick");
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].url, c[0].priceText, c[0].lat, c[0].address, c[0].bedsText], ["https://www.myhome.ie/p/777001", "€1200", 52.671, "5 Plassey Rd, Castletroy", "2 Bed"]);
});

test("embedded JSON state (Next.js style) yields listings; junk objects are ignored", () => {
  const data = { props: { pageProps: { results: [
    { id: 9001, price: 1500, displayAddress: "3 Elm Park, Castletroy", url: "/brochure/3-elm/9001", latitude: 52.67, longitude: -8.57, bedrooms: 3 },
    { id: 9002, price: "€700 per month", title: "Room, Plassey", link: "/brochure/room/9002", location: { lat: "52.672", lng: "-8.570" } },
    { id: 1, label: "menu item" },
    { id: 9003, price: 900, title: "No url listing" },
  ] } } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
  const $ = load(html);
  const c = candidatesFromEmbeddedJson(extractEmbeddedJson($, html), "https://www.myhome.ie/rentals/x");
  assert.equal(c.length, 2);
  assert.equal(c[0].priceText, "€1500");
  assert.equal(c[0].lat, 52.67);
  assert.equal(c[1].lat, 52.672);
  assert.equal(c[1].bedsText, null);
});

test("embedded window state is parsed with balanced braces", () => {
  const html = `<script>window.__INITIAL_STATE__ = {"a":{"x":"}{"},"list":[{"id":5,"price":800,"title":"Flat, Newtown","url":"/f/5"}]};</script>`;
  const $ = load(html);
  const c = candidatesFromEmbeddedJson(extractEmbeddedJson($, html), "https://site.ie/");
  assert.equal(c.length, 1);
  assert.equal(c[0].url, "https://site.ie/f/5");
});

test("coordinates: each supported format, and out-of-area rejection", () => {
  const cases = {
    "<meta property=\"place:location:latitude\" content=\"52.6701\"><meta property=\"place:location:longitude\" content=\"-8.5702\">": [52.6701, -8.5702],
    "<meta name=\"geo.position\" content=\"52.6702;-8.5703\">": [52.6702, -8.5703],
    "<div data-lat=\"52.6703\" data-lng=\"-8.5704\"></div>": [52.6703, -8.5704],
    "var x = {\"latitude\": 52.6704, \"longitude\": -8.5705};": [52.6704, -8.5705],
    "var y = {\"lat\": 52.6705, \"lng\": -8.5706};": [52.6705, -8.5706],
    "new google.maps.LatLng(52.6706, -8.5707)": [52.6706, -8.5707],
    "<img src=\"https://maps.googleapis.com/maps/api/staticmap?center=52.6707,-8.5708&zoom=15\">": [52.6707, -8.5708],
    "<a href=\"https://www.google.com/maps/@52.6708,-8.5709,15z\">map</a>": [52.6708, -8.5709],
  };
  for (const [html, [lat, lng]] of Object.entries(cases)) {
    assert.deepEqual(coordsFromHtml(html, UL), { lat, lng }, html);
  }
  assert.equal(coordsFromHtml("new google.maps.LatLng(48.8566, 2.3522)", UL), null, "Paris is rejected");
  assert.equal(coordsFromHtml("{\"lat\": 0.0, \"lng\": 0.0}", UL), null);
  assert.equal(coordsFromHtml("<p>nothing</p>", UL), null);
});

test("parseDetailPage extracts title, text, address, price, coords and image", () => {
  const html = `<html><head><title>Room in student house - Accommodation Search</title>
  <meta property="og:image" content="/photos/1.jpg">
  <meta property="place:location:latitude" content="52.674"><meta property="place:location:longitude" content="-8.572"></head>
  <body><header><h1>Room in student house, Plassey</h1></header><nav>menu</nav>
  <main><p>Bright room. Available now until June 2027. Rent €520 per month</p>
  <p>Address: 12 Plassey Village, Castletroy, Limerick Contact the landlord</p></main><footer>footer text</footer></body></html>`;
  const d = parseDetailPage(html, "https://www.accommodation.ul.ie/Advert/1002", UL);
  assert.equal(d.title, "Room in student house, Plassey");
  assert.equal(d.priceText, "€520 per month");
  assert.equal(d.address, "12 Plassey Village, Castletroy, Limerick");
  assert.deepEqual([d.lat, d.lng], [52.674, -8.572]);
  assert.equal(d.image, "https://www.accommodation.ul.ie/photos/1.jpg");
  assert.ok(d.text.includes("Available now until June 2027"));
  assert.ok(!d.text.includes("footer text") && !d.text.includes("menu"));
});

test("externalIdFromUrl prefers numeric ids, falls back to a slug", () => {
  assert.equal(externalIdFromUrl("https://www.rent.ie/rooms/castletroy/555001/"), "555001");
  assert.equal(externalIdFromUrl("https://site.ie/to-let/nice-room?x=1"), "to-let-nice-room");
});

test("null, empty or non-numeric coordinates in page JSON mean 'no location', never 0,0", () => {
  const data = { results: [
    { id: 1, price: 900, title: "Flat A, Somewhere", url: "/b/1", latitude: null, longitude: null },
    { id: 2, price: 900, title: "Flat B, Somewhere", url: "/b/2", latitude: "", longitude: "" },
    { id: 3, price: 900, title: "Flat C, Somewhere", url: "/b/3", location: { lat: null, lng: null } },
    { id: 4, price: 900, title: "Flat D, Somewhere", url: "/b/4", point: { coordinates: [null, null] } },
    { id: 5, price: 900, title: "Flat E, Somewhere", url: "/b/5", latitude: 52.67, longitude: -8.57 },
  ] };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
  const c = candidatesFromEmbeddedJson(extractEmbeddedJson(load(html), html), "https://site.ie/");
  assert.deepEqual(c.map((x) => [x.lat, x.lng]), [[null, null], [null, null], [null, null], [null, null], [52.67, -8.57]]);

  const ld = `<script type="application/ld+json">{"@type":"Apartment","name":"Flat","url":"/p/9","geo":{"latitude":null,"longitude":null}}</script>`;
  const [l] = candidatesFromJsonLd(extractJsonLd(load(ld)), "https://site.ie/");
  assert.ok(!Number.isFinite(l.lat), "JSON-LD null geo is not a coordinate");
});
