import {
  SourceError,
  candidatesFromEmbeddedJson,
  candidatesFromJsonLd,
  collapse,
  externalIdFromUrl,
  extractCards,
  extractEmbeddedJson,
  extractJsonLd,
  load,
  looksEmpty,
  parseDetailPage,
  sameSite,
} from "../html.js";
import { makeListing, validCoord } from "../listing.js";

export const ID_IN_PATH = /\d{5,}\/?$/;
const DETAIL_TTL_MS = 24 * 3600_000;

function withPage(url, page) {
  const u = new URL(url);
  u.searchParams.set("page", String(page));
  return u.href;
}

// Merge card-, JSON-LD- and embedded-JSON-derived candidates for the same URL.
function mergeCandidates(cards, structured) {
  const byUrl = new Map();
  const key = (u) => {
    const p = new URL(u);
    return p.origin + p.pathname.replace(/\/+$/, "");
  };
  for (const c of cards) byUrl.set(key(c.url), { ...c });
  for (const s of structured) {
    const k = key(s.url);
    const cur = byUrl.get(k);
    if (!cur) {
      byUrl.set(k, { ...s });
      continue;
    }
    for (const f of ["priceText", "address", "image", "bedsText"]) if (!cur[f] && s[f]) cur[f] = s[f];
    if (!validCoord(cur.lat, cur.lng) && validCoord(s.lat, s.lng)) {
      cur.lat = s.lat;
      cur.lng = s.lng;
    }
    if (s.text && !cur.text.includes(s.text)) cur.text = `${cur.text} ${s.text}`.slice(0, 3000);
  }
  const out = [...byUrl.values()];
  for (const c of out) {
    if (!validCoord(c.lat, c.lng)) {
      c.lat = null;
      c.lng = null;
    }
  }
  return out;
}

// Some sites render advert pages client-side: the HTML is an empty "Please Wait..." shell whose
// only coordinates are a site-wide map default. Such a page must never contribute a location.
export const usableDetail = (d) =>
  Boolean(d) && d.text.length >= 40 && !/^\s*(?:please wait|loading|enable javascript)/i.test(d.text);

const JUNK_TITLE = /^(?:under|over|up to|from|between|min|max)\s*€/i;
const isJunkTitle = (t) => JUNK_TITLE.test(t) || !/[a-z]{3,}/i.test(t.replace(/€\s*[\d,.]+\s*[km]?/gi, ""));

function applyDetail(c, d) {
  c.address = d.address || c.address;
  c.text = `${c.text} ${d.text}`.slice(0, 7000);
  c.priceText = c.priceText || d.priceText;
  c.image = c.image || d.image;
  if (!validCoord(c.lat, c.lng) && validCoord(d.lat, d.lng)) {
    c.lat = d.lat;
    c.lng = d.lng;
  }
  if (d.title && (!c.title || c.title.length < 6)) c.title = d.title;
}

export async function scrapePages({ source, label, urls, hrefRe = ID_IN_PATH, paginate = false, detail = true, titleIsAddress = false, config, deps }) {
  const { fetcher, cache, budget, now } = deps;
  const maxPages = paginate ? Math.min(config.maxPages, 3) : 1;
  const listings = [];
  const notes = [];
  const seenIds = new Set();

  for (const url of urls) {
    const note = { group: url, ok: true, fetched: 0, pages: 0 };
    notes.push(note);
    const pageCands = [];
    const seenOnGroup = new Set();

    for (let page = 1; page <= maxPages; page++) {
      let res;
      try {
        res = await fetcher.get(page === 1 ? url : withPage(url, page));
      } catch (err) {
        if (err.status === 404 && page === 1) note.skipped = "404: page not found (URL may have changed)";
        else if (page === 1) Object.assign(note, { ok: false, error: err.message, code: err.code, status: err.status });
        break;
      }

      const $ = load(res.html);
      const structured = [
        ...candidatesFromJsonLd(extractJsonLd($), res.url),
        ...candidatesFromEmbeddedJson(extractEmbeddedJson($, res.html), res.url),
      ].filter((c) => sameSite(c.url, res.url));
      const cards = extractCards($, res.url, hrefRe, config.center).filter((c) => sameSite(c.url, res.url) && !isJunkTitle(c.title));
      const merged = mergeCandidates(cards, structured).filter((c) => c.title && c.title.length >= 3);

      const fresh = merged.filter((c) => !seenOnGroup.has(externalIdFromUrl(c.url)));
      note.pages++;
      note.debug = {
        bytes: res.html.length,
        cards: cards.length,
        structured: structured.length,
        sample: merged[0] ?? null,
        head: merged.length === 0 ? collapse(res.html).slice(0, 800) : undefined,
      };
      if (page === 1 && merged.length === 0 && res.html.length > 2000 && !looksEmpty(res.html)) {
        note.warning = "page loaded but no listings were recognised (layout change, bot wall or empty results)";
      }
      if (fresh.length === 0) break;
      for (const c of fresh) {
        seenOnGroup.add(externalIdFromUrl(c.url));
        pageCands.push(c);
      }
    }

    for (const c of pageCands) {
      const externalId = externalIdFromUrl(c.url);
      const id = `${source}:${externalId}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      let pending = false;
      let gone = false;
      if (detail) {
        const cached = cache[id];
        const cachedDetail = cached && usableDetail(cached.detail) ? cached.detail : null;
        const fresh = cached && now() - Date.parse(cached.at) < DETAIL_TTL_MS;
        if (fresh) {
          if (cachedDetail) applyDetail(c, cachedDetail);
        } else if (budget.detail > 0) {
          budget.detail--;
          try {
            const r = await fetcher.get(c.url);
            const d = parseDetailPage(r.html, r.url, config.center);
            if (usableDetail(d)) {
              cache[id] = { at: new Date(now()).toISOString(), detail: d };
              applyDetail(c, d);
            } else {
              cache[id] = { at: new Date(now()).toISOString(), unusable: true };
              note.warning = "advert pages carry no readable content (JavaScript-rendered); using list-page data only";
            }
          } catch (err) {
            if (err.status === 404 || err.status === 410) gone = true;
            else if (cachedDetail) applyDetail(c, cachedDetail);
            else {
              pending = true;
              note.warning = `some detail pages failed: ${err.message}`;
            }
          }
        } else if (cachedDetail) applyDetail(c, cachedDetail);
        else if (!cached) pending = true;
        if (cache[id]) cache[id].lastSeen = new Date(now()).toISOString();
      }
      if (gone) continue;
      if (!pending && !c.priceText && !/€\s*\d/.test(c.text)) {
        note.dropped = (note.dropped ?? 0) + 1;
        continue;
      }

      listings.push(
        makeListing({
          source,
          sourceLabel: label,
          group: url,
          externalId,
          url: c.url,
          title: c.title,
          priceText: c.priceText,
          lat: c.lat,
          lng: c.lng,
          bedsText: c.bedsText,
          image: c.image,
          text: c.text,
          address: titleIsAddress ? c.title : c.address,
          pending,
        }),
      );
      note.fetched++;
    }
  }

  if (notes.length && notes.every((n) => !n.ok)) {
    const err = new SourceError(notes[0].error ?? "all pages failed", { status: notes[0].status, code: notes[0].code });
    err.notes = notes;
    throw err;
  }
  return { listings, notes };
}
