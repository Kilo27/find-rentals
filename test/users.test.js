import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createApp } from "../src/app.js";
import { createPusher } from "../src/push.js";
import { Store } from "../src/store.js";
import { createUsers } from "../src/users.js";
import { searchOf, tempStore } from "./helpers.js";

let server;
let base;
let store;
let dir;
let pushed;

const sub = (name) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: "k", auth: "a" } });

// Each caller keeps its own cookie jar: { session, viewAs }.
const jar = () => ({ session: "", viewAs: "" });
const cookieHeader = (j) => [j.session, j.viewAs].filter(Boolean).join("; ");

async function call(j, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(j && cookieHeader(j) ? { Cookie: cookieHeader(j) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, value] = pair.split("=");
    const slot = name === "fr_session" ? "session" : name === "fr_viewas" ? "viewAs" : null;
    if (slot && j) j[slot] = value ? pair : "";
  }
  return { status: res.status, data: await res.json().catch(() => null) };
}

const login = async (username, password) => {
  const j = jar();
  const r = await call(j, "POST", "/api/login", { username, password });
  return { j, ...r };
};

before(async () => {
  ({ store, dir } = tempStore());
  pushed = [];
  const webpush = {
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
    sendNotification: async (s) => pushed.push(s.endpoint),
  };
  const pusher = createPusher({ store, webpush, env: {} });
  const scheduler = { nextRunAt: () => null, reschedule() {} };
  const app = createApp({ store, scanner: { isRunning: () => false }, pusher, scheduler, adminUsername: "Kyle", password: "admin-pass-1", secret: "s3cret" });
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("the admin signs in with the configured username (any case) and password", async () => {
  assert.equal((await login("kyle", "wrong")).status, 401);
  assert.equal((await login("nobody", "admin-pass-1")).status, 401);
  const ok = await login("  KYLE ", "admin-pass-1");
  assert.equal(ok.status, 200);
  const { data } = await call(ok.j, "GET", "/api/state");
  assert.deepEqual(data.user, { username: "kyle", isAdmin: true });
  assert.equal(data.viewingAs, null);
});

test("an unknown user and a wrong password give the same answer", async () => {
  const a = await login("ghost", "whatever-123");
  const b = await login("kyle", "whatever-123");
  assert.equal(a.status, 401);
  assert.deepEqual(a.data, b.data);
});

test("only the admin can create users", async () => {
  const anon = jar();
  assert.equal((await call(anon, "POST", "/api/users", { username: "bob", password: "bobs-password" })).status, 401);

  const admin = (await login("kyle", "admin-pass-1")).j;
  const made = await call(admin, "POST", "/api/users", { username: "Bob", password: "bobs-password" });
  assert.equal(made.status, 201);
  assert.equal(made.data.user.username, "bob");
  assert.equal(JSON.stringify(made.data).includes("bobs-password"), false);

  const bob = (await login("bob", "bobs-password")).j;
  assert.equal((await call(bob, "POST", "/api/users", { username: "eve", password: "eves-password" })).status, 403);
  assert.equal((await call(bob, "GET", "/api/users")).status, 403);
  assert.equal((await call(bob, "PUT", "/api/users/bob/password", { password: "something-new-1" })).status, 403);
  assert.equal((await call(bob, "DELETE", "/api/users/bob")).status, 403);
  assert.equal((await call(bob, "POST", "/api/users/bob/test-push")).status, 403);
  assert.equal((await call(bob, "GET", "/api/debug")).status, 403);
  assert.equal((await call(bob, "POST", "/api/scan")).status, 403, "scans are the admin's to start");
  assert.equal((await call(bob, "PUT", "/api/regions/limerick", { maxPages: 9 })).status, 403);
  assert.equal((await call(bob, "POST", "/api/view-as", { username: "bob" })).status, 403);
  assert.equal(store.data.users.some((u) => u.username === "eve"), false);
});

test("a new account has a search of its own with no campus yet, so nothing is watched for it", async () => {
  const bob = (await login("bob", "bobs-password")).j;
  const { data } = await call(bob, "GET", "/api/state");
  assert.equal(data.campus, null);
  assert.equal(data.config, null, "there is no search until there is a campus");
  assert.deepEqual(data.matches, []);
  assert.ok(data.searchCampuses.length > 0);
  assert.equal(data.regions, null, "region settings are the admin's");
  assert.equal(searchOf(store, "bob").campus, null);
  assert.equal((await call((await login("kyle", "admin-pass-1")).j, "GET", "/api/state")).data.campus.id, "ul", "the admin's carries on at UL");
});

test("an account chooses its own campus, from the campuses that are set up", async () => {
  const bob = (await login("bob", "bobs-password")).j;
  const admin = (await login("kyle", "admin-pass-1")).j;

  for (const campus of [undefined, "", "hogwarts", "tcd", 7]) {
    assert.equal((await call(bob, "PUT", "/api/campus", { campus })).status, 400, `${campus}`);
  }
  assert.equal(searchOf(store, "bob").campus, null, "a refused choice changes nothing");

  const chose = await call(bob, "PUT", "/api/campus", { campus: "ucc" });
  assert.equal(chose.status, 200);
  assert.equal(chose.data.campus.short, "UCC");
  assert.equal(chose.data.campus.regionId, "cork");
  const state = (await call(bob, "GET", "/api/state")).data;
  assert.equal(state.config.center.label, "University College Cork");
  assert.equal(state.config.daftLocation, "cork-city", "the region's Daft area, not Limerick's");
  assert.deepEqual(state.config.sources, ["daft", "rent", "myhome"], "Cork has no accommodation board");

  // the admin's own search did not move, and the admin can see where bob is
  assert.equal((await call(admin, "GET", "/api/state")).data.campus.id, "ul");
  const row = (await call(admin, "GET", "/api/users")).data.users.find((u) => u.username === "bob");
  assert.equal(row.campus.id, "ucc");
  assert.equal(row.matches, 0);
});

test("switching campus starts watching afresh; choosing the same one again does not", async () => {
  const bob = (await login("bob", "bobs-password")).j;
  const search = searchOf(store, "bob");
  Object.assign(search, { baselineDone: true, seen: { "daft:1": { firstSeenAt: "2026-10-01T00:00:00Z" } }, matches: [{ id: "daft:1", memberIds: ["daft:1"] }], reviews: { "daft:1": { status: "seen", at: "2026-10-01T00:00:00Z" } } });

  await call(bob, "PUT", "/api/campus", { campus: "ucc" });
  assert.equal(search.baselineDone, true, "the same campus again leaves it alone");
  assert.equal(search.matches.length, 1);

  await call(bob, "PUT", "/api/campus", { campus: "mtu-cork" });
  assert.equal(search.baselineDone, false, "a new campus is a new place: what is listed there is marked seen first, not alerted");
  assert.deepEqual([search.seen, search.matches], [{}, []]);
  assert.ok(search.reviews["daft:1"], "verdicts are about listings and stay");
  await call(bob, "PUT", "/api/campus", { campus: "ucc" });
});

test("each account edits its own preferences, and nobody else's", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const bob = (await login("bob", "bobs-password")).j;
  const before = JSON.stringify(searchOf(store, "bob").prefs);

  assert.equal((await call(admin, "PUT", "/api/prefs", { radiusKm: 3, priceMax: 800 })).status, 200);
  assert.equal(searchOf(store, "@admin").prefs.radiusKm, 3);
  assert.equal(JSON.stringify(searchOf(store, "bob").prefs), before, "bob's did not move");

  assert.equal((await call(bob, "PUT", "/api/prefs", { radiusKm: 4, priceMax: 500 })).status, 200);
  assert.equal(searchOf(store, "@admin").prefs.priceMax, 800, "and bob's change left the admin's alone");
  assert.equal((await call(admin, "GET", "/api/state")).data.config.radiusKm, 3);
  assert.equal((await call(bob, "GET", "/api/state")).data.config.radiusKm, 4);

  // viewing as bob shows bob's, and changes nothing of his
  await call(admin, "POST", "/api/view-as", { username: "bob" });
  assert.equal((await call(admin, "GET", "/api/state")).data.config.radiusKm, 4, "bob's real search");
  for (const [method, path, body] of [["PUT", "/api/prefs", { radiusKm: 1 }], ["PUT", "/api/campus", { campus: "uog" }], ["PUT", "/api/review", { id: "x", status: "seen" }], ["PUT", "/api/regions/limerick", { maxPages: 2 }], ["POST", "/api/scan"]]) {
    assert.equal((await call(admin, method, path, body)).status, 403, `${method} ${path} while viewing`);
  }
  await call(admin, "DELETE", "/api/view-as");
  assert.equal(searchOf(store, "bob").prefs.radiusKm, 4);
  assert.equal(searchOf(store, "bob").campus, "ucc");

  await call(admin, "PUT", "/api/prefs", { radiusKm: 2, priceMax: null });
  await call(bob, "PUT", "/api/prefs", { radiusKm: 2, priceMax: null });
});

test("where the sites are read is the admin's to change, per region", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const bob = (await login("bob", "bobs-password")).j;
  const before = JSON.stringify(store.data.regions);

  assert.equal((await call(bob, "PUT", "/api/regions/limerick", { daftLocation: "somewhere-else" })).status, 403);
  assert.equal(JSON.stringify(store.data.regions), before);
  assert.equal((await call(admin, "PUT", "/api/regions/nowhere", { maxPages: 3 })).status, 404);
  const bad = await call(admin, "PUT", "/api/regions/limerick", { daftLocation: "../admin", rentUrls: ["http://not-https.example/"] });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.errors.length >= 2);

  const ok = await call(admin, "PUT", "/api/regions/cork", { maxPages: 6, webUrls: "https://example.ie/lettings/cork" });
  assert.equal(ok.status, 200);
  assert.equal(store.data.regions.cork.maxPages, 6);
  assert.deepEqual(store.data.regions.cork.webUrls, ["https://example.ie/lettings/cork"]);
  assert.equal(store.data.regions.limerick.maxPages, 4, "another region was not touched");

  const seen = (await call(admin, "GET", "/api/state")).data.regions;
  assert.deepEqual(seen.map((r) => r.id), ["limerick", "cork", "galway"]);
  assert.equal(seen.find((r) => r.id === "cork").watching, 1, "bob is watching in Cork");
  await call(admin, "PUT", "/api/regions/cork", { maxPages: 4, webUrls: [] });
});

