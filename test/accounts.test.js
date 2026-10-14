import test from "node:test";
import assert from "node:assert/strict";
import { createScanner } from "../src/scan.js";
import { createUsers } from "../src/users.js";
import { createLaptopWatch } from "../src/laptop-watch.js";
import { chooseCampus, updatePrefs } from "../src/searches.js";
import { ADMIN_OWNER } from "../src/push.js";
import { tagOwnerOccupied } from "../src/daft.js";
import { configure, daftPage, httpError, makeFetch, noSleep, rawListing, searchOf, tempStore, fakePusher } from "./helpers.js";

// Accounts are independent (#36): each has its own campus, preferences, seen list, verdicts and matches, and the scanner
// reads each region's sites once for everyone watching there (#13) and matches each account on its own.

const UCC = { lat: 51.8935, lng: -8.4917 };
const MIC = { lat: 52.653, lng: -8.638 };
const AREAS = { limerick: "university-of-limerick-limerick", cork: "cork-city", galway: "galway-city" };

// A fake Daft with a handler per region, given the search being asked for. The handler may return a list of raw listings or a Response.
function daft(handlers) {
  const byArea = Object.fromEntries(Object.entries(AREAS).map(([region, area]) => [area, handlers[region]]));
  return makeFetch((q, _n, url) => {
    const handler = byArea[new URL(url).pathname.split("/")[2]];
    if (!handler) return httpError(404, "no such area");
    const out = handler(q);
    return Array.isArray(out) ? daftPage(out) : out;
  });
}
const asked = (fetchImpl, area) => fetchImpl.pages().filter((c) => c.url.includes(`/${area}`)).length;

const limerick = (id, km = 1, over = {}) => rawListing({ id, km, ...over });
const cork = (id, km = 1, over = {}) => rawListing({ id: 500 + id, km, from: UCC, title: `Room ${id}, Western Road, Cork`, ...over });

function setup({ pusher = fakePusher() } = {}) {
  const { store } = tempStore();
  for (const region of Object.values(store.data.regions)) region.sources = ["daft"];
  configure(store, { sections: ["sharing"] });
  return { store, pusher };
}

async function addUser(store, name, campus, prefs = {}) {
  await createUsers({ store, adminUsername: "admin" }).create(name, "password-123");
  const search = searchOf(store, name);
  search.prefs.sections = ["sharing"];
  Object.assign(search.prefs, prefs);
  if (campus) chooseCampus(search, campus);
  return search;
}

const scannerFor = (store, pusher, fetchImpl) => createScanner({ store, pusher, fetchImpl, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, transit: null });
const ids = (search) => search.matches.map((m) => m.id).sort();
const titles = (pusher, owner) => pusher.to(owner).map((p) => p.title);

test("two accounts at different campuses each see only their own matches and are alerted only to their own", async () => {
  const { store, pusher } = setup();
  const bob = await addUser(store, "bob", "ucc");
  let limerickItems = [limerick(1)];
  let corkItems = [cork(1)];
  const fetchImpl = daft({ limerick: () => limerickItems, cork: () => corkItems });
  const scanner = scannerFor(store, pusher, fetchImpl);

  await scanner.run();
  assert.deepEqual(ids(searchOf(store)), ["daft:1"], "the admin watches UL");
  assert.deepEqual(ids(bob), ["daft:501"], "bob watches UCC");
  assert.deepEqual(titles(pusher, ADMIN_OWNER), ["Watching started: 1 current matches"]);
  assert.deepEqual(titles(pusher, "bob"), ["Watching started: 1 current matches"]);

  limerickItems = [limerick(2, 1.2, { price: "€500 per month" }), limerick(1)];
  corkItems = [cork(2, 0.8, { price: "€450 per month" }), cork(1)];
  pusher.sentToOwner.length = 0;
  await scanner.run();
  assert.deepEqual(titles(pusher, ADMIN_OWNER), ["€500/mo · Room 2, Castletroy, Co. Limerick"], "only the Limerick listing reaches the admin");
  assert.deepEqual(titles(pusher, "bob"), ["€450/mo · Room 2, Western Road, Cork"], "and only the Cork one reaches bob");
  assert.match(pusher.to("bob")[0].body, /km from University College Cork/, "with distances from his own campus");
  assert.deepEqual(ids(searchOf(store)), ["daft:1", "daft:2"]);
  assert.deepEqual(ids(bob), ["daft:501", "daft:502"]);
});

