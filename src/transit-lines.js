import { haversineKm } from "./geo.js";
import { osmUserAgent } from "./geocode.js";

// Public transport from OpenStreetMap, through the Overpass API. The main server is often overloaded or answers an
// HTML error page with status 200, so several mirrors are tried and a reply only counts if it is real JSON.
// The French mirror goes first: overpass-api.de regularly fails the route query with a dispatcher error or a 504.
export const OVERPASS_MIRRORS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const ROUTE_MODES = { bus: "bus", trolleybus: "bus", train: "rail", tram: "rail", light_rail: "rail", subway: "rail", monorail: "rail", ferry: "ferry" };
const ROUTE_REGEX = Object.keys(ROUTE_MODES).join("|");
// A route's relation also lists its platforms and stop positions; only the carriageway/track members are the line.
const NOT_THE_LINE = /^(?:platform|stop)/;
const NEAR_CENTRE_KM = 1;
const SIMPLIFY_METRES = 2.5;
const PALETTE = [
  "#7c3aed", "#db2777", "#0369a1", "#b45309", "#047857", "#be123c", "#4338ca", "#a21caf",
  "#0f766e", "#9a3412", "#1d4ed8", "#65a30d", "#c2410c", "#6d28d9", "#0e7490", "#86198f",
];

// Half the side of the box fetched around the search circle: room to pan before the lines stop.
export const transitHalfKm = (radiusKm) => Math.min(12, Math.max(5, radiusKm + 3));

export function transitBounds(center, radiusKm) {
  const halfKm = transitHalfKm(radiusKm);
  const dLat = halfKm / 111.19;
  const dLng = halfKm / (111.19 * Math.cos((center.lat * Math.PI) / 180));
  return { south: center.lat - dLat, west: center.lng - dLng, north: center.lat + dLat, east: center.lng + dLng };
}

const boxText = (b) => [b.south, b.west, b.north, b.east].map((n) => n.toFixed(5)).join(",");

export function routesQuery(bounds) {
  const b = boxText(bounds);
  return `[out:json][timeout:55];\nrelation["type"="route"]["route"~"^(${ROUTE_REGEX})$"](${b});\nout geom(${b});`;
}

export function stopsQuery(bounds) {
  const b = boxText(bounds);
  return `[out:json][timeout:55];\n(\n  node["highway"="bus_stop"](${b});\n  node["railway"~"^(station|halt|tram_stop)$"](${b});\n);\nout;`;
}

