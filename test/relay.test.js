import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { createRelay, guardedLookup, isPrivateAddress, parseAllow } from "../src/relay.js";
import { proxyFromEnv } from "../src/proxy.js";
import { createScanner } from "../src/scan.js";
import { gatewayResponse, noSleep, rawListing, router, tempStore, fakePusher } from "./helpers.js";

const token = crypto.randomBytes(9).toString("hex");
const basic = (t) => `Basic ${Buffer.from(`relay:${t}`).toString("base64")}`;
const closers = [];
after(() => closers.forEach((c) => c()));

const listen = (server, host = "127.0.0.1") =>
  new Promise((resolve) => {
    server.listen(0, host, () => resolve(server.address().port));
    closers.push(() => server.close());
  });

async function echoServer() {
  const srv = net.createServer((s) => s.on("data", (d) => s.write(d)).on("error", () => {}));
  return { srv, port: await listen(srv) };
}

async function relayFor(opts = {}) {
  const relay = createRelay({ user: "relay", password: token, allow: ["127.0.0.1"], allowPrivate: true, ...opts });
  return { relay, port: await listen(relay) };
}

// Sends a raw CONNECT and resolves with the status line and the still-open socket.
function connect(relayPort, target, auth) {
  return new Promise((resolve, reject) => {
    const s = net.connect(relayPort, "127.0.0.1", () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\r\n\r\n")) resolve({ status: buf.split("\r\n")[0], headers: buf, socket: s });
    });
    s.on("error", reject);
    closers.push(() => s.destroy());
  });
}

test("relay: an authorised CONNECT to an allowed host and port tunnels bytes both ways", async () => {
  const { port: echoPort } = await echoServer();
  const { port } = await relayFor({ allowPorts: [echoPort] });
  const r = await connect(port, `127.0.0.1:${echoPort}`, basic(token));
  assert.match(r.status, /^HTTP\/1\.1 200/);
  const echoed = await new Promise((resolve) => {
    r.socket.once("data", (d) => resolve(d.toString()));
    r.socket.write("ping through the tunnel");
  });
  assert.equal(echoed, "ping through the tunnel");
});

test("relay: missing or wrong credentials get 407 and never reach the target", async () => {
  let reached = false;
  const probe = net.createServer(() => (reached = true));
  const probePort = await listen(probe);
  const { port } = await relayFor({ allowPorts: [probePort] });
  for (const auth of [undefined, basic("not-the-token"), "Bearer something"]) {
    const r = await connect(port, `127.0.0.1:${probePort}`, auth);
    assert.match(r.status, /^HTTP\/1\.1 407/);
    assert.match(r.headers, /Proxy-Authenticate: Basic/);
  }
  assert.equal(reached, false);
});

test("relay: hosts and ports outside the allow-list are refused even with valid credentials", async () => {
  const { port: echoPort } = await echoServer();
  const { port } = await relayFor({ allowPorts: [echoPort] });
  assert.match((await connect(port, `example.org:${echoPort}`, basic(token))).status, /403/);
  assert.match((await connect(port, `evil-127.0.0.1:${echoPort}`, basic(token))).status, /403/, "suffix tricks do not match");
  assert.match((await connect(port, `127.0.0.1:${echoPort + 1}`, basic(token))).status, /403/);
  assert.match((await connect(port, "not-a-target", basic(token))).status, /403/);
});

test("relay: an allowed hostname that resolves to a private address is refused", async () => {
  const { port: echoPort } = await echoServer();
  const { port } = await relayFor({ allow: ["localhost"], allowPorts: [echoPort], allowPrivate: false });
  assert.match((await connect(port, `localhost:${echoPort}`, basic(token))).status, /403/);
});