test("there is only ever one admin: the admin name is reserved and a role can't be requested", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  assert.equal((await call(admin, "POST", "/api/users", { username: "KYLE", password: "another-pass-1" })).status, 409);
  assert.equal((await call(admin, "POST", "/api/users", { username: "bob", password: "another-pass-1" })).status, 409);

  const sneaky = await call(admin, "POST", "/api/users", { username: "sneaky", password: "sneaky-pass-1", role: "admin", isAdmin: true });
  assert.equal(sneaky.status, 201);
  const s = (await login("sneaky", "sneaky-pass-1")).j;
  assert.equal((await call(s, "GET", "/api/users")).status, 403);
  assert.equal((await call(s, "GET", "/api/state")).data.user.isAdmin, false);
});

test("usernames and passwords are validated", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  for (const body of [
    { username: "x", password: "long-enough-1" },
    { username: "has space", password: "long-enough-1" },
    { username: "@admin", password: "long-enough-1" },
    { username: "ok-name", password: "short" },
    { username: "ok-name", password: 12345678 },
    {},
  ]) {
    assert.equal((await call(admin, "POST", "/api/users", body)).status, 400, JSON.stringify(body));
  }
  // a name that is also an Object.prototype property is just a name
  assert.equal((await call(admin, "POST", "/api/users", { username: "constructor", password: "long-enough-1" })).status, 201);
  assert.equal((await login("toString", "long-enough-1")).status, 401);
});

