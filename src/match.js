import { evaluateLocation, evaluateNonLocation } from "./filter.js";
import { dedupe } from "./dedupe.js";
import { ADMIN_OWNER, buildListingPayload } from "./push.js";
import { attachTransit } from "./transit.js";
import { leaseKey } from "./daft.js";
import { campusOf, configOf } from "./searches.js";

// How a site did, without the page addresses, errors or what it sent back.
export const slimSource = (s) => ({ id: s.id, label: s.label, ok: s.ok !== false, ...(s.skipped ? { skipped: "paused" } : {}), fetched: s.fetched ?? 0, notes: (s.notes ?? []).some((n) => n.warning) ? [{ warning: "some listings may be missing" }] : [] });

const MAX_INDIVIDUAL_PUSHES = 5;
const MAX_STORED_MATCHES = 200;
const SEEN_TTL_MS = 365 * 24 * 3600_000;
const MAX_BASELINE_SCANS = 6;

// Puts one account's own preferences against a region's pool of listings (#13): which of them are near its campus and fit
// what it asked for, which of those it hasn't been told about, and an alert for each of those to its own devices. Nothing
// here is shared with another account, so two people in one region with different filters get different matches from the
// same collect, and what one has seen or put away means nothing to the other.
//
// Returns the numbers for the logs, or null if the account can't be matched: it has no campus, its campus's region isn't
// set up, it moved to another campus while this was running, or the pool was collected before it asked for a lease length
// (a collect is needed first, which is the only case where preferences can't be applied without scraping).
export async function matchAccount({ store, pusher, transit, now }, { owner, search }, pool) {
  const config = configOf(store, search);
  // An account that chose a campus in another region since this region was collected belongs to that region's pool.
  if (!config || campusOf(search).regionId !== pool.regionId) return null;
  const rev = search.rev;
  const t0 = now();
  const nowIso = t0.toISOString();

  // Lease length is something only Daft can filter, so the collect asked it once for each range anyone has chosen.
  const leaseOn = config.leaseMinMonths !== null || config.leaseMaxMonths !== null;
  const leaseKeyHere = leaseKey(config.leaseMinMonths, config.leaseMaxMonths);
  const leaseSet = leaseOn && config.sources.includes("daft") ? pool.leaseMatches[leaseKeyHere] ?? null : undefined;
  if (leaseSet === null && !pool.leaseRequested.includes(leaseKeyHere)) return null;

  const survivors = [];
  let rejected = 0;
  for (const base of pool.listings) {
    if (leaseOn && base.source === "daft" && leaseSet !== undefined && !leaseSet?.has(base.id)) {
      rejected++;
      continue;
    }
    // Each account works on its own copy: the position and the transport link depend on its campus.
    const listing = { ...base };
    const na = evaluateNonLocation(listing, config, t0);
    if (!na.ok) {
      rejected++;
      continue;
    }
    attachTransit(listing, config, transit);
    const nb = evaluateLocation(listing, config);
    if (!nb.ok) {
      rejected++;
      continue;
    }
    const flags = [...na.flags, ...nb.flags];
    if (listing.pending) flags.push("unenriched");
    if (listing.coordsCorrected) flags.push("coords-corrected");
    survivors.push({ ...listing, distanceKm: nb.distanceKm, flags });
  }

  const matches = dedupe(survivors).sort((x, y) => (y.publishedAt ?? "").localeCompare(x.publishedAt ?? ""));

  const seen = search.seen;
  const isSeen = (m) => m.memberIds.some((id) => seen[id]);
  const markSeen = (m) => {
    for (const id of m.memberIds) seen[id] ??= { firstSeenAt: nowIso };
  };
  const toOwner = (payload) => pusher.sendToOwner(owner, payload);
  const fresh = matches.filter((m) => !isSeen(m));
  // Looking again at the same collect (the account changed a preference) is not another scan.
  const newCollect = search.lastCollectAt !== pool.at;
  // What this match changes about where the account is in watching is only written once alerts have gone out and the account
  // is known not to have moved to another campus meanwhile, which would make it wrong for the new one.
  let baselineDone = search.baselineDone;
  let baselineScans = search.baselineScans;
  let notified = 0;
  let mode = "normal";

  if (!baselineDone) {
    // Watching starts by marking what is listed as seen, so a new account (or one that has moved to another campus) is
    // shown its current matches in the app and alerted only to what appears after.
    mode = "baseline";
    if (newCollect) baselineScans += 1;
    for (const m of fresh) markSeen(m);
    // Wait for the laptop's sources too, or everything they list would later alert as new.
    if ((pool.pending === 0 && !pool.laptopOffline) || baselineScans >= MAX_BASELINE_SCANS) {
      baselineDone = true;
      await toOwner({
        title: matches.length ? `Watching started: ${matches.length} current matches` : "Watching started",
        body: matches.length
          ? `Within ${config.radiusKm} km of ${config.center.label}. You'll be alerted to new ones.`
          : `Nothing matches yet within ${config.radiusKm} km of ${config.center.label}. You'll be alerted when something does.`,
        url: "/",
        tag: "baseline",
      });
    }
  } else if (fresh.length) {
    const subscribed = pusher.count(owner) > 0;
    const delivered = new Set();
    for (const m of fresh.slice(0, MAX_INDIVIDUAL_PUSHES)) {
      const r = await toOwner(buildListingPayload(m, config));
      if (r.sent > 0 || !subscribed) delivered.add(m);
      if (r.sent > 0) notified++;
    }
    const overflow = fresh.slice(MAX_INDIVIDUAL_PUSHES);
    if (overflow.length) {
      const r = await toOwner({
        title: `${overflow.length} more new listings`,
        body: `Open the app to see everything new within ${config.radiusKm} km of ${config.center.label}.`,
        url: "/",
        tag: "digest",
      });
      if (r.sent > 0 || !subscribed) for (const m of overflow) delivered.add(m);
    }
    for (const m of delivered) markSeen(m);
  }

  // The account moved on while its alerts were going out: don't write the old campus's results into its new search.
  if (search.rev !== rev) return null;
  Object.assign(search, { baselineDone, baselineScans, lastCollectAt: pool.at });

  const cutoff = t0.getTime() - SEEN_TTL_MS;
  for (const [id, v] of Object.entries(seen)) if (Date.parse(v.firstSeenAt) < cutoff) delete seen[id];

  // A source that couldn't be read this time keeps the account's earlier matches from it, rather than emptying the list.
  const failedFor = (m) => {
    const r = pool.results.find((x) => x.id === m.source);
    return r && (!r.ok || r.skipped || r.notes.some((n) => !n.ok && n.group === m.group));
  };
  const currentIds = new Set(matches.flatMap((m) => m.memberIds));
  // ...but only while they still fit what the account now asks for: a lower price limit or a shorter distance applies to
  // them too, even though the source can't be asked again. (Their wording is no longer stored, so only the numbers are checked.)
  const stillFits = (m) => {
    if (m.priceMonthly != null) {
      if (config.priceMin !== null && m.priceMonthly < config.priceMin) return false;
      if (config.priceMax !== null && m.priceMonthly > config.priceMax) return false;
    }
    if (m.kind === "property" && m.beds != null) {
      if (config.bedsMin !== null && m.beds < config.bedsMin) return false;
      if (config.bedsMax !== null && m.beds > config.bedsMax) return false;
    }
    if (m.distanceKm != null) {
      const limit = m.flags?.includes("transit-access") ? config.transitMaxKm : config.radiusKm + (m.flags?.includes("distance-approx") ? 1 : 0);
      if (m.distanceKm > limit) return false;
    }
    return true;
  };
  const kept = search.matches.filter((m) => failedFor(m) && !currentIds.has(m.id) && stillFits(m));
  // memberIds stay on the stored match so a verdict on any copy of a property still applies when another copy wins.
  search.matches = [
    ...matches.map(({ text, areaQuery, ...m }) => ({ ...m, firstSeenAt: seen[m.memberIds[0]]?.firstSeenAt ?? null })),
    ...kept,
  ].slice(0, MAX_STORED_MATCHES);

  const storedIds = new Set(search.matches.flatMap((m) => m.memberIds ?? [m.id]));
  for (const [id, v] of Object.entries(search.reviews)) {
    if (!storedIds.has(id) && Date.parse(v.at) < cutoff) delete search.reviews[id];
  }

  search.lastRun = {
    at: pool.at,
    durationMs: pool.durationMs,
    ok: true,
    mode,
    // The pages and errors are the admin's to read; every other account keeps only whether each site was read, which is
    // all it is shown, so each account's copy of the region's notes isn't saved over and over.
    sources: owner === ADMIN_OWNER ? pool.results : pool.results.map(slimSource),
    candidates: pool.candidates,
    rejected,
    pending: pool.pending,
    proxied: pool.proxied,
    via: pool.via,
    laptopOffline: pool.laptopOffline,
    matches: matches.length,
    newCount: fresh.length,
    notified,
  };
  return { mode, rejected, matches: matches.length, newCount: fresh.length, notified };
}
