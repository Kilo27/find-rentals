import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import express from "express";
import { ConfigError, SECTIONS, SOURCES, normalizePrefs, normalizeRegion } from "./config.js";
import { createAuth } from "./auth.js";
import { DEVICE_TTL_MS, isLinkToken } from "./links.js";
import { areasForMatches } from "./mapdata.js";
import { createUsers, UserError, normalizeUsername } from "./users.js";
import { CAMPUSES } from "./transit/campuses.js";
import { searchCampus, searchCampuses } from "./catalogue.js";
import { regionName, regionStatus } from "./regions.js";
import { campusOf, chooseCampus, configOf, searchOf, updatePrefs, watchers } from "./searches.js";
import { defaultTransit } from "./transit.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const requireHere = createRequire(import.meta.url);
// The map library, the QR code maker and the typeface are served from the installed packages, so the page needs no
// third-party host.
const leafletDir = path.join(path.dirname(requireHere.resolve("leaflet/package.json")), "dist");
const qrcodeDir = path.dirname(requireHere.resolve("qrcode-generator"));
const archivoDir = path.join(path.dirname(requireHere.resolve("@fontsource-variable/archivo/package.json")), "files");

const publicDevice = (s) => ({ endpoint: s.endpoint.slice(-12), userAgent: s.userAgent, addedAt: s.addedAt, lastError: s.lastError });

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

