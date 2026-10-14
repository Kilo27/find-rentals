import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { REGION_SEEDS } from "../src/catalogue.js";
import { STATE_VERSION, Store } from "../src/store.js";
import { ADMIN_OWNER } from "../src/push.js";
import { tempStore } from "./helpers.js";

// What the app saved before accounts had searches of their own (#17, #36): one config, one seen list, one set of matches and
// one map of verdicts for everybody.
const legacy = (over = {}) => ({
  version: 1,
  config: { ...normalizeConfig(DEFAULT_CONFIG), radiusKm: 3, priceMax: 700, intervalMinutes: 15, ...over.config },
  seen: { "daft:1": { firstSeenAt: "2026-09-30T10:00:00.000Z" }, "rent:9": { firstSeenAt: "2026-10-01T10:00:00.000Z" } },
  reviews: { "daft:1": { status: "rejected", at: "2026-10-02T10:00:00.000Z" } },
  matches: [{ id: "daft:1", memberIds: ["daft:1"], title: "Room 1" }, { id: "rent:9", memberIds: ["rent:9"], title: "Flat 9" }],
  subscriptions: [{ endpoint: "https://push.example/phone", keys: { p256dh: "k", auth: "a" } }, { endpoint: "https://push.example/bobs", keys: { p256dh: "k", auth: "a" }, owner: "bob" }],
  users: [{ username: "bob", passwordHash: "scrypt$a$b", sessionKey: "k", createdAt: "2026-10-01T00:00:00Z", lastLoginAt: null, lastSeenAt: null }],
  vapid: { publicKey: "pub", privateKey: "priv" },
  baselineDone: true,
  failureCount: 2,
  lastRun: { at: "2026-10-04T10:00:00.000Z", ok: true, mode: "normal", sources: [], matches: 2 },
  debug: { "daft:sharing": { at: "x" } },
  pageCache: { "rent:9": { at: "2026-10-04T00:00:00Z" } },
  geocache: { "castletroy": { lat: 1, lng: 2, at: "2026-10-04T00:00:00Z" } },
  siteConstants: { rent: ["52.6700,-8.5700"] },
  sourceHealth: { ul: { failures: 4, lastOkAt: null, lastError: "x" } },
  laptop: { offlineSince: null, offlineNotified: false },
  pendingAttempts: { "rent:7": 2 },
  baselineScans: 1,
  ...over.state,
});

function storeFrom(state) {
  const { dir } = tempStore();
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  return { dir, store: new Store(dir) };
}

test("a fresh install has the three regions, and the admin watching UL as it always has", () => {
  const { store } = tempStore();
  assert.equal(store.data.version, STATE_VERSION);
  assert.deepEqual(Object.keys(store.data.regions), ["limerick", "cork", "galway"]);
  assert.equal(store.data.searches[ADMIN_OWNER].campus, "ul");
  assert.equal(store.data.regions.limerick.daftLocation, DEFAULT_CONFIG.daftLocation);
  assert.equal(store.data.config, undefined, "there is no shared config any more");
});

test("the one shared search becomes the admin's: its campus, preferences, seen list, verdicts, matches and baseline", () => {
  const { store } = storeFrom(legacy());
  const admin = store.data.searches[ADMIN_OWNER];
  assert.equal(store.data.version, STATE_VERSION);
  assert.equal(admin.campus, "ul", "the centre was UL");
  assert.equal(admin.prefs.radiusKm, 3);
  assert.equal(admin.prefs.priceMax, 700);
  assert.deepEqual(Object.keys(admin.seen).sort(), ["daft:1", "rent:9"], "nothing already alerted is alerted again");
  assert.equal(admin.reviews["daft:1"].status, "rejected");
  assert.equal(admin.matches.length, 2);
  assert.equal(admin.baselineDone, true);
  assert.equal(admin.baselineScans, 1);
  assert.equal(admin.lastRun.matches, 2);
  for (const gone of ["config", "seen", "reviews", "matches", "baselineDone", "baselineScans", "failureCount", "lastRun", "sourceHealth", "pendingAttempts"]) {
    assert.equal(store.data[gone], undefined, `${gone} is no longer shared`);
  }
});

test("the part of the config about where to look becomes the Limerick region, with how it had been doing", () => {
  const { store } = storeFrom(legacy({ config: { daftLocation: "castletroy-limerick", webUrls: ["https://agent.example/lettings"], sources: ["daft", "web"], maxPages: 6, enabled: false } }));
  const r = store.data.regions.limerick;
  assert.equal(r.daftLocation, "castletroy-limerick", "the admin's own edit survives");
  assert.deepEqual(r.webUrls, ["https://agent.example/lettings"]);
  assert.deepEqual(r.sources, ["daft", "web"]);
  assert.equal(r.maxPages, 6);
  assert.equal(r.intervalMinutes, 15);
  assert.equal(r.enabled, false, "scanning had been switched off, and still is");
  assert.equal(r.radiusKm, REGION_SEEDS.limerick.radiusKm, "the Daft radius is the region's, not the admin's own distance");
  assert.deepEqual(store.data.regionStatus.limerick, { failureCount: 2, lastRun: legacy().lastRun, sourceHealth: { ul: { failures: 4, lastOkAt: null, lastError: "x" } }, pendingAttempts: { "rent:7": 2 } });
  assert.equal(store.data.regions.cork.daftLocation, "cork-city", "the other regions come from the catalogue");
});