test("passwords are stored hashed, and accounts survive a restart", async () => {
  const raw = fs.readFileSync(store.file, "utf8");
  assert.equal(raw.includes("bobs-password"), false);
  assert.match(JSON.parse(raw).users.find((u) => u.username === "bob").passwordHash, /^scrypt\$/);

  const users = createUsers({ store: new Store(dir), adminUsername: "kyle" });
  assert.equal((await users.verify("bob", "bobs-password"))?.username, "bob");
  assert.equal(await users.verify("bob", "bobs-passwor"), null);
});

test("successful logins are not counted against the attempt limit", async () => {
  for (let i = 0; i < 15; i++) assert.equal((await login("bob", "bobs-password")).status, 200);
});

test("devices belong to the user who registered them; test pushes only reach your own", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const bob = (await login("bob", "bobs-password")).j;

  // a subscription saved before accounts existed has no owner and is the admin's
  store.data.subscriptions.push({ ...sub("legacy"), userAgent: "Old iPhone", addedAt: "2026-09-01T00:00:00Z", lastError: null });
  assert.equal((await call(bob, "POST", "/api/subscribe", sub("bobs-phone"))).status, 200);

  assert.equal((await call(bob, "GET", "/api/state")).data.subscriptions.length, 1);
  const adminDevices = (await call(admin, "GET", "/api/state")).data.subscriptions;
  assert.equal(adminDevices.length, 1);
  assert.equal(adminDevices[0].userAgent, "Old iPhone");

  pushed.length = 0;
  assert.equal((await call(bob, "POST", "/api/test-push")).data.sent, 1);
  assert.deepEqual(pushed, ["https://push.example/bobs-phone"]);

  // nobody can remove someone else's device
  await call(admin, "POST", "/api/unsubscribe", { endpoint: "https://push.example/bobs-phone" });
  assert.equal((await call(bob, "GET", "/api/state")).data.subscriptions.length, 1);
  await call(bob, "POST", "/api/unsubscribe", { endpoint: "https://push.example/bobs-phone" });
  assert.equal((await call(bob, "GET", "/api/state")).data.subscriptions.length, 0);
});

