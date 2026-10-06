import { collectRegion } from "./collect.js";
import { matchAccount } from "./match.js";
import { createGeocoder } from "./geocode.js";
import { proxyFromEnv } from "./proxy.js";
import { searchCampus } from "./catalogue.js";
import { regionStatus, scannableRegionIds } from "./regions.js";
import { watchers } from "./searches.js";
import { defaultTransit } from "./transit.js";

const srcBrief = (s) => {
  if (s.skipped) return `${s.id}=skipped`;
  if (!s.ok) return `${s.id}=ERROR(${s.error})`;
  const flagged = s.notes.some((n) => n.warning || !n.ok);
  return `${s.id}=${s.fetched}${flagged ? "!" : ""}`;
};

// One line per region per scan for the platform logs: counts and source health only, never listing contents.
export function summarizeRun(run) {
  const sources = run.sources.map(srcBrief).join(" ");
  if (!run.ok) return `[scan] ${run.region} FAILED in ${run.durationMs}ms: ${run.error} | ${sources}`;
  return (
    `[scan] ${run.region} ok mode=${run.mode} ${run.durationMs}ms | ${sources} | candidates=${run.candidates} rejected=${run.rejected}` +
    ` pending=${run.pending} matches=${run.matches} new=${run.newCount} notified=${run.notified}` +
    ` accounts=${run.accounts}` +
    (run.proxied?.length ? ` | via-${run.via ?? "proxy"}=${run.proxied.join(",")}` : "") +
    (run.laptopOffline ? " | laptop=offline" : "")
  );
}

export function problemLines(run) {
  const out = [];
  for (const s of run.sources) {
    for (const n of s.notes) {
      const where = `${run.region} ${s.id} ${n.group}`;
      if (!n.ok) {
        const body = n.body ? ` [${String(n.body).replace(/\s+/g, " ").slice(0, 120)}]` : "";
        out.push(`[scan] ${where}: ERROR ${n.error}${body}`);
      }
      else if (n.warning) out.push(`[scan] ${where}: WARNING ${n.warning}`);
      else if (n.skipped) out.push(`[scan] ${where}: skipped, ${n.skipped}`);
    }
    if (!s.ok && s.notes.length === 0) out.push(`[scan] ${run.region} ${s.id}: ERROR ${s.error}`);
  }
  for (const [source, count] of Object.entries(run.coordsIgnored ?? {})) {
    out.push(`[scan] ${run.region} ${source}: ignored ${count} coordinate(s) shared by many listings (site-level map position, not the property)`);
  }
  return out;
}

const SILENT = { log() {}, warn() {} };

const sum = (runs, key) => runs.reduce((n, r) => n + (r[key] ?? 0), 0);

// One result for a scan that covered several regions. A scan of one region is that region's run, so what a caller sees
// doesn't change shape when a second region is switched on; `regions` always has the individual runs.
function aggregate(runs, at) {
  if (runs.length === 1) return { ...runs[0], regions: runs };
  return {
    at,
    ok: runs.every((r) => r.ok),
    mode: runs.length === 0 ? "idle" : runs.some((r) => r.mode === "baseline") ? "baseline" : "normal",
    durationMs: sum(runs, "durationMs"),
    sources: [],
    candidates: sum(runs, "candidates"),
    rejected: sum(runs, "rejected"),
    pending: sum(runs, "pending"),
    matches: sum(runs, "matches"),
    newCount: sum(runs, "newCount"),
    notified: sum(runs, "notified"),
    accounts: sum(runs, "accounts"),
    regions: runs,
  };
}

// The scanner works in two stages (#13). For each region somebody is watching in, it COLLECTS: reads the region's sites once
// and keeps the pool of listings, with nobody's preferences applied. Then it MATCHES each account watching there against that
// pool, with the account's own preferences, its own list of what it has seen, and alerts to its own devices. So what the
// sites are asked grows with the number of regions being watched, not with the number of accounts, and one account can be
// matched again, after a change of preferences, without asking the sites anything.
export function createScanner({ store, pusher, fetchImpl = fetch, sleep, politenessMs, geocodeDelayMs, now = () => new Date(), log = SILENT, proxy = proxyFromEnv(), transit = defaultTransit(log.warn) }) {
  // The latest pool for each region. It lives in memory: the accounts' own matches are what is saved, and a restart
  // collects again before the next match.
  const pools = new Map();
  let inflight = null;
  let seq = 0;
  // Only one account is matched at a time, so a match asked for by the app and one in the middle of a scan can't both alert
  // for the same listing.
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const matchContext = { store, pusher, transit, now };

  function run({ regions } = {}) {
    if (!inflight) inflight = doScan(regions).finally(() => (inflight = null));
    return inflight;
  }

  async function doScan(only) {
    const ids = scannableRegionIds(store).filter((id) => !only || only.includes(id));
    const geocoder = createGeocoder({ store, fetchImpl, sleep, minIntervalMs: geocodeDelayMs });
    const runs = [];
    for (const id of ids) {
      const result = await scanRegion(id, geocoder);
      runs.push(result);
      store.save();
      try {
        log.log(summarizeRun(result));
        for (const line of problemLines(result)) log.warn(line);
      } catch {
        /* logging must never break a scan */
      }
    }
    if (ids.length === 0 && !only) {
      try {
        log.log("[scan] idle: nobody is watching in a region that is switched on");
      } catch {
        /* logging must never break a scan */
      }
    }
    return aggregate(runs, now().toISOString());
  }

  async function scanRegion(regionId, geocoder) {
    const t0 = now();
    const accounts = watchers(store, regionId);
    const { pool, run: collected } = await collectRegion({ store, pusher, regionId, geocoder, fetchImpl, sleep, politenessMs, proxy, now, seq: ++seq });

    if (!pool) {
      // Nothing could be read, so every account keeps what it has and is told the check didn't work.
      for (const { search } of accounts) {
        search.lastRun = { at: collected.at, durationMs: collected.durationMs, ok: false, error: collected.error, sources: collected.sources, laptopOffline: collected.laptopOffline };
      }
      return { ...collected, accounts: accounts.length };
    }
    pools.set(regionId, pool);

    const totals = { rejected: 0, matches: 0, newCount: 0, notified: 0 };
    let baselining = false;
    for (const account of accounts) {
      const r = await exclusive(() => matchAccount(matchContext, account, pool));
      if (!r) continue;
      baselining ||= r.mode === "baseline";
      for (const k of Object.keys(totals)) totals[k] += r[k];
    }
    const result = { ...collected, mode: baselining ? "baseline" : "normal", ...totals, durationMs: now() - t0, accounts: accounts.length };
    regionStatus(store, regionId).lastRun = result;
    return result;
  }

  // Matches one account again against the pool already collected for its region, without asking any site anything. This is
  // what a change of preferences or of campus does. False when there is no pool to match against yet (the region hasn't
  // been collected since the server started, or since the account asked for something the pool doesn't have).
  async function match(owner) {
    const search = store.data.searches[owner];
    const campus = search?.campus ? searchCampus(search.campus) : null;
    const pool = campus ? pools.get(campus.regionId) : null;
    if (!pool) return false;
    const r = await exclusive(() => matchAccount(matchContext, { owner, search }, pool));
    if (r) store.save();
    return r !== null;
  }

  return { run, match, hasPool: (regionId) => pools.has(regionId), isRunning: () => inflight !== null };
}
