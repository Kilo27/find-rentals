import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { SECTION_PATHS } from "../src/daft.js";
import { ADMIN_OWNER } from "../src/push.js";
import { PREF_KEYS } from "../src/config.js";

export const UL = { lat: 52.6733, lng: -8.5739 };

// ~0.009 degrees of latitude is ~1 km. `from` is the point to measure from (UL unless another campus is given).
export const kmNorth = (km, from = UL) => ({ lat: from.lat + km / 111.19, lng: from.lng });

export function rawListing(over = {}) {
  const { id = 1, km = 1, price = "€650 per month", title = `Room ${id}, Castletroy, Co. Limerick`, extra = {}, from = UL } = over;
  const pos = kmNorth(km, from);
  return {
    listing: {
      id,
      title,
      price,
      numBedrooms: "1 Bed",
      propertyType: "House",
      seoFriendlyPath: `/share/room-${id}/${id}`,
      point: { type: "Point", coordinates: [pos.lng, pos.lat] },
      publishDate: Date.parse("2026-09-29T10:00:00Z") + id,
      media: { images: [{ size720x480: `https://media.example/${id}.jpg` }] },
      ...extra,
    },
  };
}

// A Daft search results page: the listings travel as Next.js page data.
export function daftPage(items, total = items.length, extra = {}) {
  const data = { props: { pageProps: { listings: items, paging: { totalResults: total }, ...extra } } };
  return `<!doctype html><html><head><title>Daft.ie</title></head><body><div id="__next"></div>` +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

const SECTION_OF_PATH = Object.fromEntries(Object.entries(SECTION_PATHS).map(([section, p]) => [p, section]));

// What a Daft search URL asks for: section, page number and query parameters.
export function daftQuery(url) {
  const u = new URL(url);
  return { section: SECTION_OF_PATH[u.pathname.split("/")[1]] ?? null, page: Number(u.searchParams.get("page") ?? 1), params: u.searchParams };
}

export function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith("/robots.txt")) return new Response("not found", { status: 404 });
    const out = await handler(daftQuery(url), calls.length, url);
    if (out instanceof Response) return out;
    if (typeof out === "string") return new Response(out, { status: 200, headers: { "Content-Type": "text/html" } });
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  fn.calls = calls;
  fn.pages = () => calls.filter((c) => !c.url.endsWith("/robots.txt"));
  return fn;
}

export const httpError = (status, text = "nope") => new Response(text, { status });

export function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-rentals-"));
  return { store: new Store(dir), dir };
}

// The notes about how the scanner is doing, which go to the admin and are not alerts about places.
const isOp = (payload) => /^(scan-failure|source-|laptop)/.test(payload.tag ?? "");

// `subscribers` is how many devices every account has, or an object giving it per account ({ bob: 2 }, others 0).
export function fakePusher({ subscribers = 1, sendResult } = {}) {
  // What the admin's devices were sent about places: the alerts and the "watching started" note, as payloads.
  const sent = [];
  // Every push, as { owner, payload }.
  const sentToOwner = [];
  const devices = (owner) => (typeof subscribers === "number" ? subscribers : subscribers[owner] ?? 0);
  return {
    sent,
    sentToOwner,
    // The scanner's own health notes to the admin.
    ops: () => sentToOwner.filter((s) => s.owner === ADMIN_OWNER && isOp(s.payload)).map((s) => s.payload),
    // The alerts one account was sent.
    to: (owner) => sentToOwner.filter((s) => s.owner === owner && !isOp(s.payload)).map((s) => s.payload),
    publicKey: "test-public-key",
    count: (owner) => devices(owner),
    sendToAll: async (payload) => {
      sent.push(payload);
      return sendResult ? sendResult(payload) : { sent: subscribers, failed: 0, removed: 0 };
    },
    sendToOwner: async (owner, payload) => {
      sentToOwner.push({ owner, payload });
      if (isOp(payload)) return { sent: 0, failed: 0, removed: 0 };
      if (owner === ADMIN_OWNER) sent.push(payload);
      return sendResult ? sendResult(payload, owner) : { sent: devices(owner), failed: 0, removed: 0 };
    },
    subscriptionsOf: () => [],
    addSubscription() {},
    removeSubscription() {},
    removeOwner() {},
  };
}

// An account's search, and a region's settings.
export const searchOf = (store, owner = ADMIN_OWNER) => store.data.searches[owner];
export const regionOf = (store, id = "limerick") => store.data.regions[id];

const REGION_KEYS = ["enabled", "intervalMinutes", "daftLocation", "sources", "ulUrls", "rentUrls", "myhomeUrls", "webUrls", "geocode", "respectRobots", "maxDetailFetches", "maxPages"];

// Sets up a search in the way the tests used to change the one shared config: settings about where to look go to the region
// (default Limerick), preferences to the account (default the admin, who is at UL).
export function configure(store, over = {}, { region = "limerick", owner = ADMIN_OWNER } = {}) {
  for (const [k, v] of Object.entries(over)) {
    if (REGION_KEYS.includes(k)) store.data.regions[region][k] = v;
    else if (PREF_KEYS.includes(k)) store.data.searches[owner].prefs[k] = v;
    else throw new Error(`configure: "${k}" is neither a region setting nor a preference`);
  }
  return store;
}

// Routes by exact URL (string) or RegExp. Unmatched URLs return 404.
export function router(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [pattern, handler] of routes) {
      const hit = typeof pattern === "string" ? pattern === url : pattern.test(url);
      if (!hit) continue;
      const out = typeof handler === "function" ? await handler(url, opts) : handler;
      if (out instanceof Response) return out;
      if (typeof out === "string") return new Response(out, { status: 200, headers: { "Content-Type": "text/html" } });
      return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  fn.calls = calls;
  fn.count = (re) => calls.filter((c) => re.test(c.url)).length;
  return fn;
}

export const noSleep = async () => {};
