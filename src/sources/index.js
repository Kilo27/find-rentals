import { DaftError, fetchSection } from "../daft.js";
import { ID_IN_PATH, scrapePages } from "./web.js";

const daft = {
  id: "daft",
  label: "Daft.ie",
  async fetch(config, { fetchImpl }) {
    const listings = [];
    const notes = [];
    let first = null;
    for (const section of config.sections) {
      try {
        const r = await fetchSection(config, section, { fetchImpl });
        listings.push(...r.listings);
        notes.push({ group: section, ok: true, fetched: r.listings.length, total: r.total, degraded: r.degraded, debug: { sample: r.rawSample } });
      } catch (err) {
        first ??= err;
        notes.push({ group: section, ok: false, error: err.message, status: err.status ?? null, body: err.body ?? "" });
      }
    }
    if (notes.length && notes.every((n) => !n.ok)) {
      const err = first instanceof DaftError ? first : new Error(first?.message ?? "Daft failed");
      err.notes = notes;
      throw err;
    }
    return { listings, notes };
  },
};

const html = (id, label, urlsKey, opts = {}) => ({
  id,
  label,
  fetch: (config, deps) =>
    scrapePages({ source: id, label, urls: config[urlsKey], config, deps, ...opts }),
});

export const ADAPTERS = {
  daft,
  ul: html("ul", "UL Accommodation", "ulUrls", { hrefRe: /\/Advert\/\d+/i, paginate: false }),
  rent: html("rent", "Rent.ie", "rentUrls", { hrefRe: ID_IN_PATH, paginate: true }),
  myhome: html("myhome", "MyHome.ie", "myhomeUrls", { hrefRe: ID_IN_PATH, paginate: true }),
  web: html("web", "Custom pages", "webUrls", { hrefRe: /\d{5,}/, paginate: true }),
};
