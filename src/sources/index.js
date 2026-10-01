import { fetchSection } from "../daft.js";
import { ID_IN_PATH, scrapePages } from "./web.js";

const daft = {
  id: "daft",
  label: "Daft.ie",
  async fetch(config, { fetcher }) {
    const listings = [];
    const notes = [];
    let first = null;
    for (const section of config.sections) {
      try {
        const r = await fetchSection(config, section, { fetcher });
        listings.push(...r.listings);
        notes.push({ group: section, ok: true, fetched: r.listings.length, total: r.total, debug: { sample: r.rawSample } });
      } catch (err) {
        first ??= err;
        notes.push({ group: section, ok: false, error: err.message, status: err.status ?? null, body: err.body ?? "" });
      }
    }
    if (notes.length && notes.every((n) => !n.ok)) {
      first.notes = notes;
      throw first;
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
  // The print page already lists address, price, availability and landlord type per advert; the advert pages are an empty JavaScript shell.
  ul: html("ul", "UL Accommodation", "ulUrls", { hrefRe: /\/Advert\/\d+/i, paginate: false, detail: false, titleIsAddress: true }),
  // Rent.ie ignores ?page= (it serves page 1 again) and its own /renting_*/page_N/ links are disallowed by robots.txt,
  // so only the first page (its 20 newest adverts) is read.
  rent: html("rent", "Rent.ie", "rentUrls", { hrefRe: ID_IN_PATH, paginate: false }),
  myhome: html("myhome", "MyHome.ie", "myhomeUrls", { hrefRe: /\/brochure\/.+\/\d+/i, paginate: true }),
  web: html("web", "Custom pages", "webUrls", { hrefRe: /\d{5,}/, paginate: true }),
};