test("the sites are read once per region, not once per account: users with different filters share one collect", async () => {
  const { store, pusher } = setup();
  const bob = await addUser(store, "bob", "ul", { priceMax: 600 });
  const carol = await addUser(store, "carol", "mic");
  const items = [
    limerick(1, 1, { price: "€500 per month" }),
    limerick(2, 1.2, { price: "€700 per month" }),
    rawListing({ id: 3, km: 1, from: MIC, price: "€650 per month", title: "Room 3, Thomondgate, Limerick" }),
  ];
  const fetchImpl = daft({ limerick: () => items });
  await scannerFor(store, pusher, fetchImpl).run();

  assert.equal(asked(fetchImpl, AREAS.limerick), 2, "one search of the rooms and one asking Daft which are owner-occupied, for all three accounts");
  assert.deepEqual(ids(searchOf(store)), ["daft:1", "daft:2"], "the admin has no price limit and is at UL");
  assert.deepEqual(ids(bob), ["daft:1"], "bob is at UL too but won't pay more than 600, which was applied to the same collect");
  assert.deepEqual(ids(carol), ["daft:3"], "carol is at Mary Immaculate College, 5 km away");
  assert.equal(asked(fetchImpl, AREAS.cork) + asked(fetchImpl, AREAS.galway), 0, "nobody is watching in Cork or Galway, so they are not read");
});

test("Daft is not asked for anyone's price, beds or lease limits; the first two are applied afterwards", async () => {
  const { store, pusher } = setup();
  await addUser(store, "bob", "ul", { priceMax: 600, bedsMin: 2 });
  configure(store, { priceMin: 300, priceMax: 900, bedsMax: 3 });
  const fetchImpl = daft({ limerick: () => [limerick(1)] });
  await scannerFor(store, pusher, fetchImpl).run();
  for (const c of fetchImpl.pages()) {
    const p = new URL(c.url).searchParams;
    for (const k of ["rentalPrice_from", "rentalPrice_to", "numBeds_from", "numBeds_to", "leaseLength_from", "leaseLength_to"]) assert.equal(p.has(k), false, `${k} in ${c.url}`);
  }
});

test("owner-occupied rooms are tagged from Daft's own filter, so accounts that allow them and accounts that don't share one collect", async () => {
  const { store, pusher } = setup();
  const bob = await addUser(store, "bob", "ul", { excludeOwnerOccupied: false });
  const fetchImpl = daft({
    limerick: (q) => (q.params.get("ownerOccupied") === "false" ? [limerick(10)] : [limerick(10), limerick(11, 1.1)]),
  });
  await scannerFor(store, pusher, fetchImpl).run();
  assert.deepEqual(ids(searchOf(store)), ["daft:10"], "the admin excludes owner-occupied rooms");
  assert.deepEqual(ids(bob), ["daft:10", "daft:11"], "bob wants to see them");
  assert.equal(bob.matches.find((m) => m.id === "daft:11").ownerOccupied, true);
  assert.equal(bob.matches.find((m) => m.id === "daft:10").ownerOccupied, false);
});

