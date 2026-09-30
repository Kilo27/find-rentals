export const SECTIONS = {
  "residential-to-rent": "Houses & apartments",
  sharing: "Rooms to rent / share",
  "student-accommodation-to-share": "Student accommodation",
};

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  intervalMinutes: 30,
  center: Object.freeze({ label: "University of Limerick", lat: 52.6733, lng: -8.5739 }),
  radiusKm: 2,
  daftLocationId: "4342",
  sections: Object.keys(SECTIONS),
  excludeOwnerOccupied: true,
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
    daftLocationId: String(src.daftLocationId ?? "").trim(),
    sections: [],
    excludeOwnerOccupied: parseBool(errors, "excludeOwnerOccupied", src.excludeOwnerOccupied),
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

  if (!/^\d+$/.test(out.daftLocationId)) errors.push("daftLocationId must be a number");

  const sections = Array.isArray(src.sections) ? src.sections : [];
  for (const s of sections) {
    if (!(s in SECTIONS)) errors.push(`unknown section "${s}"`);
  }
  out.sections = sections.filter((s) => s in SECTIONS);
  if (out.enabled && out.sections.length === 0) errors.push("select at least one section");

  for (const [lo, hi] of [["priceMin", "priceMax"], ["bedsMin", "bedsMax"], ["leaseMinMonths", "leaseMaxMonths"]]) {
    if (out[lo] !== null && out[hi] !== null && out[lo] > out[hi]) errors.push(`${lo} must not exceed ${hi}`);
  }
  if (out.needFrom && out.stayUntil && out.needFrom > out.stayUntil) {
    errors.push("needFrom must be before stayUntil");
  }

  if (errors.length) throw new ConfigError(errors);
  return out;
}
