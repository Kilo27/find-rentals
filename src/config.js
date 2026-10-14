import { isSafeUrl } from "./html.js";
import { campusById, campusIdsFor } from "./transit/campuses.js";

export const SECTIONS = {
  "residential-to-rent": "Houses & apartments",
  sharing: "Rooms to rent / share",
  "student-accommodation-to-share": "Student accommodation",
};

export const SOURCES = {
  daft: "Daft.ie",
  ul: "UL Accommodation",
  rent: "Rent.ie",
  myhome: "MyHome.ie",
  web: "Custom pages",
};

export const UNVERIFIED_MODES = ["locality", "include", "exclude"];

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  intervalMinutes: 30,
  center: Object.freeze({ label: "University of Limerick", lat: 52.6733, lng: -8.5739 }),
  radiusKm: 2,
  daftLocation: "university-of-limerick-limerick",
  sources: ["daft", "ul", "rent", "myhome"],
  sections: Object.keys(SECTIONS),
  ulUrls: ["https://www.accommodation.ul.ie/SearchResults/Print/All"],
  // The areas Rent.ie's own University of Limerick page lists as near-by. Its student-accommodation pages carry
  // no adverts; "houses-to-let" is its houses-and-apartments section and "rooms-to-rent" its shares.
  rentUrls: [
    "https://www.rent.ie/houses-to-let/limerick/castletroy/",
    "https://www.rent.ie/houses-to-let/limerick/monaleen/",
    "https://www.rent.ie/houses-to-let/limerick/rhebogue/",
    "https://www.rent.ie/houses-to-let/limerick/newtown/",
    "https://www.rent.ie/houses-to-let/limerick/singland/",
    "https://www.rent.ie/houses-to-let/limerick/annacotty/",
    "https://www.rent.ie/rooms-to-rent/limerick/castletroy/",
    "https://www.rent.ie/rooms-to-rent/limerick/kilmurry/",
    "https://www.rent.ie/rooms-to-rent/limerick/kilbane/",
    "https://www.rent.ie/rooms-to-rent/limerick/monaleen/",
    "https://www.rent.ie/rooms-to-rent/limerick/rhebogue/",
    "https://www.rent.ie/rooms-to-rent/limerick/newtown/",
  ],
  myhomeUrls: ["https://www.myhome.ie/rentals/limerick/property-to-rent"],
  webUrls: [],
  excludeOwnerOccupied: true,
  excludeWeekdayOnly: true,
  availabilityGraceDays: 14,
  endGraceDays: 60,
  geocode: true,
  unverifiedDistance: "locality",
  localityHints: ["castletroy", "plassey", "dromroe", "mayorstone", "kilmurry"],
  respectRobots: true,
  transitEnabled: true,
  transitCampuses: [],
  transitMaxKm: 5,
  transitWalkM: 500,
  transitMaxRideMin: 30,
  transitMinPerDay: 10,
  maxDetailFetches: 40,
  priceMin: null,
  priceMax: null,
  bedsMin: null,
  bedsMax: null,
  leaseMinMonths: null,
  leaseMaxMonths: null,
  needFrom: "",
  stayUntil: "2027-06-30",
  includeKeywords: [],
  excludeKeywords: [
    "owner occupied",
    "owner-occupied",
    "live-in landlord",
    "landlord lives",
  ],
  maxPages: 4,
});

export class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid config: ${errors.join("; ")}`);
    this.name = "ConfigError";
    this.errors = errors;
  }
}

const isBlank = (v) => v === null || v === undefined || v === "";

function parseNumber(errors, name, value, { min, max, int = false, nullable = false }) {
  if (isBlank(value)) {
    if (nullable) return null;
    errors.push(`${name} is required`);
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    errors.push(`${name} must be a number`);
    return null;
  }
  if (int && !Number.isInteger(n)) errors.push(`${name} must be a whole number`);
  if (min !== undefined && n < min) errors.push(`${name} must be at least ${min}`);
  if (max !== undefined && n > max) errors.push(`${name} must be at most ${max}`);
  return n;
}

function parseBool(errors, name, value) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "on") return true;
  if (value === "false" || value === "off") return false;
  errors.push(`${name} must be true or false`);
  return false;
}

function parseDate(errors, name, value) {
  if (isBlank(value)) return "";
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    errors.push(`${name} must be a date like 2027-06-30 (or blank)`);
    return "";
  }
  return s;
}

function parseUrls(errors, name, value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  const urls = [...new Set(list.map((u) => String(u).trim()).filter(Boolean))];
  for (const u of urls) if (!isSafeUrl(u)) errors.push(`${name}: "${u}" must be a public https:// URL`);
  return urls;
}

