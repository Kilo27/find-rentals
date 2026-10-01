import fs from "node:fs";
import { haversineKm } from "./geo.js";
import { campusById, campusIdsFor } from "./transit/campuses.js";

const DATA_FILE = new URL("./transit/data.json", import.meta.url);
const MAX_OPTIONS = 4;
const M_PER_DEG_LAT = 111_195;

// How far to search for listings: a home beyond the radius can still be accepted when a direct bus, tram or train
// runs from near it to the campus, so the sources have to be asked for that wider area.
export function searchRadiusKm(config) {
  if (!config.transitEnabled || campusIdsFor(config).length === 0) return config.radiusKm;
  return Math.max(config.radiusKm, config.transitMaxKm);
}

// data is the parsed src/transit/data.json (see scripts/build-transit.mjs).
export function createTransit(data) {
  const campuses = new Map();
  for (const [id, c] of Object.entries(data.campuses ?? {})) {
    const routes = c.routes.map((r) => ({ label: r.label, mode: r.mode, operator: r.operator, name: r.name }));
    const stops = c.stops.map(([code, name, lat, lng]) => ({ code, name, lat, lng, calls: [] }));
    c.routes.forEach((r, ri) => {
      for (const [si, perDay, mins] of r.calls) stops[si].calls.push({ route: ri, perDay, mins });
    });
    campuses.set(id, { routes, stops });
  }

  // The best way to the campus from a point: for each route, the nearest stop within walking distance that
  // is served often enough and gets there quickly enough.
  function access(lat, lng, config) {
    const walkM = config.transitWalkM;
    const dLat = walkM / M_PER_DEG_LAT;
    const dLng = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const found = [];
    for (const id of campusIdsFor(config)) {
      const c = campuses.get(id);
      if (!c) continue;
      const best = new Map();
      for (const stop of c.stops) {
        if (Math.abs(stop.lat - lat) > dLat || Math.abs(stop.lng - lng) > dLng) continue;
        const distM = Math.round(haversineKm(lat, lng, stop.lat, stop.lng) * 1000);
        if (distM > walkM) continue;
        for (const call of stop.calls) {
          if (call.perDay < config.transitMinPerDay) continue;
          if (call.mins !== null && call.mins > config.transitMaxRideMin) continue;
          const prev = best.get(call.route);
          if (prev && prev.distM <= distM) continue;
          const r = c.routes[call.route];
          best.set(call.route, {
            label: r.label,
            mode: r.mode,
            operator: r.operator,
            stop: stop.name,
            code: stop.code,
            lat: stop.lat,
            lng: stop.lng,
            distM,
            perDay: call.perDay,
            mins: call.mins,
          });
        }
      }
      if (!best.size) continue;
      const options = [...best.values()].sort((a, b) => a.distM - b.distM || b.perDay - a.perDay).slice(0, MAX_OPTIONS);
      const meta = campusById(id);
      found.push({ id, name: meta?.name ?? id, short: meta?.short ?? meta?.name ?? id, options });
    }
    return { good: found.length > 0, campuses: found };
  }

  // Every route that goes on to the campus, with the stops to board it at (nearest the campus last).
  function stopsFor(id) {
    const c = campuses.get(id);
    const meta = campusById(id);
    if (!c || !meta) return null;
    return {
      campus: { id, name: meta.name, short: meta.short, lat: meta.lat, lng: meta.lng, region: meta.region },
      routes: c.routes.map((r, ri) => ({
        ...r,
        stops: c.stops
          .flatMap((s) => s.calls.filter((k) => k.route === ri).map((k) => ({ code: s.code, name: s.name, lat: s.lat, lng: s.lng, perDay: k.perDay, mins: k.mins })))
          .sort((a, b) => (b.mins ?? -1) - (a.mins ?? -1) || a.name.localeCompare(b.name)),
      })),
    };
  }

  return {
    access,
    stopsFor,
    has: (id) => campuses.has(id),
    meta: { generated: data.generated, feeds: data.feeds, attribution: data.attribution, limits: data.limits },
  };
}

let shared;
// The packaged dataset, read once. Null (with a warning) if it is missing, which just turns transit off.
export function defaultTransit(warn = console.warn) {
  if (shared === undefined) {
    try {
      shared = createTransit(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
    } catch (err) {
      warn(`Public transport data unavailable (${err.message}); run npm run transit to build it.`);
      shared = null;
    }
  }
  return shared;
}

// Records on the listing how it connects to the campus (listing.transit), for the filter and the app to use.
// An area-level location is too vague to say which stop is a short walk away.
export function attachTransit(listing, config, transit) {
  listing.transit = null;
  if (!config.transitEnabled || !transit || listing.lat === null || listing.lng === null) return;
  if (listing.distanceSource === "geocoded-area") return;
  const t = transit.access(listing.lat, listing.lng, config);
  if (t.good) listing.transit = t;
}
