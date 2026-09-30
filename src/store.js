import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, normalizeConfig } from "./config.js";

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
  sourceHealth: {},
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