function parseKeywords(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  return [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
}

export function normalizeConfig(input = {}) {
  const src = { ...DEFAULT_CONFIG, ...input };
  const errors = [];

  const center = { ...DEFAULT_CONFIG.center, ...(input.center ?? {}) };
  const out = {
    enabled: parseBool(errors, "enabled", src.enabled),
    intervalMinutes: parseNumber(errors, "intervalMinutes", src.intervalMinutes, { min: 5, max: 1440, int: true }),
    center: {
      label: String(center.label ?? "").trim().slice(0, 80) || "Search centre",
      lat: parseNumber(errors, "center.lat", center.lat, { min: -90, max: 90 }),
      lng: parseNumber(errors, "center.lng", center.lng, { min: -180, max: 180 }),
    },
    radiusKm: parseNumber(errors, "radiusKm", src.radiusKm, { min: 0.1, max: 20 }),
    daftLocation: String(src.daftLocation ?? "").trim().toLowerCase(),
    sources: [],
    sections: [],
    ulUrls: parseUrls(errors, "ulUrls", src.ulUrls),
    rentUrls: parseUrls(errors, "rentUrls", src.rentUrls),
    myhomeUrls: parseUrls(errors, "myhomeUrls", src.myhomeUrls),
    webUrls: parseUrls(errors, "webUrls", src.webUrls),
    excludeOwnerOccupied: parseBool(errors, "excludeOwnerOccupied", src.excludeOwnerOccupied),
    excludeWeekdayOnly: parseBool(errors, "excludeWeekdayOnly", src.excludeWeekdayOnly),
    availabilityGraceDays: parseNumber(errors, "availabilityGraceDays", src.availabilityGraceDays, { min: 0, max: 365, int: true }),
    endGraceDays: parseNumber(errors, "endGraceDays", src.endGraceDays, { min: 0, max: 365, int: true }),
    geocode: parseBool(errors, "geocode", src.geocode),
    unverifiedDistance: String(src.unverifiedDistance ?? ""),
    localityHints: parseKeywords(src.localityHints),
    respectRobots: parseBool(errors, "respectRobots", src.respectRobots),
    transitEnabled: parseBool(errors, "transitEnabled", src.transitEnabled),
    transitCampuses: [],
    transitMaxKm: parseNumber(errors, "transitMaxKm", src.transitMaxKm, { min: 0.5, max: 20 }),
    transitWalkM: parseNumber(errors, "transitWalkM", src.transitWalkM, { min: 100, max: 2000, int: true }),
    transitMaxRideMin: parseNumber(errors, "transitMaxRideMin", src.transitMaxRideMin, { min: 5, max: 90, int: true }),
    transitMinPerDay: parseNumber(errors, "transitMinPerDay", src.transitMinPerDay, { min: 1, max: 500, int: true }),
    maxDetailFetches: parseNumber(errors, "maxDetailFetches", src.maxDetailFetches, { min: 0, max: 200, int: true }),
    priceMin: parseNumber(errors, "priceMin", src.priceMin, { min: 0, nullable: true }),
    priceMax: parseNumber(errors, "priceMax", src.priceMax, { min: 0, nullable: true }),
    bedsMin: parseNumber(errors, "bedsMin", src.bedsMin, { min: 0, int: true, nullable: true }),
    bedsMax: parseNumber(errors, "bedsMax", src.bedsMax, { min: 0, int: true, nullable: true }),
    leaseMinMonths: parseNumber(errors, "leaseMinMonths", src.leaseMinMonths, { min: 0, int: true, nullable: true }),
    leaseMaxMonths: parseNumber(errors, "leaseMaxMonths", src.leaseMaxMonths, { min: 0, int: true, nullable: true }),
    needFrom: parseDate(errors, "needFrom", src.needFrom),
    stayUntil: parseDate(errors, "stayUntil", src.stayUntil),
    includeKeywords: parseKeywords(src.includeKeywords),
    excludeKeywords: parseKeywords(src.excludeKeywords),
    maxPages: parseNumber(errors, "maxPages", src.maxPages, { min: 1, max: 10, int: true }),
  };

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.daftLocation)) {
    errors.push("daftLocation must be the area name from a Daft search URL, like university-of-limerick-limerick");
  }

  if (!UNVERIFIED_MODES.includes(out.unverifiedDistance)) errors.push(`unverifiedDistance must be one of ${UNVERIFIED_MODES.join(", ")}`);

  const sources = Array.isArray(src.sources) ? src.sources : [];
  for (const id of sources) if (!(id in SOURCES)) errors.push(`unknown source "${id}"`);
  out.sources = sources.filter((id) => id in SOURCES);
  if (out.enabled && out.sources.length === 0) errors.push("select at least one source");

  const campuses = Array.isArray(src.transitCampuses) ? src.transitCampuses : [];
  for (const id of campuses) if (!campusById(id)) errors.push(`unknown campus "${id}"`);
  out.transitCampuses = [...new Set(campuses.filter((id) => campusById(id)))];

  const sections = Array.isArray(src.sections) ? src.sections : [];
  for (const s of sections) {
    if (!(s in SECTIONS)) errors.push(`unknown section "${s}"`);
  }
  out.sections = sections.filter((s) => s in SECTIONS);
  if (out.enabled && out.sources.includes("daft") && out.sections.length === 0) errors.push("select at least one Daft section (or untick Daft.ie)");

  for (const [lo, hi] of [["priceMin", "priceMax"], ["bedsMin", "bedsMax"], ["leaseMinMonths", "leaseMaxMonths"]]) {
    if (out[lo] !== null && out[hi] !== null && out[lo] > out[hi]) errors.push(`${lo} must not exceed ${hi}`);
  }
  if (out.needFrom && out.stayUntil && out.needFrom > out.stayUntil) {
    errors.push("needFrom must be before stayUntil");
  }

  if (errors.length) throw new ConfigError(errors);
  return out;
}

