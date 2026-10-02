import test from "node:test";
import assert from "node:assert/strict";
import { createScanner } from "../src/scan.js";
import { createPusher, buildListingPayload } from "../src/push.js";
import { createTransit } from "../src/transit.js";
import { daftPage, httpError, kmNorth, makeFetch, noSleep, rawListing, tempStore, fakePusher } from "./helpers.js";

const bySection = (map) => makeFetch((q) => {
  const out = map[q.section];
  return typeof out === "function" ? out(q) : out ?? daftPage([]);
});

const newScanner = (opts) => createScanner({ sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, ...opts });

function setup({ pusher = fakePusher(), sections = ["sharing"] } = {}) {
  const { store } = tempStore();
  store.data.config = { ...store.data.config, sections, sources: ["daft"] };
  return { store, pusher };
}

test("scan: first run is a baseline - one summary push, listings marked seen", async () => {
  const { store, pusher } = setup();
  const fetchImpl = bySection({ sharing: daftPage([rawListing({ id: 1 }), rawListing({ id: 2 })]) });
  const scanner = newScanner({ store, pusher, fetchImpl });

  const run = await scanner.run();
  assert.equal(run.mode, "baseline");
  assert.equal(run.matches, 2);
  assert.equal(pusher.sent.length, 1);
  assert.match(pusher.sent[0].title, /Watching started: 2/);
  assert.deepEqual(Object.keys(store.data.seen).sort(), ["daft:1", "daft:2"]);
  assert.equal(store.data.matches.length, 2);
  assert.equal(store.data.matches[0].text, undefined);
});

test("scan: year-old verdicts on listings that are gone are pruned; current and recent ones stay", async () => {
  const { store, pusher } = setup();
  const scanner = newScanner({ store, pusher, fetchImpl: bySection({ sharing: () => daftPage([rawListing({ id: 1 })]) }) });
  const old = "2020-01-01T00:00:00.000Z";
  store.data.reviews = {
    "daft:1": { status: "seen", at: old },
    "daft:98": { status: "rejected", at: new Date().toISOString() },
    "daft:99": { status: "rejected", at: old },
  };
  await scanner.run();
  assert.deepEqual(Object.keys(store.data.reviews).sort(), ["daft:1", "daft:98"]);
});

test("scan: later runs push only brand-new matches, once", async () => {
  const { store, pusher } = setup();
  let items = [rawListing({ id: 1 })];
  const scanner = newScanner({ store, pusher, fetchImpl: bySection({ sharing: () => daftPage(items) }) });
  await scanner.run();
  pusher.sent.length = 0;

  await scanner.run();
  assert.equal(pusher.sent.length, 0, "nothing new");

  items = [rawListing({ id: 2, km: 1.2, price: "€500 per month" }), rawListing({ id: 1 })];
  const run = await scanner.run();
  assert.equal(run.newCount, 1);
  assert.equal(pusher.sent.length, 1);
  assert.match(pusher.sent[0].title, /^€500\/mo · Room 2/);
  assert.match(pusher.sent[0].body, /1\.2 km from University of Limerick/);
  assert.equal(pusher.sent[0].url, "/?listing=daft%3A2", "a tap opens the app on that listing");
  assert.equal(pusher.sent[0].listingUrl, "https://www.daft.ie/share/room-2/2", "the source address still travels with it");

  await scanner.run();
  assert.equal(pusher.sent.length, 1, "no repeat notification");
});

test("scan: non-matching listings never notify, but reappear if settings widen", async () => {
  const { store, pusher } = setup();
  const items = [rawListing({ id: 1 })];
  const scanner = newScanner({ store, pusher, fetchImpl: bySection({ sharing: () => daftPage(items) }) });
  await scanner.run();
  pusher.sent.length = 0;

  items.push(rawListing({ id: 2, km: 2.5 }), rawListing({ id: 3, title: "Room in owner-occupied home" }));
  const run = await scanner.run();
  assert.equal(run.newCount, 0);
  assert.equal(run.rejected, 2);
  assert.equal(pusher.sent.length, 0);

  store.data.config = { ...store.data.config, radiusKm: 3 };
  await scanner.run();
  assert.equal(pusher.sent.length, 1);
  assert.match(pusher.sent[0].title, /Room 2/);
});

