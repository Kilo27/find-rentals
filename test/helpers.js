import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { SECTION_PATHS } from "../src/daft.js";

export const UL = { lat: 52.6733, lng: -8.5739 };

// ~0.009 degrees of latitude is ~1 km
export const kmNorth = (km) => ({ lat: UL.lat + km / 111.19, lng: UL.lng });

export function rawListing(over = {}) {
  const { id = 1, km = 1, price = "€650 per month", title = `Room ${id}, Castletroy, Co. Limerick`, extra = {} } = over;
  const pos = kmNorth(km);
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

export function fakePusher({ subscribers = 1, sendResult } = {}) {
  const sent = [];
  return {
    sent,
    publicKey: "test-public-key",
    count: () => subscribers,
    sendToAll: async (payload) => {
      sent.push(payload);
      return sendResult ? sendResult(payload) : { sent: subscribers, failed: 0, removed: 0 };
    },
    addSubscription() {},
    removeSubscription() {},
  };
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
