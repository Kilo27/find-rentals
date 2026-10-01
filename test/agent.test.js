import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { createApp } from "../src/app.js";
import { AgentOfflineError, createAgentHub } from "../src/agent-hub.js";
import { checkTarget, createJobFetcher, guardedLookup, isPrivateAddress, parseAllow, runAgent } from "../src/agent.js";
import { proxyFromEnv } from "../src/proxy.js";
import { createScanner } from "../src/scan.js";
import { daftPage, noSleep, rawListing, router, tempStore, fakePusher } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("base64url");
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const SILENT = { log() {}, warn() {} };
const UL_LIST = "https://www.accommodation.ul.ie/SearchResults/Print/All";
const UL_PAGE = `<html><body><div id="r"><div class="advert"><a href="/Advert/3001">Dromroe Village, Castletroy</a>
  Available: Now €500 Per person per month Room in House / Apartment with other tenants Rent: €500 Available Now</div></div></body></html>`;

const closers = [];
after(() => closers.forEach((c) => c()));

async function serve(hub) {
  const { store } = tempStore();
  const scheduler = { nextRunAt: () => null, reschedule() {} };
  const app = createApp({ store, scanner: { isRunning: () => false }, pusher: fakePusher(), scheduler, agentHub: hub, password: "pw", secret: "s" });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const next = (base, headers = AUTH) => fetch(`${base}/api/agent/next`, { headers });
const answer = (base, body, token = TOKEN) =>
  fetch(`${base}/api/agent/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: zlib.gzipSync(JSON.stringify(body)),
  });

async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("agent hub: short tokens are refused; a wrong token gets 401 and doesn't make the agent count as online", async () => {
  assert.throws(() => createAgentHub({ token: "too-short" }), /at least 32/);
  const hub = createAgentHub({ token: TOKEN, pollWaitMs: 50 });
  const base = await serve(hub);
  for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: TOKEN }]) {
    assert.equal((await next(base, headers)).status, 401);
  }
  assert.equal((await answer(base, { id: "x" }, "x".repeat(40))).status, 401);
  assert.equal(hub.online(), false);
  await assert.rejects(hub.fetch("https://www.daft.ie/x"), AgentOfflineError);
});

test("agent hub: a request reaches the waiting poll with only safe headers, and the answer comes back as a Response", async () => {
  const hub = createAgentHub({ token: TOKEN, pollWaitMs: 2000 });
  const base = await serve(hub);
  const poll = next(base);
  await waitFor(() => hub.online());

  const pending = hub.fetch("https://www.daft.ie/sharing/x", { headers: { "User-Agent": "RW", Cookie: "secret=1", Accept: "text/html" } });
  const job = await (await poll).json();
  assert.equal(job.url, "https://www.daft.ie/sharing/x");
  assert.deepEqual(job.headers, { accept: "text/html", "user-agent": "RW" }, "cookies and other headers never reach the laptop");

  const reply = { id: job.id, status: 200, url: "https://www.daft.ie/sharing/x/", contentType: "text/html", body: "<html>ok</html>" };
  assert.equal((await answer(base, reply)).status, 204);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.url, "https://www.daft.ie/sharing/x/", "the final URL after redirects is kept");
  assert.equal(res.headers.get("content-type"), "text/html");
  assert.equal(await res.text(), "<html>ok</html>");
});

test("agent hub: requests queue between polls; error answers, late answers and cancelled requests are handled", async () => {
  const hub = createAgentHub({ token: TOKEN, pollWaitMs: 100 });
  const base = await serve(hub);
  assert.equal((await next(base)).status, 204, "an idle poll ends with 204 after the wait");
  assert.equal(hub.online(), true, "the agent stays online between polls");

  const failing = assert.rejects(hub.fetch("https://www.daft.ie/a"), /laptop agent: getaddrinfo ENOTFOUND/);
  const job = await (await next(base)).json();
  await answer(base, { id: job.id, error: "getaddrinfo ENOTFOUND" });
  await failing;

  assert.equal((await answer(base, { id: "long-gone", status: 200, body: "" })).status, 204, "a late answer is dropped quietly");

  const ctl = new AbortController();
  const cancelled = hub.fetch("https://www.daft.ie/b", { signal: ctl.signal });
  ctl.abort(new Error("caller gave up"));
  await assert.rejects(cancelled, /caller gave up/);
  assert.equal((await next(base)).status, 204, "a cancelled request is not handed out");

  const bad = assert.rejects(hub.fetch("https://www.daft.ie/c"), /bad status/);
  const badJob = await (await next(base)).json();
  await answer(base, { id: badJob.id, status: 99, body: "" });
  await bad;

  const garbled = await fetch(`${base}/api/agent/result`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/octet-stream" }, body: "not gzip" });
  assert.equal(garbled.status, 400);
});

test("agent hub: onOnline fires when the agent arrives or returns, not on every poll", async () => {
  let t = 1_000_000;
  const arrivals = [];
  const hub = createAgentHub({ token: TOKEN, pollWaitMs: 10, onlineWindowMs: 60_000, now: () => t, onOnline: () => arrivals.push(t) });
  const base = await serve(hub);
  await next(base);
  await next(base);
  assert.deepEqual(arrivals, [1_000_000]);
  t += 5 * 60_000;
  assert.equal(hub.online(), false, "gone quiet: the laptop is asleep");
  await next(base);
  assert.deepEqual(arrivals, [1_000_000, 1_300_000]);
});

test("agent: only https to allow-listed hosts, and every redirect hop is checked again", async () => {
  const allow = ["daft.ie"];
  assert.equal(checkTarget("https://www.daft.ie/x", allow).host, "www.daft.ie");
  assert.equal(checkTarget("https://daft.ie/x", allow).host, "daft.ie");
  for (const bad of ["http://www.daft.ie/x", "https://www.daft.ie:8443/x", "https://evil-daft.ie/", "https://daft.ie.evil.com/", "https://u:p@www.daft.ie/", "nonsense"]) {
    assert.throws(() => checkTarget(bad, allow), /not allowed|not a URL/, bad);
  }

  const upstream = router([
    [/\/start$/, () => new Response(null, { status: 301, headers: { location: "/landed" } })],
    [/\/landed$/, () => new Response("<html>landed</html>", { status: 200, headers: { "content-type": "text/html" } })],
    [/\/away$/, () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } })],
    [/\/loop$/, () => new Response(null, { status: 302, headers: { location: "/loop" } })],
  ]);
  const fetchJob = createJobFetcher({ allow, fetchImpl: upstream });
  const r = await fetchJob({ url: "https://www.daft.ie/start", headers: { "user-agent": "RW", cookie: "x", authorization: "y" } });
  assert.deepEqual(r, { status: 200, url: "https://www.daft.ie/landed", contentType: "text/html", body: "<html>landed</html>" });
  assert.deepEqual(upstream.calls[0].opts.headers, { "user-agent": "RW" });
  assert.equal(upstream.calls[0].opts.redirect, "manual");

  await assert.rejects(fetchJob({ url: "https://www.daft.ie/away" }), /not allowed: evil\.example/);
  assert.equal(upstream.count(/evil/), 0, "the off-list redirect target is never contacted");
  await assert.rejects(fetchJob({ url: "https://www.daft.ie/loop" }), /too many redirects/);
  await assert.rejects(fetchJob({ url: "https://www.google.com/" }), /not allowed: www\.google\.com/);
});

test("agent: bodies are capped like the server's own fetcher, and private addresses are never connected to", async () => {
  const capped = createJobFetcher({ allow: ["daft.ie"], maxBytes: 10, fetchImpl: router([[/x$/, "0123456789abcdef"]]) });
  assert.equal((await capped({ url: "https://www.daft.ie/x" })).body, "0123456789");

  const real = createJobFetcher({ allow: ["localhost"] });
  await assert.rejects(real({ url: "https://localhost/" }), (e) => /private address refused/.test(e.cause?.message ?? e.message));
});

test("agent: the DNS guard handles both lookup shapes Node uses (one address, or all of them)", async () => {
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

test("agent helpers: private address detection and allow-list parsing", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "172.32.0.1", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPrivateAddress(a), false, a);
  assert.deepEqual(parseAllow(" Daft.ie, rent.ie  myhome.ie "), ["daft.ie", "rent.ie", "myhome.ie"]);
  assert.deepEqual(parseAllow(""), []);
});

test("agent loop: retries with growing backoff while the server is unreachable or refuses the token", async () => {
  const sleeps = [];
  const urls = [];
  const ctl = new AbortController();
  const server = async (url) => {
    urls.push(url);
    if (urls.length <= 2) throw new Error("ECONNREFUSED");
    if (urls.length === 3) return new Response(null, { status: 401 });
    ctl.abort();
    return new Response(null, { status: 204 });
  };
  const warnings = [];
  await runAgent({ server: "https://srv.example/", token: TOKEN, fetchJob: async () => ({}), fetchImpl: server, sleep: async (ms) => sleeps.push(ms), log: { log() {}, warn: (m) => warnings.push(m) }, signal: ctl.signal });
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.equal(urls[0], "https://srv.example/api/agent/next");
  assert.match(warnings[2], /refused the token/);
});

test("laptop agent end to end: a scan fetches Daft through the agent while UL and the geocoder stay direct", async () => {
  const hub = createAgentHub({ token: TOKEN, pollWaitMs: 200 });
  const base = await serve(hub);
  const seenFromLaptop = router([[/^https:\/\/www\.daft\.ie\/sharing\//, daftPage([rawListing({ id: 9, km: 0.9 })])]]);
  const ctl = new AbortController();
  closers.push(() => ctl.abort());
  const agent = runAgent({ server: base, token: TOKEN, fetchJob: createJobFetcher({ fetchImpl: seenFromLaptop }), log: SILENT, signal: ctl.signal, sleep: noSleep });
  await waitFor(() => hub.online());

  const direct = router([[UL_LIST, UL_PAGE], [/daft\.ie/, () => new Response("blocked", { status: 403 })], [/nominatim/, []]]);
  const { store } = tempStore();
  store.data.config = { ...store.data.config, sources: ["daft", "ul"], sections: ["sharing"], ulUrls: [UL_LIST], rentUrls: [], myhomeUrls: [], webUrls: [] };
  const lines = [];
  const scanner = createScanner({
    store,
    pusher: fakePusher(),
    fetchImpl: direct,
    sleep: noSleep,
    politenessMs: 0,
    geocodeDelayMs: 0,
    proxy: proxyFromEnv({}, () => {}, hub),
    log: { log: (l) => lines.push(l), warn() {} },
  });
  const run = await scanner.run();
  ctl.abort();
  await agent;

  assert.deepEqual(run.proxied, ["daft"]);
  assert.equal(direct.count(/daft\.ie/), 0, "Daft never goes direct");
  assert.ok(seenFromLaptop.count(/www\.daft\.ie\/sharing\//) >= 1, "the laptop fetched Daft");
  assert.equal(seenFromLaptop.count(/accommodation\.ul\.ie|nominatim/), 0, "UL and the geocoder never go through the laptop");
  assert.ok(store.data.matches.some((m) => m.id === "daft:9"), "the Daft listing arrived via the laptop");
  assert.match(lines[0], /daft=1 ul=1 .*\| via-laptop=daft$/);
});

function laptopSetup() {
  const state = { online: true, t: Date.parse("2026-10-01T12:00:00Z") };
  const proxy = { kind: "laptop", fetch: router([[/www\.daft\.ie\/sharing\//, daftPage([rawListing({ id: 4 })])]]), sources: new Set(["daft"]), online: () => state.online };
  const { store } = tempStore();
  store.data.config = { ...store.data.config, sources: ["daft", "ul"], sections: ["sharing"], ulUrls: [UL_LIST], rentUrls: [], myhomeUrls: [], webUrls: [] };
  const pusher = fakePusher();
  const lines = [];
  const scanner = createScanner({
    store,
    pusher,
    fetchImpl: router([[UL_LIST, UL_PAGE], [/nominatim/, []]]),
    sleep: noSleep,
    politenessMs: 0,
    geocodeDelayMs: 0,
    proxy,
    now: () => new Date(state.t),
    log: { log: (l) => lines.push(l), warn() {} },
  });
  const scanAfter = async (minutes) => {
    state.t += minutes * 60_000;
    return scanner.run();
  };
  return { state, store, pusher, lines, scanner, scanAfter };
}

test("scan: while the laptop is offline its sources are skipped, not failed, and their matches are kept", async () => {
  const { state, store, pusher, lines, scanAfter } = laptopSetup();
  await scanAfter(0);
  assert.ok(store.data.matches.some((m) => m.id === "daft:4"));

  state.online = false;
  for (let i = 0; i < 10; i++) await scanAfter(30);
  const run = store.data.lastRun;
  assert.equal(run.sources.find((s) => s.id === "daft").skipped, "laptop agent offline");
  assert.equal(run.laptopOffline, true);
  assert.match(lines.at(-1), /\| daft=skipped ul=1 \|.*\| laptop=offline$/);
  assert.ok(store.data.matches.some((m) => m.id === "daft:4"), "Daft's matches stay while the laptop sleeps");
  assert.equal(store.data.sourceHealth.daft.failures, 0, "a sleeping laptop is not a broken source");
  assert.ok(!pusher.sent.some((p) => /looks broken|offline/.test(p.title)), "no alerts for a night's sleep");
});

test("scan: a fresh install waits for the laptop before finishing its baseline, so existing listings don't alert as new", async () => {
  const { state, store, pusher, scanAfter } = laptopSetup();
  state.online = false;
  await scanAfter(0);
  assert.equal(store.data.baselineDone, false);
  assert.equal(pusher.sent.length, 0);

  state.online = true;
  const run = await scanAfter(1);
  assert.equal(run.mode, "baseline");
  assert.equal(store.data.baselineDone, true);
  assert.ok(store.data.seen["daft:4"], "the laptop's listings are part of the baseline");
  assert.deepEqual(pusher.sent.map((p) => p.title), ["Watching started: 2 current matches"]);
});

test("scan: one push after a day without the laptop, and one when it is back", async () => {
  const { state, pusher, scanAfter } = laptopSetup();
  await scanAfter(0);
  pusher.sent.length = 0;

  state.online = false;
  await scanAfter(23 * 60);
  assert.equal(pusher.sent.length, 0);
  await scanAfter(60);
  await scanAfter(30);
  assert.deepEqual(pusher.sent.map((p) => p.title), ["Laptop agent offline"]);
  assert.match(pusher.sent[0].body, /Daft\.ie hasn't been checked for a day/);

  state.online = true;
  await scanAfter(30);
  await scanAfter(30);
  assert.deepEqual(pusher.sent.map((p) => p.title), ["Laptop agent offline", "Laptop agent is back"]);
});
