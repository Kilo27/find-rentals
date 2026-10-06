import { ConfigError, DEFAULT_PREFS, effectiveConfig, normalizePrefs } from "./config.js";
import { searchCampus } from "./catalogue.js";
import { ADMIN_OWNER } from "./push.js";
import { UserError } from "./users.js";

// Every account has a search of its own (#36): the campus it chose, its preferences, and everything the app has worked
// out for it, such as what it has been alerted to, what it has put away and what currently matches. Nothing in it is
// shared with another account. What is shared is the region's collected listings, which carry no one's preferences.
//
//   campus          the catalogue id the account chose, or null until it has chosen one (an account with no campus is
//                   not searched and gets no alerts)
//   prefs           see normalizePrefs()
//   seen            listing id -> { firstSeenAt }: what has been alerted to (or was there when watching began)
//   reviews         listing id -> { status, at }: the account's own "seen", "not a fit" and "no longer available"
//   matches         what currently matches, newest first
//   baselineDone    whether the first look, which marks what is already listed as seen instead of alerting, has finished
//   baselineScans   how many collects that first look has waited through
//   rev             goes up when the search moves to another campus, so a scan that was already running for the old one
//                   doesn't write its results into the new one
//   lastRun         what the last match for this account found
export const newSearch = ({ campus = null, prefs = DEFAULT_PREFS } = {}) => ({
  campus,
  prefs: { ...normalizePrefs(prefs) },
  seen: {},
  reviews: {},
  matches: [],
  baselineDone: false,
  baselineScans: 0,
  lastCollectAt: null,
  rev: 0,
  lastRun: null,
});

export const searchOf = (store, owner) => (store.data.searches[owner] ??= newSearch());

// Starts watching afresh: what is listed now is marked seen at the next match instead of alerting, as for a new account.
// The account's own verdicts stay; they are about listings, not about where it is looking.
export function resetWatching(search) {
  search.seen = {};
  search.matches = [];
  search.baselineDone = false;
  search.baselineScans = 0;
  search.lastCollectAt = null;
  search.lastRun = null;
  search.rev += 1;
}

export const campusOf = (search) => (search.campus ? searchCampus(search.campus) : null);

export const regionOf = (store, campus) => (campus ? store.data.regions[campus.regionId] ?? null : null);

// The complete search for an account, or null while it has no campus or its region isn't set up.
export function configOf(store, search) {
  const campus = campusOf(search);
  const region = regionOf(store, campus);
  return campus && region ? effectiveConfig(region, campus, search.prefs) : null;
}

// Moves an account to a campus. A different campus is a different place, so what was watched for the old one is dropped.
export function chooseCampus(search, campusId) {
  const campus = typeof campusId === "string" ? searchCampus(campusId) : null;
  if (!campus) throw new UserError("Choose one of the campuses on the list");
  const moved = search.campus !== campus.id;
  search.campus = campus.id;
  search.prefs = {
    ...search.prefs,
    radiusKm: Math.min(search.prefs.radiusKm, campus.maxRadiusKm),
    transitMaxKm: Math.min(search.prefs.transitMaxKm, campus.maxRadiusKm),
  };
  if (moved) resetWatching(search);
  return { campus, moved };
}

// Saves an account's preferences. Only preferences are read from `input`; a campus is chosen with chooseCampus().
export function updatePrefs(search, input) {
  const campus = campusOf(search);
  try {
    search.prefs = normalizePrefs({ ...search.prefs, ...input }, campus ? { maxRadiusKm: campus.maxRadiusKm } : undefined);
  } catch (err) {
    if (err instanceof ConfigError) throw new UserError(err.errors.join("; "));
    throw err;
  }
}

// Who is watching, with their searches: the admin and every user who has a campus.
export function watchers(store, regionId = null) {
  const known = new Set([ADMIN_OWNER, ...store.data.users.map((u) => u.username)]);
  return Object.entries(store.data.searches)
    .filter(([owner, s]) => known.has(owner) && s.campus && (regionId === null || searchCampus(s.campus)?.regionId === regionId))
    .map(([owner, search]) => ({ owner, search }));
}

// The region ids somebody is watching in, in a stable order.
export const activeRegionIds = (store) => [...new Set(watchers(store).map(({ search }) => searchCampus(search.campus).regionId))].sort();