test("the admin sees every user's devices and activity, and can test one user's devices", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const bob = (await login("bob", "bobs-password")).j;
  await call(bob, "POST", "/api/subscribe", sub("bobs-phone"));
  await call(bob, "GET", "/api/state");

  const { data } = await call(admin, "GET", "/api/users");
  const row = data.users.find((u) => u.username === "bob");
  assert.equal(row.devices.length, 1);
  assert.ok(row.lastLoginAt);
  assert.ok(row.lastSeenAt);
  assert.equal(data.users.find((u) => u.username === "sneaky").lastLoginAt !== null, true);

  pushed.length = 0;
  assert.equal((await call(admin, "POST", "/api/users/bob/test-push")).data.sent, 1);
  assert.deepEqual(pushed, ["https://push.example/bobs-phone"]);
  assert.equal((await call(admin, "POST", "/api/users/nobody/test-push")).status, 404);
});

test("marks on listings (seen, not a fit) are each account's own", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const bob = (await login("bob", "bobs-password")).j;
  const listing = () => ({ id: "daft:1", title: "Room 1", memberIds: ["daft:1"], flags: [] });
  searchOf(store, "@admin").matches = [listing()];
  searchOf(store, "bob").matches = [listing()];
  try {
    assert.equal((await call(bob, "PUT", "/api/review", { id: "daft:1", status: "rejected" })).status, 200);
    assert.equal((await call(bob, "GET", "/api/state")).data.matches[0].review, "rejected");
    assert.equal((await call(admin, "GET", "/api/state")).data.matches[0].review, null, "what bob put away is still in front of the admin");

    assert.equal((await call(admin, "PUT", "/api/review", { id: "daft:1", status: "seen" })).status, 200);
    assert.equal((await call(bob, "GET", "/api/state")).data.matches[0].review, "rejected", "and the admin's mark did not change bob's");
    assert.equal((await call(admin, "PUT", "/api/review", { id: "daft:1", status: null })).status, 200);
    assert.equal((await call(bob, "GET", "/api/state")).data.matches[0].review, "rejected");

    // a listing that is only in someone else's matches isn't yours to mark
    searchOf(store, "bob").matches = [];
    assert.equal((await call(bob, "PUT", "/api/review", { id: "daft:1", status: "seen" })).status, 404);
  } finally {
    for (const owner of ["@admin", "bob"]) Object.assign(searchOf(store, owner), { matches: [], reviews: {} });
  }
});

test("the state is the account's own: nothing in it says how many others share a search, because none do", async () => {
  const bob = (await login("bob", "bobs-password")).j;
  const { data } = await call(bob, "GET", "/api/state");
  assert.equal(data.sharedWith, undefined);
});