export function createApp({ store, scanner, pusher, scheduler, agentHub = null, mapData = null, transit = defaultTransit(), adminUsername = "admin", password, secret }) {
  const app = express();
  const admin = normalizeUsername(adminUsername);
  const users = createUsers({ store, adminUsername: admin });
  const auth = createAuth({ users, store, adminUsername: admin, password, secret });
  if (users.find(admin)) console.warn(`A user named "${admin}" exists but ADMIN_USERNAME is the same name, so only the admin can sign in as it.`);

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
  app.use("/vendor/leaflet", express.static(leafletDir, { maxAge: "7d", index: false }));
  app.use("/vendor/qrcode", express.static(qrcodeDir, { maxAge: "7d", index: false }));
  app.use("/vendor/archivo", express.static(archivoDir, { maxAge: "30d", index: false }));

  // A sign-in link is the app's address with ?join=<token>. An iPhone's Home Screen app keeps its own cookies apart from
  // Safari's, so the page opened from such a link names a manifest whose start address carries the same token: the app
  // added to the Home Screen from that page then opens already signed in, with nothing to type. The token is only ever
  // copied into the page when it has the shape of one.
  const joinToken = (req) => (isLinkToken(req.query.join) ? req.query.join : null);
  app.get(["/", "/index.html"], async (req, res) => {
    const token = joinToken(req);
    let html = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    if (token) html = html.replace('href="/manifest.webmanifest"', `href="/manifest.webmanifest?join=${token}"`);
    res.set("Cache-Control", "no-cache");
    res.type("html").send(html);
  });
  app.get("/manifest.webmanifest", async (req, res) => {
    const manifest = JSON.parse(await fs.readFile(path.join(publicDir, "manifest.webmanifest"), "utf8"));
    const token = joinToken(req);
    if (token) manifest.start_url = `/?join=${token}`;
    res.set("Cache-Control", token ? "no-store" : "no-cache");
    res.type("application/manifest+json").send(JSON.stringify(manifest));
  });
  // The app's own code has no build step and no versioned file names, so a browser has to check with the server before
  // reusing a copy: otherwise a deploy goes unseen until the old file's hour is up (and a new app.js can meet an old
  // module it imports). A check that finds nothing new costs a small 304. Images and the manifest may be kept an hour.
  app.use(
    express.static(publicDir, {
      maxAge: "1h",
      index: "index.html",
      setHeaders: (res, file) => {
        if (/\.(?:html|js|css)$/.test(file)) res.set("Cache-Control", "no-cache");
      },
    }),
  );

  app.post("/api/login", auth.login);
  app.post("/api/join", auth.join);
  app.post("/api/logout", auth.logout);

  // The laptop agent authenticates with its own token, not the app password.
  if (agentHub) {
    app.get("/api/agent/next", agentHub.next);
    app.post("/api/agent/result", express.raw({ type: "application/octet-stream", limit: "4mb" }), agentHub.result);
  }

  const api = express.Router();
  api.use(auth.requireAuth);

  // Everything here is the signed-in account's own: its campus and preferences, its matches and verdicts, and the status of
  // its region. Nothing in it comes from another account.
  const mine = (req) => searchOf(store, req.auth.effective.owner);
  const describeCampus = (c) =>
    c && { id: c.id, name: c.name, short: c.short, regionId: c.regionId, regionName: regionName(store, c.regionId), maxRadiusKm: c.maxRadiusKm, defaultRadiusKm: c.defaultRadiusKm };

  // The admin's view of the regions: their settings, how the last look went and who is watching.
  const describeRegions = () =>
    Object.entries(store.data.regions).map(([id, settings]) => {
      const status = regionStatus(store, id);
      const campuses = searchCampuses().filter((c) => c.regionId === id);
      return {
        id,
        settings,
        campuses: campuses.map((c) => ({ id: c.id, short: c.short, name: c.name, watching: watchers(store, id).filter(({ search }) => search.campus === c.id).length })),
        watching: watchers(store, id).length,
        failureCount: status.failureCount,
        lastRun: status.lastRun,
        sourceHealth: status.sourceHealth,
        nextRunAt: scheduler.nextRunAt(id),
      };
    });

  api.get("/state", (req, res) => {
    const { effective, real, viewing } = req.auth;
    const search = mine(req);
    const campus = campusOf(search);
    const status = campus ? regionStatus(store, campus.regionId) : null;
    const account = effective.isAdmin ? null : users.find(effective.username);
    res.json({
      // `name` is what to call them; `hasPassword` is false for someone who has only ever signed in with a link.
      user: { username: effective.username, isAdmin: effective.isAdmin, name: account?.name ?? null, hasPassword: effective.isAdmin || users.hasPassword(account) },
      viewingAs: viewing ? { username: effective.username, by: real.username } : null,
      campus: describeCampus(campus),
      // The campuses that can be chosen. Choosing one is what puts the account in a region.
      searchCampuses: searchCampuses().map((c) => ({ ...describeCampus(c), region: CAMPUSES.find((x) => x.id === c.id)?.region })),
      prefs: search.prefs,
      // The complete search (preferences, campus and region together), or null until a campus has been chosen.
      config: configOf(store, search),
      sections: SECTIONS,
      sources: SOURCES,
      campuses: CAMPUSES.map(({ id, name, short, region }) => ({ id, name, short, region })),
      transit: transit ? transit.meta : null,
      sourceHealth: status?.sourceHealth ?? {},
      matches: search.matches.map(({ memberIds: _ids, ...m }) => ({ ...m, review: reviewFor(search.reviews, m)?.status ?? null })),
      areas: areasForMatches(search.matches, store.data.geocache),
      lastRun: search.lastRun,
      failureCount: status?.failureCount ?? 0,
      scanning: scanner.isRunning(),
      nextRunAt: scheduler.nextRunAt(campus?.regionId),
      subscriptions: pusher.subscriptionsOf(effective.owner).map(publicDevice),
      // When this account last opened the app from a Home Screen, or null.
      homeScreenAt: store.data.homeScreens?.[effective.owner] ?? null,
      vapidPublicKey: pusher.publicKey,
      serverTime: new Date().toISOString(),
      // Only the admin, and only as themselves, sees how the regions are set up.
      regions: real.isAdmin && !viewing ? describeRegions() : null,
    });
  });

  // The campus outline and the bus and rail lines. They come from OpenStreetMap in the background, so this answers at
  // once with what it has and a status; the page asks again while the lines are still loading.
  const noMap = { center: null, radiusKm: null, campus: null, transit: null, transitStatus: "error", transitError: "Choose a campus to see the map" };
  api.get("/map", (req, res) => {
    res.set("Cache-Control", "no-store");
    const config = configOf(store, mine(req));
    if (!config) return res.json(noMap);
    res.json(mapData ? mapData.get(config) : { center: config.center, radiusKm: config.radiusKm, campus: null, transit: null, transitStatus: "error", transitError: "Map data is not enabled" });
  });

  api.post("/map/refresh", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!mapData) return res.status(404).json({ error: "Map data is not enabled" });
    const config = configOf(store, mine(req));
    res.json(config ? mapData.get(config, { retry: true }) : noMap);
  });

  // An account's search changed. It is matched again at once against what its region last collected, without asking any
  // site anything (#13). If nothing has been collected there yet, a collect is brought forward instead.
  async function rematch(req) {
    const { owner } = req.auth.effective;
    const campus = campusOf(mine(req));
    const matched = campus ? Boolean(await scanner.match?.(owner)) : false;
    if (campus && !matched) scheduler.runSoon?.(campus.regionId);
    return matched;
  }

  // Preferences belong to the person signed in, never to whoever is being viewed.
  api.put("/prefs", auth.blockWhileViewing, async (req, res) => {
    const search = mine(req);
    updatePrefs(search, req.body ?? {});
    store.save();
    const matched = await rematch(req);
    res.json({ prefs: search.prefs, config: configOf(store, search), matched });
  });

  // Choosing a campus puts the account in that campus's region and starts watching there afresh.
  api.put("/campus", auth.blockWhileViewing, async (req, res) => {
    const { campus, moved } = chooseCampus(mine(req), req.body?.campus);
    store.save();
    const matched = await rematch(req);
    res.json({ campus: describeCampus(campus), moved, matched, config: configOf(store, mine(req)) });
  });

  // The guided first-run setup: a campus and the answers to a few questions, saved together and matched once. Doing it in
  // one go matters: matching with the default preferences first would finish watching's first look with those, and then
  // whatever the person's own answers let in on top would alert as new.
  api.post("/setup", auth.blockWhileViewing, async (req, res) => {
    const search = mine(req);
    const campus = typeof req.body?.campus === "string" ? searchCampus(req.body.campus) : null;
    if (!campus) throw new UserError("Choose one of the campuses on the list");
    try {
      normalizePrefs({ ...search.prefs, ...(req.body?.prefs ?? {}) }, { maxRadiusKm: campus.maxRadiusKm });
    } catch (err) {
      if (err instanceof ConfigError) throw new UserError(err.errors.join("; "));
      throw err;
    }
    const { moved } = chooseCampus(search, campus.id);
    updatePrefs(search, req.body?.prefs ?? {});
    store.save();
    const matched = await rematch(req);
    res.json({ campus: describeCampus(campus), moved, matched, matches: search.matches.length });
  });

  // A sign-in link for the device asking, so that an iPhone's Home Screen app (which doesn't share Safari's cookies) opens
  // signed in. The page puts it in the manifest the app is added from, never in the address bar, so sharing the page
  // doesn't share it.
  api.post("/account/link", auth.blockWhileViewing, (req, res) => {
    res.json(auth.issueLink(req.auth.effective.username, { ttlMs: DEVICE_TTL_MS, purpose: "device" }));
  });

  // The app was opened from a Home Screen. The page in Safari that walked someone through adding it watches for this, so it
  // can tell them it worked and that they can carry on in the app; the admin sees it under Users.
  api.post("/account/home-screen", auth.blockWhileViewing, (req, res) => {
    (store.data.homeScreens ??= {})[req.auth.effective.owner] = new Date().toISOString();
    store.save();
    res.json({ ok: true });
  });

  // Where a region looks and how, which only the admin changes: a page that is wrong for one account is wrong for
  // everyone in the region, and these are the addresses the server reads on everyone's behalf.
  api.put("/regions/:id", auth.requireAdmin, (req, res) => {
    const current = store.data.regions[req.params.id];
    if (!current) return res.status(404).json({ error: "No such region" });
    try {
      store.data.regions[req.params.id] = normalizeRegion({ ...current, ...req.body });
    } catch (err) {
      if (err instanceof ConfigError) return res.status(400).json({ errors: err.errors });
      throw err;
    }
    store.save();
    scheduler.reschedule?.(req.params.id);
    res.json({ region: store.data.regions[req.params.id] });
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
  // Marks are the account's own: what one person puts away is still in front of everyone else.
  api.put("/review", auth.blockWhileViewing, (req, res) => {
    const { id, status } = req.body ?? {};
    if (typeof id !== "string" || !(status === null || REVIEW_STATUSES.has(status))) {
      return res.status(400).json({ error: "id and status (seen, rejected, unavailable or null) are required" });
    }
    const search = mine(req);
    const match = search.matches.find((m) => memberIds(m).includes(id));
    if (!match) return res.status(404).json({ error: "that listing is no longer in your matches" });
    const at = new Date().toISOString();
    for (const memberId of memberIds(match)) {
      if (status === null) delete search.reviews[memberId];
      else search.reviews[memberId] = { status, at };
    }
    store.save();
    res.json({ id: match.id, review: status });
  });

  // A device belongs to whoever signed in on it last. Notifications for shared alerts go to every account's devices.
  api.post("/subscribe", auth.blockWhileViewing, (req, res) => {
    const { owner } = req.auth.effective;
    try {
      pusher.addSubscription(req.body, req.get("user-agent"), owner);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json({ ok: true, count: pusher.count(owner) });
  });

  api.post("/unsubscribe", auth.blockWhileViewing, (req, res) => {
    const { owner } = req.auth.effective;
    if (typeof req.body?.endpoint === "string") pusher.removeSubscription(req.body.endpoint, owner);
    res.json({ ok: true, count: pusher.count(owner) });
  });

  api.post("/test-push", auth.blockWhileViewing, async (req, res) => {
    const result = await pusher.sendToOwner(req.auth.effective.owner, {
      title: "Test notification",
      body: "Push alerts are working on this device.",
      url: "/",
      tag: "test",
    });
    res.json(result);
  });

  // Starting a scan is the admin's: it asks other people's sites for pages, and anyone being able to do that on demand
  // could overload them. Scans run on their own timers; an account changing its campus or preferences is matched at once.
  api.post("/scan", auth.requireAdmin, async (req, res) => {
    const run = await scanner.run();
    res.json({ lastRun: mine(req).lastRun ?? run, regions: run.regions });
  });

  api.get("/debug", auth.requireAdmin, (req, res) => res.json({ debug: store.data.debug, seenCount: Object.keys(mine(req).seen).length }));

  api.post("/account/password", auth.blockWhileViewing, auth.changePassword);

  // Only the admin can create, change or remove accounts, or view the app as one. The admin account itself
  // comes from ACCESS_PASSWORD and ADMIN_USERNAME and is not stored.
  const describeUser = (u) => {
    const search = store.data.searches[u.username];
    const campus = search ? campusOf(search) : null;
    return {
      username: u.username,
      name: u.name ?? null,
      hasPassword: users.hasPassword(u),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      lastSeenAt: u.lastSeenAt,
      devices: pusher.subscriptionsOf(u.username).map(publicDevice),
      homeScreenAt: store.data.homeScreens?.[u.username] ?? null,
      // Where they are watching and what they have, for working out why someone isn't getting alerts.
      campus: describeCampus(campus),
      matches: search?.matches.length ?? 0,
      lastCheckAt: search?.lastRun?.at ?? null,
    };
  };

  api.get("/users", auth.requireAdmin, (_req, res) => res.json({ users: users.list().map(describeUser) }));

  // Adding someone takes only a name: the username is made from it, a password is optional, and what comes back is a
  // sign-in link to send them. The page builds the full address from its own origin.
  api.post("/users", auth.requireAdmin, async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name && !req.body?.username) throw new UserError("Type the person's name");
    const username = req.body?.username ? req.body.username : users.suggestUsername(name);
    const user = await users.create(username, req.body?.password ?? null, { name: name || null });
    const link = auth.issueLink(user.username, { replace: true });
    res.status(201).json({ user: describeUser(user), link });
  });

  // A fresh sign-in link for someone, replacing the last one sent. Nobody is signed out.
  api.post("/users/:username/link", auth.requireAdmin, (req, res) => {
    const user = users.find(req.params.username);
    if (!user) throw new UserError("No such user", 404);
    res.json({ link: auth.issueLink(user.username, { replace: true }) });
  });

  api.put("/users/:username/password", auth.requireAdmin, async (req, res) => {
    await users.setPassword(req.params.username, req.body?.password);
    res.json({ ok: true });
  });

  api.delete("/users/:username", auth.requireAdmin, (req, res) => {
    const user = users.find(req.params.username);
    users.remove(req.params.username);
    pusher.removeOwner(user.username);
    auth.forgetLinks(user.username);
    if (store.data.homeScreens) delete store.data.homeScreens[user.username];
    res.json({ ok: true });
  });

  api.post("/users/:username/test-push", auth.requireAdmin, async (req, res) => {
    const user = users.find(req.params.username);
    if (!user) throw new UserError("No such user", 404);
    res.json(await pusher.sendToOwner(user.username, { title: "Test notification", body: "Sent by the admin to check this device.", url: "/", tag: "test" }));
  });

  api.post("/view-as", auth.requireRealAdmin, auth.viewAs);
  api.delete("/view-as", auth.requireRealAdmin, auth.stopViewing);

  app.use("/api", api);
  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
