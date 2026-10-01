import { createRelay, parseAllow } from "./relay.js";
import { fetchSection } from "./daft.js";
import { createFetcher } from "./html.js";
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

const titleOf = (err) => {
  const title = /<title>([^<]{0,80})/i.exec(err.body ?? "")?.[1]?.trim();
  return title ? ` (page title: ${title})` : "";
};

// Logs whether this region's egress can reach the sites, making the same requests the app makes,
// so a proxy can be judged before it is used.
async function selfTest() {
  const fetcher = createFetcher();
  try {
    const cfg = { ...normalizeConfig(DEFAULT_CONFIG), maxPages: 1 };
    const r = await fetchSection(cfg, "sharing", { fetcher });
    console.log(`[relay] selftest daft OK: ${r.listings.length} listing(s), ${r.total} total`);
  } catch (err) {
    console.log(`[relay] selftest daft FAILED: ${err.message}${titleOf(err)}`);
  }
  try {
    const r = await fetcher.get(DEFAULT_CONFIG.rentUrls[0]);
    console.log(`[relay] selftest rent.ie HTTP ${r.status}`);
  } catch (err) {
    console.log(`[relay] selftest rent.ie FAILED: ${err.message}${titleOf(err)}`);
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