test("a listing is only called owner-occupied for being left out if the filtered search looked as far back as the full one", () => {
  const mk = (id, publishedAt) => ({ id, publishedAt, ownerOccupied: null });
  const all = { listings: [mk("a", "2026-09-30"), mk("b", "2026-09-29"), mk("c", "2026-09-28")] };
  tagOwnerOccupied(all, { listings: [mk("a", "2026-09-30"), mk("c", "2026-09-28")], complete: false });
  assert.deepEqual(all.listings.map((l) => l.ownerOccupied), [false, true, false], "it reached back past the oldest, so b was left out for a reason");

  const short = { listings: [mk("a", "2026-09-30"), mk("b", "2026-09-29"), mk("c", "2026-09-28")] };
  tagOwnerOccupied(short, { listings: [mk("a", "2026-09-30")], complete: false });
  assert.deepEqual(short.listings.map((l) => l.ownerOccupied), [false, null, null], "it stopped paging early, so nothing can be said about b and c");

  const done = { listings: [mk("a", "2026-09-30"), mk("b", "2026-09-29")] };
  tagOwnerOccupied(done, { listings: [mk("a", "2026-09-30")], complete: true });
  assert.deepEqual(done.listings.map((l) => l.ownerOccupied), [false, true], "it ran out of results, so it saw everything there was");
});

test("a lease length is something only Daft can filter, so it is asked for only on behalf of the accounts that set one", async () => {
  const { store, pusher } = setup();
  const fetchImpl = daft({
    limerick: (q) => (q.params.get("leaseLength_from") === "6" ? [limerick(20)] : [limerick(20), limerick(21, 1.1)]),
  });
  const scanner = scannerFor(store, pusher, fetchImpl);
  await scanner.run();
  assert.equal(asked(fetchImpl, AREAS.limerick), 2, "nobody has a lease limit");

  const bob = await addUser(store, "bob", "ul", { leaseMinMonths: 6, leaseMaxMonths: 12 });
  await scanner.run();
  assert.equal(asked(fetchImpl, AREAS.limerick), 2 + 3, "and now one more search, for bob's range");
  assert.deepEqual(ids(searchOf(store)), ["daft:20", "daft:21"], "the admin still sees both");
  assert.deepEqual(ids(bob), ["daft:20"], "bob only sees what Daft's lease filter kept");
});

test("changing preferences matches the account again at once, without asking any site", async () => {
  const { store, pusher } = setup();
  const items = [limerick(1), limerick(2, 2.5)];
  const fetchImpl = daft({ limerick: () => items });
  const scanner = scannerFor(store, pusher, fetchImpl);
  await scanner.run();
  assert.deepEqual(ids(searchOf(store)), ["daft:1"]);
  const bob = await addUser(store, "bob", "ul");
  await scanner.run();
  pusher.sentToOwner.length = 0;
  const requests = fetchImpl.pages().length;

  updatePrefs(searchOf(store), { radiusKm: 3 });
  assert.equal(await scanner.match(ADMIN_OWNER), true);
  assert.equal(fetchImpl.pages().length, requests, "nothing was fetched");
  assert.deepEqual(ids(searchOf(store)), ["daft:1", "daft:2"]);
  assert.deepEqual(titles(pusher, ADMIN_OWNER), ["€650/mo · Room 2, Castletroy, Co. Limerick"], "the listing that now fits is alerted");
  assert.deepEqual(pusher.to("bob"), [], "bob's search did not change");
  assert.deepEqual(ids(bob), ["daft:1"]);
});

test("an account can't be matched until its region has been collected, and then can", async () => {
  const { store, pusher } = setup();
  const bob = await addUser(store, "bob", "ucc");
  const scanner = scannerFor(store, pusher, daft({ limerick: () => [limerick(1)], cork: () => [cork(1)] }));
  assert.equal(await scanner.match("bob"), false);
  assert.equal(scanner.hasPool("cork"), false);
  await scanner.run();
  assert.equal(scanner.hasPool("cork"), true);
  assert.equal(await scanner.match("bob"), true);
  assert.equal(bob.baselineScans, 1, "matching again at the same collect is not another scan");
});

