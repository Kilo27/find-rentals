import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createScanner } from "../src/scan.js";
import { createLinks, DEVICE_TTL_MS, INVITE_TTL_MS } from "../src/links.js";
import { evaluateNonLocation } from "../src/filter.js";
import { makeListing } from "../src/listing.js";
import { normalizeConfig } from "../src/config.js";
import { ADMIN_OWNER } from "../src/push.js";
import { daftPage, fakePusher, makeFetch, noSleep, rawListing, searchOf, tempStore } from "./helpers.js";

// Getting someone from "the admin added them" to "alerts are on" with nothing to type and nothing to know: a sign-in link
// instead of a username and password, and a guided setup whose answers are saved and matched in one go.

let server;
let base;
let store;
let pusher;
let items;
let scanner;

const jar = () => ({ session: "", viewAs: "" });
async function call(j, method, path, body) {
  const cookie = [j?.session, j?.viewAs].filter(Boolean).join("; ");
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, value] = pair.split("=");
    const slot = name === "fr_session" ? "session" : name === "fr_viewas" ? "viewAs" : null;
    if (slot && j) j[slot] = value ? pair : "";
  }
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, cache: res.headers.get("cache-control"), data: type.includes("json") ? await res.json() : await res.text() };
}
const login = async (username, password) => {
  const j = jar();
  const r = await call(j, "POST", "/api/login", { username, password });
  return { j, ...r };
};
const admin = async () => (await login("kyle", "admin-pass-1")).j;
const join = async (token) => {
  const j = jar();
  const r = await call(j, "POST", "/api/join", { token });
  return { j, ...r };
};

