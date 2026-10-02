import { ADAPTERS } from "./sources/index.js";
import { usableDetail } from "./sources/web.js";
import { createFetcher } from "./html.js";
import { createGeocoder, resolveArea, resolveLocation } from "./geocode.js";
import { analyzeListing, evaluateLocation, evaluateNonLocation } from "./filter.js";
import { dedupe } from "./dedupe.js";
import { stripSharedCoords } from "./coords.js";
import { proxyFromEnv } from "./proxy.js";
import { ADMIN_OWNER, buildListingPayload } from "./push.js";
import { attachTransit, defaultTransit } from "./transit.js";

const MAX_INDIVIDUAL_PUSHES = 5;
const MAX_STORED_MATCHES = 200;
const SEEN_TTL_MS = 365 * 24 * 3600_000;
const CACHE_TTL_MS = 14 * 24 * 3600_000;
const MAX_PENDING_SCANS = 5;
const MAX_BASELINE_SCANS = 6;
const GEOCODE_BUDGET = 60;
const SOURCE_ALERT_AFTER = 6;
const LAPTOP_ALERT_AFTER_MS = 24 * 3600_000;

const srcBrief = (s) => {
  if (s.skipped) return `${s.id}=skipped`;
  if (!s.ok) return `${s.id}=ERROR(${s.error})`;
  const flagged = s.notes.some((n) => n.warning || !n.ok);
  return `${s.id}=${s.fetched}${flagged ? "!" : ""}`;
};

// One line per scan for the platform logs: counts and source health only, never listing contents.
export function summarizeRun(run) {
  const sources = run.sources.map(srcBrief).join(" ");
  if (!run.ok) return `[scan] FAILED in ${run.durationMs}ms: ${run.error} | ${sources}`;
  return (
    `[scan] ok mode=${run.mode} ${run.durationMs}ms | ${sources} | candidates=${run.candidates} rejected=${run.rejected}` +
    ` pending=${run.pending} matches=${run.matches} new=${run.newCount} notified=${run.notified}` +
    (run.proxied?.length ? ` | via-${run.via ?? "proxy"}=${run.proxied.join(",")}` : "") +
    (run.laptopOffline ? " | laptop=offline" : "")
  );
}

export function problemLines(run) {
  const out = [];
  for (const s of run.sources) {
    for (const n of s.notes) {
      const where = `${s.id} ${n.group}`;
      if (!n.ok) {
        const body = n.body ? ` [${String(n.body).replace(/\s+/g, " ").slice(0, 120)}]` : "";
        out.push(`[scan] ${where}: ERROR ${n.error}${body}`);
      }
      else if (n.warning) out.push(`[scan] ${where}: WARNING ${n.warning}`);
      else if (n.skipped) out.push(`[scan] ${where}: skipped, ${n.skipped}`);
    }
    if (!s.ok && s.notes.length === 0) out.push(`[scan] ${s.id}: ERROR ${s.error}`);
  }
  for (const [source, count] of Object.entries(run.coordsIgnored ?? {})) {
    out.push(`[scan] ${source}: ignored ${count} coordinate(s) shared by many listings (site-level map position, not the property)`);
  }
  return out;
}

const SILENT = { log() {}, warn() {} };