test("the admin can view the app as a user, and only the admin", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const bob = (await login("bob", "bobs-password")).j;
  await call(bob, "POST", "/api/subscribe", sub("bobs-phone"));
  const seenBefore = store.data.users.find((u) => u.username === "bob").lastSeenAt;

  assert.equal((await call(admin, "POST", "/api/view-as", { username: "nobody" })).status, 404);
  assert.equal((await call(admin, "POST", "/api/view-as", { username: "bob" })).status, 200);

  const { data } = await call(admin, "GET", "/api/state");
  assert.deepEqual(data.user, { username: "bob", isAdmin: false });
  assert.deepEqual(data.viewingAs, { username: "bob", by: "kyle" });
  assert.equal(data.subscriptions.length, 1, "shows bob's devices, not the admin's");
  assert.equal(store.data.users.find((u) => u.username === "bob").lastSeenAt, seenBefore, "viewing is not bob being active");

  // it behaves as bob would: no user management, and nothing that changes bob's devices or password
  assert.equal((await call(admin, "GET", "/api/users")).status, 403);
  assert.equal((await call(admin, "GET", "/api/debug")).status, 403);
  assert.equal((await call(admin, "POST", "/api/subscribe", sub("admins-laptop"))).status, 403);
  assert.equal((await call(admin, "POST", "/api/unsubscribe", { endpoint: "https://push.example/bobs-phone" })).status, 403);
  assert.equal((await call(admin, "POST", "/api/test-push")).status, 403);
  assert.equal((await call(admin, "POST", "/api/account/password", { current: "admin-pass-1", next: "brand-new-pass-1" })).status, 403);
  assert.equal(store.data.subscriptions.some((s) => s.endpoint.includes("admins-laptop")), false);
  assert.equal((await login("bob", "bobs-password")).status, 200, "bob's password is unchanged");

  // view can be switched, and ended
  assert.equal((await call(admin, "POST", "/api/view-as", { username: "sneaky" })).status, 200);
  assert.equal((await call(admin, "GET", "/api/state")).data.user.username, "sneaky");
  assert.equal((await call(admin, "DELETE", "/api/view-as")).status, 200);
  const back = (await call(admin, "GET", "/api/state")).data;
  assert.deepEqual(back.user, { username: "kyle", isAdmin: true });
  assert.equal(back.viewingAs, null);

  // a user who sends the cookie anyway is still themselves
  const forged = { session: bob.session, viewAs: "fr_viewas=sneaky" };
  assert.equal((await call(forged, "GET", "/api/state")).data.user.username, "bob");
  assert.equal((await call(forged, "DELETE", "/api/view-as")).status, 403);
});

test("signing in again ends a view-as", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  await call(admin, "POST", "/api/view-as", { username: "bob" });
  await call(admin, "POST", "/api/login", { username: "kyle", password: "admin-pass-1" });
  assert.equal((await call(admin, "GET", "/api/state")).data.viewingAs, null);
});

test("a user can change their own password; their other sessions end, this one carries on", async () => {
  const phone = (await login("sneaky", "sneaky-pass-1")).j;
  const laptop = (await login("sneaky", "sneaky-pass-1")).j;

  assert.equal((await call(phone, "POST", "/api/account/password", { current: "wrong-wrong", next: "sneaky-pass-2" })).status, 400);
  assert.equal((await call(phone, "POST", "/api/account/password", { current: "sneaky-pass-1", next: "short" })).status, 400);
  assert.equal((await call(phone, "POST", "/api/account/password", { current: "sneaky-pass-1", next: "sneaky-pass-2" })).status, 200);

  assert.equal((await call(phone, "GET", "/api/state")).status, 200);
  assert.equal((await call(laptop, "GET", "/api/state")).status, 401);
  assert.equal((await login("sneaky", "sneaky-pass-1")).status, 401);
  assert.equal((await login("sneaky", "sneaky-pass-2")).status, 200);
});

test("the admin password is not changed in the app", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const r = await call(admin, "POST", "/api/account/password", { current: "admin-pass-1", next: "brand-new-pass-1" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /ACCESS_PASSWORD/);
});

