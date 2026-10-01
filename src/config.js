import { isSafeUrl } from "./html.js";

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
  rentUrls: [
    "https://www.rent.ie/rooms-to-rent/limerick/castletroy/",
    "https://www.rent.ie/student-accommodation/University-of-Limerick/46/",
    "https://www.rent.ie/houses-to-rent/limerick/castletroy/",
    "https://www.rent.ie/apartments-to-rent/limerick/castletroy/",
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
