import { OWNER_FILTER_SECTIONS, fetchSection, leaseKey, tagOwnerOccupied } from "../daft.js";
import { ID_IN_PATH, scrapePages } from "./web.js";

const daft = {
  id: "daft",
  label: "Daft.ie",
  // A region's collect asks for everything in the area, with nobody's filters, and then asks Daft two more things that the
  // results themselves don't say. `config.ownerPass`: which of the rooms are owner-occupied (see tagOwnerOccupied).
  // `config.leaseVariants`: which listings Daft's lease-length filter keeps, for each range somebody has chosen, returned as
  // `leaseMatches` (range key -> listing ids), because lease length can only be filtered by Daft.
  async fetch(config, { fetcher }) {
    const listings = [];
    const notes = [];
    const leaseMatches = {};
    let first = null;
    for (const section of config.sections) {
      try {
        const r = await fetchSection(config, section, { fetcher });
        const note = { group: section, ok: true, fetched: r.listings.length, total: r.total, debug: { sample: r.rawSample } };
        if (config.ownerPass && OWNER_FILTER_SECTIONS.has(section)) {
          try {
            tagOwnerOccupied(r, await fetchSection({ ...config, excludeOwnerOccupied: true }, section, { fetcher }));
          } catch (err) {
            note.warning = `couldn't tell which rooms are owner-occupied: ${err.message}`;
          }
        }
        for (const range of config.leaseVariants ?? []) {
          const key = leaseKey(range.min, range.max);
          try {
            const v = await fetchSection({ ...config, leaseMinMonths: range.min, leaseMaxMonths: range.max }, section, { fetcher });
            (leaseMatches[key] ??= []).push(...v.listings.map((l) => l.id));
          } catch (err) {
            note.warning ??= `couldn't read the results for lease length ${key}: ${err.message}`;
          }
        }
        listings.push(...r.listings);
        notes.push(note);
      } catch (err) {
        first ??= err;
        notes.push({ group: section, ok: false, error: err.message, status: err.status ?? null, body: err.body ?? "" });
      }
    }
    if (notes.length && notes.every((n) => !n.ok)) {
      first.notes = notes;
      throw first;
    }
    return { listings, notes, leaseMatches };
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
