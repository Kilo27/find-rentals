// Deciding what goes where on the map. No DOM and no Leaflet in here, so it can be tested on its own.

export const FALLBACK_AREA_RADIUS_M = 500;

const hasPoint = (m) => Number.isFinite(m.lat) && Number.isFinite(m.lng);

// Splits the matches into:
//   spots    - listings with a real position; those at the same spot share one marker
//   zones    - listings whose exact spot is unknown, grouped by the named area they are in
//   unplaced - listings nothing is known about
// A "geocoded-area" position is only the middle of a place name, so it counts as a zone, never a spot.
export function placeMatches(matches, areas = {}) {
  const spots = new Map();
  const zones = new Map();
  const unplaced = [];

  const into = (map, key, make, m) => {
    if (!map.has(key)) map.set(key, { key, ...make(), items: [] });
    map.get(key).items.push(m);
  };

  for (const m of matches) {
    if (hasPoint(m) && m.distanceSource !== "geocoded-area") {
      into(spots, `${m.lat.toFixed(5)},${m.lng.toFixed(5)}`, () => ({ kind: "spot", lat: m.lat, lng: m.lng }), m);
      continue;
    }
    const area = m.areaKey ? areas[m.areaKey] : null;
    if (area) {
      into(zones, m.areaKey, () => ({ kind: "zone", name: area.name, lat: area.lat, lng: area.lng, radiusM: area.radiusM || FALLBACK_AREA_RADIUS_M, geometry: area.geometry ?? null }), m);
    } else if (hasPoint(m)) {
      // The area itself could not be looked up, but the approximate position is known: a circle around it.
      into(zones, `pt:${m.lat.toFixed(3)},${m.lng.toFixed(3)}`, () => ({ kind: "zone", name: "", lat: m.lat, lng: m.lng, radiusM: FALLBACK_AREA_RADIUS_M, geometry: null }), m);
    } else {
      unplaced.push(m);
    }
  }
  return { spots: [...spots.values()], zones: [...zones.values()], unplaced };
}

// Merges spots whose markers would overlap on screen at the current zoom. `project` turns a position into pixels.
// Each cluster lists its spots and all of their listings; one that holds a single spot is that spot, unchanged.
export function clusterSpots(spots, project, minPx = 44) {
  const ordered = [...spots].sort((a, b) => b.lat - a.lat || a.lng - b.lng);
  const clusters = [];
  for (const spot of ordered) {
    const p = project(spot.lat, spot.lng);
    const home = clusters.find((c) => Math.hypot(c.px.x - p.x, c.px.y - p.y) < minPx);
    if (home) home.spots.push(spot);
    else clusters.push({ px: p, spots: [spot] });
  }
  return clusters.map(({ spots: members }) => {
    const items = members.flatMap((s) => s.items);
    const lat = members.reduce((sum, s) => sum + s.lat, 0) / members.length;
    const lng = members.reduce((sum, s) => sum + s.lng, 0) / members.length;
    return { kind: "spot", key: members.map((s) => s.key).join("|"), lat, lng, spots: members, items };
  });
}

export const priceShort = (m) => (m.priceMonthly !== null && m.priceMonthly !== undefined ? `€${Math.round(m.priceMonthly).toLocaleString("en-IE")}` : "€?");

// "€650" for one listing, "€600+" for a group.
export function pinLabel(items) {
  const priced = items.filter((m) => m.priceMonthly !== null && m.priceMonthly !== undefined);
  if (!priced.length) return "€?";
  const lowest = priced.reduce((a, b) => (b.priceMonthly < a.priceMonthly ? b : a));
  return items.length > 1 ? `${priceShort(lowest)}+` : priceShort(lowest);
}