test("scan: more than 5 new listings sends 5 individual pushes plus a digest", async () => {
  const { store, pusher } = setup();
  let items = [rawListing({ id: 1 })];
  const scanner = newScanner({ store, pusher, fetchImpl: bySection({ sharing: () => daftPage(items) }) });
  await scanner.run();
  pusher.sent.length = 0;

  items = Array.from({ length: 8 }, (_, i) => rawListing({ id: 100 + i }));
  await scanner.run();
  assert.equal(pusher.sent.length, 6);
  assert.match(pusher.sent[5].title, /3 more new listings/);
  pusher.sent.length = 0;
  await scanner.run();
  assert.equal(pusher.sent.length, 0);
});

test("scan: listings stay unseen if delivery fails to every device, then retry", async () => {
  let delivering = false;
  const pusher = fakePusher({ sendResult: () => (delivering ? { sent: 1, failed: 0, removed: 0 } : { sent: 0, failed: 1, removed: 0 }) });
  const { store } = setup({ pusher });
  let items = [rawListing({ id: 1 })];
  const scanner = newScanner({ store, pusher, fetchImpl: bySection({ sharing: () => daftPage(items) }) });
  await scanner.run();

  items = [rawListing({ id: 1 }), rawListing({ id: 2 })];
  await scanner.run();
  assert.equal(store.data.seen["daft:2"], undefined);

  delivering = true;
  pusher.sent.length = 0;
  await scanner.run();
  assert.equal(pusher.sent.length, 1);
  assert.ok(store.data.seen["daft:2"]);
});

test("scan: with no subscribers listings are still marked seen", async () => {
  const pusher = fakePusher({ subscribers: 0, sendResult: () => ({ sent: 0, failed: 0, removed: 0 }) });
  const { store } = setup({ pusher });
  let items = [];
  const scanner = newScanner({ store, pusher, fetchImpl: bySection({ sharing: () => daftPage(items) }) });
  await scanner.run();
  items = [rawListing({ id: 9 })];
  await scanner.run();
  assert.ok(store.data.seen["daft:9"]);
});

test("scan: duplicate ids across sections are collapsed", async () => {
  const { store, pusher } = setup({ sections: ["sharing", "student-accommodation-to-share"] });
  const item = rawListing({ id: 5 });
  const scanner = newScanner({
    store,
    pusher,
    fetchImpl: bySection({ sharing: daftPage([item]), "student-accommodation-to-share": daftPage([item]) }),
  });
  const run = await scanner.run();
  assert.equal(run.matches, 1);
});