export async function overpass(query, { fetchImpl = fetch, mirrors = OVERPASS_MIRRORS, userAgent = osmUserAgent(), timeoutMs = 60_000, preferred = { url: null } } = {}) {
  const order = preferred.url && mirrors.includes(preferred.url) ? [preferred.url, ...mirrors.filter((m) => m !== preferred.url)] : mirrors;
  const errors = [];
  for (const url of order) {
    const host = new URL(url).hostname;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent, Accept: "application/json" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let json;
      try {
        json = JSON.parse(await res.text());
      } catch {
        throw new Error("not JSON (an error page)");
      }
      if (!Array.isArray(json?.elements)) throw new Error("no elements in reply");
      // Overpass reports running out of time or memory in a remark, alongside whatever it managed to collect.
      if (/runtime error|timed out|out of memory/i.test(json.remark ?? "")) throw new Error(`incomplete: ${json.remark}`);
      preferred.url = url;
      return json;
    } catch (err) {
      errors.push(`${host}: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
    }
  }
  throw new Error(`Overpass unavailable (${errors.join("; ")})`);
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;
const hexColour = (c) => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c ?? "").trim()) ? String(c).trim() : null);
const hashIndex = (s, mod) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % mod;
};

// A way's geometry has null entries where its points fall outside the requested box: those split it into runs.
function runsOf(geometry) {
  const runs = [];
  let run = [];
  for (const p of geometry ?? []) {
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) run.push([p.lat, p.lon]);
    else {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

// Joins segments that meet end to end (either way round) into longer lines: far fewer shapes to draw.
export function stitch(segments) {
  const key = (p) => `${p[0]},${p[1]}`;
  const at = new Map();
  segments.forEach((s, i) => {
    for (const end of [s[0], s[s.length - 1]]) {
      const k = key(end);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(i);
    }
  });
  const used = new Array(segments.length).fill(false);
  const take = (point) => at.get(key(point))?.find((i) => !used[i]);
  const lines = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let line = [...segments[i]];
    for (let next = take(line[line.length - 1]); next !== undefined; next = take(line[line.length - 1])) {
      used[next] = true;
      const s = segments[next];
      line = line.concat(key(s[0]) === key(line[line.length - 1]) ? s.slice(1) : [...s].reverse().slice(1));
    }
    for (let prev = take(line[0]); prev !== undefined; prev = take(line[0])) {
      used[prev] = true;
      const s = segments[prev];
      line = (key(s[s.length - 1]) === key(line[0]) ? s.slice(0, -1) : [...s].reverse().slice(0, -1)).concat(line);
    }
    lines.push(line);
  }
  return lines;
}

// Douglas-Peucker on a flat local projection, tolerance in metres.
export function simplify(line, toleranceM = SIMPLIFY_METRES) {
  if (line.length < 3) return line;
  const lat0 = line[0][0];
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_540;
  const pts = line.map(([lat, lng]) => [lng * kx, lat * ky]);
  const keep = new Array(line.length).fill(false);
  keep[0] = keep[line.length - 1] = true;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1;
    let farD = toleranceM;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > farD) {
        far = i;
        farD = d;
      }
    }
    if (far !== -1) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

// "Galway - Limerick" and "Limerick - Galway" are one railway, so refless routes are keyed by their ends in sorted order.
const endsKey = (name) => name.toLowerCase().split(/\s*(?:->|-->|=>|→|–|-)\s*/).map((s) => s.trim()).filter(Boolean).sort().join(" - ");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function routeLabel(group) {
  const raw = group.names[0] ?? "";
  const stripped = group.ref ? raw.replace(new RegExp(`^(?:bus|route|line)?\\s*${escapeRe(group.ref)}\\s*[:\\-–]?\\s*`, "i"), "").trim() : raw;
  const fromTo = group.from && group.to ? `${group.from} - ${group.to}` : "";
  return (stripped || fromTo || raw || group.operators[0] || "").slice(0, 100);
}

// Route relations -> one entry per route number: its de-duplicated, stitched lines, a colour and a label.
export function buildRoutes(elements, center) {
  const groups = new Map();
  for (const rel of elements) {
    if (rel.type !== "relation") continue;
    const mode = ROUTE_MODES[rel.tags?.route];
    if (!mode) continue;
    const tags = rel.tags;
    const ref = String(tags.ref ?? "").trim().slice(0, 12);
    const name = String(tags.name ?? "").trim();
    const id = `${mode}|${ref || endsKey(name) || rel.id}`;
    let g = groups.get(id);
    if (!g) {
      g = { id, mode, ref, names: [], operators: [], colour: null, from: tags.from, to: tags.to, ways: new Set(), segments: [] };
      groups.set(id, g);
    }
    if (name && !g.names.includes(name)) g.names.push(name);
    const operator = String(tags.operator ?? "").trim();
    if (operator && !g.operators.includes(operator)) g.operators.push(operator);
    g.colour ??= hexColour(tags.colour);
    for (const m of rel.members ?? []) {
      if (m.type !== "way" || NOT_THE_LINE.test(m.role ?? "") || g.ways.has(m.ref)) continue;
      g.ways.add(m.ref);
      g.segments.push(...runsOf(m.geometry));
    }
  }

  const routes = [];
  for (const g of groups.values()) {
    if (!g.segments.length) continue;
    routes.push({
      id: g.id,
      mode: g.mode,
      ref: g.ref,
      label: routeLabel(g),
      operator: g.operators.slice(0, 2).join(" / "),
      colour: g.colour,
      nearCentre: center ? g.segments.some((s) => s.some(([lat, lng]) => haversineKm(center.lat, center.lng, lat, lng) <= NEAR_CENTRE_KM)) : false,
      lines: stitch(g.segments).map((l) => simplify(l).map(([lat, lng]) => [round5(lat), round5(lng)])),
    });
  }

  // Routes without a colour of their own start from a hash of their id, so colours stay put between refreshes, and
  // move on when one is taken. Those serving the centre choose first so they never share a colour.
  const taken = new Set(routes.map((r) => r.colour).filter(Boolean));
  const byId = [...routes].sort((a, b) => Number(b.nearCentre) - Number(a.nearCentre) || a.id.localeCompare(b.id));
  for (const r of byId) {
    if (r.colour) continue;
    const start = hashIndex(r.id, PALETTE.length);
    const free = PALETTE.findIndex((_, i) => !taken.has(PALETTE[(start + i) % PALETTE.length]));
    r.colour = PALETTE[(start + Math.max(free, 0)) % PALETTE.length];
    taken.add(r.colour);
  }

  const num = (r) => (/^\d+/.test(r.ref) ? Number.parseInt(r.ref, 10) : Number.MAX_SAFE_INTEGER);
  return routes.sort((a, b) => Number(b.nearCentre) - Number(a.nearCentre) || a.mode.localeCompare(b.mode) || num(a) - num(b) || a.ref.localeCompare(b.ref) || a.label.localeCompare(b.label));
}

export function buildStops(elements) {
  const stops = [];
  const seen = new Set();
  for (const n of elements) {
    if (n.type !== "node" || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) continue;
    const rail = Boolean(n.tags?.railway);
    const lat = round5(n.lat);
    const lng = round5(n.lon);
    const name = String(n.tags?.name ?? "").trim().slice(0, 80);
    const k = `${rail}|${lat}|${lng}`;
    if (seen.has(k)) continue;
    seen.add(k);
    stops.push({ lat, lng, name, mode: rail ? "rail" : "bus" });
  }
  return stops;
}

// All the lines and stops in the box. The two queries are separate so a slow one cannot sink the other.
export async function fetchTransit(center, radiusKm, opts = {}) {
  const bounds = transitBounds(center, radiusKm);
  const routes = await overpass(routesQuery(bounds), opts);
  const stops = await overpass(stopsQuery(bounds), opts);
  return { bounds, routes: buildRoutes(routes.elements, center), stops: buildStops(stops.elements) };
}
