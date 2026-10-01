import { haversineKm } from "./geo.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const HIT_TTL_MS = 90 * 24 * 3600_000;
const MISS_TTL_MS = 7 * 24 * 3600_000;
const COARSE_TYPES = new Set([
  "suburb", "neighbourhood", "neighborhood", "quarter", "village", "town", "city", "hamlet",
  "city_district", "borough", "county", "state", "municipality", "locality", "isolated_dwelling_area",
]);
const MAX_KM_FROM_CENTRE = 40;
const OUTLINE_MAX_KM = 3;

// How far a place name with no outline of its own is drawn out from its point, so the map can still highlight "the area".
const AREA_RADIUS_M = {
  neighbourhood: 350, neighborhood: 350, quarter: 350, hamlet: 400, isolated_dwelling_area: 400, locality: 500,
  suburb: 700, village: 900, city_district: 1200, borough: 1200, town: 1500, municipality: 1500, city: 3000,
};
export const DEFAULT_AREA_RADIUS_M = 500;
export const areaRadiusM = (kind) => AREA_RADIUS_M[kind] ?? DEFAULT_AREA_RADIUS_M;

export const osmUserAgent = (env = process.env) =>
  env.GEOCODER_USER_AGENT || `RentalWatch/1.0 (personal rental monitor; ${env.VAPID_SUBJECT ?? "self-hosted"})`;

// Nominatim's GeoJSON outline of a place, rounded to ~1 m. Only areas count: a point or a street is no outline.
function cleanOutline(g) {
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) return null;
  const r = (n) => Math.round(n * 1e5) / 1e5;
  const ring = (c) => c.map(([x, y]) => [r(x), r(y)]);
  const coordinates = g.type === "Polygon" ? g.coordinates.map(ring) : g.coordinates.map((poly) => poly.map(ring));
  const out = { type: g.type, coordinates };
  return JSON.stringify(out).length > 30_000 ? null : out;
}

const sameName = (a, b) => String(a ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "") === String(b ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

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
  userAgent = osmUserAgent(),
}) {
  let lastCall = 0;
  const cache = () => (store.data.geocache ??= {});

  // One throttled Nominatim request; null when it could not be made (nothing is cached for that).
  async function search(q, center, { limit = 1, outline = false } = {}) {
    const wait = lastCall + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastCall = now();

    const box = [center.lng - 0.3, center.lat + 0.2, center.lng + 0.3, center.lat - 0.2].join(",");
    const shape = outline ? "&polygon_geojson=1&polygon_threshold=0.0002" : "";
    const url = `${NOMINATIM}?format=jsonv2&limit=${limit}&countrycodes=ie&viewbox=${box}${shape}&q=${encodeURIComponent(`${q}, Ireland`)}`;
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": userAgent, "Accept-Language": "en" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    } catch {
      return null;
    }
  }

  async function lookup(q, center) {
    const key = q.toLowerCase();
    const hit = cache()[key];
    if (hit && now() - Date.parse(hit.at) < (hit.miss ? MISS_TTL_MS : HIT_TTL_MS)) return hit.miss ? null : hit;

    const rows = await search(q, center);
    if (rows === null) return null;
    const r = rows[0];
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
      if (r) return { lat: r.lat, lng: r.lng, coarse: r.coarse || drop > 0, query: q };
    }
    return null;
  }

  // Cached fetch of a stored entry, spending one unit of `budget` when Nominatim has to be asked.
  async function cached(key, budget, ask) {
    const hit = cache()[key];
    if (!hit || now() - Date.parse(hit.at) >= (hit.miss ? MISS_TTL_MS : HIT_TTL_MS)) {
      if (budget && budget.geocode <= 0) {
        budget.exhausted = true;
        return null;
      }
      if (budget) budget.geocode--;
      const entry = await ask();
      if (entry === undefined) return null;
      cache()[key] = { ...entry, at: new Date(now()).toISOString() };
    }
    const out = cache()[key];
    return out.miss ? null : out;
  }

  // The named place a listing sits in (a suburb, estate or village), with its outline when OpenStreetMap has one,
  // so the map can highlight the whole area when the exact spot is unknown.
  async function area(query, center, budget) {
    const q = String(query ?? "").trim();
    if (q.length < 3) return null;
    const key = `area:${q.toLowerCase()}`;
    const entry = await cached(key, budget, async () => {
      const rows = await search(q, center, { limit: 5, outline: true });
      if (rows === null) return undefined;
      const r = rows.find((x) => Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lon)) && haversineKm(center.lat, center.lng, Number(x.lat), Number(x.lon)) <= MAX_KM_FROM_CENTRE);
      if (!r) return { miss: true };
      const kind = String(r.addresstype ?? r.type ?? "");
      return {
        lat: Number(r.lat),
        lng: Number(r.lon),
        kind,
        name: String(r.name || String(r.display_name ?? "").split(",")[0] || q.split(",")[0]).trim().slice(0, 80),
        geometry: cleanOutline(r.geojson),
      };
    });
    return entry ? { key, ...entry } : null;
  }

  // The footprint of a named site such as a campus: every outline with the best match's name close to the centre.
  async function outline(query, center, budget) {
    const q = String(query ?? "").trim();
    if (q.length < 3) return [];
    const entry = await cached(`outline:${q.toLowerCase()}`, budget, async () => {
      const rows = await search(q, center, { limit: 6, outline: true });
      if (rows === null) return undefined;
      const near = rows.filter((x) => haversineKm(center.lat, center.lng, Number(x.lat), Number(x.lon)) <= OUTLINE_MAX_KM && cleanOutline(x.geojson));
      if (!near.length) return { miss: true };
      return { polygons: near.filter((x) => sameName(x.name, near[0].name)).slice(0, 4).map((x) => cleanOutline(x.geojson)) };
    });
    return entry?.polygons ?? [];
  }

  return { geocode, area, outline };
}

export async function resolveLocation(listing, config, geocoder, budget) {
  if (!config.geocode || !geocoder) return;
  if (listing.lat !== null) {
    // Coordinates scraped from a page are cross-checked against the address; the API's own are trusted.
    if (listing.source === "daft" || listing.distanceSource !== "source") return;
    const [q] = addressQueries(listing);
    if (!q) return;
    const r = await geocoder.geocode(q, config.center, budget);
    if (r && !r.coarse && haversineKm(listing.lat, listing.lng, r.lat, r.lng) > 2) {
      listing.lat = r.lat;
      listing.lng = r.lng;
      listing.distanceSource = "geocoded";
      listing.coordsCorrected = true;
    }
    return;
  }
  for (const q of addressQueries(listing)) {
    const r = await geocoder.geocode(q, config.center, budget);
    if (r) {
      listing.lat = r.lat;
      listing.lng = r.lng;
      listing.distanceSource = r.coarse ? "geocoded-area" : "geocoded";
      if (r.coarse) listing.areaQuery = r.query;
      return;
    }
  }
}

// A listing whose exact spot is unknown still belongs to a named place; remember which, so the map can highlight it.
export async function resolveArea(listing, config, geocoder, budget) {
  if (!config.geocode || !geocoder) return;
  if (listing.lat !== null && listing.distanceSource !== "geocoded-area") return;
  const place = `${listing.address ?? ""} ${listing.title}`.toLowerCase();
  const query = listing.areaQuery ?? config.localityHints.find((h) => place.includes(h));
  if (!query) return;
  const found = await geocoder.area(query, config.center, budget);
  if (found) listing.areaKey = found.key;
}
