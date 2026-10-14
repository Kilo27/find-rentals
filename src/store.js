import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_PREFS, PREF_KEYS, normalizeConfig, normalizePrefs, normalizeRegion } from "./config.js";
import { REGION_SEEDS, searchCampus, searchCampuses } from "./catalogue.js";
import { haversineKm } from "./geo.js";
import { ADMIN_OWNER } from "./push.js";
import { newSearch } from "./searches.js";

export const STATE_VERSION = 2;

// Only the first of these was a Rent.ie search page: houses-to-rent redirects to the homepage, apartments-to-rent
// is a 404 and the student-accommodation page carries no adverts.
const OLD_RENT_URLS = JSON.stringify([
  "https://www.rent.ie/rooms-to-rent/limerick/castletroy/",
  "https://www.rent.ie/student-accommodation/University-of-Limerick/46/",
  "https://www.rent.ie/houses-to-rent/limerick/castletroy/",
  "https://www.rent.ie/apartments-to-rent/limerick/castletroy/",
]);

const pickKeys = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

const seedRegions = () => Object.fromEntries(Object.entries(REGION_SEEDS).map(([id, seed]) => [id, normalizeRegion(seed)]));

const freshState = () => ({
  version: STATE_VERSION,
  // Where to look, by region (admin only), and how each region's last look went.
  regions: seedRegions(),
  regionStatus: {},
  // One search per account: the campus it chose, its preferences, what it has seen and what matches. The admin's is
  // under ADMIN_OWNER, every other account's under its username. A fresh install watches UL, as it always has.
  searches: { [ADMIN_OWNER]: newSearch({ campus: "ul" }) },
  subscriptions: [],
  users: [],
  vapid: null,
  // Shared by every region and account: nothing in them depends on who is asking.
  debug: {},
  pageCache: {},
  geocache: {},
  mapCache: { transit: {}, campus: {} },
  siteConstants: {},
  laptop: { offlineSince: null, offlineNotified: false },
});

const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// The campus nearest a centre point that a saved search used before campuses could be chosen, or UL.
function campusNear(centre) {
  const [best] = searchCampuses()
    .map((c) => ({ c, km: haversineKm(centre.lat, centre.lng, c.lat, c.lng) }))
    .sort((a, b) => a.km - b.km);
  return best && best.km <= 10 ? best.c : searchCampus("ul");
}

// Before accounts had searches of their own there was one config, one seen list, one set of matches and one verdict map
// for the whole app (#17, #36). They become the admin's search, and the part of the config about where to look becomes
// the Limerick region. People who already had an account carry on as they were, with their own copy of it, so that
// nobody goes quiet or is flooded by alerts for listings they have already had; from here on the copies are independent.
function migrate(old) {
  let legacy;
  try {
    legacy = normalizeConfig(old.config ?? {});
    if (JSON.stringify(legacy.rentUrls) === OLD_RENT_URLS) legacy.rentUrls = [...DEFAULT_CONFIG.rentUrls];
  } catch {
    legacy = normalizeConfig(DEFAULT_CONFIG);
  }
  const state = freshState();
  const regionKeys = ["enabled", "intervalMinutes", "daftLocation", "sources", "ulUrls", "rentUrls", "myhomeUrls", "webUrls", "geocode", "respectRobots", "maxDetailFetches", "maxPages"];
  try {
    state.regions.limerick = normalizeRegion({ ...REGION_SEEDS.limerick, ...pickKeys(legacy, regionKeys) });
  } catch {
    /* keep the seed */
  }

  const campus = campusNear(legacy.center);
  const search = newSearch({ campus: campus.id });
  try {
    search.prefs = normalizePrefs({ ...pickKeys(legacy, PREF_KEYS), radiusKm: Math.min(legacy.radiusKm, campus.maxRadiusKm), transitMaxKm: Math.min(legacy.transitMaxKm, campus.maxRadiusKm) }, { maxRadiusKm: campus.maxRadiusKm });
  } catch {
    /* keep the defaults */
  }
  Object.assign(search, {
    seen: asObject(old.seen),
    reviews: asObject(old.reviews),
    matches: Array.isArray(old.matches) ? old.matches : [],
    baselineDone: old.baselineDone === true,
    baselineScans: Number(old.baselineScans) || 0,
    lastRun: old.lastRun ?? null,
  });

  const users = Array.isArray(old.users) ? old.users : [];
  const searches = { [ADMIN_OWNER]: search };
  for (const u of users) searches[u.username] = structuredClone(search);

  state.regionStatus.limerick = {
    failureCount: Number(old.failureCount) || 0,
    lastRun: old.lastRun ?? null,
    sourceHealth: asObject(old.sourceHealth),
    pendingAttempts: asObject(old.pendingAttempts),
  };

  const carried = ["subscriptions", "users", "vapid", "debug", "pageCache", "geocache", "mapCache", "siteConstants", "laptop"];
  for (const k of carried) if (old[k] !== undefined) state[k] = old[k];
  state.searches = searches;
  return state;
}

// A saved search with anything missing or invalid put right, so a hand-edited or older file can't break a scan.
function loadSearch(raw) {
  const s = newSearch();
  const campus = typeof raw.campus === "string" ? searchCampus(raw.campus) : null;
  s.campus = campus?.id ?? null;
  try {
    s.prefs = normalizePrefs(raw.prefs ?? {}, campus ? { maxRadiusKm: campus.maxRadiusKm } : undefined);
  } catch {
    s.prefs = { ...DEFAULT_PREFS };
  }
  s.seen = asObject(raw.seen);
  s.reviews = asObject(raw.reviews);
  s.matches = Array.isArray(raw.matches) ? raw.matches : [];
  s.baselineDone = raw.baselineDone === true;
  s.baselineScans = Number(raw.baselineScans) || 0;
  s.lastCollectAt = typeof raw.lastCollectAt === "string" ? raw.lastCollectAt : null;
  s.rev = Number(raw.rev) || 0;
  s.lastRun = raw.lastRun ?? null;
  return s;
}

function upgrade(parsed) {
  const state = { ...freshState(), ...parsed, version: STATE_VERSION };
  // Regions from the catalogue that the saved state doesn't have yet are added; the admin's edits to the others are kept.
  const saved = asObject(parsed.regions);
  const seeds = seedRegions();
  state.regions = { ...seeds };
  for (const [id, raw] of Object.entries(saved)) {
    try {
      state.regions[id] = normalizeRegion(raw);
    } catch {
      state.regions[id] = seeds[id] ?? state.regions[id];
    }
  }
  state.regionStatus = asObject(parsed.regionStatus);

  const owners = new Set([ADMIN_OWNER, ...state.users.map((u) => u.username)]);
  const searches = {};
  for (const [owner, raw] of Object.entries(asObject(parsed.searches))) if (owners.has(owner)) searches[owner] = loadSearch(raw);
  searches[ADMIN_OWNER] ??= newSearch({ campus: "ul" });
  state.searches = searches;
  return state;
}

export class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
    this.data = this.#load();
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return freshState();
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      return freshState();
    }
    // Reading a file that parses is not allowed to set it aside: a mistake there should stop the server, not lose the state.
    return parsed?.version >= STATE_VERSION ? upgrade(parsed) : migrate(parsed ?? {});
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