async function startApp(s) {
  const scheduler = { nextRunAt: () => null, reschedule() {}, runSoon() {} };
  const app = createApp({ store: s, scanner, pusher, scheduler, adminUsername: "Kyle", password: "admin-pass-1", secret: "s3cret" });
  const srv = await new Promise((r) => {
    const x = app.listen(0, "127.0.0.1", () => r(x));
  });
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

before(async () => {
  ({ store } = tempStore());
  for (const region of Object.values(store.data.regions)) region.sources = ["daft"];
  pusher = fakePusher({ subscribers: 0 });
  items = [rawListing({ id: 1, price: "€600 per month" }), rawListing({ id: 2, price: "€950 per month" })];
  // Real Daft lists a place in one section; these are all rooms.
  const fetchImpl = makeFetch((q) => daftPage(q.section === "sharing" ? items : []));
  scanner = createScanner({ store, pusher, fetchImpl, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, transit: null });
  ({ srv: server, url: base } = await startApp(store));
});

after(() => server.close());

test("the admin adds someone with just a name, and gets a link to send instead of a password", async () => {
  const a = await admin();
  assert.equal((await call(a, "POST", "/api/users", {})).status, 400, "a name is still needed");
  const made = await call(a, "POST", "/api/users", { name: "Seán O'Brien" });
  assert.equal(made.status, 201);
  assert.equal(made.data.user.username, "seanobrien", "the username is made from the name");
  assert.equal(made.data.user.name, "Seán O'Brien");
  assert.equal(made.data.user.hasPassword, false);
  assert.match(made.data.link.token, /^[A-Za-z0-9_-]{32}$/);

  const again = await call(a, "POST", "/api/users", { name: "Sean OBrien" });
  assert.equal(again.data.user.username, "seanobrien2", "a taken name gets a number");

  assert.equal(JSON.stringify(store.data.signInLinks).includes(made.data.link.token), false, "only a hash of the link is kept");
  assert.equal((await login("seanobrien", "")).status, 401, "an account with no password can't be signed in to with an empty one");
});

test("the link signs them in on any device, with no username or password", async () => {
  const a = await admin();
  const { data } = await call(a, "POST", "/api/users", { name: "Sam" });
  const phone = await join(data.link.token);
  assert.equal(phone.status, 200);
  assert.equal(phone.data.username, "sam");
  const laptop = await join(data.link.token);
  assert.equal(laptop.status, 200, "the same link works on a second device (Safari, then the Home Screen app)");

  const state = (await call(phone.j, "GET", "/api/state")).data;
  assert.deepEqual(state.user, { username: "sam", isAdmin: false, name: "Sam", hasPassword: false });
  assert.equal(state.campus, null, "and the guided setup starts from choosing a campus");
  assert.ok(store.data.users.find((u) => u.username === "sam").lastLoginAt, "a link sign-in counts as signing in");
});

test("a link stops working when it is replaced, when they are removed, and when their sessions are ended", async () => {
  const a = await admin();
  const first = (await call(a, "POST", "/api/users", { name: "Tom" })).data.link.token;
  const second = (await call(a, "POST", "/api/users/tom/link")).data.link.token;
  assert.equal((await join(first)).status, 400, "a new link retires the last one sent");
  const refused = await join(first);
  assert.match(refused.data.error, /expired or has been replaced\. Ask the person who sent it for a new one/);
  const tom = await join(second);
  assert.equal(tom.status, 200);
  assert.equal((await call(tom.j, "GET", "/api/state")).status, 200, "and making a new one signs nobody out");

  await call(a, "PUT", "/api/users/tom/password", { password: "brand-new-pass" });
  assert.equal((await join(second)).status, 400, "a password reset ends sessions, and the links made under them");

  const third = (await call(a, "POST", "/api/users/tom/link")).data.link.token;
  await call(a, "DELETE", "/api/users/tom");
  assert.equal((await join(third)).status, 400);
  await call(a, "POST", "/api/users", { username: "tom", name: "Another Tom" });
  assert.equal((await join(third)).status, 400, "nor does it sign in to a new account that reuses the name");
});

// On a server of its own, because ten failures from one address shut the door on it for a while.
test("nonsense and made-up tokens are refused, and count as failed sign-ins", async () => {
  const shared = base;
  const { store: s } = tempStore();
  const own = await startApp(s);
  base = own.url;
  try {
    const good = (await call(await admin(), "POST", "/api/users", { name: "Yas" })).data.link.token;
    for (const token of [undefined, "", "short", "x".repeat(40), { a: 1 }, null, 7, "y".repeat(32), "z".repeat(64), "-".repeat(20)]) {
      assert.equal((await join(token)).status, 400, JSON.stringify(token));
    }
    assert.equal((await join(good)).status, 429, "after ten, even a real link waits");
  } finally {
    base = shared;
    own.srv.close();
  }
});

test("the page opened from a link names a manifest that opens the Home Screen app with the same link", async () => {
  const a = await admin();
  const token = (await call(a, "POST", "/api/users", { name: "Una" })).data.link.token;

  const page = await call(null, "GET", `/?join=${token}`);
  assert.equal(page.status, 200);
  assert.match(page.data, new RegExp(`<link rel="manifest" href="/manifest.webmanifest\\?join=${token}">`));
  const manifest = await call(null, "GET", `/manifest.webmanifest?join=${token}`);
  assert.equal(manifest.data.start_url, `/?join=${token}`);
  assert.equal(manifest.data.id, "/", "still the same app, whatever it opens at");
  assert.equal(manifest.cache, "no-store");

  const plain = await call(null, "GET", "/");
  assert.match(plain.data, /href="\/manifest.webmanifest"/);
  assert.equal((await call(null, "GET", "/manifest.webmanifest")).data.start_url, "/");

  const evil = encodeURIComponent('"><script>alert(1)</script>');
  assert.doesNotMatch((await call(null, "GET", `/?join=${evil}`)).data, /<script>alert/, "only something shaped like a token is copied in");
  assert.equal((await call(null, "GET", `/manifest.webmanifest?join=${evil}`)).data.start_url, "/");
});

test("a device can get a link of its own for its Home Screen app, but not while viewing as someone", async () => {
  const a = await admin();
  const token = (await call(a, "POST", "/api/users", { name: "Vic" })).data.link.token;
  const vic = (await join(token)).j;
  const handoff = await call(vic, "POST", "/api/account/link");
  assert.equal(handoff.status, 200);
  const life = Date.parse(handoff.data.expiresAt) - Date.now();
  assert.ok(life > DEVICE_TTL_MS - 60_000 && life <= DEVICE_TTL_MS, "it lasts as long as a session, so the Home Screen app can always sign itself in again");
  assert.equal((await join(handoff.data.token)).data.username, "vic");
  assert.equal((await join(token)).status, 200, "and the link the admin sent still works");

  const own = await call(a, "POST", "/api/account/link");
  assert.equal((await join(own.data.token)).data.username, "kyle", "the admin's devices can have one too");

  await call(a, "POST", "/api/view-as", { username: "vic" });
  assert.equal((await call(a, "POST", "/api/account/link")).status, 403, "viewing as vic is not being vic");
  await call(a, "DELETE", "/api/view-as");
});

test("opening the app from a Home Screen is noted, for the Safari page waiting on it and for the admin", async () => {
  const a = await admin();
  const token = (await call(a, "POST", "/api/users", { name: "Zoe" })).data.link.token;
  const zoe = (await join(token)).j;
  assert.equal((await call(zoe, "GET", "/api/state")).data.homeScreenAt, null);
  assert.equal((await call(zoe, "POST", "/api/account/home-screen")).status, 200);
  const at = (await call(zoe, "GET", "/api/state")).data.homeScreenAt;
  assert.ok(at && Date.now() - Date.parse(at) < 10_000);
  const row = (await call(a, "GET", "/api/users")).data.users.find((u) => u.username === "zoe");
  assert.equal(row.homeScreenAt, at, "the admin can see who has it on their Home Screen");
  assert.equal((await call(a, "GET", "/api/state")).data.homeScreenAt, null, "each account's own");
  assert.equal((await call(null, "POST", "/api/account/home-screen")).status, 401);
  await call(a, "DELETE", "/api/users/zoe");
  assert.equal(store.data.homeScreens.zoe, undefined, "and it goes with the account");
});

test("someone who signed in with a link sets a first password without a current one, then needs it", async () => {
  const a = await admin();
  const token = (await call(a, "POST", "/api/users", { name: "Wren" })).data.link.token;
  const wren = (await join(token)).j;
  assert.equal((await call(wren, "POST", "/api/account/password", { next: "short" })).status, 400);
  assert.equal((await call(wren, "POST", "/api/account/password", { next: "wrens-password" })).status, 200);
  assert.equal((await call(wren, "GET", "/api/state")).data.user.hasPassword, true);
  assert.equal((await login("wren", "wrens-password")).status, 200);
  assert.equal((await call(wren, "POST", "/api/account/password", { next: "another-one-1" })).status, 400, "now the current one is asked for");
});

test("setup saves the campus and the answers together, matches at once, and alerts only to what is listed later", async () => {
  await scanner.run(); // the Limerick pool the admin's search keeps up to date
  const a = await admin();
  const token = (await call(a, "POST", "/api/users", { name: "Xan" })).data.link.token;
  const xan = (await join(token)).j;

  const bad = await call(xan, "POST", "/api/setup", { campus: "ul", prefs: { priceMin: 900, priceMax: 100 } });
  assert.equal(bad.status, 400);
  assert.equal(searchOf(store, "xan").campus, null, "answers that don't add up change nothing, not even the campus");
  assert.equal((await call(xan, "POST", "/api/setup", { campus: "hogwarts", prefs: {} })).status, 400);

  const done = await call(xan, "POST", "/api/setup", { campus: "ul", prefs: { sections: ["sharing"], priceMax: 700, excludeOwnerOccupied: false } });
  assert.equal(done.status, 200);
  assert.equal(done.data.matched, true, "matched at once against what Limerick last collected, without asking any site");
  assert.equal(done.data.matches, 1, "the €950 room is over the budget");
  const state = (await call(xan, "GET", "/api/state")).data;
  assert.equal(state.matches.length, done.data.matches, "the preview count is what the list then shows (#19)");
  assert.equal(state.prefs.priceMax, 700);
  assert.equal(state.prefs.excludeOwnerOccupied, false);
  assert.equal(searchOf(store, "xan").baselineDone, true);
  assert.deepEqual(pusher.to("xan").map((p) => p.title), ["Watching started: 1 current matches"], "no alert for anything already listed");

  items = [rawListing({ id: 3, price: "€650 per month" }), ...items];
  await scanner.run();
  assert.deepEqual(pusher.to("xan").map((p) => p.title).slice(1), ["€650/mo · Room 3, Castletroy, Co. Limerick"], "a place listed afterwards is alerted");
  assert.equal(pusher.to(ADMIN_OWNER).filter((p) => /Room 3/.test(p.title)).length, 1, "and the admin's own search is untouched by xan's answers");
});

test("links expire, and each account keeps only its last few", () => {
  const { store: s } = tempStore();
  let t = Date.parse("2026-10-14T12:00:00Z");
  const links = createLinks({ store: s, now: () => new Date(t) });
  const keyOf = () => "key-1";
  const { token } = links.issue("sam", "key-1");
  assert.equal(links.redeem(token, keyOf), "sam");
  t += INVITE_TTL_MS + 1;
  assert.equal(links.redeem(token, keyOf), null, "two weeks on it has expired");

  const tokens = Array.from({ length: 12 }, () => links.issue("sam", "key-1", { purpose: "device" }).token);
  assert.equal(s.data.signInLinks.filter((l) => l.username === "sam").length, 10);
  assert.equal(links.redeem(tokens[0], keyOf), null, "the oldest went first");
  assert.equal(links.redeem(tokens[11], keyOf), "sam");
  assert.equal(links.redeem(tokens[11], () => "key-2"), null, "a link made before the account's sessions were ended doesn't work after");
  assert.equal(links.redeem(tokens[11], () => null), null, "nor once the account is gone");
});

// "A room" or "a whole place" is the first thing the guided setup asks, and a region collects for everyone watching there,
// so each account's answer has to be applied when it is matched.
test("filter: only the kinds of place an account asked for", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const rooms = normalizeConfig({ sections: ["sharing", "student-accommodation-to-share"] });
  const whole = normalizeConfig({ sections: ["residential-to-rent"] });
  const daftHouse = makeListing({ source: "daft", sourceLabel: "Daft.ie", externalId: "1", url: "https://www.daft.ie/for-rent/x/1", title: "3 bed house, Castletroy", section: "residential-to-rent", kind: "property" });
  const daftRoom = makeListing({ source: "daft", sourceLabel: "Daft.ie", externalId: "2", url: "https://www.daft.ie/share/x/2", title: "Double room, Castletroy", section: "sharing", kind: "room" });
  const rentRoom = makeListing({ source: "rent", sourceLabel: "Rent.ie", externalId: "3", url: "https://www.rent.ie/rooms-to-rent/limerick/castletroy/3", title: "Double room in Castletroy" });
  const rentUnclear = makeListing({ source: "rent", sourceLabel: "Rent.ie", externalId: "4", url: "https://www.rent.ie/x/4", title: "Plassey Park, Castletroy" });

  assert.equal(evaluateNonLocation({ ...daftHouse }, rooms, now).ok, false, "a Daft house for someone who wants a room");
  assert.equal(evaluateNonLocation({ ...daftRoom }, rooms, now).ok, true);
  assert.equal(evaluateNonLocation({ ...daftRoom }, whole, now).ok, false);
  assert.equal(evaluateNonLocation({ ...daftHouse }, whole, now).ok, true);
  assert.equal(evaluateNonLocation({ ...rentRoom }, whole, now).ok, false, "another site's advert that says it is a room");
  assert.equal(evaluateNonLocation({ ...rentRoom }, rooms, now).ok, true);
  assert.equal(evaluateNonLocation({ ...rentUnclear }, rooms, now).ok, true, "one that doesn't say is kept rather than guessed away");
  assert.equal(evaluateNonLocation({ ...rentUnclear }, whole, now).ok, true);
});
