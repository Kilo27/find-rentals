import * as cheerio from "cheerio";
import { haversineKm } from "./geo.js";

export class SourceError extends Error {
  constructor(message, { status = null, code = null, body = "" } = {}) {
    super(message);
    this.name = "SourceError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// An honest bot name. A user agent claiming to be Chrome from a client that isn't gets Cloudflare's
// "Security Check" 403 on Daft and Rent.ie from any network, home connections included.
const DEFAULT_UA = "Mozilla/5.0 (compatible; RentalWatch/1.0; personal rental monitor)";
const UA_TOKEN = "rentalwatch";
const MAX_HTML = 3_000_000;

export const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function isSafeUrl(url, allowPrivate = process.env.ALLOW_PRIVATE_URLS === "1") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (allowPrivate) return u.protocol === "https:" || u.protocol === "http:";
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost") return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h.startsWith("[")) return false;
  return !/\.(internal|local|localhost|lan|home|corp)$/.test(h);
}

export function parseRobots(text, token = UA_TOKEN) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (cur) cur.rules.push({ allow: key === "allow", path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && (token.includes(a) || a.includes(token))));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function pathRegex(path) {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function isAllowed(rules, pathAndQuery) {
  let best = { len: -1, allow: true };
  for (const r of rules) {
    if (!r.path) continue;
    if (pathRegex(r.path).test(pathAndQuery)) {
      const len = r.path.length;
      if (len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best.allow;
}

export function createFetcher({
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  politenessMs = Number(process.env.SCRAPE_DELAY_MS ?? 1200),
  respectRobots = true,
  userAgent = process.env.SCRAPER_USER_AGENT || DEFAULT_UA,
} = {}) {
  const lastHit = new Map();
  const robotsCache = new Map();

  async function politely(host) {
    const wait = (lastHit.get(host) ?? 0) + politenessMs - now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, now());
  }

  const headers = {
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
    "Accept-Language": "en-IE,en;q=0.9",
  };

  async function robotsRules(origin) {
    const hit = robotsCache.get(origin);
    if (hit && hit.until > now()) return hit.rules;
    let rules;
    let ttl = 24 * 3600_000;
    try {
      await politely(new URL(origin).host);
      const res = await fetchImpl(`${origin}/robots.txt`, { headers, signal: AbortSignal.timeout(10_000), redirect: "follow" });
      if (res.ok) rules = parseRobots(await res.text());
      else if (res.status >= 500) {
        rules = [{ allow: false, path: "/" }];
        ttl = 10 * 60_000;
      } else rules = [];
    } catch {
      rules = [{ allow: false, path: "/" }];
      ttl = 10 * 60_000;
    }
    robotsCache.set(origin, { rules, until: now() + ttl });
    return rules;
  }

  async function get(url) {
    if (!isSafeUrl(url)) throw new SourceError(`URL not allowed: ${url}`, { code: "unsafe-url" });
    const u = new URL(url);
    if (respectRobots) {
      const rules = await robotsRules(u.origin);
      if (!isAllowed(rules, u.pathname + u.search)) {
        throw new SourceError(`Blocked by robots.txt: ${u.host}${u.pathname}`, { code: "robots" });
      }
    }
    await politely(u.host);
    let res;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000), redirect: "follow" });
    } catch (err) {
      throw new SourceError(`Network error fetching ${u.host}: ${err.message}`, { code: "network" });
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new SourceError(`HTTP ${res.status} from ${u.host}`, { status: res.status, code: "http", body });
    }
    const html = (await res.text()).slice(0, MAX_HTML);
    return { html, url: res.url || url, status: res.status };
  }

  return { get };
}

export const load = (html) => cheerio.load(html);

// cheerio's .text() glues neighbouring elements together ("€650 per month" + "1 bedroom" -> "month1");
// pad every element with a space first so words and prices stay separate.
export function textOf($, el) {
  const copy = $(el).clone();
  copy.find("*").each((_, n) => {
    $(n).append(" ").prepend(" ");
  });
  return collapse(copy.text());
}

export function resolveUrl(base, href) {
  if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    u.hash = "";
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const rootHost = (h) => h.replace(/^www\./, "");
export const sameSite = (a, b) => {
  try {
    const x = rootHost(new URL(a).hostname);
    const y = rootHost(new URL(b).hostname);
    return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
  } catch {
    return false;
  }
};

export function externalIdFromUrl(url) {
  const u = new URL(url);
  const num = /(\d{4,})(?=[/?#]|$)/.exec(u.pathname);
  if (num) return num[1];
  return u.pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(-80) || "root";
}

const PRICE_RE = /€\s*[\d,]+(?:\.\d+)?(?:\s*(?:per|a|\/|p\/?)\s*(?:person\s*per\s*)?(?:weeks?|wk|months?|mth|w|m)\b)?/i;
export const findPriceText = (text) => PRICE_RE.exec(String(text ?? ""))?.[0]?.trim() ?? "";

export function extractJsonLd($) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    out.push(n);
    walk(n["@graph"]);
    walk(n.itemListElement);
    walk(n.item);
    walk(n.itemOffered);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).contents().text()));
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  return out;
}

