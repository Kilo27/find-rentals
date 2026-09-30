import { ProxyAgent, fetch as undiciFetch } from "undici";

export function proxyFetch(proxyUrl) {
  const agent = new ProxyAgent(proxyUrl);
  return (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher: agent });
}

const NONE = Object.freeze({ fetch: null, sources: new Set() });

// SCRAPER_PROXY_URL routes the listed sources (default daft and rent) through an HTTP proxy.
export function proxyFromEnv(env = process.env, warn = console.warn) {
  const raw = env.SCRAPER_PROXY_URL;
  if (!raw) return NONE;
  let u;
  try {
    u = new URL(raw);
  } catch {
    warn("SCRAPER_PROXY_URL is not a valid URL; ignoring it");
    return NONE;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    warn("SCRAPER_PROXY_URL must be an http(s):// proxy URL; ignoring it");
    return NONE;
  }
  const sources = new Set(String(env.SCRAPER_PROXY_SOURCES ?? "daft,rent").split(/[\s,]+/).filter(Boolean));
  return { fetch: proxyFetch(raw), sources };
}
