const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const key = (l) => `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;

// A coordinate that appears on many *different* listings is a site-wide map position
// (campus marker, default map centre), not any one property's location.
export function detectSharedCoords(listings, { minListings = 3 } = {}) {
  const groups = new Map();
  for (const l of listings) {
    if (l.lat === null || l.lng === null) continue;
    const k = key(l);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const shared = new Set();
  for (const [k, ls] of groups) {
    const distinctPlaces = new Set(ls.map((l) => norm(l.address || l.title))).size;
    if (ls.length >= minListings && distinctPlaces >= minListings) shared.add(k);
  }
  return shared;
}

// Removes untrusted coordinates from scraped (non-API) listings, remembers them across scans
// so a single new listing with the same position is still caught, and returns how many were cleared.
export function stripSharedCoords(listings, known) {
  const bySource = new Map();
  for (const l of listings) {
    if (l.source === "daft") continue;
    if (!bySource.has(l.source)) bySource.set(l.source, []);
    bySource.get(l.source).push(l);
  }
  const cleared = {};
  for (const [source, ls] of bySource) {
    const keys = new Set(known[source] ?? []);
    for (const k of detectSharedCoords(ls)) keys.add(k);
    known[source] = [...keys];
    for (const l of ls) {
      if (l.lat !== null && l.lng !== null && keys.has(key(l))) {
        l.lat = null;
        l.lng = null;
        l.distanceSource = null;
        cleared[source] = (cleared[source] ?? 0) + 1;
      }
    }
  }
  return cleared;
}