const LD_TYPES = /(Residence|Apartment|House|Accommodation|RealEstateListing|Room|LodgingBusiness|Product|Offer|Place)/i;

function addressToString(a) {
  if (!a) return "";
  if (typeof a === "string") return collapse(a);
  if (typeof a === "object") {
    return collapse([a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(", "));
  }
  return "";
}

export function candidatesFromJsonLd(nodes, baseUrl) {
  const out = [];
  for (const n of nodes) {
    const type = [].concat(n["@type"] ?? []).join(",");
    if (!LD_TYPES.test(type)) continue;
    const url = resolveUrl(baseUrl, n.url ?? n["@id"]);
    const title = collapse(n.name ?? n.headline ?? "");
    if (!url || !title) continue;
    const offer = [].concat(n.offers ?? n.offer ?? [])[0];
    const priceRaw = offer?.price ?? n.price;
    const priceText = priceRaw !== undefined ? `€${String(priceRaw).replace(/[^\d.,]/g, "")}` : findPriceText(n.description ?? "");
    const geo = n.geo ?? n.location?.geo;
    const image = [].concat(n.image ?? [])[0];
    out.push({
      url,
      title,
      priceText,
      lat: geo ? num(geo.latitude) : null,
      lng: geo ? num(geo.longitude) : null,
      address: addressToString(n.address ?? n.location?.address),
      text: collapse(n.description ?? ""),
      image: typeof image === "string" ? image : (image?.url ?? null),
      bedsText: n.numberOfBedrooms ? `${n.numberOfBedrooms} Bed` : null,
    });
  }
  return out;
}

function balancedJson(str, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return str.slice(start, i + 1);
  }
  return null;
}

