import test from "node:test";
import assert from "node:assert/strict";
import { createScanner, problemLines, summarizeRun } from "../src/scan.js";
import { configure, daftPage, httpError, noSleep, rawListing, router, searchOf, tempStore, fakePusher } from "./helpers.js";

const UL_LIST = "https://www.accommodation.ul.ie/SearchResults/Print/All";
const DAFT = /^https:\/\/www\.daft\.ie\/sharing\//;

function capture() {
  const lines = { log: [], warn: [] };
  return { lines, log: { log: (l) => lines.log.push(l), warn: (l) => lines.warn.push(l) } };
}

function setup(sources, fetchImpl, log) {
  const { store } = tempStore();
  configure(store, { sources, sections: ["sharing"], ulUrls: [UL_LIST], rentUrls: [], myhomeUrls: [], webUrls: [] });
  const scanner = createScanner({ store, pusher: fakePusher(), fetchImpl, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, log });
  return { store, scanner };
}

test("a successful scan logs exactly one summary line with counts", async () => {
  const { lines, log } = capture();
  const { scanner } = setup(["daft"], router([[DAFT, daftPage([rawListing({ id: 1 })])]]), log);
  await scanner.run();
  assert.equal(lines.log.length, 1);
  assert.match(lines.log[0], /^\[scan\] limerick ok mode=baseline \d+ms \| daft=1 \| candidates=1 rejected=0 pending=0 matches=1 new=1 notified=0 accounts=1$/);
  assert.deepEqual(lines.warn, []);
});

test("a failing source is named in the summary and gets its own warning line", async () => {
  const { lines, log } = capture();
  const fetchImpl = router([
    ["https://www.accommodation.ul.ie/robots.txt", "User-agent: *\nDisallow: /SearchResults/"],
    [DAFT, daftPage([rawListing({ id: 1 })])],
  ]);
  const { scanner } = setup(["daft", "ul"], fetchImpl, log);
  await scanner.run();
  assert.match(lines.log[0], /daft=1 ul=ERROR\(Blocked by robots\.txt/);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], new RegExp(`^\\[scan\\] limerick ul ${UL_LIST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: ERROR Blocked by robots\\.txt`));
});

test("when every source fails the summary says FAILED", async () => {
  const { lines, log } = capture();
  const { scanner } = setup(["daft"], router([[DAFT, () => httpError(403, "blocked")]]), log);
  await scanner.run();
  assert.match(lines.log[0], /^\[scan\] limerick FAILED in \d+ms: HTTP 403 from www\.daft\.ie \| daft=ERROR\(HTTP 403 from www\.daft\.ie\)$/);
  assert.match(lines.warn[0], /^\[scan\] limerick daft sharing: ERROR HTTP 403 from www\.daft\.ie \[blocked\]$/);
});

test("an unrecognised page layout is flagged with ! and a WARNING line", async () => {
  const { lines, log } = capture();
  const blank = `<html><body>${"<div>nothing we know</div>".repeat(200)}</body></html>`;
  const { scanner } = setup(["ul"], router([[UL_LIST, blank]]), log);
  await scanner.run();
  assert.match(lines.log[0], /ul=0! /);
  assert.match(lines.warn[0], /ul .*: WARNING page loaded but no listings were recognised/);
});

test("skipped (404) pages are reported as skipped, not errors", () => {
  const run = {
    ok: true,
    region: "limerick",
    sources: [{ id: "rent", ok: true, fetched: 0, notes: [{ group: "https://www.rent.ie/x/", ok: true, skipped: "404: page not found (URL may have changed)" }] }],
  };
  assert.deepEqual(problemLines(run), ["[scan] limerick rent https://www.rent.ie/x/: skipped, 404: page not found (URL may have changed)"]);
});

test("logs never contain listing titles or URLs", async () => {
  const { lines, log } = capture();
  const item = rawListing({ id: 7, title: "Room 14, Secret Street, Castletroy", price: "€650 per month" });
  const { scanner } = setup(["daft"], router([[DAFT, daftPage([item])]]), log);
  await scanner.run();
  const all = [...lines.log, ...lines.warn].join("\n");
  assert.ok(!all.includes("Secret Street") && !all.includes("daft.ie/share"), all);
});

test("a logger that throws never breaks a scan", async () => {
  const boom = { log() { throw new Error("log sink down"); }, warn() { throw new Error("log sink down"); } };
  const { scanner, store } = setup(["daft"], router([[DAFT, daftPage([rawListing({ id: 1 })])]]), boom);
  const run = await scanner.run();
  assert.equal(run.ok, true);
  assert.equal(searchOf(store).matches.length, 1);
});

test("the scanner is silent by default (library use and tests)", async () => {
  const seen = [];
  const { log: origLog, warn: origWarn } = console;
  console.log = (...a) => seen.push(a.join(" "));
  console.warn = (...a) => seen.push(a.join(" "));
  try {
    const { scanner } = setup(["daft"], router([[DAFT, daftPage([])]]), undefined);
    await scanner.run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  assert.deepEqual(seen, []);
});

test("summarizeRun handles a run with no sources cleanly", () => {
  assert.equal(summarizeRun({ ok: false, region: "limerick", durationMs: 3, error: "No sources enabled", sources: [] }), "[scan] limerick FAILED in 3ms: No sources enabled | ");
});

test("ignored site-wide coordinates are reported in the logs", () => {
  const run = { ok: true, region: "limerick", sources: [], coordsIgnored: { ul: 80 } };
  assert.deepEqual(problemLines(run), ["[scan] limerick ul: ignored 80 coordinate(s) shared by many listings (site-level map position, not the property)"]);
});

test("a scan with nobody watching says so and fetches nothing", async () => {
  const { lines, log } = capture();
  const fetchImpl = router([]);
  const { scanner, store } = setup(["daft"], fetchImpl, log);
  searchOf(store).campus = null;
  const run = await scanner.run();
  assert.equal(run.mode, "idle");
  assert.deepEqual(lines.log, ["[scan] idle: nobody is watching in a region that is switched on"]);
  assert.equal(fetchImpl.calls.length, 0);
});