export function createScanner({ store, pusher, fetchImpl = fetch, sleep, politenessMs, geocodeDelayMs, now = () => new Date(), log = SILENT, proxy = proxyFromEnv(), transit = defaultTransit(log.warn) }) {
  let inflight = null;

  // How the scanner is doing is for whoever runs it. Everyone else gets alerts about places, and the status line in
  // the app says if the sites are not being checked; a note about a laptop agent or an HTTP code helps nobody else.
  const toAdmin = (payload) => pusher.sendToOwner(ADMIN_OWNER, payload);

  function run() {
    if (!inflight) inflight = doScan().finally(() => (inflight = null));
    return inflight;
  }

  // One push when the laptop agent has been away for a day, and one when it is back.
  async function noteLaptop(d, offline, t0, labels) {
    const lap = (d.laptop ??= { lastOnlineAt: null, offlineNotified: false });
    const names = labels.join(" and ");
    const plural = labels.length > 1;
    if (!offline) {
      if (lap.offlineNotified) {
        await toAdmin({ title: "Laptop agent is back", body: `${names} ${plural ? "are" : "is"} being checked again.`, url: "/", tag: "laptop" });
      }
      lap.lastOnlineAt = t0.toISOString();
      lap.offlineNotified = false;
      return;
    }
    lap.lastOnlineAt ??= t0.toISOString();
    if (!lap.offlineNotified && t0.getTime() - Date.parse(lap.lastOnlineAt) >= LAPTOP_ALERT_AFTER_MS) {
      await toAdmin({
        title: "Laptop agent offline",
        body: `${names} ${plural ? "haven't" : "hasn't"} been checked for a day. Wake the laptop or start npm run agent.`,
        url: "/",
        tag: "laptop",
      });
      lap.offlineNotified = true;
    }
  }

  async function doScan() {
    const result = await scanOnce();
    try {
      log.log(summarizeRun(result));
      for (const line of problemLines(result)) log.warn(line);
    } catch {
      /* logging must never break a scan */
    }
    return result;
  }

  async function scanOnce() {
    const t0 = now();
    const nowIso = t0.toISOString();
    const config = store.data.config;
    const d = store.data;

    for (const [id, v] of Object.entries(d.pageCache)) {
      if (id.startsWith("ul:") || (v.detail && !usableDetail(v.detail))) delete d.pageCache[id];
    }

    const deps = {
      fetchImpl,
      fetcher: createFetcher({ fetchImpl, sleep, politenessMs, respectRobots: config.respectRobots }),
      cache: d.pageCache,
      budget: { detail: config.maxDetailFetches, geocode: GEOCODE_BUDGET, exhausted: false },
      now: () => now().getTime(),
    };
    const geocoder = createGeocoder({ store, fetchImpl, sleep, minIntervalMs: geocodeDelayMs });

    // Sources listed in SCRAPER_PROXY_SOURCES go out through the proxy or laptop agent; everything else
    // (and the geocoder) stays direct.
    const proxiedFetcher = proxy.fetch
      ? createFetcher({ fetchImpl: proxy.fetch, sleep, politenessMs, respectRobots: config.respectRobots })
      : null;
    const depsFor = (id) =>
      proxy.fetch && proxy.sources.has(id) ? { ...deps, fetchImpl: proxy.fetch, fetcher: proxiedFetcher } : deps;
    const routed = proxy.fetch ? config.sources.filter((id) => proxy.sources.has(id)) : [];
    // A sleeping laptop is not a broken source: its sources are skipped for this scan, not failed.
    const laptopOffline = proxy.kind === "laptop" && routed.length > 0 && !proxy.online();
    const proxied = laptopOffline ? [] : routed;

    const results = [];
    const candidates = new Map();
    for (const id of config.sources) {
      const adapter = ADAPTERS[id];
      if (!adapter) continue;
      if (laptopOffline && proxy.sources.has(id)) {
        results.push({ id, label: adapter.label, ok: true, skipped: "laptop agent offline", fetched: 0, notes: [] });
        continue;
      }
      try {
        const r = await adapter.fetch(config, depsFor(id));
        results.push({ id, label: adapter.label, ok: true, fetched: r.listings.length, notes: r.notes });
        for (const n of r.notes) {
          if (n.debug) d.debug[`${id}:${n.group}`] = { at: nowIso, ...n.debug };
          delete n.debug;
        }
        for (const l of r.listings) if (!candidates.has(l.id)) candidates.set(l.id, l);
      } catch (err) {
        const notes = err.notes ?? [];
        for (const n of notes) {
          if (n.debug) d.debug[`${id}:${n.group}`] = { at: nowIso, ...n.debug };
          delete n.debug;
        }
        results.push({ id, label: adapter.label, ok: false, error: err.message, status: err.status ?? null, notes });
      }
    }

    if (proxy.kind === "laptop" && routed.length) {
      await noteLaptop(d, laptopOffline, t0, routed.map((id) => ADAPTERS[id]?.label ?? id));
    }

    const okSources = results.filter((r) => r.ok);
    if (okSources.length === 0) {
      const firstError = results[0]?.error ?? "No sources enabled";
      d.failureCount += 1;
      d.lastRun = { at: nowIso, durationMs: now() - t0, ok: false, error: firstError, sources: results, laptopOffline };
      store.save();
      const n = d.failureCount;
      if (n === 3 || n % 48 === 0) {
        await toAdmin({
          title: "Rental bot can't reach any source",
          body: `${n} scans failed in a row: ${firstError}`,
          url: "/",
          tag: "scan-failure",
        });
      }
      return d.lastRun;
    }

    const recovered = d.failureCount >= 3;
    d.failureCount = 0;

    // Per-source health: a source that keeps failing or recognising nothing gets flagged.
    for (const r of results) {
      if (r.skipped) continue;
      const h = (d.sourceHealth[r.id] ??= { failures: 0, lastOkAt: null, lastError: null });
      const warning = r.notes.find((n) => n.warning)?.warning;
      const badNote = r.notes.find((n) => !n.ok);
      const problem = !r.ok || (r.fetched === 0 && (warning || badNote));
      if (problem) {
        h.failures += 1;
        h.lastError = r.error ?? badNote?.error ?? warning;
        if (h.failures === SOURCE_ALERT_AFTER || (h.failures > SOURCE_ALERT_AFTER && h.failures % 96 === 0)) {
          await toAdmin({
            title: `${r.label} looks broken`,
            body: `${h.failures} scans in a row with no usable results: ${h.lastError}`,
            url: "/",
            tag: `source-${r.id}`,
          });
        }
      } else {
        if (h.failures >= SOURCE_ALERT_AFTER) {
          await toAdmin({ title: `${r.label} is working again`, body: "Listings are coming through.", url: "/", tag: `source-${r.id}` });
        }
        h.failures = 0;
        h.lastOkAt = nowIso;
        h.lastError = null;
      }
    }

    const coordsIgnored = stripSharedCoords([...candidates.values()], d.siteConstants);

    const survivors = [];
    let rejected = 0;
    let pendingCount = 0;
    const pendingAttempts = {};
    for (const listing of candidates.values()) {
      if (listing.pending) {
        const n = (d.pendingAttempts[listing.id] ?? 0) + 1;
        pendingAttempts[listing.id] = n;
        if (n < MAX_PENDING_SCANS) {
          pendingCount++;
          continue;
        }
      }
      analyzeListing(listing, t0);
      const a = evaluateNonLocation(listing, config, t0);
      if (!a.ok) {
        rejected++;
        continue;
      }
      deps.budget.exhausted = false;
      await resolveLocation(listing, config, geocoder, deps.budget);
      if (listing.lat === null && config.geocode && deps.budget.exhausted) {
        pendingCount++;
        continue;
      }
      attachTransit(listing, config, transit);
      const b = evaluateLocation(listing, config);
      if (!b.ok) {
        rejected++;
        continue;
      }
      await resolveArea(listing, config, geocoder, deps.budget);
      const flags = [...a.flags, ...b.flags];
      if (listing.pending) flags.push("unenriched");
      if (listing.coordsCorrected) flags.push("coords-corrected");
      survivors.push({ ...listing, distanceKm: b.distanceKm, flags });
    }
    d.pendingAttempts = pendingAttempts;

    const matches = dedupe(survivors).sort((x, y) => (y.publishedAt ?? "").localeCompare(x.publishedAt ?? ""));

    const seen = d.seen;
    const isSeen = (m) => m.memberIds.some((id) => seen[id]);
    const markSeen = (m) => {
      for (const id of m.memberIds) seen[id] ??= { firstSeenAt: nowIso };
    };
    const fresh = matches.filter((m) => !isSeen(m));
    let notified = 0;
    let mode = "normal";

    if (!d.baselineDone) {
      mode = "baseline";
      d.baselineScans += 1;
      for (const m of fresh) markSeen(m);
      // Wait for the laptop's sources too, or everything they list would later alert as new.
      if ((pendingCount === 0 && !laptopOffline) || d.baselineScans >= MAX_BASELINE_SCANS) {
        d.baselineDone = true;
        await pusher.sendToAll({
          title: matches.length ? `Watching started: ${matches.length} current matches` : "Watching started",
          body: matches.length
            ? `Within ${config.radiusKm} km of ${config.center.label}. You'll be alerted to new ones.`
            : `Nothing matches yet within ${config.radiusKm} km of ${config.center.label}. You'll be alerted when something does.`,
          url: "/",
          tag: "baseline",
        });
      }
    } else if (fresh.length) {
      const subscribed = pusher.count() > 0;
      const delivered = new Set();
      for (const m of fresh.slice(0, MAX_INDIVIDUAL_PUSHES)) {
        const r = await pusher.sendToAll(buildListingPayload(m, config));
        if (r.sent > 0 || !subscribed) delivered.add(m);
        if (r.sent > 0) notified++;
      }
      const overflow = fresh.slice(MAX_INDIVIDUAL_PUSHES);
      if (overflow.length) {
        const r = await pusher.sendToAll({
          title: `${overflow.length} more new listings`,
          body: `Open the app to see everything new within ${config.radiusKm} km of ${config.center.label}.`,
          url: "/",
          tag: "digest",
        });
        if (r.sent > 0 || !subscribed) for (const m of overflow) delivered.add(m);
      }
      for (const m of delivered) markSeen(m);
    }

    if (recovered) {
      await toAdmin({ title: "Rental bot is back", body: "Scans are working again.", url: "/", tag: "scan-failure" });
    }

    const cutoff = t0.getTime() - SEEN_TTL_MS;
    for (const [id, v] of Object.entries(seen)) if (Date.parse(v.firstSeenAt) < cutoff) delete seen[id];
    for (const [id, v] of Object.entries(d.pageCache)) {
      if (t0.getTime() - Date.parse(v.lastSeen ?? v.at) > CACHE_TTL_MS) delete d.pageCache[id];
    }

    const failedFor = (m) => {
      const r = results.find((x) => x.id === m.source);
      return r && (!r.ok || r.skipped || r.notes.some((n) => !n.ok && n.group === m.group));
    };
    const currentIds = new Set(matches.flatMap((m) => m.memberIds));
    const kept = d.matches.filter((m) => failedFor(m) && !currentIds.has(m.id));
    // memberIds stay on the stored match so a verdict on any copy of a property still applies when another copy wins.
    d.matches = [
      ...matches.map(({ text, areaQuery, ...m }) => ({ ...m, firstSeenAt: seen[m.memberIds[0]]?.firstSeenAt ?? null })),
      ...kept,
    ].slice(0, MAX_STORED_MATCHES);

    const storedIds = new Set(d.matches.flatMap((m) => m.memberIds ?? [m.id]));
    for (const [id, v] of Object.entries(d.reviews)) {
      if (!storedIds.has(id) && Date.parse(v.at) < cutoff) delete d.reviews[id];
    }

    d.lastRun = {
      at: nowIso,
      durationMs: now() - t0,
      ok: true,
      mode,
      sources: results,
      candidates: candidates.size,
      rejected,
      pending: pendingCount,
      proxied,
      via: proxy.kind,
      laptopOffline,
      coordsIgnored,
      matches: matches.length,
      newCount: fresh.length,
      notified,
    };
    store.save();
    return d.lastRun;
  }

  return { run, isRunning: () => inflight !== null };
}
