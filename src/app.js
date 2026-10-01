import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ConfigError, SECTIONS, SOURCES, normalizeConfig } from "./config.js";
import { createAuth } from "./auth.js";
import { CAMPUSES, campusIdsFor } from "./transit/campuses.js";
import { defaultTransit } from "./transit.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));

const REVIEW_STATUSES = new Set(["seen", "rejected", "unavailable"]);

const memberIds = (m) => m.memberIds ?? [m.id];

// The newest verdict on any copy of this property, or null.
function reviewFor(reviews, m) {
  let latest = null;
  for (const id of memberIds(m)) {
    const r = reviews[id];
    if (r && (!latest || r.at > latest.at)) latest = r;
  }
  return latest;
}

export function createApp({ store, scanner, pusher, scheduler, agentHub = null, transit = defaultTransit(), password, secret }) {
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
    // publicDir is fixed, so dotfiles: allow only stops Express refusing a checkout that sits under a dot folder (.claude/worktrees/...).
    res.type("application/javascript").sendFile(path.join(publicDir, "sw.js"), { dotfiles: "allow" });
  });
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
      campuses: CAMPUSES.map(({ id, name, short, region }) => ({ id, name, short, region })),
      autoCampuses: campusIdsFor({ ...store.data.config, transitCampuses: [] }),
      transit: transit ? transit.meta : null,
      sourceHealth: store.data.sourceHealth,
      matches: store.data.matches.map(({ memberIds: _ids, ...m }) => ({ ...m, review: reviewFor(store.data.reviews, m)?.status ?? null })),
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

  // The stops that go on to a campus, for the app's stop list and for taking into a map app:
  // /api/transit/ul (JSON), /api/transit/ul?format=csv, /api/transit/ul?format=geojson
  api.get("/transit/:campus", (req, res) => {
    const result = transit?.stopsFor(req.params.campus);
    if (!result) return res.status(404).json({ error: "no transit data for that campus" });
    const only = String(req.query.routes ?? "").split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
    const routes = result.routes.filter((r) => !only.length || only.includes(r.label.toLowerCase()));
    if (req.query.format === "csv") {
      const lines = routes.flatMap((r) => r.stops.map((s) => [r.label, r.operator, r.mode, s.code, s.name, s.lat, s.lng, s.perDay, s.mins ?? ""].map(csvCell).join(",")));
      res.type("text/csv").send(["route,operator,mode,stop_code,stop_name,latitude,longitude,trips_per_weekday,minutes_to_campus", ...lines].join("\n") + "\n");
      return;
    }
    if (req.query.format === "geojson") {
      const features = routes.flatMap((r) =>
        r.stops.map((s) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lng, s.lat] },
          properties: { route: r.label, operator: r.operator, mode: r.mode, stop: s.name, code: s.code, tripsPerWeekday: s.perDay, minutesToCampus: s.mins },
        })),
      );
      res.json({ type: "FeatureCollection", features });
      return;
    }
    res.json({ ...result, routes, attribution: transit.meta.attribution });
  });

  // Mark a listing "seen", "rejected" (doesn't fit the requirements) or "unavailable" (no longer on offer); null clears the mark.
  api.put("/review", (req, res) => {
    const { id, status } = req.body ?? {};
    if (typeof id !== "string" || !(status === null || REVIEW_STATUSES.has(status))) {
      return res.status(400).json({ error: "id and status (seen, rejected, unavailable or null) are required" });
    }
    const match = store.data.matches.find((m) => memberIds(m).includes(id));
    if (!match) return res.status(404).json({ error: "that listing is no longer in your matches" });
    const at = new Date().toISOString();
    for (const memberId of memberIds(match)) {
      if (status === null) delete store.data.reviews[memberId];
      else store.data.reviews[memberId] = { status, at };
    }
    store.save();
    res.json({ id: match.id, review: status });
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
