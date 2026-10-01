import test from "node:test";
import assert from "node:assert/strict";
import { proxyFromEnv } from "../src/proxy.js";
import { createScanner } from "../src/scan.js";
import { daftPage, noSleep, rawListing, router, tempStore, fakePusher } from "./helpers.js";

test("proxyFromEnv: off unless a valid http(s) URL is set; sources default to daft and rent", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(proxyFromEnv({}, warn).fetch, null);
  assert.equal(proxyFromEnv({ SCRAPER_PROXY_URL: "not a url" }, warn).fetch, null);
  assert.equal(proxyFromEnv({ SCRAPER_PROXY_URL: "socks5://h:1" }, warn).fetch, null);
  assert.equal(warnings.length, 2);

  const on = proxyFromEnv({ SCRAPER_PROXY_URL: "http://user:x@proxy.example.com:8080" }, warn);
  assert.equal(typeof on.fetch, "function");
  assert.deepEqual([...on.sources].sort(), ["daft", "rent"]);
  assert.deepEqual([...proxyFromEnv({ SCRAPER_PROXY_URL: "http://h:1", SCRAPER_PROXY_SOURCES: "daft" }, warn).sources], ["daft"]);
});

test("scanner: only the listed sources go through the proxy; others and the geocoder stay direct", async () => {
  const UL_LIST = "https://www.accommodation.ul.ie/SearchResults/Print/All";
  const ulPage = `<html><body><div id="r"><div class="advert"><a href="/Advert/3001">Dromroe Village, Castletroy</a>
    Available: Now €500 Per person per month Room in House / Apartment with other tenants Rent: €500 Available Now</div></div></body></html>`;
  const DAFT = /^https:\/\/www\.daft\.ie\/sharing\//;

  const direct = router([[UL_LIST, ulPage], [DAFT, () => new Response("blocked", { status: 403 })], [/nominatim/, []]]);
  const viaProxy = router([[DAFT, daftPage([rawListing({ id: 9, km: 0.9 })])]]);

  const { store } = tempStore();
  store.data.config = { ...store.data.config, sources: ["daft", "ul"], sections: ["sharing"], ulUrls: [UL_LIST], rentUrls: [], myhomeUrls: [], webUrls: [] };
  const scanner = createScanner({
    store,
    pusher: fakePusher(),
    fetchImpl: direct,
    sleep: noSleep,
    politenessMs: 0,
    geocodeDelayMs: 0,
    proxy: { fetch: viaProxy, sources: new Set(["daft"]) },
  });
  const run = await scanner.run();

  assert.deepEqual(run.proxied, ["daft"]);
  assert.equal(direct.count(/www\.daft\.ie/), 0, "Daft never goes direct");
  assert.ok(viaProxy.count(/www\.daft\.ie\/sharing\//) >= 1);
  assert.equal(viaProxy.count(/accommodation\.ul\.ie/), 0, "UL never goes through the proxy");
  assert.ok(direct.count(/SearchResults/) >= 1);
  assert.ok(store.data.matches.some((m) => m.id === "daft:9"), "the Daft listing arrived via the proxy");
});

test("scanner: with no proxy configured nothing is proxied", async () => {
  const { store } = tempStore();
  store.data.config = { ...store.data.config, sources: ["daft"], sections: ["sharing"] };
  const direct = router([[/^https:\/\/www\.daft\.ie\/sharing\//, daftPage([])]]);
  const scanner = createScanner({ store, pusher: fakePusher(), fetchImpl: direct, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, proxy: { fetch: null, sources: new Set() } });
  const run = await scanner.run();
  assert.deepEqual(run.proxied, []);
});

test("proxyFromEnv: an HTTP proxy wins over the laptop agent, and a broken proxy setting falls back to it", () => {
  const warn = () => {};
  const agent = { fetch: async () => new Response(""), online: () => true };
  const laptop = proxyFromEnv({}, warn, agent);
  assert.equal(laptop.kind, "laptop");
  assert.equal(laptop.fetch, agent.fetch);
  assert.equal(laptop.online, agent.online);
  assert.deepEqual([...laptop.sources].sort(), ["daft", "rent"]);
  assert.equal(proxyFromEnv({ SCRAPER_PROXY_URL: "http://h:1" }, warn, agent).kind, "proxy");
  assert.equal(proxyFromEnv({ SCRAPER_PROXY_URL: "not a url" }, warn, agent).kind, "laptop");
  assert.equal(proxyFromEnv({}, warn).kind, null);
});
