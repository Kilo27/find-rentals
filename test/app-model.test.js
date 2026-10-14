import test from "node:test";
import assert from "node:assert/strict";
import { alertsSetup, inviteText, listingFromSearch, summarizeSources } from "../public/app-model.js";

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

test("invite: new users get the steps for an iPhone, a reset gets only the new password", () => {
  const invite = inviteText({ url: "https://rw.example.com", username: "aoife", password: "pw123456" });
  assert.match(invite, /Open: https:\/\/rw\.example\.com/);
  assert.match(invite, /Username: aoife/);
  assert.match(invite, /Password: pw123456/);
  assert.match(invite, /Add to Home Screen/);
  assert.match(invite, /Turn on alerts/);
  assert.match(invite, /Choose your campus/, "nothing is watched for a new account until they pick one");
  assert.match(invite, /Copy the link into Safari/, "a link opened inside WhatsApp can't be added to the Home Screen");
  assert.match(invite, /log in again/, "the Home Screen app is a separate app to Safari");
  assert.match(invite, /change your password any time under Alerts/);

  const reset = inviteText({ url: "https://rw.example.com", username: "aoife", password: "newpass99", reset: true });
  assert.match(reset, /password has been reset/);
  assert.match(reset, /Password: newpass99/);
  assert.doesNotMatch(reset, /Home Screen/);
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