test("relay: the DNS guard handles both lookup shapes Node uses (one address, or all of them)", async () => {
  const fake = (result) => (hostname, opts, cb) => cb(null, result, Array.isArray(result) ? undefined : 4);
  const run = (lookup, allowPrivate = false) => new Promise((resolve) => guardedLookup(allowPrivate, lookup)("h.example", {}, (err, a, f) => resolve({ err: err?.message, a, f })));

  assert.deepEqual(await run(fake("93.184.216.34")), { err: undefined, a: "93.184.216.34", f: 4 });
  assert.equal((await run(fake("10.0.0.5"))).err, "private address refused");
  const pub = [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800::1", family: 6 }];
  assert.equal((await run(fake(pub))).err, undefined, "all-public list passes");
  assert.equal((await run(fake([...pub, { address: "192.168.0.9", family: 4 }]))).err, "private address refused", "one private address in the list is enough to refuse");
  assert.equal((await run(fake("10.0.0.5"), true)).err, undefined, "allowed when private addresses are explicitly enabled");
  assert.equal((await run((h, o, cb) => cb(new Error("ENOTFOUND")))).err, "ENOTFOUND");
});

test("relay: only CONNECT tunnels are served; /healthz answers for the platform health check", async () => {
  const { port } = await relayFor();
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return [res.status, await res.text()];
  };
  assert.deepEqual(await get("/healthz"), [200, "ok"]);
  assert.equal((await get("/")).at(0), 405);
  assert.equal((await get("/anything?url=http://internal")).at(0), 405);
});

test("relay: refuses to start without credentials or an allow-list", () => {
  assert.throws(() => createRelay({ user: "", password: token, allow: ["a.ie"] }));
  assert.throws(() => createRelay({ user: "relay", password: "", allow: ["a.ie"] }));
  assert.throws(() => createRelay({ user: "relay", password: token, allow: [] }));
});

test("relay helpers: private address detection and allow-list parsing", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "172.32.0.1", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPrivateAddress(a), false, a);
  assert.deepEqual(parseAllow(" Daft.ie, rent.ie  myhome.ie "), ["daft.ie", "rent.ie", "myhome.ie"]);
  assert.deepEqual(parseAllow(""), []);
});

test("proxyFromEnv: off unless a valid http(s) URL is set; sources default to daft and rent", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(proxyFromEnv({}, warn).fetch, null);
  assert.equal(proxyFromEnv({ SCRAPER_PROXY_URL: "not a url" }, warn).fetch, null);
  assert.equal(proxyFromEnv({ SCRAPER_PROXY_URL: "socks5://h:1" }, warn).fetch, null);
  assert.equal(warnings.length, 2);

  const on = proxyFromEnv({ SCRAPER_PROXY_URL: "http://relay:x@relay.railway.internal:3128" }, warn);
  assert.equal(typeof on.fetch, "function");
  assert.deepEqual([...on.sources].sort(), ["daft", "rent"]);
  assert.deepEqual([...proxyFromEnv({ SCRAPER_PROXY_URL: "http://h:1", SCRAPER_PROXY_SOURCES: "daft" }, warn).sources], ["daft"]);
});

test("scanner: only the listed sources go through the proxy; others and the geocoder stay direct", async () => {
  const UL_LIST = "https://www.accommodation.ul.ie/SearchResults/Print/All";
  const ulPage = `<html><body><div id="r"><div class="advert"><a href="/Advert/3001">Dromroe Village, Castletroy</a>
    Available: Now €500 Per person per month Room in House / Apartment with other tenants Rent: €500 Available Now</div></div></body></html>`;
  const DAFT = "https://gateway.daft.ie/api/v2/ads/listings";

  const direct = router([[UL_LIST, ulPage], [DAFT, () => new Response("blocked", { status: 403 })], [/nominatim/, []]]);
  const viaProxy = router([[DAFT, gatewayResponse([rawListing({ id: 9, km: 0.9 })])]]);

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
  assert.equal(direct.count(/gateway\.daft\.ie/), 0, "Daft never goes direct");
  assert.ok(viaProxy.count(/gateway\.daft\.ie/) >= 1);
  assert.equal(viaProxy.count(/accommodation\.ul\.ie/), 0, "UL never goes through the proxy");
  assert.ok(direct.count(/SearchResults/) >= 1);
  assert.ok(store.data.matches.some((m) => m.id === "daft:9"), "the Daft listing arrived via the proxy");
});

test("scanner: with no proxy configured nothing is proxied", async () => {
  const { store } = tempStore();
  store.data.config = { ...store.data.config, sources: ["daft"], sections: ["sharing"] };
  const direct = router([["https://gateway.daft.ie/api/v2/ads/listings", gatewayResponse([])]]);
  const scanner = createScanner({ store, pusher: fakePusher(), fetchImpl: direct, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, proxy: { fetch: null, sources: new Set() } });
  const run = await scanner.run();
  assert.deepEqual(run.proxied, []);
});