export function extractEmbeddedJson($, html) {
  const roots = [];
  $('script#__NEXT_DATA__, script[type="application/json"]').each((_, el) => {
    try {
      roots.push(JSON.parse($(el).contents().text()));
    } catch {
      /* ignore */
    }
  });
  for (const m of html.matchAll(/window\.(?:__(?:INITIAL|PRELOADED|APP)_STATE__|__NUXT__)\s*=\s*/g)) {
    const start = html.indexOf("{", m.index + m[0].length - 1);
    if (start < 0 || start > m.index + m[0].length + 2) continue;
    const raw = balancedJson(html, start);
    if (!raw) continue;
    try {
      roots.push(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }
  return roots;
}

const KEYS = {
  id: ["id", "propertyid", "listingid", "brochureid", "adid", "propertyreference", "reference"],
  url: ["url", "seourl", "seofriendlypath", "link", "brochureurl", "detailurl", "href", "canonicalurl", "permalink"],
  price: ["price", "rent", "pricetext", "displayprice", "monthlyrent", "rentalprice", "pricedisplay", "priceasstring"],
  title: ["title", "displayaddress", "address", "name", "headline", "propertyaddress"],
  lat: ["latitude", "lat"],
  lng: ["longitude", "lng", "lon", "long"],
  beds: ["bedrooms", "beds", "numbedrooms", "bedroomcount"],
  image: ["image", "imageurl", "photo", "mainphoto", "mainimage", "thumbnail", "primaryimage"],
};

function pick(obj, names) {
  for (const k of Object.keys(obj)) if (names.includes(k.toLowerCase())) return obj[k];
  return undefined;
}

// JSON null/"" must count as "no value": Number(null) is 0, which would put the listing at 0,0.
const num = (v) => (v === null || v === undefined || v === "" || typeof v === "object" ? NaN : Number(v));

const asString = (v) => {
  if (typeof v === "string") return collapse(v);
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") {
    return collapse(Object.values(v).filter((x) => typeof x === "string").join(", "));
  }
  return "";
};

function coordsOf(obj) {
  const direct = [num(pick(obj, KEYS.lat)), num(pick(obj, KEYS.lng))];
  if (direct.every(Number.isFinite)) return { lat: direct[0], lng: direct[1] };
  for (const key of ["location", "geo", "geolocation", "coordinates", "point", "latlng", "position"]) {
    const sub = pick(obj, [key]);
    if (Array.isArray(sub) && sub.length >= 2 && sub.slice(0, 2).every((v) => Number.isFinite(num(v)))) {
      return { lat: Number(sub[1]), lng: Number(sub[0]) };
    }
    if (sub && typeof sub === "object") {
      const c = coordsOf(sub);
      if (c) return c;
      if (Array.isArray(sub.coordinates) && sub.coordinates.slice(0, 2).every((v) => Number.isFinite(num(v)))) {
        return { lat: Number(sub.coordinates[1]), lng: Number(sub.coordinates[0]) };
      }
    }
  }
  return null;
}

export function candidatesFromEmbeddedJson(roots, baseUrl) {
  const out = [];
  let budget = 200_000;
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 12 || budget-- <= 0) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    const hasId = pick(node, KEYS.id) !== undefined;
    const priceRaw = pick(node, KEYS.price);
    const titleRaw = pick(node, KEYS.title);
    if (hasId && priceRaw !== undefined && titleRaw !== undefined) {
      const url = resolveUrl(baseUrl, asString(pick(node, KEYS.url)));
      const title = asString(titleRaw);
      const priceText = typeof priceRaw === "number" ? `€${priceRaw}` : asString(priceRaw);
      if (url && title.length >= 3 && /\d/.test(priceText)) {
        const c = coordsOf(node);
        const beds = pick(node, KEYS.beds);
        const img = pick(node, KEYS.image);
        out.push({
          url,
          title,
          priceText: priceText.includes("€") ? priceText : `€${priceText.replace(/[^\d.,]/g, "")}`,
          lat: c?.lat ?? null,
          lng: c?.lng ?? null,
          bedsText: beds !== undefined && beds !== null ? `${asString(beds)} Bed` : null,
          image: typeof img === "string" ? resolveUrl(baseUrl, img) : null,
          address: typeof titleRaw === "string" ? collapse(titleRaw) : "",
          text: "",
        });
        return;
      }
    }
    for (const v of Object.values(node)) visit(v, depth + 1);
  };
  roots.forEach((r) => visit(r, 0));
  return out;
}

const STOP_TAGS = new Set(["body", "html", "ul", "ol", "table", "tbody", "main", "section"]);

// Finds one "card" per listing link without relying on site-specific class names:
// climb from the link until the container would hold a second distinct listing.
export function extractCards($, baseUrl, hrefRe, center = null) {
  const byKey = new Map();
  const keyOf = (a) => {
    const u = resolveUrl(baseUrl, $(a).attr("href"));
    if (!u) return null;
    const p = new URL(u);
    return hrefRe.test(p.pathname) || hrefRe.test(p.pathname + p.search) ? p.origin + p.pathname : null;
  };
  $("a[href]").each((_, a) => {
    const key = keyOf(a);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(a);
  });

  const cards = [];
  for (const [key, anchors] of byKey) {
    let card = anchors[0];
    let node = card.parent;
    while (node && node.name && !STOP_TAGS.has(node.name)) {
      const distinct = new Set();
      $(node)
        .find("a[href]")
        .each((_, a) => {
          const k = keyOf(a);
          if (k) distinct.add(k);
        });
      if (distinct.size > 1 || textOf($, node).length > 1500) break;
      card = node;
      node = node.parent;
    }
    const $card = $(card);
    const text = textOf($, card).slice(0, 1500);
    const anchorTitles = anchors.map((a) => textOf($, a)).filter((t) => t.length >= 3).sort((x, y) => y.length - x.length);
    const heading = textOf($, $card.find("h1,h2,h3,h4").first());
    const title = anchorTitles[0] || heading || text.slice(0, 80);
    let image = null;
    $card.find("img").each((_, img) => {
      if (image) return;
      const src = $(img).attr("src") || $(img).attr("data-src") || $(img).attr("data-lazy-src");
      if (src && !src.startsWith("data:")) image = resolveUrl(baseUrl, src);
    });
    const beds = /(\d+)\s*(?:bed(?:room)?s?)\b/i.exec(text);
    const own = center ? coordsFromHtml($.html(card), center) : null;
    cards.push({
      url: key,
      title,
      priceText: findPriceText(text),
      lat: own?.lat ?? null,
      lng: own?.lng ?? null,
      bedsText: beds ? `${beds[1]} Bed` : null,
      image,
      address: "",
      text,
    });
  }
  return cards;
}

