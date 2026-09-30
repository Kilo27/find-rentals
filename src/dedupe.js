import { haversineKm } from "./geo.js";

const RANK = { daft: 0, ul: 1, rent: 2, myhome: 3, web: 4 };
const STOP = new Set([
  "room", "rooms", "double", "single", "twin", "bedroom", "bed", "to", "rent", "let", "share", "sharing", "co", "county",
  "limerick", "ireland", "the", "in", "available", "house", "apartment", "flat", "ensuite", "en", "suite", "shared",
  "large", "small", "per", "month", "week", "and", "for",
]);

const tokens = (s) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/€\s*[\d,.]+/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => /^\d+$/.test(t) || (t.length > 1 && !STOP.has(t))),
  );

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const canonical = (u) => {
  try {
    const p = new URL(u);
    return p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/+$/, "");
  } catch {
    return u;
  }
};

const digits = (s) => new Set(String(s ?? "").match(/\d+/g) ?? []);

export function sameProperty(a, b) {
  if (canonical(a.url) === canonical(b.url)) return true;
  // Separate ads from one site are separate listings; only cross-site copies are merged.
  if (a.source === b.source) return false;
  const pa = a.priceMonthly;
  const pb = b.priceMonthly;
  if (pa === null || pb === null) return false;
  if (Math.abs(pa - pb) > 0.05 * Math.max(pa, pb)) return false;
  const ta = tokens(a.address || a.title);
  const tb = tokens(b.address || b.title);
  // "14 Plassey Park" and "16 Plassey Park" are neighbours, not the same listing.
  const da = digits(a.address || a.title);
  const db = digits(b.address || b.title);
  if (da.size && db.size && ![...da].some((d) => db.has(d))) return false;
  const j = jaccard(ta, tb);
  if (a.lat !== null && b.lat !== null && haversineKm(a.lat, a.lng, b.lat, b.lng) <= 0.06) return j >= 0.34;
  return ta.size >= 3 && tb.size >= 3 && j >= 0.75;
}

const better = (a, b) => {
  const va = a.distanceSource === "source" ? 0 : 1;
  const vb = b.distanceSource === "source" ? 0 : 1;
  if (va !== vb) return va < vb ? a : b;
  return (RANK[a.source] ?? 9) <= (RANK[b.source] ?? 9) ? a : b;
};

// Collapses the same property advertised on several sites. The winner keeps
// every member id (so a later-appearing copy never re-notifies) and links to the others.
export function dedupe(listings) {
  const parent = listings.map((_, i) => i);
  const sources = listings.map((l) => new Set([l.source]));
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < listings.length; i++) {
    for (let j = i + 1; j < listings.length; j++) {
      const ri = find(i);
      const rj = find(j);
      if (ri === rj || !sameProperty(listings[i], listings[j])) continue;
      // A merged group holds at most one ad per site, so two separate ads from one site
      // can never be chained together through a copy on another site.
      const sameUrl = canonical(listings[i].url) === canonical(listings[j].url);
      if (!sameUrl && [...sources[ri]].some((s) => sources[rj].has(s))) continue;
      parent[rj] = ri;
      for (const s of sources[rj]) sources[ri].add(s);
    }
  }
  const groups = new Map();
  listings.forEach((l, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(l);
  });
  return [...groups.values()].map((members) => {
    const winner = members.reduce(better);
    return {
      ...winner,
      memberIds: members.map((m) => m.id),
      alsoOn: members.filter((m) => m !== winner).map((m) => ({ source: m.source, label: m.sourceLabel, url: m.url })),
    };
  });
}
