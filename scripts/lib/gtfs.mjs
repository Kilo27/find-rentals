import { haversineKm } from "../../src/geo.js";
import { REACH_EXTRA_M } from "../../src/transit/campuses.js";

// Turns GTFS timetable feeds into the small dataset the app reads: for each campus, the stops where you can
// board a bus, tram or train that goes on to stop at that campus, with how many such trips run on a typical
// weekday and how long the ride takes. "Heading towards" is read from the trips themselves (a stop counts
// only if the same trip calls at the campus *later*), so the opposite side of the road never matches.
//
// A feed is { name, has(file), lines(file) -> AsyncIterable<string> }, so the zip reader and the tests can both provide one.

export function splitCsv(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Rows of a feed file as { column: value } objects. Only for the small files; stop_times is read positionally.
async function* rows(feed, file) {
  if (!feed.has(file)) return;
  let header = null;
  for await (const raw of feed.lines(file)) {
    const line = raw.replace(/^﻿/, "");
    if (!line) continue;
    const cells = splitCsv(line);
    if (!header) {
      header = cells.map((c) => c.trim());
      continue;
    }
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    yield row;
  }
}

export const toSeconds = (t) => {
  const m = /^\s*(\d+):(\d{2}):(\d{2})\s*$/.exec(t ?? "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

const ymd = (d) => d.toISOString().slice(0, 10).replaceAll("-", "");

export function modeOf(routeType) {
  const t = Number(routeType);
  if (t === 0 || t === 1 || (t >= 900 && t < 1000)) return "tram";
  if (t === 2 || (t >= 100 && t < 200)) return "rail";
  return "bus";
}

export function operatorName(agency) {
  const a = String(agency ?? "");
  if (/dublin bus/i.test(a)) return "Dublin Bus";
  if (/bus [eé]ireann/i.test(a)) return "Bus Éireann";
  if (/luas/i.test(a)) return "Luas";
  if (/iarn[oó]d|irish rail/i.test(a)) return "Irish Rail";
  if (/go-?ahead/i.test(a)) return "Go-Ahead Ireland";
  return a || "Unknown";
}

function routeLabel(mode, short, long) {
  if (mode === "tram") return /line$/i.test(short) ? short : `${short} Line`;
  if (mode === "rail") return /^dart$/i.test(short) ? "DART" : long || short || "Train";
  return short || long;
}

// The next date (on or after `from`) that falls on a Tuesday, then every week for `weeks` weeks.
export function tuesdays(from, weeks) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return Array.from({ length: weeks }, (_, i) => new Date(d.getTime() + i * 7 * 86400_000));
}

async function loadFeed(feed) {
  const agencies = new Map();
  for await (const r of rows(feed, "agency.txt")) agencies.set(r.agency_id, r.agency_name);
  const defaultAgency = [...agencies.values()][0];

  const routes = new Map();
  for await (const r of rows(feed, "routes.txt")) {
    const mode = modeOf(r.route_type);
    const operator = operatorName(agencies.get(r.agency_id) ?? defaultAgency);
    const short = r.route_short_name.trim();
    const long = r.route_long_name.trim();
    routes.set(r.route_id, {
      mode,
      operator,
      label: routeLabel(mode, short, long),
      name: long,
      key: `${mode}|${operator}|${short}${mode === "bus" ? "" : `|${long}`}`,
    });
  }

  const stops = new Map();
  for await (const r of rows(feed, "stops.txt")) {
    const lat = Number(r.stop_lat);
    const lng = Number(r.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
    stops.set(r.stop_id, { id: r.stop_id, code: r.stop_code || "", name: r.stop_name, lat, lng });
  }

  const trips = new Map();
  const tripsPerService = new Map();
  for await (const r of rows(feed, "trips.txt")) {
    if (!routes.has(r.route_id)) continue;
    trips.set(r.trip_id, { route: routes.get(r.route_id), service: r.service_id });
    tripsPerService.set(r.service_id, (tripsPerService.get(r.service_id) ?? 0) + 1);
  }

  const calendar = [];
  for await (const r of rows(feed, "calendar.txt")) {
    calendar.push({
      service: r.service_id,
      days: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((d) => r[d] === "1"),
      start: r.start_date,
      end: r.end_date,
    });
  }
  const exceptions = new Map();
  for await (const r of rows(feed, "calendar_dates.txt")) {
    if (!exceptions.has(r.date)) exceptions.set(r.date, []);
    exceptions.get(r.date).push({ service: r.service_id, type: r.exception_type });
  }
  let validTo = "";
  for await (const r of rows(feed, "feed_info.txt")) validTo = r.feed_end_date || validTo;

  return { name: feed.name, feed, routes, stops, trips, tripsPerService, calendar, exceptions, validTo };
}

export function activeServices(data, date) {
  const key = ymd(date);
  const dow = date.getUTCDay();
  const active = new Set();
  for (const c of data.calendar) if (c.days[dow] && c.start <= key && key <= c.end) active.add(c.service);
  for (const e of data.exceptions.get(key) ?? []) {
    if (e.type === "1") active.add(e.service);
    else if (e.type === "2") active.delete(e.service);
  }
  return active;
}

// The Tuesday in the next few weeks with the most trips running: the fullest, term-time-style weekday timetable.
export function pickReferenceDate(data, today, weeks = 8) {
  let best = null;
  for (const date of tuesdays(new Date(today.getTime() + 86400_000), weeks)) {
    let n = 0;
    for (const s of activeServices(data, date)) n += data.tripsPerService.get(s) ?? 0;
    if (!best || n > best.n) best = { date, n };
  }
  return best;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};

export async function buildDataset({ feeds, campuses, today = new Date(), maxKm = 12, maxRideMin = 60, log = () => {} }) {
  const maxM = maxKm * 1000;
  const maxReachM = (c) => c.reachM + Math.max(...Object.values(REACH_EXTRA_M));
  // campusIdx -> routeKey -> stopId -> { n, mins[] }
  const found = campuses.map(() => new Map());
  const routeInfo = new Map();
  const feedsMeta = [];

  for (const feed of feeds) {
    log(`${feed.name}: reading timetable`);
    const data = await loadFeed(feed);
    const ref = pickReferenceDate(data, today);
    if (!ref || ref.n === 0) {
      log(`${feed.name}: no weekday service found in the next 8 weeks, skipped`);
      continue;
    }
    const active = activeServices(data, ref.date);
    feedsMeta.push({ name: feed.name, refDate: ref.date.toISOString().slice(0, 10), weekdayTrips: ref.n, validTo: data.validTo });

    // Per-stop distance to every campus, so the 2M-row pass below is cheap arithmetic.
    for (const s of data.stops.values()) {
      s.dist = campuses.map((c) => haversineKm(s.lat, s.lng, c.lat, c.lng) * 1000);
      s.reach = [];
      campuses.forEach((c, i) => {
        if (s.dist[i] <= maxReachM(c)) s.reach.push(i);
      });
    }

    let tripId = null;
    let trip = null;
    let calls = [];
    let tripsScanned = 0;

    const finishTrip = () => {
      if (!trip || calls.length < 2) return;
      tripsScanned++;
      const candidates = new Set();
      for (const call of calls) for (const c of call.stop.reach) candidates.add(c);
      for (const c of candidates) {
        const campus = campuses[c];
        const reachM = campus.reachM + REACH_EXTRA_M[trip.route.mode];
        const counted = new Set();
        let ahead = false;
        let aheadAt = null;
        for (let i = calls.length - 1; i >= 0; i--) {
          const call = calls[i];
          const d = call.stop.dist[c];
          if (ahead && call.pickup !== "1" && d <= maxM && !counted.has(call.stop.id)) {
            const mins = aheadAt !== null && call.dep !== null ? Math.ceil((aheadAt - call.dep) / 60) : null;
            if (mins === null || (mins >= 0 && mins <= maxRideMin)) {
              counted.add(call.stop.id);
              const routes = found[c];
              if (!routes.has(trip.route.key)) routes.set(trip.route.key, new Map());
              const stopsOf = routes.get(trip.route.key);
              if (!stopsOf.has(call.stop.id)) stopsOf.set(call.stop.id, { stop: call.stop, n: 0, mins: [] });
              const rec = stopsOf.get(call.stop.id);
              rec.n++;
              if (mins !== null) rec.mins.push(mins);
              routeInfo.set(trip.route.key, trip.route);
            }
          }
          if (d <= reachM && call.drop !== "1") {
            ahead = true;
            aheadAt = call.arr ?? call.dep;
          }
        }
      }
    };

    let header = null;
    let col = null;
    for await (const raw of feed.lines("stop_times.txt")) {
      const line = raw.replace(/^﻿/, "");
      if (!line) continue;
      const cells = splitCsv(line);
      if (!header) {
        header = cells.map((c) => c.trim());
        col = Object.fromEntries(header.map((h, i) => [h, i]));
        continue;
      }
      const id = cells[col.trip_id];
      if (id !== tripId) {
        finishTrip();
        tripId = id;
        const t = data.trips.get(id);
        trip = t && active.has(t.service) ? t : null;
        calls = [];
      }
      if (!trip) continue;
      const stop = data.stops.get(cells[col.stop_id]);
      if (!stop) continue;
      calls.push({
        stop,
        arr: toSeconds(cells[col.arrival_time]),
        dep: toSeconds(cells[col.departure_time]) ?? toSeconds(cells[col.arrival_time]),
        pickup: cells[col.pickup_type] ?? "0",
        drop: cells[col.drop_off_type] ?? "0",
      });
    }
    finishTrip();
    log(`${feed.name}: ${tripsScanned} weekday trips on ${feedsMeta.at(-1).refDate}`);
  }

  const out = {};
  campuses.forEach((campus, c) => {
    const stopIndex = new Map();
    const stops = [];
    const routes = [];
    for (const [routeKey, byStop] of found[c]) {
      const info = routeInfo.get(routeKey);
      const callsOut = [];
      for (const rec of byStop.values()) {
        if (!stopIndex.has(rec.stop.id)) {
          stopIndex.set(rec.stop.id, stops.length);
          stops.push([rec.stop.code, rec.stop.name, round5(rec.stop.lat), round5(rec.stop.lng)]);
        }
        callsOut.push([stopIndex.get(rec.stop.id), rec.n, rec.mins.length ? median(rec.mins) : null]);
      }
      // Journey order: furthest ride first.
      callsOut.sort((a, b) => (b[2] ?? -1) - (a[2] ?? -1) || a[0] - b[0]);
      routes.push({ label: info.label, mode: info.mode, operator: info.operator, name: info.name, calls: callsOut });
    }
    const order = { tram: 0, rail: 1, bus: 2 };
    routes.sort((a, b) => order[a.mode] - order[b.mode] || a.label.localeCompare(b.label, "en", { numeric: true }));
    out[campus.id] = { stops, routes };
  });

  return {
    version: 1,
    generated: today.toISOString().slice(0, 10),
    attribution: "Timetable data from the National Transport Authority via Transport for Ireland, licensed under CC BY 4.0.",
    limits: { maxKm, maxRideMin },
    feeds: feedsMeta,
    campuses: out,
  };
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

// One line per campus keeps diffs of the committed file readable.
export function serializeDataset(ds) {
  const { campuses, ...head } = ds;
  const headJson = JSON.stringify(head).slice(0, -1);
  const body = Object.entries(campuses).map(([id, v]) => `${JSON.stringify(id)}:${JSON.stringify(v)}`);
  return `${headJson},"campuses":{\n${body.join(",\n")}\n}}\n`;
}