const inIreland = (lat, lng, center) => haversineKm(center.lat, center.lng, lat, lng) <= 300;

export function coordsFromHtml(html, center) {
  const ok = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 0.01 && inIreland(lat, lng, center);
  const tries = [
    () => {
      const la = /<meta[^>]+(?:property|name)=["'](?:place:location:latitude|og:latitude)["'][^>]+content=["'](-?\d+\.\d+)["']/i.exec(html);
      const lo = /<meta[^>]+(?:property|name)=["'](?:place:location:longitude|og:longitude)["'][^>]+content=["'](-?\d+\.\d+)["']/i.exec(html);
      return la && lo ? [Number(la[1]), Number(lo[1])] : null;
    },
    () => {
      const m = /<meta[^>]+name=["'](?:geo\.position|ICBM)["'][^>]+content=["'](-?\d+\.\d+)\s*[;,]\s*(-?\d+\.\d+)["']/i.exec(html);
      return m ? [Number(m[1]), Number(m[2])] : null;
    },
    () => {
      const m = /data-lat(?:itude)?=["'](-?\d+\.\d+)["'][^>]*data-(?:lng|lon|long|longitude)=["'](-?\d+\.\d+)["']/i.exec(html);
      return m ? [Number(m[1]), Number(m[2])] : null;
    },
    () => {
      const la = /["']latitude["']\s*:\s*["']?(-?\d+\.\d+)/i.exec(html);
      const lo = /["']longitude["']\s*:\s*["']?(-?\d+\.\d+)/i.exec(html);
      return la && lo ? [Number(la[1]), Number(lo[1])] : null;
    },
    () => {
      const m = /["']lat["']\s*:\s*["']?(-?\d+\.\d+)["']?\s*,\s*["'](?:lng|lon|long)["']\s*:\s*["']?(-?\d+\.\d+)/i.exec(html);
      return m ? [Number(m[1]), Number(m[2])] : null;
    },
    () => {
      const m = /LatLng\(\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\)/.exec(html);
      return m ? [Number(m[1]), Number(m[2])] : null;
    },
    () => {
      const m = /[?&;](?:center|q|ll|query)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i.exec(html) || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(html);
      return m ? [Number(m[1]), Number(m[2])] : null;
    },
  ];
  for (const t of tries) {
    const c = t();
    if (c && ok(c[0], c[1])) return { lat: c[0], lng: c[1] };
  }
  return null;
}

export function parseDetailPage(html, pageUrl, center) {
  const $ = load(html);
  const ld = extractJsonLd($);
  const ldNode = ld.find((n) => n.geo || n.address || n.offers) ?? {};
  const coords =
    (ldNode.geo && ok2(Number(ldNode.geo.latitude), Number(ldNode.geo.longitude), center)
      ? { lat: Number(ldNode.geo.latitude), lng: Number(ldNode.geo.longitude) }
      : null) ?? coordsFromHtml(html, center);

  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogImage = $('meta[property="og:image"]').attr("content");
  const titleTag = collapse($("title").first().text()).split(/\s[-|–—·]\s/)[0];
  const h1 = collapse($("h1").first().text());

  $("script, style, noscript, nav, header, footer, form, svg, iframe").remove();
  const rootEl = ["main", "#content", ".content", "article"].map((s) => $(s).first()).find((e) => e.length) ?? $("body");
  const text = textOf($, rootEl).slice(0, 6000);
  const title = h1 || collapse(ogTitle) || titleTag;

  const addr = addressToString(ldNode.address) ||
    collapse(/(?:Address|Location)\s*:\s*(.{5,90}?)(?=\s(?:Price|Rent|Type|Beds?|Available|Contact|Description|BER|Deposit)\b|$)/i.exec(text)?.[1] ?? "");
  const offerPrice = [].concat(ldNode.offers ?? [])[0]?.price;
  const priceText = offerPrice !== undefined ? `€${String(offerPrice).replace(/[^\d.,]/g, "")}` : findPriceText(title) || findPriceText(text);

  return {
    title,
    address: addr,
    text,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    image: ogImage ? resolveUrl(pageUrl, ogImage) : null,
    priceText,
  };
}

function ok2(lat, lng, center) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 0.01 && inIreland(lat, lng, center);
}

export function looksEmpty(html) {
  return /\b(?:no\s+(?:results|properties|listings|rooms|adverts|accommodation)\s+(?:found|available|match)|0\s+(?:results|properties|listings)|nothing\s+found|no\s+matches)\b/i.test(html);
}
