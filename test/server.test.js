import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createScanner } from "../src/scan.js";
import { createScheduler } from "../src/scheduler.js";
import { daftPage, makeFetch, noSleep, rawListing, tempStore, fakePusher } from "./helpers.js";

let server;
let base;
let store;
let cookie = "";

const call = async (method, path, body, withCookie = true) => {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(withCookie && cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  return { res, data: await res.json().catch(() => null), set };
};

before(async () => {
  ({ store } = tempStore());
  store.data.config = { ...store.data.config, sections: ["sharing"], sources: ["daft"] };
  const pusher = fakePusher();
  const fetchImpl = makeFetch(() => daftPage([rawListing({ id: 1 })]));
  const scanner = createScanner({ store, pusher, fetchImpl, sleep: noSleep, politenessMs: 0 });
  const scheduler = createScheduler({ store, scanner, startDelayMs: 3_600_000 });
  const app = createApp({ store, scanner, pusher, scheduler, password: "hunter2", secret: "s3cret" });
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("health and static shell are public", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /manifest\.webmanifest/);
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get("cache-control"), "no-cache");
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal((await manifest.json()).display, "standalone");
  assert.equal((await fetch(`${base}/icons/apple-touch-icon.png`)).headers.get("content-type"), "image/png");
});

test("API requires auth", async () => {
  for (const [m, p] of [["GET", "/api/state"], ["PUT", "/api/config"], ["POST", "/api/scan"], ["POST", "/api/test-push"], ["GET", "/api/debug"]]) {
    const { res } = await call(m, p, m === "GET" ? undefined : {}, false);
    assert.equal(res.status, 401, `${m} ${p}`);
  }
});

test("wrong password is rejected; right password sets an httpOnly cookie", async () => {
  const bad = await call("POST", "/api/login", { password: "nope" }, false);
  assert.equal(bad.res.status, 401);
  const good = await call("POST", "/api/login", { password: "hunter2" }, false);
  assert.equal(good.res.status, 200);
  assert.match(good.set, /fr_session=/);
  assert.match(good.set, /HttpOnly/i);
  cookie = good.set.split(";")[0];
});

test("scan now populates matches; state endpoint exposes config and VAPID key", async () => {
  const scan = await call("POST", "/api/scan");
  assert.equal(scan.res.status, 200);
  assert.equal(scan.data.lastRun.ok, true);
  const { data } = await call("GET", "/api/state");
  assert.equal(data.matches.length, 1);
  assert.equal(data.config.radiusKm, 2);
  assert.equal(data.vapidPublicKey, "test-public-key");
  assert.ok(data.sections.sharing);
});

test("config can be updated, is validated, and persists to disk", async () => {
  const ok = await call("PUT", "/api/config", { radiusKm: 1.5, priceMax: 700, excludeKeywords: "noisy, smoking" });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.data.config.radiusKm, 1.5);
  assert.deepEqual(ok.data.config.excludeKeywords, ["noisy", "smoking"]);
  assert.equal(store.data.config.priceMax, 700);

  const bad = await call("PUT", "/api/config", { radiusKm: 500, intervalMinutes: 1 });
  assert.equal(bad.res.status, 400);
  assert.ok(bad.data.errors.length >= 2);
  assert.equal(store.data.config.radiusKm, 1.5, "rejected update must not change config");

  const reloaded = JSON.parse((await import("node:fs")).readFileSync(store.file, "utf8"));
  assert.equal(reloaded.config.radiusKm, 1.5);
});

test("transit: the state lists the campuses, and a campus's stops can be read as JSON, CSV or GeoJSON", async () => {
  const { data: state } = await call("GET", "/api/state");
  assert.ok(state.campuses.some((c) => c.id === "ul" && c.short === "UL"));
  assert.deepEqual(state.autoCampuses, ["ul"]);
  assert.ok(state.transit.attribution);

  const json = await call("GET", "/api/transit/ul?routes=304,310");
  assert.equal(json.res.status, 200);
  assert.deepEqual(json.data.routes.map((r) => r.label), ["304", "310"]);
  const stop = json.data.routes[0].stops.find((s) => s.name === "Plassey Village");
  assert.deepEqual([stop.code, stop.lat, stop.lng], ["607611", 52.66898, -8.57495]);

  const csv = await fetch(base + "/api/transit/ul?format=csv&routes=304A", { headers: { Cookie: cookie } });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const lines = (await csv.text()).trim().split("\n");
  assert.equal(lines[0], "route,operator,mode,stop_code,stop_name,latitude,longitude,trips_per_weekday,minutes_to_campus");
  assert.ok(lines.length > 20 && lines.slice(1).every((l) => l.startsWith("304A,Bus Éireann,bus,")));

  const geo = await call("GET", "/api/transit/ul?format=geojson&routes=310");
  assert.equal(geo.data.type, "FeatureCollection");
  assert.deepEqual(Object.keys(geo.data.features[0].properties).sort(), ["code", "minutesToCampus", "mode", "operator", "route", "stop", "tripsPerWeekday"]);
  assert.ok(geo.data.features.every((f) => f.geometry.coordinates[0] < -8 && f.geometry.coordinates[1] > 52), "GeoJSON is [longitude, latitude]");

  assert.equal((await call("GET", "/api/transit/nowhere")).res.status, 404);
  assert.equal((await call("GET", "/api/transit/ul", undefined, false)).res.status, 401);
});

test("logout clears the session", async () => {
  const out = await call("POST", "/api/logout");
  assert.equal(out.res.status, 200);
  const after = await call("GET", "/api/state", undefined, false);
  assert.equal(after.res.status, 401);
});

test("login is rate limited", async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call("POST", "/api/login", { password: "wrong" }, false);
  assert.equal(last.res.status, 429);
});
