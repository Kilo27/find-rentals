import test from "node:test";
import assert from "node:assert/strict";
import { alertsSetup, answersFromPrefs, cleanSearch, collegeYearEnd, describeAnswers, devicePlatform, distanceChoices, homeScreenMode, inviteText, joinFromSearch, kindOf, linkInviteText, listingFromSearch, prefsFromAnswers, safariLayout, setupQuestions, summarizeSources } from "../public/app-model.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const src = (id, over = {}) => ({ id, label: id.toUpperCase(), ok: true, fetched: 5, notes: [], ...over });
const state = (over = {}) => ({
  config: { enabled: true, intervalMinutes: 30 },
  sourceHealth: {},
  lastRun: { at: minutesAgo(16), ok: true, sources: [src("daft"), src("ul")] },
  ...over,
});

test("sources: all working reads as calm, with one line and nothing to fix", () => {
  const s = summarizeSources(state(), NOW);
  assert.equal(s.level, "ok");
  assert.equal(s.headline, "Watching 2 sites · last check 16 min ago");
  assert.deepEqual(s.issues, []);
  assert.equal(s.note, null);
});

test("sources: a paused or failing site is named in plain words, and the raw error stays for the admin", () => {
  const s = summarizeSources(
    state({
      lastRun: {
        at: minutesAgo(16),
        ok: true,
        sources: [src("daft"), src("rent", { skipped: "laptop agent offline", fetched: 0 }), src("myhome", { ok: false, error: "HTTP 403 from www.myhome.ie" }), src("ul")],
      },
      sourceHealth: { myhome: { failures: 4 } },
    }),
    NOW,
  );
  assert.equal(s.level, "partial");
  assert.equal(s.headline, "Watching 2 of 4 sites · last check 16 min ago");
  assert.deepEqual(s.issues.map((i) => i.text), ["RENT: Paused for now. It will catch up by itself.", "MYHOME: Not responding for a while."]);
  assert.equal(s.note, "Not checking properly: RENT (paused), MYHOME (not responding)", "the one line that sits above the list");
  assert.ok([...s.issues.map((i) => i.text), s.note].every((t) => !/403|laptop|agent/i.test(t)), "no codes or internals in what everyone sees");
  assert.equal(s.rows.find((r) => r.id === "rent").raw, "not checked: laptop agent offline");
  assert.equal(s.rows.find((r) => r.id === "myhome").raw, "error: HTTP 403 from www.myhome.ie (failing x4)");
});

test("sources: a site that is only paused is routine, so it is calm, and invited users are not shown site names", () => {
  const s = summarizeSources(state({ lastRun: { at: minutesAgo(16), ok: true, sources: [src("daft", { skipped: "laptop agent offline", fetched: 0 }), src("rent", { skipped: "laptop agent offline", fetched: 0 }), src("ul")] } }), NOW);
  assert.equal(s.level, "catching-up", "not the warning level");
  assert.equal(s.headline, "Watching 1 of 3 sites · last check 16 min ago");
  assert.equal(s.note, "Catching up: DAFT, RENT", "the admin sees which");
  assert.equal(s.plainNote, "Some sites are catching up.", "everyone else only that something is");
  assert.ok(!/DAFT|RENT/.test(s.plainNote));
});

test("sources: a site that is not responding is the warning level, and says 'for a while' once it keeps failing", () => {
  const mk = (failures) => summarizeSources(state({ sourceHealth: { ul: { failures } }, lastRun: { at: minutesAgo(5), ok: true, sources: [src("daft"), src("ul", { ok: false, error: "HTTP 403" })] } }), NOW);
  const now = mk(1);
  assert.equal(now.level, "partial");
  assert.equal(now.rows[1].detail, "Not responding right now.");
  assert.equal(now.plainNote, "Some sites aren't responding, so you may miss a few places.");
  assert.equal(mk(4).rows[1].detail, "Not responding for a while.");
});

test("sources: a pause alongside a real fault is still a fault", () => {
  const s = summarizeSources(state({ lastRun: { at: minutesAgo(5), ok: true, sources: [src("daft", { skipped: "laptop agent offline", fetched: 0 }), src("ul", { ok: false, error: "x" }), src("rent")] } }), NOW);
  assert.equal(s.level, "partial");
  assert.equal(s.note, "Not checking properly: DAFT (paused), UL (not responding)");
});

test("sources: a page that loaded but looked wrong is a warning, not a failure", () => {
  const s = summarizeSources(state({ lastRun: { at: minutesAgo(5), ok: true, sources: [src("daft", { notes: [{ ok: true, warning: "no listings recognised" }] })] } }), NOW);
  assert.equal(s.level, "partial");
  assert.equal(s.rows[0].status, "warn");
  assert.equal(s.headline, "Watching 1 site · last check 5 min ago");
});