test("the admin can reset a password, which ends that user's sessions", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const bob = (await login("bob", "bobs-password")).j;
  assert.equal((await call(admin, "PUT", "/api/users/bob/password", { password: "short" })).status, 400);
  assert.equal((await call(admin, "PUT", "/api/users/nobody/password", { password: "long-enough-1" })).status, 404);
  assert.equal((await call(admin, "PUT", "/api/users/bob/password", { password: "bobs-new-password" })).status, 200);
  assert.equal((await call(bob, "GET", "/api/state")).status, 401);
  assert.equal((await login("bob", "bobs-password")).status, 401);
  assert.equal((await login("bob", "bobs-new-password")).status, 200);
});

test("removing a user ends their sessions and deletes their devices", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  const bob = (await login("bob", "bobs-new-password")).j;
  await call(bob, "POST", "/api/subscribe", sub("bobs-phone"));

  assert.equal((await call(admin, "DELETE", "/api/users/nobody")).status, 404);
  assert.equal((await call(admin, "DELETE", "/api/users/bob")).status, 200);

  assert.equal((await call(bob, "GET", "/api/state")).status, 401);
  assert.equal((await login("bob", "bobs-new-password")).status, 401);
  assert.equal(store.data.users.some((u) => u.username === "bob"), false);
  assert.equal(store.data.subscriptions.some((s) => s.endpoint.includes("bobs-phone")), false);
  assert.equal(store.data.searches.bob, undefined, "their search goes with them");

  // a new account with the same name starts clean
  await call(admin, "POST", "/api/users", { username: "bob", password: "bobs-third-pass" });
  const again = (await login("bob", "bobs-third-pass")).j;
  assert.equal((await call(again, "GET", "/api/state")).data.subscriptions.length, 0);
  assert.equal((await call(again, "GET", "/api/state")).data.campus, null, "and a new bob starts without a campus, not with the old bob's");
  assert.equal((await call(bob, "GET", "/api/state")).status, 401, "the old session does not work for the new account");
});

test("viewing as a user that has since been removed falls back to the admin", async () => {
  const admin = (await login("kyle", "admin-pass-1")).j;
  await call(admin, "POST", "/api/users", { username: "temp", password: "temp-password-1" });
  await call(admin, "POST", "/api/view-as", { username: "temp" });
  await call(admin, "DELETE", "/api/view-as");
  await call(admin, "DELETE", "/api/users/temp");
  admin.viewAs = "fr_viewas=temp";
  assert.equal((await call(admin, "GET", "/api/state")).data.user.username, "kyle");
});

test("local development without a password: the admin signs in with an empty one", async () => {
  const { store: s2 } = tempStore();
  const pusher = createPusher({ store: s2, webpush: { generateVAPIDKeys: () => ({ publicKey: "p", privateKey: "q" }) }, env: {} });
  const srv = await new Promise((r) => {
    const x = createApp({ store: s2, scanner: { isRunning: () => false }, pusher, scheduler: { nextRunAt: () => null }, password: "" }).listen(0, "127.0.0.1", () => r(x));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "" }),
    });
    assert.equal(res.status, 200);
  } finally {
    srv.close();
  }
});

test("changing the admin password signs the admin out", async () => {
  const { store: s2 } = tempStore();
  const pusher = createPusher({ store: s2, webpush: { generateVAPIDKeys: () => ({ publicKey: "p", privateKey: "q" }) }, env: {} });
  const mk = (password) => createApp({ store: s2, scanner: { isRunning: () => false }, pusher, scheduler: { nextRunAt: () => null }, adminUsername: "kyle", password, secret: "s3cret" });
  const first = mk("one-password-1");
  const second = mk("two-password-2");
  const srv1 = await new Promise((r) => { const x = first.listen(0, "127.0.0.1", () => r(x)); });
  const srv2 = await new Promise((r) => { const x = second.listen(0, "127.0.0.1", () => r(x)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv1.address().port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "kyle", password: "one-password-1" }),
    });
    const cookie = res.headers.getSetCookie()[0].split(";")[0];
    const state = (srv, c) => fetch(`http://127.0.0.1:${srv.address().port}/api/state`, { headers: { Cookie: c } });
    assert.equal((await state(srv1, cookie)).status, 200);
    assert.equal((await state(srv2, cookie)).status, 401);
  } finally {
    srv1.close();
    srv2.close();
  }
});
