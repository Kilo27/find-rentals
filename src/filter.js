import { haversineKm } from "./geo.js";
import { analyzeText, isoDate } from "./text.js";

const SHORT_TERM_RE =
  /short[- ]?term|until june|till june|academic year|semester|flexible (lease|term|stay)|month[- ]to[- ]month|\b(6|7|8|9|10)[- ]?months?\b/i;

const addDays = (iso, days) => isoDate(new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400_000));

export function analyzeListing(listing, now = new Date()) {
  const a = analyzeText(listing.text, now);
  listing.availableFrom = a.availableFrom;
  listing.availableTo = a.availableTo;
  listing.weekdayOnly = a.weekdayOnly;
  listing.ownerOccupiedText = a.ownerOccupied;
  listing.academicYear = a.academicYear;
  listing.immediate = a.immediate;
  return listing;
}

// Everything except distance, so callers can skip geocoding listings that fail here.
export function evaluateNonLocation(listing, config, now = new Date()) {
  if (listing.availableFrom === undefined) analyzeListing(listing, now);
  const flags = [];
  const text = listing.text.toLowerCase();
  const reject = (reason) => ({ ok: false, reason, flags });

  if (config.excludeOwnerOccupied) {
    if (listing.ownerOccupied === true) return reject("owner occupied");
    if (listing.ownerOccupied !== false && listing.ownerOccupiedText === true) return reject("owner occupied (from description)");
    const hit = config.excludeKeywords.find((k) => text.includes(k));
    if (hit) return reject(`keyword: ${hit}`);
  } else {
    const hit = config.excludeKeywords.find((k) => text.includes(k));
    if (hit && !/owner|landlord/.test(hit)) return reject(`keyword: ${hit}`);
  }

  if (config.excludeWeekdayOnly && listing.weekdayOnly) return reject("weekday-only let");

  const today = isoDate(now);
  const target = config.needFrom || today;
  if (listing.availableFrom && listing.availableFrom > addDays(target, config.availabilityGraceDays)) {
    return reject(`available from ${listing.availableFrom}`);
  }
  if (config.stayUntil && listing.availableTo && addDays(listing.availableTo, config.endGraceDays) < config.stayUntil) {
    return reject(`ends ${listing.availableTo}`);
  }

  if (config.includeKeywords.length && !config.includeKeywords.some((k) => text.includes(k))) return reject("missing include keyword");

  const p = listing.priceMonthly;
  if (p !== null) {
    if (config.priceMin !== null && p < config.priceMin) return reject("below min price");
    if (config.priceMax !== null && p > config.priceMax) return reject("above max price");
  }
  if (listing.kind === "property" && listing.beds !== null) {
    if (config.bedsMin !== null && listing.beds < config.bedsMin) return reject("too few beds");
    if (config.bedsMax !== null && listing.beds > config.bedsMax) return reject("too many beds");
  }

  if (SHORT_TERM_RE.test(listing.text)) flags.push("short-term");
  if (listing.immediate || (listing.availableFrom && listing.availableFrom <= today)) flags.push("available-now");
  if (config.stayUntil && listing.availableTo && listing.availableTo < config.stayUntil) flags.push("ends-early");
  if (listing.academicYear) flags.push("academic-year");
  if (listing.kind === "room" && listing.ownerOccupied === null && listing.ownerOccupiedText === null) flags.push("owner-occupied-unknown");
  if (listing.source !== "daft" && !listing.availableFrom) flags.push("availability-unknown");

  return { ok: true, reason: null, flags };
}

export function evaluateLocation(listing, config) {
  const flags = [];
  if (listing.lat !== null && listing.lng !== null) {
    const distanceKm = haversineKm(config.center.lat, config.center.lng, listing.lat, listing.lng);
    const coarse = listing.distanceSource === "geocoded-area";
    if (distanceKm > config.radiusKm + (coarse ? 1 : 0)) return { ok: false, reason: "too far", distanceKm, flags };
    if (coarse) flags.push("distance-approx");
    return { ok: true, reason: null, distanceKm, flags };
  }
  flags.push("distance-unverified");
  if (config.unverifiedDistance === "exclude") return { ok: false, reason: "no location", distanceKm: null, flags };
  if (config.unverifiedDistance === "locality") {
    const text = listing.text.toLowerCase();
    if (!config.localityHints.some((h) => text.includes(h))) return { ok: false, reason: "no location", distanceKm: null, flags };
  }
  return { ok: true, reason: null, distanceKm: null, flags };
}

export function evaluateListing(listing, config, now = new Date()) {
  const a = evaluateNonLocation(listing, config, now);
  if (!a.ok) return { ...a, distanceKm: null };
  const b = evaluateLocation(listing, config);
  return { ok: b.ok, reason: b.reason, distanceKm: b.distanceKm, flags: [...a.flags, ...b.flags] };
}
