export const DAFT_BASE = "https://www.daft.ie";
export const PAGE_SIZE = 50;

const RADIUS_SHAPES_M = [1000, 3000, 5000, 10000, 20000];
const OWNER_FILTER_SECTIONS = new Set(["sharing", "student-accommodation-to-share"]);
const BEDS_SECTIONS = new Set(["residential-to-rent"]);
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class DaftError extends Error {
  constructor(message, { status = null, body = "" } = {}) {
    super(message);
    this.name = "DaftError";
    this.status = status;
    this.body = body;
  }
}

const endpoint = () => process.env.DAFT_API_URL || "https://gateway.daft.ie/api/v2/ads/listings";

function headers() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": process.env.DAFT_USER_AGENT || DEFAULT_UA,
    Origin: DAFT_BASE,
    Referer: `${DAFT_BASE}/`,
    brand: "daft",
    platform: "web",
  };
}

// Daft only offers stored radius shapes (1/3/5/10/20 km); pick the smallest that
// covers the requested radius. The exact radius is enforced later via haversine.
export function shapeIdFor(locationId, radiusKm) {
  const meters = radiusKm * 1000;
  const shape = RADIUS_SHAPES_M.find((m) => m >= meters) ?? RADIUS_SHAPES_M.at(-1);
  return `${locationId}_${shape}`;
}

export function buildPayload(config, section, from = 0, withServerFilters = true) {
  const payload = {
    section,
    geoFilter: {
      storedShapeIds: [shapeIdFor(config.daftLocationId, config.radiusKm)],
      geoSearchType: "STORED_SHAPES",
    },
    sort: "publishDateDesc",
    paging: { from: String(from), pagesize: String(PAGE_SIZE) },
  };
  if (!withServerFilters) return payload;

  const filters = [];
  if (config.excludeOwnerOccupied && OWNER_FILTER_SECTIONS.has(section)) {
    filters.push({ name: "ownerOccupied", values: [false] });
  }
  const ranges = [];
  const addRange = (name, lo, hi) => {
    if (lo === null && hi === null) return;
    ranges.push({ name, from: String(lo ?? 0), to: String(hi ?? 1e9) });
  };
  addRange("rentalPrice", config.priceMin, config.priceMax);
  if (BEDS_SECTIONS.has(section)) addRange("numBeds", config.bedsMin, config.bedsMax);
  addRange("leaseLength", config.leaseMinMonths, config.leaseMaxMonths);

  if (filters.length) payload.filters = filters;
  if (ranges.length) payload.ranges = ranges;
  return payload;
}

async function post(fetchImpl, payload) {
  let res;
  try {
    res = await fetchImpl(endpoint(), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new DaftError(`Network error calling Daft: ${err.message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new DaftError(`Daft API returned HTTP ${res.status}`, { status: res.status, body });
  }
  try {
    return await res.json();
  } catch {
    throw new DaftError("Daft API returned non-JSON response");
  }
}

const canRetryWithoutFilters = (err) =>
  err.status !== null && err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status);

export async function fetchSection(config, section, { fetchImpl = fetch } = {}) {
  let withServerFilters = true;
  let degraded = false;
  const listings = [];
  let total = 0;
  let rawSample = null;

  for (let page = 0; page < config.maxPages; page++) {
    const payload = buildPayload(config, section, page * PAGE_SIZE, withServerFilters);
    let data;
    try {
      data = await post(fetchImpl, payload);
    } catch (err) {
      const hasFilters = Boolean(payload.filters || payload.ranges);
      if (withServerFilters && hasFilters && canRetryWithoutFilters(err)) {
        withServerFilters = false;
        degraded = true;
        page--;
        continue;
      }
      throw err;
    }

    const items = Array.isArray(data.listings) ? data.listings : [];
    total = Number(data.paging?.totalResults ?? total);
    if (!rawSample && items[0]) rawSample = items[0];
    for (const item of items) {
      for (const flat of expandGrouped(item)) {
        const normalized = normalizeListing(flat, section);
        if (normalized) listings.push(normalized);
      }
    }
    if (items.length === 0 || (page + 1) * PAGE_SIZE >= total) break;
  }

  return { listings, total, degraded, rawSample };
}

function expandGrouped(item) {
  const l = item.listing ?? item;
  const subUnits = (l.prs ?? l.newHome)?.subUnits;
  if (Array.isArray(subUnits) && subUnits.length) return subUnits.map((sub) => ({ ...l, ...sub }));
  return [l];
}

export function parsePriceMonthly(text) {
  const m = /€\s*([\d,]+(?:\.\d+)?)/.exec(String(text ?? ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return /week/i.test(text) ? Math.round((n * 52) / 12) : Math.round(n);
}

function findOwnerOccupied(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;
  for (const [key, value] of Object.entries(obj)) {
    if (/^owner_?occupied$/i.test(key)) {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return /^(true|yes)$/i.test(value);
    }
  }
  for (const value of Object.values(obj)) {
    const found = findOwnerOccupied(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function firstImageUrl(l) {
  const img = l.media?.images?.[0];
  if (!img) return null;
  if (typeof img === "string") return img;
  for (const key of ["size720x480", "size600x600", "size400x300", "size360x240"]) {
    if (typeof img[key] === "string") return img[key];
  }
  return Object.values(img).find((v) => typeof v === "string" && v.startsWith("http")) ?? null;
}

export function normalizeListing(l, section) {
  if (l?.id === undefined || l?.id === null) return null;
  const id = String(l.id);
  const coords = l.point?.coordinates;
  const lng = Array.isArray(coords) ? Number(coords[0]) : NaN;
  const lat = Array.isArray(coords) ? Number(coords[1]) : NaN;
  const priceText = typeof l.price === "string" ? l.price : "";
  const bedsText = typeof l.numBedrooms === "string" ? l.numBedrooms : null;
  const bedsMatch = bedsText ? /(\d+)/.exec(bedsText) : null;
  const title = String(l.title ?? l.displayAddress ?? "Listing");

  return {
    id,
    section,
    title,
    url: l.seoFriendlyPath ? new URL(l.seoFriendlyPath, DAFT_BASE).href : `${DAFT_BASE}/${id}`,
    priceText,
    priceMonthly: parsePriceMonthly(priceText),
    bedsText,
    beds: bedsMatch ? Number(bedsMatch[1]) : null,
    propertyType: typeof l.propertyType === "string" ? l.propertyType : null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    publishedAt: typeof l.publishDate === "number" ? new Date(l.publishDate).toISOString() : null,
    ownerOccupied: findOwnerOccupied(l),
    image: firstImageUrl(l),
    text: [title, l.description, l.shortDescription].filter((s) => typeof s === "string").join(" \n "),
  };
}