// --- Who owns which setting (#12) ------------------------------------------------------------------------------------
//
// normalizeConfig() above describes one complete search, which is the shape the filters and the sources read. That
// search is put together from three owners, so that one person's choices can't change anyone else's:
//   - the account's PREFERENCES: which campus, how far, what kind of place, price, dates, keywords;
//   - the REGION, which only the admin edits: where to look (the Daft area, Rent.ie and MyHome pages, the accommodation
//     board), which sites, and how often and how hard to look;
//   - the CAMPUS, from the catalogue: its name, position and the neighbourhood names around it.
// effectiveConfig() puts them together again.

export const PREF_KEYS = [
  "radiusKm",
  "sections",
  "excludeOwnerOccupied",
  "excludeWeekdayOnly",
  "needFrom",
  "stayUntil",
  "availabilityGraceDays",
  "endGraceDays",
  "priceMin",
  "priceMax",
  "bedsMin",
  "bedsMax",
  "leaseMinMonths",
  "leaseMaxMonths",
  "includeKeywords",
  "excludeKeywords",
  "unverifiedDistance",
  "transitEnabled",
  "transitMaxKm",
  "transitWalkM",
  "transitMaxRideMin",
  "transitMinPerDay",
];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

export const DEFAULT_PREFS = Object.freeze(pick(DEFAULT_CONFIG, PREF_KEYS));

// An account's preferences. Anything that isn't a preference (a centre point, page addresses, sources) is ignored, so
// an account can't set it however the request is written. `maxRadiusKm` is the campus's limit on how far out to look.
export function normalizePrefs(input = {}, { maxRadiusKm = 20 } = {}) {
  const errors = [];
  let full = null;
  try {
    full = normalizeConfig({ ...DEFAULT_CONFIG, ...pick(input, PREF_KEYS) });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    errors.push(...err.errors.map((e) => (/Daft section/.test(e) ? "choose at least one kind of place" : e)));
  }
  if (full) {
    if (full.radiusKm > maxRadiusKm) errors.push(`radiusKm must be at most ${maxRadiusKm} for this campus`);
    if (full.transitMaxKm > maxRadiusKm) errors.push(`transitMaxKm must be at most ${maxRadiusKm} for this campus`);
  }
  if (errors.length) throw new ConfigError(errors);
  return pick(full, PREF_KEYS);
}

