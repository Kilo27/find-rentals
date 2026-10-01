import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, normalizeConfig } from "./config.js";

// Defaults shipped earlier that were wrong: "university of limerick" is the destination, not a nearby area,
// and matched almost every advert.
const OLD_LOCALITY_HINTS = JSON.stringify(["castletroy", "plassey", "dromroe", "mayorstone", "kilmurry", "university of limerick"]);
// Only the first of these was a Rent.ie search page: houses-to-rent redirects to the homepage, apartments-to-rent
// is a 404 and the student-accommodation page carries no adverts.
const OLD_RENT_URLS = JSON.stringify([
  "https://www.rent.ie/rooms-to-rent/limerick/castletroy/",
  "https://www.rent.ie/student-accommodation/University-of-Limerick/46/",
  "https://www.rent.ie/houses-to-rent/limerick/castletroy/",
  "https://www.rent.ie/apartments-to-rent/limerick/castletroy/",
]);

const freshState = () => ({
  version: 1,
  config: normalizeConfig(DEFAULT_CONFIG),
  seen: {},
  matches: [],
  subscriptions: [],
  vapid: null,
  baselineDone: false,
  failureCount: 0,
  lastRun: null,
  debug: {},
  pageCache: {},
  geocache: {},
  siteConstants: {},
  sourceHealth: {},
  laptop: { lastOnlineAt: null, offlineNotified: false },
  pendingAttempts: {},
  baselineScans: 0,
});

export class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
    this.data = this.#load();
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return freshState();
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      const state = { ...freshState(), ...parsed };
      try {
        state.config = normalizeConfig(parsed.config ?? {});
        if (JSON.stringify(state.config.localityHints) === OLD_LOCALITY_HINTS) {
          state.config.localityHints = [...DEFAULT_CONFIG.localityHints];
        }
        if (JSON.stringify(state.config.rentUrls) === OLD_RENT_URLS) {
          state.config.rentUrls = [...DEFAULT_CONFIG.rentUrls];
        }
      } catch {
        state.config = normalizeConfig(DEFAULT_CONFIG);
      }
      return state;
    } catch {
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      return freshState();
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
