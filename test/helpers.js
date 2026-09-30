import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

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

export function gatewayResponse(items, total = items.length) {
  return { listings: items, paging: { totalResults: total } };
}

export function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, opts, body });
    const out = await handler(body, calls.length);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  fn.calls = calls;
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
