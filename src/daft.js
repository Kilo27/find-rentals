import { SourceError, createFetcher } from "./html.js";
import { makeListing } from "./listing.js";
import { parsePriceMonthly } from "./text.js";

export { parsePriceMonthly };
export const DAFT_BASE = "https://www.daft.ie";

const RADIUS_SHAPES_M = [1000, 3000, 5000, 10000, 20000];
const OWNER_FILTER_SECTIONS = new Set(["sharing", "student-accommodation-to-share"]);
const BEDS_SECTIONS = new Set(["residential-to-rent"]);

// Daft's website path for each section; only houses & apartments is named differently.
export const SECTION_PATHS = {
  "residential-to-rent": "property-for-rent",
  sharing: "sharing",
  "student-accommodation-to-share": "student-accommodation-to-share",
};

// Daft only searches its stored radii (1/3/5/10/20 km; any other value returns nothing), so pick the
// smallest that covers the requested radius. The exact radius is enforced later via haversine.
export function radiusParam(radiusKm) {
  const meters = radiusKm * 1000;
  return RADIUS_SHAPES_M.find((m) => m >= meters) ?? RADIUS_SHAPES_M.at(-1);
}

export function searchUrl(config, section, page = 1) {
  const u = new URL(`/${SECTION_PATHS[section]}/${config.daftLocation}`, DAFT_BASE);
  const q = u.searchParams;
  q.set("radius", String(radiusParam(config.radiusKm)));
  q.set("sort", "publishDateDesc");
  if (page > 1) q.set("page", String(page));
  if (config.excludeOwnerOccupied && OWNER_FILTER_SECTIONS.has(section)) q.set("ownerOccupied", "false");
  const range = (name, lo, hi) => {
    if (lo !== null) q.set(`${name}_from`, String(lo));
    if (hi !== null) q.set(`${name}_to`, String(hi));
  };
  range("rentalPrice", config.priceMin, config.priceMax);
  if (BEDS_SECTIONS.has(section)) range("numBeds", config.bedsMin, config.bedsMax);
  range("leaseLength", config.leaseMinMonths, config.leaseMaxMonths);
  return u.href;
}

const NEXT_DATA = /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

// Daft's search pages carry their results as Next.js page data, in the same shape its gateway API
// returned. (The gateway itself now refuses every client that isn't a browser.)
export function parseSearchPage(html) {
  const m = NEXT_DATA.exec(html);
  if (!m) return null;
  try {
    const props = JSON.parse(m[1])?.props?.pageProps;
    return Array.isArray(props?.listings) ? props : null;
  } catch {
    return null;
  }
}

const lastSegment = (url) => {
  try {
    return new URL(url, DAFT_BASE).pathname.split("/").filter(Boolean).at(-1) ?? "";
  } catch {
    return "";
  }
};

export async function fetchSection(config, section, { fetcher = createFetcher() } = {}) {
  const listings = [];
  let total = 0;
  let rawSample = null;
  let received = 0;

  for (let page = 1; page <= config.maxPages; page++) {
    const res = await fetcher.get(searchUrl(config, section, page));
    const data = parseSearchPage(res.html);
    if (!data) {
      const title = /<title>([^<]{0,80})/i.exec(res.html)?.[1]?.trim();
      throw new SourceError(`Daft page had no listing data (bot wall or layout change)${title ? `, page title "${title}"` : ""}`, { code: "layout" });
    }
    // An area name Daft doesn't know silently becomes a search of all of Ireland.
    if (config.daftLocation !== "ireland" && lastSegment(data.canonicalUrl ?? "") === "ireland") {
      throw new SourceError(`Daft doesn't recognise the area "${config.daftLocation}" (check Settings → Advanced → Daft area)`, { code: "location" });
    }

    // Daft answers a paging parameter it doesn't understand with page 1 again; stop rather than re-read it.
    const current = Number(data.paging?.currentPage);
    if (page > 1 && Number.isFinite(current) && current !== page) break;

    const items = data.listings;
    total = Number(data.paging?.totalResults ?? total);
    if (!rawSample && items[0]) rawSample = items[0];
    for (const item of items) {
      for (const flat of expandGrouped(item)) {
        const normalized = normalizeListing(flat, section);
        if (normalized) listings.push(normalized);
      }
    }
    received += items.length;
    if (items.length === 0 || received >= total) break;
  }

  return { listings, total, rawSample };
}

function expandGrouped(item) {
  const l = item.listing ?? item;
  const subUnits = (l.prs ?? l.newHome)?.subUnits;
  if (Array.isArray(subUnits) && subUnits.length) return subUnits.map((sub) => ({ ...l, ...sub }));
  return [l];
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

  return makeListing({
    source: "daft",
    sourceLabel: "Daft.ie",
    group: section,
    section,
    kind: section === "residential-to-rent" ? "property" : "room",
    externalId: id,
    url: l.seoFriendlyPath ? new URL(l.seoFriendlyPath, DAFT_BASE).href : `${DAFT_BASE}/${id}`,
    title: String(l.title ?? l.displayAddress ?? "Listing"),
    priceText: typeof l.price === "string" ? l.price : "",
    lat,
    lng,
    bedsText: typeof l.numBedrooms === "string" ? l.numBedrooms : null,
    propertyType: typeof l.propertyType === "string" ? l.propertyType : null,
    publishedAt: typeof l.publishDate === "number" ? new Date(l.publishDate).toISOString() : null,
    ownerOccupied: findOwnerOccupied(l),
    image: firstImageUrl(l),
    text: [l.description, l.shortDescription].filter((s) => typeof s === "string").join(" \n "),
  });
}