test("what is shared by everyone stays shared: devices, accounts, VAPID keys and the caches", () => {
  const { store } = storeFrom(legacy());
  assert.equal(store.data.subscriptions.length, 2);
  assert.deepEqual(store.data.users.map((u) => u.username), ["bob"]);
  assert.deepEqual(store.data.vapid, { publicKey: "pub", privateKey: "priv" });
  assert.ok(store.data.pageCache["rent:9"]);
  assert.ok(store.data.geocache.castletroy);
  assert.deepEqual(store.data.siteConstants, { rent: ["52.6700,-8.5700"] });
  assert.ok(store.data.debug["daft:sharing"]);
});

test("people who already had an account carry on as they were, from their own copy, and the copies are independent", () => {
  const { store, dir } = storeFrom(legacy());
  const admin = store.data.searches[ADMIN_OWNER];
  const bob = store.data.searches.bob;
  assert.equal(bob.campus, "ul");
  assert.deepEqual(Object.keys(bob.seen).sort(), ["daft:1", "rent:9"], "bob isn't flooded with listings he has already had");
  assert.equal(bob.baselineDone, true, "and isn't sent 'watching started' again");
  assert.equal(bob.prefs.radiusKm, 3);

  bob.seen["daft:5"] = { firstSeenAt: "2026-10-05T00:00:00Z" };
  bob.prefs.priceMax = 400;
  bob.reviews["rent:9"] = { status: "seen", at: "2026-10-05T00:00:00Z" };
  assert.equal(admin.seen["daft:5"], undefined);
  assert.equal(admin.prefs.priceMax, 700);
  assert.equal(admin.reviews["rent:9"], undefined);

  store.save();
  const again = new Store(dir);
  assert.equal(again.data.searches.bob.prefs.priceMax, 400, "saved in the new shape, and read back");
  assert.equal(again.data.searches[ADMIN_OWNER].prefs.priceMax, 700);
});

test("the admin's campus is the one nearest the old centre, and a distance past a campus's limit is brought back to it", () => {
  const mic = storeFrom(legacy({ config: { center: { label: "MIC", lat: 52.653, lng: -8.638 }, radiusKm: 8, transitMaxKm: 12 } }));
  const admin = mic.store.data.searches[ADMIN_OWNER];
  assert.equal(admin.campus, "mic");
  assert.equal(admin.prefs.radiusKm, 5);
  assert.equal(admin.prefs.transitMaxKm, 5);

  const lost = storeFrom(legacy({ config: { center: { label: "Elsewhere", lat: 54.5, lng: -5.9 } } }));
  assert.equal(lost.store.data.searches[ADMIN_OWNER].campus, "ul", "a centre that isn't near any campus we have falls back to UL");
});

test("the old default Rent.ie addresses are replaced, edited ones are left alone", () => {
  const old = [
    "https://www.rent.ie/rooms-to-rent/limerick/castletroy/",
    "https://www.rent.ie/student-accommodation/University-of-Limerick/46/",
    "https://www.rent.ie/houses-to-rent/limerick/castletroy/",
    "https://www.rent.ie/apartments-to-rent/limerick/castletroy/",
  ];
  assert.deepEqual(storeFrom(legacy({ config: { rentUrls: old } })).store.data.regions.limerick.rentUrls, DEFAULT_CONFIG.rentUrls);
  assert.deepEqual(storeFrom(legacy({ config: { rentUrls: old.slice(0, 2) } })).store.data.regions.limerick.rentUrls, old.slice(0, 2));
});

test("a saved file that can't be read is set aside and the app starts fresh, but a mistake of ours in reading it stops the app instead", () => {
  const { dir } = tempStore();
  fs.writeFileSync(path.join(dir, "state.json"), "{ not json");
  const store = new Store(dir);
  assert.equal(store.data.version, STATE_VERSION);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-")), "kept for looking at");

  const { dir: dir2 } = tempStore();
  fs.writeFileSync(path.join(dir2, "state.json"), JSON.stringify({ version: STATE_VERSION, regions: "nonsense", searches: 7, users: "no" }));
  assert.throws(() => new Store(dir2), TypeError);
  assert.deepEqual(fs.readdirSync(dir2), ["state.json"], "and the file is not touched");
});

test("a saved state is put right on the way in: accounts that no longer exist, unknown campuses, missing regions and invalid settings", () => {
  const { dir } = tempStore();
  const { store: fresh } = tempStore();
  const good = fresh.data.searches[ADMIN_OWNER];
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      version: STATE_VERSION,
      users: [{ username: "bob" }],
      regions: { limerick: { ...fresh.data.regions.limerick, maxPages: 7 }, cork: { name: "" } },
      searches: {
        [ADMIN_OWNER]: { ...good, campus: "hogwarts", prefs: { radiusKm: 99 } },
        bob: { ...good, campus: "ucc", seen: [], matches: "no" },
        ghost: good,
      },
    }),
  );
  const { data } = new Store(dir);
  assert.deepEqual(Object.keys(data.searches).sort(), ["@admin", "bob"], "a search with no account is dropped");
  assert.equal(data.searches[ADMIN_OWNER].campus, null);
  assert.equal(data.searches[ADMIN_OWNER].prefs.radiusKm, 2, "invalid preferences are replaced by the defaults");
  assert.deepEqual([data.searches.bob.seen, data.searches.bob.matches], [{}, []]);
  assert.equal(data.searches.bob.campus, "ucc");
  assert.equal(data.regions.limerick.maxPages, 7, "the admin's edit is kept");
  assert.equal(data.regions.cork.daftLocation, "cork-city", "an invalid saved region falls back to the catalogue's");
  assert.ok(data.regions.galway, "a region the file didn't have is added");
});