test("a new account's first look marks what is listed as seen without alerting the others, and a new campus does the same", async () => {
  const { store, pusher } = setup();
  let items = [limerick(1), limerick(2, 1.1)];
  const scanner = scannerFor(store, pusher, daft({ limerick: () => items, cork: () => [cork(1), cork(2)] }));
  await scanner.run();
  pusher.sentToOwner.length = 0;

  const bob = await addUser(store, "bob", "ul");
  items = [limerick(3, 1.2), ...items];
  await scanner.run();
  assert.deepEqual(titles(pusher, ADMIN_OWNER), ["€650/mo · Room 3, Castletroy, Co. Limerick"], "the admin hears about the new listing");
  assert.deepEqual(titles(pusher, "bob"), ["Watching started: 3 current matches"], "bob is shown all three and alerted to none");
  assert.deepEqual(Object.keys(bob.seen).sort(), ["daft:1", "daft:2", "daft:3"]);

  pusher.sentToOwner.length = 0;
  chooseCampus(bob, "ucc");
  assert.equal(bob.baselineDone, false);
  await scanner.run();
  assert.deepEqual(titles(pusher, ADMIN_OWNER), [], "nothing for the admin: bob moving is none of their business");
  assert.deepEqual(titles(pusher, "bob"), ["Watching started: 2 current matches"]);
  assert.deepEqual(ids(bob), ["daft:501", "daft:502"]);
  assert.deepEqual(Object.keys(searchOf(store).seen).sort(), ["daft:1", "daft:2", "daft:3"], "and the admin's seen list is untouched");
});

test("one account's alerts failing to arrive leave only that account's listings unseen", async () => {
  let bobReachable = false;
  const pusher = fakePusher({
    subscribers: { [ADMIN_OWNER]: 1, bob: 1 },
    sendResult: (_payload, owner) => (owner === "bob" && !bobReachable ? { sent: 0, failed: 1, removed: 0 } : { sent: 1, failed: 0, removed: 0 }),
  });
  const { store } = setup({ pusher });
  const bob = await addUser(store, "bob", "ul");
  let items = [limerick(1)];
  const scanner = scannerFor(store, pusher, daft({ limerick: () => items }));
  await scanner.run();

  items = [limerick(2, 1.1), limerick(1)];
  pusher.sentToOwner.length = 0;
  await scanner.run();
  assert.ok(searchOf(store).seen["daft:2"], "the admin got theirs");
  assert.equal(bob.seen["daft:2"], undefined, "bob's didn't arrive, so it is still new to him");

  bobReachable = true;
  pusher.sentToOwner.length = 0;
  await scanner.run();
  assert.deepEqual(titles(pusher, "bob"), ["€650/mo · Room 2, Castletroy, Co. Limerick"], "his is tried again");
  assert.deepEqual(titles(pusher, ADMIN_OWNER), [], "and the admin is not told twice");
});