test("sources: nothing working, nothing selected, and a scan that failed outright", () => {
  const down = summarizeSources(state({ lastRun: { at: minutesAgo(5), ok: true, sources: [src("daft", { ok: false, error: "x" })] } }), NOW);
  assert.equal(down.level, "down");
  assert.match(down.headline, /^Not watching any sites right now/);

  const none = summarizeSources(state({ lastRun: { at: minutesAgo(5), ok: true, sources: [] } }), NOW);
  assert.equal(none.level, "down");

  const failed = summarizeSources(state({ lastRun: { at: minutesAgo(5), ok: false, error: "boom" } }), NOW);
  assert.equal(failed.level, "failed");
  assert.match(failed.headline, /didn't work/);
});

test("sources: no scan yet, paused, and a scan that is long overdue are each their own state", () => {
  assert.equal(summarizeSources(state({ lastRun: null }), NOW).level, "none");
  assert.equal(summarizeSources(state({ config: { enabled: false } }), NOW).level, "paused");
  const late = summarizeSources(state({ lastRun: { at: minutesAgo(200), ok: true, sources: [src("daft")] } }), NOW);
  assert.equal(late.level, "stale");
  assert.match(late.headline, /Last check was 3 h ago, so alerts may be late/);
  // 80 minutes on a 30 minute schedule is still within the 90 minute allowance.
  assert.equal(summarizeSources(state({ lastRun: { at: minutesAgo(80), ok: true, sources: [src("daft")] } }), NOW).level, "ok");
  // A slow schedule scales the allowance: three intervals.
  const slow = state({ config: { enabled: true, intervalMinutes: 120 }, lastRun: { at: minutesAgo(300), ok: true, sources: [src("daft")] } });
  assert.equal(summarizeSources(slow, NOW).level, "ok");
});

test("sources: an account that hasn't chosen a campus has nothing to check, and is told what to do", () => {
  const s = summarizeSources(state({ config: null, lastRun: null }), NOW);
  assert.equal(s.level, "none");
  assert.equal(s.headline, "Choose a campus to start watching");
  assert.deepEqual(s.rows, []);
  assert.equal(summarizeSources(state({ config: { enabled: false } }), NOW).level, "paused", "a region that is switched off is still just paused");
});

test("a password the admin sets is sent with the address and username, and nothing else", () => {
  const reset = inviteText({ url: "https://rw.example.com", username: "aoife", password: "newpass99" });
  assert.match(reset, /password has been changed/);
  assert.match(reset, /Open: https:\/\/rw\.example\.com/);
  assert.match(reset, /Username: aoife/);
  assert.match(reset, /Password: newpass99/);
  assert.doesNotMatch(reset, /Home Screen/, "setting up the phone is what a sign-in link is for");
});

test("alerts setup: each device lands in exactly one state", () => {
  const base = { viewing: false, isIos: false, standalone: false, supported: true, permission: "default", subscribedHere: false };
  assert.equal(alertsSetup({ ...base, viewing: true }), "viewing");
  assert.equal(alertsSetup({ ...base, isIos: true, supported: false }), "install", "Safari on an iPhone can't do push until it is on the Home Screen");
  assert.equal(alertsSetup({ ...base, isIos: true, standalone: true }), "off", "...but the Home Screen app can");
  assert.equal(alertsSetup({ ...base, supported: false }), "unsupported");
  assert.equal(alertsSetup({ ...base, permission: "denied" }), "blocked");
  assert.equal(alertsSetup({ ...base, permission: "granted", subscribedHere: true }), "on");
  assert.equal(alertsSetup({ ...base, permission: "granted", subscribedHere: false }), "off", "allowed but never subscribed");
  assert.equal(alertsSetup(base), "off");
});

test("listing from an alert's address", () => {
  assert.equal(listingFromSearch("?listing=daft%3A123"), "daft:123");
  assert.equal(listingFromSearch(""), null);
  assert.equal(listingFromSearch("?other=1"), null);
  assert.equal(listingFromSearch("?listing="), null);
});

// --- Getting someone set up -------------------------------------------------------------------------------------------

const UA = {
  iphone26: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iphone17: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  homeScreenApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};
const device = (ua, over = {}) => devicePlatform({ ua: UA[ua], ...over });

test("platform: which phone and browser, as far as it matters for getting set up", () => {
  assert.deepEqual(
    [device("iphone26").safari, device("iphone26").safariVersion, device("iphone26").ipad],
    [true, 26, false],
    "Safari 26 still says iOS 18 in its user agent; its own version is what counts",
  );
  assert.equal(device("ipadDesktop", { touchPoints: 5 }).ipad, true, "an iPad asking for desktop pages says it is a Mac but has a touch screen");
  assert.equal(device("mac").ios, false, "a real Mac has no touch screen");
  assert.equal(device("instagram").inApp, true);
  assert.equal(device("instagram").safari, false);
  assert.equal(device("chromeIos").otherBrowser, true);
  assert.equal(device("chromeIos").safari, false);
  const app = device("homeScreenApp", { standalone: true });
  assert.equal(app.inApp, false, "the Home Screen app has no Safari in its user agent but isn't someone else's browser");
  assert.equal(device("android").android, true);
});

test("home screen: one tap where the browser allows it, the taps spelt out on an iPhone, nothing on a computer", () => {
  const mode = (ua, over = {}, canPrompt = false) => homeScreenMode({ platform: device(ua, over), canPrompt });
  assert.equal(mode("iphone26"), "ios-safari");
  assert.equal(mode("instagram"), "ios-elsewhere", "an app's own browser can't add to the Home Screen; Safari first");
  assert.equal(mode("chromeIos"), "ios-elsewhere");
  assert.equal(mode("homeScreenApp", { standalone: true }), "installed");
  assert.equal(mode("android", {}, true), "prompt", "Chrome on Android installs with one tap once it offers to");
  assert.equal(mode("android"), "android-menu", "until it does, the browser's menu");
  assert.equal(mode("mac"), "none");
  assert.equal(mode("mac", {}, true), "prompt", "a computer whose browser offers it can take it");

  assert.equal(safariLayout(device("iphone26")), "compact", "Safari 26 keeps Share behind the ⋯ button");
  assert.equal(safariLayout(device("iphone17")), "classic");
  assert.equal(safariLayout(device("ipadDesktop", { touchPoints: 5 })), "ipad");
});

test("sign-in links: read once from the address, then taken out of it", () => {
  // Shaped like a link's token but plainly made up, so secret scanners don't take a test for a leak.
  const token = "x".repeat(32);
  assert.equal(joinFromSearch(`?join=${token}`), token);
  assert.equal(joinFromSearch("?join=short"), null);
  assert.equal(joinFromSearch('?join="><script>'), null);
  assert.equal(joinFromSearch(""), null);
  assert.equal(cleanSearch(`?join=${token}`), "");
  assert.equal(cleanSearch(`?listing=daft%3A1&join=${token}&utm=x`), "?utm=x", "anything else in the address stays");
  assert.equal(cleanSearch(""), "");
});

test("invite: a link and nothing to remember, greeting them by first name", () => {
  const link = "https://rw.example.com/?join=abc";
  const text = linkInviteText({ name: "Seán O'Brien", link });
  assert.match(text, /^Hi Seán, I've set you up on Rental Watch/);
  assert.ok(text.includes(link));
  assert.match(text, /no password/);
  assert.match(text, /open it in Safari/);
  assert.match(text, /2 weeks/);
  assert.doesNotMatch(text, /Username|Password:/);
  assert.match(linkInviteText({ name: null, link, fresh: true }), /^Here's a new link for Rental Watch\./);
  assert.match(linkInviteText({ name: "Sam", link, fresh: true }), /^Hi Sam, here's a new link/);
});

test("setup answers: the questions stand for preferences, and back again", () => {
  const prefs = { sections: ["sharing", "student-accommodation-to-share"], priceMax: 800, needFrom: "", stayUntil: "2027-06-30", excludeOwnerOccupied: true, excludeWeekdayOnly: false, radiusKm: 2, transitEnabled: true };
  const a = answersFromPrefs(prefs);
  assert.deepEqual(a, { kind: "room", budget: 800, moveIn: "", stayUntil: "2027-06-30", liveIn: false, weekdays: true, radiusKm: 2, transit: true });
  assert.deepEqual(prefsFromAnswers(a), prefs, "a round trip changes nothing");

  assert.equal(kindOf(["residential-to-rent"]), "whole");
  assert.equal(kindOf(["sharing", "residential-to-rent"]), "either");
  assert.equal(kindOf(["student-accommodation-to-share"]), "room");
  assert.deepEqual(prefsFromAnswers({ ...a, kind: "whole" }).sections, ["residential-to-rent"]);

  assert.deepEqual(setupQuestions({ kind: "room" }), ["campus", "kind", "budget", "dates", "sharing"]);
  assert.deepEqual(setupQuestions({ kind: "whole" }), ["campus", "kind", "budget", "dates"], "living with the owner is about rooms");

  const said = describeAnswers(a, { short: "UL" }, { transitMaxKm: 5 });
  assert.equal(said.kind, "A room in a shared place");
  assert.equal(said.budget, "Up to €800 a month");
  assert.equal(said.dates, "As soon as possible, until 30 Jun 2027");
  assert.equal(said.sharing, "Not with a live-in owner · weekdays only is fine");
  assert.equal(said.distance, "Within 2 km of UL, or up to 5 km on a direct bus or train");
  assert.equal(describeAnswers({ ...a, budget: null, stayUntil: "", transit: false }, { short: "UL" }).budget, "Any price");
  assert.match(describeAnswers({ ...a, stayUntil: "" }, null).dates, /for as long as I like/);

  assert.equal(collegeYearEnd(new Date("2026-10-14")), "2027-06-30");
  assert.equal(collegeYearEnd(new Date("2027-03-01")), "2027-06-30");
  assert.equal(collegeYearEnd(new Date("2027-07-01")), "2028-06-30", "in summer, the coming year");
  assert.deepEqual(distanceChoices(4.5), [1, 2, 3]);
  assert.deepEqual(distanceChoices(5), [1, 2, 3, 5]);
});
