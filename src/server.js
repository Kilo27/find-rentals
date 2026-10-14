import path from "node:path";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { createPusher } from "./push.js";
import { createScanner } from "./scan.js";
import { createScheduler } from "./scheduler.js";
import { createAgentHub } from "./agent-hub.js";
import { alertAfterFromEnv, createLaptopWatch } from "./laptop-watch.js";
import { createMapData } from "./mapdata.js";
import { proxyFromEnv } from "./proxy.js";
import { isValidUsername, normalizeUsername } from "./users.js";
import { configOf, watchers } from "./searches.js";

const password = process.env.ACCESS_PASSWORD;
if (!password && process.env.ALLOW_NO_AUTH !== "1") {
  console.error("ACCESS_PASSWORD is required (set ALLOW_NO_AUTH=1 only for local development).");
  process.exit(1);
}

// The admin account is this username plus ACCESS_PASSWORD. Everyone else is created by the admin in the app.
const adminUsername = normalizeUsername(process.env.ADMIN_USERNAME || "admin");
if (!isValidUsername(adminUsername)) {
  console.error("ADMIN_USERNAME must be 2-32 characters: lowercase letters, numbers, dot, dash or underscore.");
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || "./data");
const store = new Store(dataDir);
const pusher = createPusher({ store });

// AGENT_TOKEN lets a laptop agent (npm run agent) fetch the proxied sources from a home connection.
// When it reconnects after a scan had to skip it, scan again straight away to catch up.
let agentHub = null;
if (process.env.AGENT_TOKEN) {
  try {
    agentHub = createAgentHub({
      token: process.env.AGENT_TOKEN,
      onOnline: () => {
        console.log("[agent] laptop agent connected");
        for (const [id, status] of Object.entries(store.data.regionStatus)) if (status.lastRun?.laptopOffline) scheduler.runSoon(id);
      },
    });
  } catch (err) {
    console.warn(`AGENT_TOKEN ignored: ${err.message}`);
  }
}

const proxy = proxyFromEnv(process.env, console.warn, agentHub);
const scanner = createScanner({ store, pusher, log: console, proxy });
// The admin's devices hear when the laptop agent goes away and when it is back.
const laptopWatch = createLaptopWatch({ store, pusher, proxy, alertAfterMs: alertAfterFromEnv(process.env) });
const startDelayMs = Number(process.env.SCAN_START_DELAY_SECONDS ?? 10) * 1000;
const scheduler = createScheduler({ store, scanner, startDelayMs });

const mapData = createMapData({ store, log: console });

const app = createApp({ store, scanner, pusher, scheduler, agentHub, mapData, adminUsername, password: password ?? "", secret: process.env.SESSION_SECRET });

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`find-rentals listening on :${port}, data in ${dataDir}`);
  if (!process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH && process.env.RAILWAY_ENVIRONMENT) {
    console.warn("WARNING: no volume attached - state is lost on every deploy. Add a Railway Volume.");
  }
  scheduler.start();
  laptopWatch.start();
  // Fetch the transport lines now, so the map is ready the first time it is opened.
  setTimeout(() => {
    for (const { search } of watchers(store)) {
      const config = configOf(store, search);
      if (config) mapData.get(config);
    }
  }, 5000).unref();
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    scheduler.stop();
    laptopWatch.stop();
    server.close(() => process.exit(0));
  });
}
