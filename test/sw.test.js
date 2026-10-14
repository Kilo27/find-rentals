import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// The service worker sits in front of every page load, and no browser here can run one, so it is run against stand-ins
// for its globals: a cache, a network that can be switched off, and the events a browser would send it.
const src = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

test("service worker: the app opens offline, the network always comes first, and a sign-in link is never kept", async () => {
  const handlers = {};
  const store = new Map();
  const cache = {
    add: async (f) => store.set(f, new Response(`cached ${f}`)),
    put: async (k, r) => store.set(k, r),
  };
  let online = true;
  const net = [];
  const self = {
    location: { origin: "https://rw.example" },
    addEventListener: (t, fn) => (handlers[t] = fn),
    skipWaiting() {},
    clients: { claim: async () => {} },
    registration: { scope: "https://rw.example/" },
  };
  const caches = {
    open: async () => cache,
    keys: async () => ["rw-shell-v0", "rw-shell-v1"],
    delete: async (k) => net.push(`deleted ${k}`),
    match: async (k) => store.get(k)?.clone(),
  };
  const fetchFake = async (req) => {
    net.push(req.url);
    if (!online) throw new TypeError("offline");
    return new Response(`fresh ${new URL(req.url).pathname}${new URL(req.url).search}`);
  };
  vm.runInNewContext(src, { self, caches, fetch: fetchFake, URL, Response, Promise, Set, console });

  async function dispatch(url, { mode = "cors", method = "GET" } = {}) {
    let responded = null;
    const waits = [];
    handlers.fetch({ request: { url, mode, method }, respondWith: (p) => (responded = p), waitUntil: (p) => waits.push(p) });
    if (!responded) return null;
    const res = await responded;
    await Promise.all(waits);
    return res.text();
  }

  await (async () => {
    const waits = [];
    handlers.install({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  })();
  assert.ok(store.has("/") && store.has("/app.js"), "the app's files are kept at install");

  assert.equal(await dispatch("https://rw.example/api/state"), null, "the API is never touched");
  assert.equal(await dispatch("https://tile.openstreetmap.org/1/1/1.png"), null, "nor other sites");
  assert.equal(await dispatch("https://rw.example/app.js", { method: "POST" }), null);

  assert.equal(await dispatch("https://rw.example/app.js"), "fresh /app.js", "online, the network answers");
  assert.equal(await (store.get("/app.js").clone()).text(), "fresh /app.js", "and the copy is refreshed");

  assert.equal(await dispatch("https://rw.example/?join=SECRETTOKEN0123456789", { mode: "navigate" }), "fresh /?join=SECRETTOKEN0123456789");
  assert.doesNotMatch(await store.get("/").clone().text(), /SECRET/, "a page opened at a sign-in link is never kept");
  await dispatch("https://rw.example/", { mode: "navigate" });
  assert.equal(await store.get("/").clone().text(), "fresh /");

  online = false;
  assert.equal(await dispatch("https://rw.example/?join=SECRETTOKEN0123456789", { mode: "navigate" }), "fresh /", "offline, the kept page answers, whatever address it was opened at");
  assert.equal(await dispatch("https://rw.example/styles.css"), "cached /styles.css");
  await assert.rejects(dispatch("https://rw.example/vendor/leaflet/leaflet.js").then((r) => (r === null ? Promise.reject(new Error("not handled")) : r)), /not handled/, "files it doesn't keep are left to the browser");

  await (async () => {
    const waits = [];
    handlers.activate({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  })();
  assert.ok(net.includes("deleted rw-shell-v0") && !net.includes("deleted rw-shell-v1"), "old copies are cleared on activate");
});