test("scan: total failure records error and alerts on 3rd consecutive failure only", async () => {
  const { store, pusher } = setup();
  const scanner = newScanner({ store, pusher, fetchImpl: makeFetch(() => httpError(403, "blocked")) });
  for (let i = 1; i <= 4; i++) {
    const run = await scanner.run();
    assert.equal(run.ok, false);
    assert.match(run.error, /403/);
  }
  assert.equal(store.data.failureCount, 4);
  assert.equal(pusher.sent.length, 1);
  assert.match(pusher.sent[0].title, /can't reach any source/);
  assert.equal(store.data.baselineDone, false, "baseline must wait for a successful scan");
});

test("scan: recovery after 3+ failures sends a recovery push", async () => {
  const { store, pusher } = setup();
  let ok = false;
  const scanner = newScanner({
    store,
    pusher,
    fetchImpl: makeFetch(() => (ok ? daftPage([]) : httpError(500))),
  });
  for (let i = 0; i < 3; i++) await scanner.run();
  pusher.sent.length = 0;
  ok = true;
  await scanner.run();
  assert.ok(pusher.sent.some((p) => /is back/.test(p.title)));
  assert.equal(store.data.failureCount, 0);
});

test("scan: partial failure keeps previous matches for the failed section", async () => {
  const { store, pusher } = setup({ sections: ["sharing", "residential-to-rent"] });
  let failRent = false;
  const scanner = newScanner({
    store,
    pusher,
    fetchImpl: bySection({
      sharing: daftPage([rawListing({ id: 1 })]),
      "residential-to-rent": () => (failRent ? httpError(500) : daftPage([rawListing({ id: 2 })])),
    }),
  });
  await scanner.run();
  assert.equal(store.data.matches.length, 2);
  failRent = true;
  const run = await scanner.run();
  assert.equal(run.ok, true);
  assert.equal(store.data.failureCount, 0);
  assert.deepEqual(store.data.matches.map((m) => m.id).sort(), ["daft:1", "daft:2"]);
  assert.equal(run.sources[0].notes.find((n) => n.group === "residential-to-rent").ok, false);
});

test("scan: concurrent run() calls share one scan", async () => {
  const { store, pusher } = setup();
  const fetchImpl = bySection({ sharing: daftPage([]) });
  const scanner = newScanner({ store, pusher, fetchImpl });
  const [a, b] = await Promise.all([scanner.run(), scanner.run()]);
  assert.equal(a, b);
  assert.equal(fetchImpl.pages().length, 1);
});

test("push: dead subscriptions (410) are pruned, failures recorded", async () => {
  const { store } = tempStore();
  const calls = [];
  const webpush = {
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
    sendNotification: async (sub, body, opts) => {
      calls.push({ sub, body, opts });
      if (sub.endpoint.includes("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (sub.endpoint.includes("flaky")) throw Object.assign(new Error("boom"), { statusCode: 500, body: "server error" });
    },
  };
  const pusher = createPusher({ store, webpush, env: { VAPID_SUBJECT: "mailto:a@b.co" } });
  assert.equal(pusher.publicKey, "pub");
  for (const name of ["ok", "gone", "flaky"]) {
    pusher.addSubscription({ endpoint: `https://push.example/${name}`, keys: { p256dh: "k", auth: "a" } }, "UA");
  }
  const r = await pusher.sendToAll({ title: "hi" });
  assert.deepEqual(r, { sent: 1, failed: 1, removed: 1 });
  assert.equal(pusher.count(), 2);
  assert.match(store.data.subscriptions.find((s) => s.endpoint.includes("flaky")).lastError, /500/);
  assert.equal(calls[0].opts.vapidDetails.subject, "mailto:a@b.co");
  assert.equal(JSON.parse(calls[0].body).title, "hi");
});

test("push: VAPID keys persist across restarts; env keys override", () => {
  const { store, dir } = tempStore();
  const webpush = { generateVAPIDKeys: () => ({ publicKey: `pub${Math.random()}`, privateKey: "priv" }) };
  const first = createPusher({ store, webpush, env: {} });
  const again = createPusher({ store, webpush, env: {} });
  assert.equal(first.publicKey, again.publicKey);
  const overridden = createPusher({ store, webpush, env: { VAPID_PUBLIC_KEY: "envpub", VAPID_PRIVATE_KEY: "envpriv" } });
  assert.equal(overridden.publicKey, "envpub");
  assert.ok(dir);
});

test("push: rejects malformed or non-https subscriptions", () => {
  const { store } = tempStore();
  const pusher = createPusher({ store, webpush: { generateVAPIDKeys: () => ({ publicKey: "p", privateKey: "q" }) }, env: {} });
  assert.throws(() => pusher.addSubscription({}));
  assert.throws(() => pusher.addSubscription({ endpoint: "http://x", keys: { p256dh: "a", auth: "b" } }));
});

test("push: listing payload formatting", () => {
  const payload = buildListingPayload(
    { id: "daft:3", title: "Room 3, Plassey", priceMonthly: 600, priceText: "€600 per month", distanceKm: 0.84, bedsText: "Double Room", sourceLabel: "Daft.ie", flags: ["short-term", "owner-occupied-unknown"], url: "https://www.daft.ie/x" },
    { center: { label: "UL" } },
  );
  assert.equal(payload.title, "€600/mo · Room 3, Plassey");
  assert.equal(payload.body, "0.8 km from UL · Daft.ie · Double Room · short-term friendly · check owner-occupied");
  assert.equal(payload.tag, "listing-daft:3");
  assert.equal(payload.url, "/?listing=daft%3A3");
  assert.equal(payload.listingUrl, "https://www.daft.ie/x");
});

test("push: ids with awkward characters survive the round trip through the alert's address", async () => {
  const { listingFromSearch } = await import("../public/app-model.js");
  const payload = buildListingPayload(
    { id: "web:https://site.ie/a b?c=1&d=2", title: "T", priceMonthly: 500, distanceKm: 1, sourceLabel: "Site", url: "https://site.ie/a" },
    { center: { label: "UL" } },
  );
  assert.equal(listingFromSearch(payload.url.slice(1)), "web:https://site.ie/a b?c=1&d=2");
});

import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";

test("store: a saved config carrying the old 'university of limerick' locality hint is migrated", () => {
  const { dir } = tempStore();
  const old = { ...normalizeConfig(DEFAULT_CONFIG), localityHints: ["castletroy", "plassey", "dromroe", "mayorstone", "kilmurry", "university of limerick"] };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, config: old }));
  const migrated = new Store(dir);
  assert.ok(!migrated.data.config.localityHints.includes("university of limerick"));
  assert.ok(migrated.data.config.localityHints.includes("castletroy"));

  const custom = { ...old, localityHints: ["castletroy", "my own area"] };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, config: custom }));
  assert.deepEqual(new Store(dir).data.config.localityHints, ["castletroy", "my own area"], "user-edited hints are left alone");
});

