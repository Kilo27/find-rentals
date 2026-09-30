import { createRelay, parseAllow } from "./relay.js";
import { fetchSection } from "./daft.js";
import { DEFAULT_CONFIG, normalizeConfig } from "./config.js";

const password = process.env.PROXY_PASSWORD;
if (!password) {
  console.error("PROXY_PASSWORD is required when PROXY_MODE=1");
  process.exit(1);
}
const user = process.env.PROXY_USER || "relay";
const allow = parseAllow(process.env.PROXY_ALLOW || "daft.ie,rent.ie");
const port = Number(process.env.PORT || 3128);

const relay = createRelay({ user, password, allow, log: console });

// Logs whether this region's egress can reach the sites, so a proxy can be judged before it is used.
async function selfTest() {
  try {
    const cfg = { ...normalizeConfig(DEFAULT_CONFIG), maxPages: 1 };
    const r = await fetchSection(cfg, "sharing", { fetchImpl: fetch });
    console.log(`[relay] selftest daft OK: ${r.listings.length} listing(s), ${r.total} total`);
  } catch (err) {
    const title = /<title>([^<]{0,80})/i.exec(err.body ?? "")?.[1]?.trim();
    console.log(`[relay] selftest daft FAILED: ${err.message}${title ? ` (page title: ${title})` : ""}`);
  }
  try {
    const res = await fetch("https://www.rent.ie/rooms-to-rent/limerick/castletroy/", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RentalWatch/1.0; personal rental monitor)" },
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`[relay] selftest rent.ie HTTP ${res.status}`);
  } catch (err) {
    console.log(`[relay] selftest rent.ie FAILED: ${err.message}`);
  }
}

const started = () => {
  console.log(`[relay] listening on :${port}, allowing ${allow.join(", ")} (HTTPS only)`);
  if (process.env.PROXY_SELFTEST !== "0") selfTest();
};
relay.once("error", (err) => {
  if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") relay.listen(port, "0.0.0.0", started);
  else throw err;
});
relay.listen(port, "::", started);

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => relay.close(() => process.exit(0)));
