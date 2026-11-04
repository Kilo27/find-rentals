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
// A price tag is wider than it is tall, so `gap` is a box ({ x, y } pixels, or one number for both).
// A merged tag is drawn at the middle of its spots, which can move it onto a neighbour, so merging goes on until no two
// tags touch. Each cluster lists its spots and all of their listings; one that holds a single spot is that spot, unchanged.
export function clusterSpots(spots, project, gap = 44) {
  const { x: gx, y: gy } = typeof gap === "number" ? { x: gap, y: gap } : gap;
  const touch = (a, b) => Math.abs(a.px.x - b.px.x) < gx && Math.abs(a.px.y - b.px.y) < gy;
  const clusters = [...spots].sort((a, b) => b.lat - a.lat || a.lng - b.lng).map((spot) => ({ px: project(spot.lat, spot.lng), spots: [spot] }));
  for (let i = 0; i < clusters.length; i++) {
    const j = clusters.findIndex((c, k) => k > i && touch(clusters[i], c));
    if (j < 0) continue;
    const [a, b] = [clusters[i], clusters[j]];
    const n = a.spots.length + b.spots.length;
    a.px = { x: (a.px.x * a.spots.length + b.px.x * b.spots.length) / n, y: (a.px.y * a.spots.length + b.px.y * b.spots.length) / n };
    a.spots.push(...b.spots);
    clusters.splice(j, 1);
    // The grown tag has moved: look again from the start.
    i = -1;
  }
  return clusters.map(({ spots: members }) => {
    const items = members.flatMap((s) => s.items);
    const lat = members.reduce((sum, s) => sum + s.lat, 0) / members.length;
    const lng = members.reduce((sum, s) => sum + s.lng, 0) / members.length;
    return { kind: "spot", key: members.map((s) => s.key).join("|"), lat, lng, spots: members, items };
  });
}

const kmApart = (a, [lat, lng]) => Math.hypot((lat - a.lat) * 111.19, (lng - a.lng) * 111.19 * Math.cos((a.lat * Math.PI) / 180));

// The positions the map first frames, out of `points` ([lat, lng] pairs): those near the search circle. One place far
// across the city (a direct route, an area the geocoder put wide) would otherwise shrink every other pin into a
// huddle round the campus, so the far ones wait for "Show all", unless they are more than a quarter of the whole.
export function framePoints(points, center, radiusKm) {
  const reach = Math.max(radiusKm * 1.5, radiusKm + 1);
  const near = points.filter((p) => kmApart(center, p) <= reach);
  return points.length - near.length > points.length / 4 ? points : near;
}

export const priceShort = (m) => (m.priceMonthly !== null && m.priceMonthly !== undefined ? `€${Math.round(m.priceMonthly).toLocaleString("en-IE")}` : "€?");

// "€650" for one listing, "€600+" for a group.
export function pinLabel(items) {
  const priced = items.filter((m) => m.priceMonthly !== null && m.priceMonthly !== undefined);
  if (!priced.length) return "€?";
  const lowest = priced.reduce((a, b) => (b.priceMonthly < a.priceMonthly ? b : a));
  return items.length > 1 ? `${priceShort(lowest)}+` : priceShort(lowest);
}
