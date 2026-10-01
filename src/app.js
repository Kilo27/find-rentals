import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import express from "express";
import { ConfigError, SECTIONS, SOURCES, normalizeConfig } from "./config.js";
import { createAuth } from "./auth.js";
import { areasForMatches } from "./mapdata.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
// The map library is served from the installed package, so the page needs no third-party script host.
const leafletDir = path.join(path.dirname(createRequire(import.meta.url).resolve("leaflet/package.json")), "dist");

export function createApp({ store, scanner, pusher, scheduler, agentHub = null, mapData = null, password, secret }) {
  const app = express();
  const auth = createAuth({ password, secret });

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.get("/sw.js", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    // Relative to a root, so a dot-directory somewhere above the project (a .claude worktree, say) is not refused.
    res.type("application/javascript").sendFile("sw.js", { root: publicDir });
  });
  app.use("/vendor/leaflet", express.static(leafletDir, { maxAge: "7d", index: false }));
  app.use(express.static(publicDir, { maxAge: "1h", index: "index.html" }));

  app.post("/api/login", (req, res) => auth.login(req, res));
  app.post("/api/logout", (req, res) => auth.logout(req, res));

  // The laptop agent authenticates with its own token, not the app password.
  if (agentHub) {
    app.get("/api/agent/next", agentHub.next);
    app.post("/api/agent/result", express.raw({ type: "application/octet-stream", limit: "4mb" }), agentHub.result);
  }

  const api = express.Router();
  api.use(auth.requireAuth);

  api.get("/state", (_req, res) => {
    res.json({
      config: store.data.config,
      sections: SECTIONS,
      sources: SOURCES,
      sourceHealth: store.data.sourceHealth,
      matches: store.data.matches,
      areas: areasForMatches(store.data.matches, store.data.geocache),
      lastRun: store.data.lastRun,
      failureCount: store.data.failureCount,
      scanning: scanner.isRunning(),
      nextRunAt: scheduler.nextRunAt(),
      subscriptions: store.data.subscriptions.map((s) => ({
        endpoint: s.endpoint.slice(-12),
        userAgent: s.userAgent,
        addedAt: s.addedAt,
        lastError: s.lastError,
      })),
      vapidPublicKey: pusher.publicKey,
      serverTime: new Date().toISOString(),
    });
  });

  // The campus outline and the bus and rail lines. They come from OpenStreetMap in the background, so this answers at
  // once with what it has and a status; the page asks again while the lines are still loading.
  api.get("/map", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(mapData ? mapData.get(store.data.config) : { center: store.data.config.center, radiusKm: store.data.config.radiusKm, campus: null, transit: null, transitStatus: "error", transitError: "Map data is not enabled" });
  });

  api.post("/map/refresh", (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!mapData) return res.status(404).json({ error: "Map data is not enabled" });
    res.json(mapData.get(store.data.config, { retry: true }));
  });

  api.put("/config", (req, res) => {
    try {
      store.data.config = normalizeConfig({ ...store.data.config, ...req.body });
    } catch (err) {
      if (err instanceof ConfigError) return res.status(400).json({ errors: err.errors });
      throw err;
    }
    store.save();
    scheduler.reschedule();
    res.json({ config: store.data.config });
  });

  api.post("/subscribe", (req, res) => {
    try {
      pusher.addSubscription(req.body, req.get("user-agent"));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json({ ok: true, count: pusher.count() });
  });

  api.post("/unsubscribe", (req, res) => {
    if (typeof req.body?.endpoint === "string") pusher.removeSubscription(req.body.endpoint);
    res.json({ ok: true, count: pusher.count() });
  });

  api.post("/test-push", async (_req, res) => {
    const result = await pusher.sendToAll({
      title: "Test notification",
      body: "Push alerts are working on this device.",
      url: "/",
      tag: "test",
    });
    res.json(result);
  });

  api.post("/scan", async (_req, res) => {
    const lastRun = await scanner.run();
    res.json({ lastRun });
  });

  api.get("/debug", (_req, res) => res.json({ debug: store.data.debug, seenCount: Object.keys(store.data.seen).length }));

  app.use("/api", api);
  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
