import { haversineKm } from "./geo.js";

const SHORT_TERM_RE =
  /short[- ]?term|until june|till june|academic year|semester|flexible (lease|term|stay)|month[- ]to[- ]month|\b(6|7|8|9|10)[- ]?months?\b/i;

export function evaluateListing(listing, config) {
  const flags = [];
  const text = listing.text.toLowerCase();

  let distanceKm = null;
  if (listing.lat !== null && listing.lng !== null) {
    distanceKm = haversineKm(config.center.lat, config.center.lng, listing.lat, listing.lng);
    if (distanceKm > config.radiusKm) return { ok: false, reason: "too far", distanceKm, flags };
  } else {
    flags.push("no-location");
  }

  if (config.excludeOwnerOccupied) {
    if (listing.ownerOccupied === true) return { ok: false, reason: "owner occupied", distanceKm, flags };
    const hit = config.excludeKeywords.find((k) => text.includes(k));
    if (hit) return { ok: false, reason: `keyword: ${hit}`, distanceKm, flags };
  } else {
    const hit = config.excludeKeywords.find((k) => text.includes(k));
    if (hit && !/owner|landlord/.test(hit)) return { ok: false, reason: `keyword: ${hit}`, distanceKm, flags };
  }

  if (config.includeKeywords.length && !config.includeKeywords.some((k) => text.includes(k))) {
    return { ok: false, reason: "missing include keyword", distanceKm, flags };
  }

  const p = listing.priceMonthly;
  if (p !== null) {
    if (config.priceMin !== null && p < config.priceMin) return { ok: false, reason: "below min price", distanceKm, flags };
    if (config.priceMax !== null && p > config.priceMax) return { ok: false, reason: "above max price", distanceKm, flags };
  }

  if (listing.section === "residential-to-rent" && listing.beds !== null) {
    if (config.bedsMin !== null && listing.beds < config.bedsMin) return { ok: false, reason: "too few beds", distanceKm, flags };
    if (config.bedsMax !== null && listing.beds > config.bedsMax) return { ok: false, reason: "too many beds", distanceKm, flags };
  }

  if (SHORT_TERM_RE.test(listing.text)) flags.push("short-term");
  if (listing.ownerOccupied === null && listing.section !== "residential-to-rent") flags.push("owner-occupied-unknown");

  return { ok: true, reason: null, distanceKm, flags };
}
