import path from "node:path";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { createPusher } from "./push.js";
import { createScanner } from "./scan.js";
import { createScheduler } from "./scheduler.js";

const password = process.env.ACCESS_PASSWORD;
if (!password && process.env.ALLOW_NO_AUTH !== "1") {
  console.error("ACCESS_PASSWORD is required (set ALLOW_NO_AUTH=1 only for local development).");
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || "./data");
const store = new Store(dataDir);
const pusher = createPusher({ store });
const scanner = createScanner({ store, pusher });
const startDelayMs = Number(process.env.SCAN_START_DELAY_SECONDS ?? 10) * 1000;
const scheduler = createScheduler({ store, scanner, startDelayMs });

const app = createApp({ store, scanner, pusher, scheduler, password: password ?? "", secret: process.env.SESSION_SECRET });

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`find-rentals listening on :${port}, data in ${dataDir}`);
  if (!process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH && process.env.RAILWAY_ENVIRONMENT) {
    console.warn("WARNING: no volume attached - state is lost on every deploy. Add a Railway Volume.");
  }
  scheduler.start();
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    scheduler.stop();
    server.close(() => process.exit(0));
  });
}
