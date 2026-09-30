import test from "node:test";
import assert from "node:assert/strict";
import { createScanner } from "../src/scan.js";
import { createPusher, buildListingPayload } from "../src/push.js";
import { gatewayResponse, httpError, makeFetch, rawListing, tempStore, fakePusher } from "./helpers.js";

const bySection = (map) => makeFetch((body) => {
  const out = map[body.section];
  return typeof out === "function" ? out(body) : out ?? gatewayResponse([]);
});

function setup({ pusher = fakePusher(), sections = ["sharing"] } = {}) {
  const { store } = tempStore();
  store.data.config = { ...store.data.config, sections, sources: ["daft"] };
  return { store, pusher };
}

test("scan: first run is a baseline - one summary push, listings marked seen", async () => {
  const { store, pusher } = setup();
  const fetchImpl = bySection({ sharing: gatewayResponse([rawListing({ id: 1 }), rawListing({ id: 2 })]) });
  const scanner = createScanner({ store, pusher, fetchImpl });

  const run = await scanner.run();
  assert.equal(run.mode, "baseline");
  assert.equal(run.matches, 2);
  assert.equal(pusher.sent.length, 1);
  assert.match(pusher.sent[0].title, /Watching started: 2/);
  assert.deepEqual(Object.keys(store.data.seen).sort(), ["daft:1", "daft:2"]);
  assert.equal(store.data.matches.length, 2);
  assert.equal(store.data.matches[0].text, undefined);
});

test("scan: later runs push only brand-new matches, once", async () => {
  const { store, pusher } = setup();
  let items = [rawListing({ id: 1 })];
  const scanner = createScanner({ store, pusher, fetchImpl: bySection({ sharing: () => gatewayResponse(items) }) });
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
  assert.equal(pusher.sent[0].url, "https://www.daft.ie/share/room-2/2");

  await scanner.run();
  assert.equal(pusher.sent.length, 1, "no repeat notification");
});

test("scan: non-matching listings never notify, but reappear if settings widen", async () => {
  const { store, pusher } = setup();
  const items = [rawListing({ id: 1 })];
  const scanner = createScanner({ store, pusher, fetchImpl: bySection({ sharing: () => gatewayResponse(items) }) });
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
  const scanner = createScanner({ store, pusher, fetchImpl: bySection({ sharing: () => gatewayResponse(items) }) });
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
  const scanner = createScanner({ store, pusher, fetchImpl: bySection({ sharing: () => gatewayResponse(items) }) });
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
  const scanner = createScanner({ store, pusher, fetchImpl: bySection({ sharing: () => gatewayResponse(items) }) });
  await scanner.run();
  items = [rawListing({ id: 9 })];
  await scanner.run();
  assert.ok(store.data.seen["daft:9"]);
});

test("scan: duplicate ids across sections are collapsed", async () => {
  const { store, pusher } = setup({ sections: ["sharing", "student-accommodation-to-share"] });
  const item = rawListing({ id: 5 });
  const scanner = createScanner({
    store,
    pusher,
    fetchImpl: bySection({ sharing: gatewayResponse([item]), "student-accommodation-to-share": gatewayResponse([item]) }),
  });
  const run = await scanner.run();
  assert.equal(run.matches, 1);
});

test("scan: total failure records error and alerts on 3rd consecutive failure only", async () => {
  const { store, pusher } = setup();
  const scanner = createScanner({ store, pusher, fetchImpl: makeFetch(() => httpError(403, "blocked")) });
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
  const scanner = createScanner({
    store,
    pusher,
    fetchImpl: makeFetch(() => (ok ? gatewayResponse([]) : httpError(500))),
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
  const scanner = createScanner({
    store,
    pusher,
    fetchImpl: bySection({
      sharing: gatewayResponse([rawListing({ id: 1 })]),
      "residential-to-rent": () => (failRent ? httpError(500) : gatewayResponse([rawListing({ id: 2 })])),
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
  const fetchImpl = bySection({ sharing: gatewayResponse([]) });
  const scanner = createScanner({ store, pusher, fetchImpl });
  const [a, b] = await Promise.all([scanner.run(), scanner.run()]);
  assert.equal(a, b);
  assert.equal(fetchImpl.calls.length, 1);
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
});