// A 304 stop 3.5 km north of UL (a made-up one: the real data has none there), 15 minutes from the campus.
const stopAt = kmNorth(3.5);
const northLine = () =>
  createTransit({
    campuses: { ul: { stops: [["999", "Test Stop", stopAt.lat + 0.001, stopAt.lng]], routes: [{ label: "304", mode: "bus", operator: "Bus Éireann", name: "Test", calls: [[0, 40, 15]] }] } },
  });

test("scan: a home beyond the radius with a direct route to the campus is matched, with the route stored and in the alert", async () => {
  const { store, pusher } = setup();
  let items = [rawListing({ id: 1 })];
  const scanner = newScanner({ store, pusher, transit: northLine(), fetchImpl: bySection({ sharing: () => daftPage(items) }) });
  await scanner.run();
  pusher.sent.length = 0;

  items = [rawListing({ id: 1 }), rawListing({ id: 2, km: 3.5 }), rawListing({ id: 3, km: 4.5 }), rawListing({ id: 4, km: 6 })];
  const run = await scanner.run();
  assert.equal(run.newCount, 1, "2 km radius + a 500 m walk to the stop; 4.5 km is 1 km from it and 6 km is past the outer limit");
  assert.equal(run.rejected, 2);
  assert.match(pusher.sent[0].body, /3\.5 km from University of Limerick · 304 \d+ m away, 15 min to UL/);

  const stored = store.data.matches.find((m) => m.id === "daft:2");
  assert.ok(stored.flags.includes("transit-access"));
  assert.equal(stored.transit.campuses[0].options[0].label, "304");
  assert.equal(stored.transit.campuses[0].options[0].code, "999");
  assert.equal(store.data.matches.find((m) => m.id === "daft:1").transit, null, "homes inside the radius with no stop nearby carry no transport link");
});

test("scan: without transport data (or with it switched off) the radius is strict", async () => {
  for (const setupTransit of [(s) => ({ transit: null }), (s) => { s.store.data.config = { ...s.store.data.config, transitEnabled: false }; return { transit: northLine() }; }]) {
    const s = setup();
    let items = [rawListing({ id: 1 })];
    const scanner = newScanner({ ...s, ...setupTransit(s), fetchImpl: bySection({ sharing: () => daftPage(items) }) });
    await scanner.run();
    items = [rawListing({ id: 1 }), rawListing({ id: 2, km: 3.5 })];
    const run = await scanner.run();
    assert.equal(run.matches, 1);
    assert.equal(run.rejected, 1);
  }
});

test("store: a saved config carrying the old, mostly broken default Rent.ie URLs is migrated", () => {
  const { dir } = tempStore();
  const oldUrls = [
    "https://www.rent.ie/rooms-to-rent/limerick/castletroy/",
    "https://www.rent.ie/student-accommodation/University-of-Limerick/46/",
    "https://www.rent.ie/houses-to-rent/limerick/castletroy/",
    "https://www.rent.ie/apartments-to-rent/limerick/castletroy/",
  ];
  const old = { ...normalizeConfig(DEFAULT_CONFIG), rentUrls: oldUrls };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, config: old }));
  assert.deepEqual(new Store(dir).data.config.rentUrls, DEFAULT_CONFIG.rentUrls);

  const custom = { ...old, rentUrls: oldUrls.slice(0, 2) };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, config: custom }));
  assert.deepEqual(new Store(dir).data.config.rentUrls, oldUrls.slice(0, 2), "user-edited URLs are left alone");
});