test("a region that can't be read leaves the accounts in other regions alone, and the admin is told which region", async () => {
  const { store, pusher } = setup();
  const bob = await addUser(store, "bob", "ucc");
  let corkOk = true;
  const scanner = scannerFor(store, pusher, daft({ limerick: () => [limerick(1)], cork: () => (corkOk ? [cork(1)] : httpError(403, "blocked")) }));
  await scanner.run();
  corkOk = false;
  for (let i = 0; i < 3; i++) await scanner.run();

  assert.equal(store.data.regionStatus.cork.failureCount, 3);
  assert.equal(store.data.regionStatus.limerick.failureCount, 0, "Limerick is fine");
  assert.equal(searchOf(store).lastRun.ok, true);
  assert.equal(bob.lastRun.ok, false, "bob is told his check didn't work");
  assert.deepEqual(ids(bob), ["daft:501"], "and keeps what he had");
  assert.equal(pusher.ops().length, 1);
  assert.match(pusher.ops()[0].body, /^Cork: 3 scans failed in a row: .*403/);
  assert.deepEqual(pusher.sentToOwner.filter((s) => s.owner === "bob" && /can't reach/.test(s.payload.title)), [], "error codes are not bob's to see");
});

test("a campus nobody has chosen is not read, and is read from the next scan once someone does", async () => {
  const { store, pusher } = setup();
  const carol = await addUser(store, "carol");
  const fetchImpl = daft({ limerick: () => [limerick(1)], galway: () => [rawListing({ id: 900, km: 1, from: { lat: 53.2785, lng: -9.0615 }, title: "Room, Newcastle, Galway" })] });
  const scanner = scannerFor(store, pusher, fetchImpl);
  await scanner.run();
  assert.equal(asked(fetchImpl, AREAS.galway), 0);
  assert.equal(carol.lastRun, null, "no campus, so no search");
  assert.deepEqual(titles(pusher, "carol"), []);

  chooseCampus(carol, "uog");
  await scanner.run();
  assert.ok(asked(fetchImpl, AREAS.galway) > 0);
  assert.deepEqual(ids(carol), ["daft:900"]);
  assert.deepEqual(titles(pusher, "carol"), ["Watching started: 1 current matches"]);
});

test("an account that moves to another region while its old region is being read gets nothing from the old read", async () => {
  const { store, pusher } = setup();
  const bob = await addUser(store, "bob", "ucc");
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const fetchImpl = makeFetch(async (_q, _n, url) => {
    const area = new URL(url).pathname.split("/")[2];
    if (area === AREAS.cork) await gate;
    return daftPage(area === AREAS.cork ? [cork(1)] : [limerick(1)]);
  });
  const scanner = scannerFor(store, pusher, fetchImpl);
  const running = scanner.run();
  while (!fetchImpl.pages().some((c) => c.url.includes(AREAS.cork))) await new Promise((resolve) => setImmediate(resolve));

  chooseCampus(bob, "uog");
  release();
  await running;
  assert.equal(bob.campus, "uog");
  assert.deepEqual(bob.matches, [], "Cork's listings were not written into a search that is now in Galway");
  assert.deepEqual(titles(pusher, "bob"), [], "and he wasn't told 'watching started' about Cork");
  assert.equal(bob.baselineDone, false);
});

test("an account that moves while its alerts are going out doesn't take the old campus's progress into its new search", async () => {
  const { store } = setup();
  const pusher = fakePusher();
  const send = pusher.sendToOwner;
  let hook = null;
  pusher.sendToOwner = async (owner, payload) => {
    if (hook && owner === "bob") {
      const run = hook;
      hook = null;
      await run();
    }
    return send(owner, payload);
  };
  const bob = await addUser(store, "bob", "ul");
  const scanner = scannerFor(store, pusher, daft({ limerick: () => [limerick(1)] }));

  // the first look ("watching started") is being announced when he picks Mary Immaculate College, which is in the same region
  hook = () => chooseCampus(bob, "mic");
  await scanner.run();
  assert.equal(bob.campus, "mic");
  assert.equal(bob.baselineDone, false, "he has not been through a first look at MIC");
  assert.deepEqual(bob.matches, []);
  assert.equal(bob.lastRun, null);
  assert.deepEqual(bob.seen, {});

  await scanner.run();
  assert.equal(bob.baselineDone, true, "the next scan gives him one, for MIC");
});

test("the laptop watch only worries about sites that someone is watching a region for", async () => {
  const { store, pusher } = setup();
  const proxy = { kind: "laptop", fetch() {}, sources: new Set(["daft"]), online: () => false };
  store.data.regions.limerick.sources = ["daft"];
  let t = Date.parse("2026-10-05T10:00:00Z");
  const watch = createLaptopWatch({ store, pusher, proxy, alertAfterMs: 0, now: () => new Date(t), log: { warn() {} } });

  searchOf(store).campus = null;
  await watch.check();
  assert.deepEqual(pusher.ops(), [], "nobody is watching anywhere, so nothing is waiting on the laptop");

  chooseCampus(searchOf(store), "ul");
  t += 60_000;
  await watch.check();
  assert.equal(pusher.ops().length, 1);
  assert.match(pusher.ops()[0].body, /^Daft\.ie isn't being checked\./);
});
