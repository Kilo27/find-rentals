import { areaRadiusM, createGeocoder } from "./geocode.js";
import { fetchTransit, transitHalfKm } from "./transit-lines.js";
import { searchRadiusKm } from "./transit.js";

const TRANSIT_TTL_MS = 7 * 24 * 3600_000;
const CAMPUS_TTL_MS = 30 * 24 * 3600_000;
const RETRY_AFTER_MS = 10 * 60_000;
const MANUAL_RETRY_AFTER_MS = 20_000;
const KEEP_ENTRIES = 3;

const SILENT = { log() {}, warn() {} };

// The named places the current matches sit in, with outlines, for the map to highlight.
export function areasForMatches(matches, geocache = {}) {
  const out = {};
  for (const m of matches) {
    const key = m.areaKey;
    const a = key && geocache[key];
    if (!a || a.miss || key in out) continue;
    out[key] = { name: a.name, lat: a.lat, lng: a.lng, radiusM: areaRadiusM(a.kind), geometry: a.geometry ?? null };
  }
  return out;
}

// The slow-changing background of the map: the campus outline and the bus and rail lines around it. Both are fetched
// in the background and kept in the store for a week or more, then served instantly. A stale copy keeps being shown
// while a new one loads, and a failure is remembered for a few minutes rather than hammering the public servers.
export function createMapData({ store, fetchImpl = fetch, now = () => Date.now(), log = SILENT, geocoder = createGeocoder({ store, fetchImpl }) }) {
  const buckets = () => {
    const c = (store.data.mapCache ??= {});
    return { transit: (c.transit ??= {}), campus: (c.campus ??= {}) };
  };
  const jobs = new Map();
  const failures = new Map();
  const mirror = { url: null };

  const centreKey = (c) => `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
  // Homes beyond the radius with a direct route are matches too, so the lines are fetched as far out as they can be.
  const transitKey = (config) => `${centreKey(config.center)},${transitHalfKm(searchRadiusKm(config))}`;
  const campusKey = (config) => `${config.center.label.toLowerCase()}|${centreKey(config.center)}`;

  const isFresh = (entry, ttl) => entry && now() - Date.parse(entry.at) < ttl;
  const prune = (bucket) => {
    const newest = Object.keys(bucket).sort((a, b) => Date.parse(bucket[b].at) - Date.parse(bucket[a].at)).slice(0, KEEP_ENTRIES);
    for (const k of Object.keys(bucket)) if (!newest.includes(k)) delete bucket[k];
  };

  function start(jobKey, run, retry) {
    if (jobs.has(jobKey)) return;
    const failed = failures.get(jobKey);
    if (failed && now() - failed.at < (retry ? MANUAL_RETRY_AFTER_MS : RETRY_AFTER_MS)) return;
    const job = run()
      .then(() => failures.delete(jobKey))
      .catch((err) => {
        failures.set(jobKey, { at: now(), error: err.message });
        log.warn(`[map] ${jobKey}: ${err.message}`);
      })
      .finally(() => jobs.delete(jobKey));
    jobs.set(jobKey, job);
  }

  const loadTransit = (config, key) => async () => {
    const data = await fetchTransit(config.center, searchRadiusKm(config), { fetchImpl, preferred: mirror });
    const { transit } = buckets();
    transit[key] = { at: new Date(now()).toISOString(), routes: data.routes, stops: data.stops };
    prune(transit);
    store.save();
    log.log(`[map] transit: ${data.routes.length} routes, ${data.stops.length} stops`);
  };

  const loadCampus = (config, key) => async () => {
    const polygons = await geocoder.outline(config.center.label, config.center, { geocode: 3, exhausted: false });
    const { campus } = buckets();
    campus[key] = { at: new Date(now()).toISOString(), polygons };
    prune(campus);
    store.save();
  };

  // What the map needs right now, without waiting: anything missing or stale is fetched in the background.
  // `retry` is the user asking again, which waits out only a short gap instead of the full back-off.
  function get(config, { retry = false } = {}) {
    const tKey = transitKey(config);
    const cKey = campusKey(config);
    const { transit, campus } = buckets();
    const t = transit[tKey];
    const c = campus[cKey];
    if (!isFresh(t, TRANSIT_TTL_MS)) start(`transit:${tKey}`, loadTransit(config, tKey), retry);
    if (!isFresh(c, CAMPUS_TTL_MS)) start(`campus:${cKey}`, loadCampus(config, cKey), retry);

    const failed = failures.get(`transit:${tKey}`);
    const waiting = jobs.has(`transit:${tKey}`);
    return {
      center: config.center,
      radiusKm: config.radiusKm,
      campus: c ? c.polygons : null,
      transit: t ? { routes: t.routes, stops: t.stops, fetchedAt: t.at } : null,
      transitStatus: t ? "ready" : failed && !waiting ? "error" : "loading",
      transitError: !t && failed && !waiting ? failed.error : null,
    };
  }

  // Resolves once the background fetches in flight have finished.
  const settled = () => Promise.all([...jobs.values()]);

  return { get, settled };
}
