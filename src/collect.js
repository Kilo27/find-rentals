import { ADAPTERS } from "./sources/index.js";
import { usableDetail } from "./sources/web.js";
import { createFetcher } from "./html.js";
import { resolveArea, resolveLocation } from "./geocode.js";
import { analyzeListing } from "./filter.js";
import { stripSharedCoords } from "./coords.js";
import { DEFAULT_CONFIG, SECTIONS, normalizeConfig } from "./config.js";
import { leaseKey } from "./daft.js";
import { campusesInRegion, regionCentre } from "./catalogue.js";
import { regionName, regionStatus, collectionPlan } from "./regions.js";
import { ADMIN_OWNER } from "./push.js";
import { watchers } from "./searches.js";

const GEOCODE_BUDGET = 60;
const MAX_PENDING_SCANS = 5;
const SOURCE_ALERT_AFTER = 6;
const CACHE_TTL_MS = 14 * 24 * 3600_000;

const noteWarning = (r) => r.notes.find((n) => n.warning)?.warning;
const noteFailure = (r) => r.notes.find((n) => !n.ok);

// What one region's sites have to offer, read once however many accounts are watching there (#13). It is read with nobody's
// preferences: Daft is asked for everything in the area, and each account's price, beds, dates and distance are applied
// afterwards, in match.js. What comes out is a pool of listings with the text already analysed and, where the source gave
// no position, an address looked up (within a budget), plus a record of how each site did.
//
// Returns { pool, run }: `pool` is null when no site could be reached (every account then keeps what it has), and `run` is
// the record of how it went, for the logs and the admin.
export async function collectRegion({ store, pusher, regionId, geocoder, fetchImpl, sleep, politenessMs, proxy, now, seq }) {
  const t0 = now();
  const nowIso = t0.toISOString();
  const d = store.data;
  const region = d.regions[regionId];
  const status = regionStatus(store, regionId);
  const name = regionName(store, regionId);
  const toAdmin = (payload) => pusher.sendToOwner(ADMIN_OWNER, payload);

  for (const [id, v] of Object.entries(d.pageCache)) {
    if (id.startsWith("ul:") || (v.detail && !usableDetail(v.detail))) delete d.pageCache[id];
  }

  // Everything the accounts watching here want looked for, and nothing about who wants it.
  const watching = watchers(store, regionId);
  const campusIds = watching.map(({ search }) => search.campus);
  const plan = collectionPlan(store, regionId, campusIds);
  const prefs = watching.map(({ search }) => search.prefs);
  const ranges = new Map();
  for (const p of prefs) if (p.leaseMinMonths !== null || p.leaseMaxMonths !== null) ranges.set(leaseKey(p.leaseMinMonths, p.leaseMaxMonths), { min: p.leaseMinMonths, max: p.leaseMaxMonths });
  const sections = [...new Set(prefs.flatMap((p) => p.sections))];
  const centre = regionCentre(regionId) ?? { label: name, lat: 53.35, lng: -7.9 };
  const config = {
    ...normalizeConfig({
      ...DEFAULT_CONFIG,
      center: centre,
      radiusKm: region.radiusKm,
      daftLocation: region.daftLocation,
      sources: region.sources,
      sections: sections.length ? sections : Object.keys(SECTIONS),
      ulUrls: plan.ulUrls,
      rentUrls: plan.rentUrls,
      myhomeUrls: plan.myhomeUrls,
      webUrls: region.webUrls,
      geocode: region.geocode,
      respectRobots: region.respectRobots,
      maxDetailFetches: region.maxDetailFetches,
      maxPages: region.maxPages,
      // The distance rules, transport and price limits are each account's own and are applied when it is matched.
      transitEnabled: false,
      excludeOwnerOccupied: false,
      priceMin: null,
      priceMax: null,
      bedsMin: null,
      bedsMax: null,
      leaseMinMonths: null,
      leaseMaxMonths: null,
    }),
    ownerPass: prefs.some((p) => p.excludeOwnerOccupied),
    leaseVariants: [...ranges.values()],
  };

  const budget = { detail: region.maxDetailFetches, geocode: GEOCODE_BUDGET, exhausted: false };
  const deps = {
    fetchImpl,
    fetcher: createFetcher({ fetchImpl, sleep, politenessMs, respectRobots: region.respectRobots }),
    cache: d.pageCache,
    budget,
    now: () => now().getTime(),
  };
  // Sources listed in SCRAPER_PROXY_SOURCES go out through the proxy or laptop agent; everything else
  // (and the geocoder) stays direct.
  const proxiedFetcher = proxy.fetch ? createFetcher({ fetchImpl: proxy.fetch, sleep, politenessMs, respectRobots: region.respectRobots }) : null;
  const depsFor = (id) => (proxy.fetch && proxy.sources.has(id) ? { ...deps, fetchImpl: proxy.fetch, fetcher: proxiedFetcher } : deps);
  const routed = proxy.fetch ? region.sources.filter((id) => proxy.sources.has(id)) : [];
  // A sleeping laptop is not a broken source: its sources are skipped for this scan, not failed.
  const laptopOffline = proxy.kind === "laptop" && routed.length > 0 && !proxy.online();
  const proxied = laptopOffline ? [] : routed;

  const results = [];
  const candidates = new Map();
  const leaseMatches = {};
  const keepDebug = (id, notes) => {
    for (const n of notes) {
      if (n.debug) d.debug[`${regionId}/${id}:${n.group}`] = { at: nowIso, ...n.debug };
      delete n.debug;
    }
  };
  for (const id of region.sources) {
    const adapter = ADAPTERS[id];
    if (!adapter) continue;
    if (laptopOffline && proxy.sources.has(id)) {
      results.push({ id, label: adapter.label, ok: true, skipped: "laptop agent offline", fetched: 0, notes: [] });
      continue;
    }
    try {
      const r = await adapter.fetch(config, depsFor(id));
      results.push({ id, label: adapter.label, ok: true, fetched: r.listings.length, notes: r.notes });
      keepDebug(id, r.notes);
      for (const l of r.listings) if (!candidates.has(l.id)) candidates.set(l.id, l);
      for (const [key, ids] of Object.entries(r.leaseMatches ?? {})) (leaseMatches[key] ??= []).push(...ids);
    } catch (err) {
      const notes = err.notes ?? [];
      keepDebug(id, notes);
      results.push({ id, label: adapter.label, ok: false, error: err.message, status: err.status ?? null, notes });
    }
  }

  const base = { region: regionId, at: nowIso, sources: results, proxied, via: proxy.kind, laptopOffline };

  const okSources = results.filter((r) => r.ok);
  if (okSources.length === 0) {
    const firstError = results[0]?.error ?? "No sources enabled";
    status.failureCount += 1;
    status.lastRun = { ...base, durationMs: now() - t0, ok: false, error: firstError };
    const n = status.failureCount;
    if (n === 3 || n % 48 === 0) {
      await toAdmin({
        title: "Rental bot can't reach any source",
        body: `${name}: ${n} scans failed in a row: ${firstError}`,
        url: "/",
        tag: `scan-failure-${regionId}`,
      });
    }
    return { pool: null, run: status.lastRun };
  }

  const recovered = status.failureCount >= 3;
  status.failureCount = 0;
  if (recovered) await toAdmin({ title: "Rental bot is back", body: `${name}: scans are working again.`, url: "/", tag: `scan-failure-${regionId}` });

  // Per-source health: a source that keeps failing or recognising nothing gets flagged.
  for (const r of results) {
    if (r.skipped) continue;
    const h = (status.sourceHealth[r.id] ??= { failures: 0, lastOkAt: null, lastError: null });
    const warning = noteWarning(r);
    const badNote = noteFailure(r);
    const problem = !r.ok || (r.fetched === 0 && (warning || badNote));
    if (problem) {
      h.failures += 1;
      h.lastError = r.error ?? badNote?.error ?? warning;
      if (h.failures === SOURCE_ALERT_AFTER || (h.failures > SOURCE_ALERT_AFTER && h.failures % 96 === 0)) {
        await toAdmin({
          title: `${r.label} looks broken`,
          body: `${name}: ${h.failures} scans in a row with no usable results: ${h.lastError}`,
          url: "/",
          tag: `source-${regionId}-${r.id}`,
        });
      }
    } else {
      if (h.failures >= SOURCE_ALERT_AFTER) {
        await toAdmin({ title: `${r.label} is working again`, body: `${name}: listings are coming through.`, url: "/", tag: `source-${regionId}-${r.id}` });
      }
      h.failures = 0;
      h.lastOkAt = nowIso;
      h.lastError = null;
    }
  }

  const coordsIgnored = stripSharedCoords([...candidates.values()], d.siteConstants);

  // The names of the neighbourhoods around every campus here, for finding the area a listing with no position sits in.
  const hints = { geocode: config.geocode, center: centre, localityHints: [...new Set(campusesInRegion(regionId).flatMap((c) => c.localityHints))] };
  const attempts = {};
  const listings = [];
  let pending = 0;
  for (const listing of candidates.values()) {
    if (listing.pending) {
      const n = (status.pendingAttempts?.[listing.id] ?? 0) + 1;
      attempts[listing.id] = n;
      if (n < MAX_PENDING_SCANS) {
        pending++;
        continue;
      }
    }
    analyzeListing(listing, t0);
    budget.exhausted = false;
    await resolveLocation(listing, hints, geocoder, budget);
    if (listing.lat === null && config.geocode && budget.exhausted) {
      pending++;
      continue;
    }
    await resolveArea(listing, hints, geocoder, budget);
    listings.push(listing);
  }
  status.pendingAttempts = attempts;

  for (const [id, v] of Object.entries(d.pageCache)) {
    if (t0.getTime() - Date.parse(v.lastSeen ?? v.at) > CACHE_TTL_MS) delete d.pageCache[id];
  }

  const pool = { regionId, at: nowIso, seq, durationMs: now() - t0, listings, results, candidates: candidates.size, pending, laptopOffline, proxied, via: proxy.kind, leaseRequested: [...ranges.keys()], leaseMatches: Object.fromEntries(Object.entries(leaseMatches).map(([k, ids]) => [k, new Set(ids)])) };
  status.lastRun = { ...base, durationMs: now() - t0, ok: true, candidates: candidates.size, pending, coordsIgnored, listings: listings.length };
  return { pool, run: status.lastRun };
}