// The admin's settings for one region: where its sites are searched and how. `radiusKm` is how far around the Daft area
// to ask for, which has to reach every campus in the region.
export function normalizeRegion(input = {}) {
  const errors = [];
  const out = {
    name: String(input.name ?? "").trim().slice(0, 60),
    enabled: parseBool(errors, "enabled", input.enabled ?? true),
    intervalMinutes: parseNumber(errors, "intervalMinutes", input.intervalMinutes ?? DEFAULT_CONFIG.intervalMinutes, { min: 5, max: 1440, int: true }),
    radiusKm: parseNumber(errors, "radiusKm", input.radiusKm ?? 5, { min: 1, max: 20 }),
    daftLocation: String(input.daftLocation ?? "").trim().toLowerCase(),
    sources: [],
    ulUrls: parseUrls(errors, "ulUrls", input.ulUrls),
    rentUrls: parseUrls(errors, "rentUrls", input.rentUrls),
    myhomeUrls: parseUrls(errors, "myhomeUrls", input.myhomeUrls),
    webUrls: parseUrls(errors, "webUrls", input.webUrls),
    geocode: parseBool(errors, "geocode", input.geocode ?? true),
    respectRobots: parseBool(errors, "respectRobots", input.respectRobots ?? true),
    maxDetailFetches: parseNumber(errors, "maxDetailFetches", input.maxDetailFetches ?? DEFAULT_CONFIG.maxDetailFetches, { min: 0, max: 200, int: true }),
    maxPages: parseNumber(errors, "maxPages", input.maxPages ?? DEFAULT_CONFIG.maxPages, { min: 1, max: 10, int: true }),
  };
  if (!out.name) errors.push("name is required");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.daftLocation)) {
    errors.push("daftLocation must be the area name from a Daft search URL, like university-of-limerick-limerick");
  }
  const sources = Array.isArray(input.sources) ? input.sources : [];
  for (const id of sources) if (!(id in SOURCES)) errors.push(`unknown source "${id}"`);
  out.sources = [...new Set(sources.filter((id) => id in SOURCES))];
  if (out.enabled && out.sources.length === 0) errors.push("select at least one source");
  if (errors.length) throw new ConfigError(errors);
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The complete search for one account: its region's settings, its campus and its preferences, in the shape
// normalizeConfig() returns, so the filters and the sources read it as they always have. `campus` carries the
// catalogue's name, position, hints and limits.
export function effectiveConfig(region, campus, prefs) {
  const maxKm = campus.maxRadiusKm ?? 20;
  // The campus at the centre is what the transport rules look for unless another is named, so only name it when that
  // wouldn't be found anyway.
  const found = campusIdsFor({ center: campus, transitCampuses: [] });
  return normalizeConfig({
    ...DEFAULT_PREFS,
    ...prefs,
    enabled: region.enabled,
    intervalMinutes: region.intervalMinutes,
    center: { label: campus.name, lat: campus.lat, lng: campus.lng },
    radiusKm: Math.min(prefs.radiusKm ?? DEFAULT_PREFS.radiusKm, maxKm),
    transitMaxKm: Math.min(prefs.transitMaxKm ?? DEFAULT_PREFS.transitMaxKm, maxKm),
    transitCampuses: sameList(found, [campus.id]) ? [] : [campus.id],
    daftLocation: region.daftLocation,
    sources: region.sources,
    ulUrls: region.ulUrls,
    rentUrls: region.rentUrls,
    myhomeUrls: region.myhomeUrls,
    webUrls: region.webUrls,
    geocode: region.geocode,
    respectRobots: region.respectRobots,
    maxDetailFetches: region.maxDetailFetches,
    maxPages: region.maxPages,
    localityHints: campus.localityHints ?? [],
  });
}
