import { ProxyAgent, fetch as undiciFetch } from "undici";

export function proxyFetch(proxyUrl) {
  const agent = new ProxyAgent(proxyUrl);
  return (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher: agent });
}

const NONE = Object.freeze({ kind: null, fetch: null, sources: new Set(), online: () => true });

// The sources in SCRAPER_PROXY_SOURCES (default daft and rent) go out through SCRAPER_PROXY_URL, an HTTP
// proxy such as a paid residential one, or else through the laptop agent when the server has one.
// Everything else, the geocoder included, stays direct.
export function proxyFromEnv(env = process.env, warn = console.warn, agent = null) {
  const sources = new Set(String(env.SCRAPER_PROXY_SOURCES ?? "daft,rent").split(/[\s,]+/).filter(Boolean));
  const raw = env.SCRAPER_PROXY_URL;
  if (raw) {
    let u = null;
    try {
      u = new URL(raw);
    } catch {
      warn("SCRAPER_PROXY_URL is not a valid URL; ignoring it");
    }
    if (u && u.protocol !== "http:" && u.protocol !== "https:") {
      warn("SCRAPER_PROXY_URL must be an http(s):// proxy URL; ignoring it");
      u = null;
    }
    if (u) return { kind: "proxy", fetch: proxyFetch(raw), sources, online: () => true };
  }
  if (agent) return { kind: "laptop", fetch: agent.fetch, sources, online: agent.online };
  return NONE;
}
