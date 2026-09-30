import { haversineKm } from "./geo.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const HIT_TTL_MS = 90 * 24 * 3600_000;
const MISS_TTL_MS = 7 * 24 * 3600_000;
const COARSE_TYPES = new Set([
  "suburb", "neighbourhood", "neighborhood", "quarter", "village", "town", "city", "hamlet",
  "city_district", "borough", "county", "state", "municipality", "locality", "isolated_dwelling_area",
]);
const MAX_KM_FROM_CENTRE = 40;

const ROOM_PREFIX = /^(?:(?:double|single|twin|triple|large|small|spacious|en-?suite|shared|furnished|bright|modern)\s+)*(?:rooms?|bedrooms?|bedsit)\b[^,]*,\s*/i;

export function addressQueries(listing) {
  const out = [];
  const add = (s) => {
    let q = String(s ?? "").replace(/€.*$/, "").replace(ROOM_PREFIX, "").replace(/\s+/g, " ").trim().replace(/[,\s]+$/, "");
    if (q.length >= 4 && /[a-z]{3}/i.test(q) && !out.includes(q)) out.push(q);
  };
  add(listing.address);
  if (listing.title && !/€/.test(listing.title) && /,/.test(listing.title)) add(listing.title);
  return out;
}

export function createGeocoder({
  store,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  minIntervalMs = Number(process.env.GEOCODE_DELAY_MS ?? 1100),
  userAgent = process.env.GEOCODER_USER_AGENT || `RentalWatch/1.0 (personal rental monitor; ${process.env.VAPID_SUBJECT ?? "self-hosted"})`,
}) {
  let lastCall = 0;
  const cache = () => (store.data.geocache ??= {});

  async function lookup(q, center) {
    const key = q.toLowerCase();
    const hit = cache()[key];
    if (hit && now() - Date.parse(hit.at) < (hit.miss ? MISS_TTL_MS : HIT_TTL_MS)) return hit.miss ? null : hit;

    const wait = lastCall + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastCall = now();

    const box = [center.lng - 0.3, center.lat + 0.2, center.lng + 0.3, center.lat - 0.2].join(",");
    const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=ie&viewbox=${box}&q=${encodeURIComponent(`${q}, Ireland`)}`;
    let rows;
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": userAgent, "Accept-Language": "en" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      rows = await res.json();
    } catch {
      return null;
    }
    const r = Array.isArray(rows) ? rows[0] : null;
    const lat = Number(r?.lat);
    const lng = Number(r?.lon);
    if (!r || !Number.isFinite(lat) || !Number.isFinite(lng) || haversineKm(center.lat, center.lng, lat, lng) > MAX_KM_FROM_CENTRE) {
      cache()[key] = { miss: true, at: new Date(now()).toISOString() };
      return null;
    }
    const entry = { lat, lng, coarse: COARSE_TYPES.has(String(r.addresstype ?? r.type ?? "")), at: new Date(now()).toISOString() };
    cache()[key] = entry;
    return entry;
  }

  // Tries the full address, then progressively drops leading segments (street -> area),
  // marking the result coarse when it had to fall back.
  async function geocode(query, center, budget) {
    const segments = query.split(",").map((s) => s.trim()).filter(Boolean);
    for (let drop = 0; drop < Math.min(3, segments.length); drop++) {
      const q = segments.slice(drop).join(", ");
      if (q.length < 4) break;
      const cached = cache()[q.toLowerCase()];
      const needsCall = !cached || now() - Date.parse(cached.at) >= (cached.miss ? MISS_TTL_MS : HIT_TTL_MS);
      if (needsCall) {
        if (budget.geocode <= 0) {
          budget.exhausted = true;
          return null;
        }
        budget.geocode--;
      }
      const r = await lookup(q, center);
      if (r) return { lat: r.lat, lng: r.lng, coarse: r.coarse || drop > 0 };
    }
    return null;
  }

  return { geocode };
}

export async function resolveLocation(listing, config, geocoder, budget) {
  if (listing.lat !== null || !config.geocode || !geocoder) return;
  for (const q of addressQueries(listing)) {
    const r = await geocoder.geocode(q, config.center, budget);
    if (r) {
      listing.lat = r.lat;
      listing.lng = r.lng;
      listing.distanceSource = r.coarse ? "geocoded-area" : "geocoded";
      return;
    }
  }
}
