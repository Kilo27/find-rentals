import crypto from "node:crypto";
import { ADMIN_OWNER } from "./push.js";
import { MAX_PASSWORD, UserError, normalizeUsername } from "./users.js";

const COOKIE = "fr_session";
const VIEW_COOKIE = "fr_viewas";
const ONE_YEAR_S = 365 * 24 * 3600;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const decode = (v) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

// Sessions are signed cookies naming the user. The signature covers a per-user key that changes with the
// password, so a password change or reset ends that user's sessions, and removing a user ends them at once.
// The admin's key comes from ACCESS_PASSWORD, so changing that variable signs the admin out everywhere.
export function createAuth({ users, adminUsername, password, secret }) {
  const key = secret || sha(`find-rentals:${password}`);
  const adminSessionKey = sha(password).toString("hex");
  const sign = (username, sessionKey) => crypto.createHmac("sha256", key).update(`session-v2:${username}:${sessionKey}`).digest("hex");

  const adminIdentity = { username: adminUsername, isAdmin: true, owner: ADMIN_OWNER };
  const userIdentity = (u) => ({ username: u.username, isAdmin: false, owner: u.username });
  const sessionKeyOf = (identity) => (identity.isAdmin ? adminSessionKey : users.find(identity.username).sessionKey);

  const parseCookies = (header = "") =>
    Object.fromEntries(
      header
        .split(";")
        .map((p) => p.trim().split("="))
        .filter(([k]) => k)
        .map(([k, ...v]) => [k, decode(v.join("="))]),
    );

  const identityFor = (username) => {
    if (username === adminUsername) return adminIdentity;
    const u = users.find(username);
    return u ? userIdentity(u) : null;
  };

  const readSession = (value) => {
    if (typeof value !== "string") return null;
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const identity = identityFor(value.slice(0, dot));
    if (!identity) return null;
    return safeEqual(value.slice(dot + 1), sign(identity.username, sessionKeyOf(identity))) ? identity : null;
  };

  // `real` is who is signed in. `effective` is who the app is being used as: the same, unless the admin is
  // viewing the app as another user.
  const identify = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const real = readSession(cookies[COOKIE]);
    if (!real) return null;
    let effective = real;
    if (real.isAdmin && cookies[VIEW_COOKIE]) {
      const target = users.find(cookies[VIEW_COOKIE]);
      if (target) effective = userIdentity(target);
    }
    return { real, effective, viewing: effective !== real };
  };

  const cookieOpts = (req, maxAge) => ({ httpOnly: true, secure: req.secure, sameSite: "lax", maxAge, path: "/" });
  const startSession = (req, res, identity) =>
    res.cookie(COOKIE, `${identity.username}.${sign(identity.username, sessionKeyOf(identity))}`, cookieOpts(req, ONE_YEAR_S * 1000));

  // Only failed attempts count, so people sharing a connection can log in as often as they like.
  const failures = new Map();
  const blocked = (ip) => {
    const f = failures.get(ip);
    return Boolean(f && f.resetAt > Date.now() && f.count >= MAX_FAILURES);
  };
  const recordFailure = (ip) => {
    const now = Date.now();
    if (failures.size > 500) for (const [k, v] of failures) if (v.resetAt < now) failures.delete(k);
    const f = failures.get(ip);
    if (!f || f.resetAt < now) failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    else f.count++;
  };

  const passwordOk = async (identity, given) =>
    typeof given === "string" && given.length <= MAX_PASSWORD && (identity.isAdmin ? safeEqual(given, password) : Boolean(await users.verify(identity.username, given)));

  return {
    identify,

    requireAuth(req, res, next) {
      const auth = identify(req);
      if (!auth) return res.status(401).json({ error: "unauthorized" });
      req.auth = auth;
      if (!auth.viewing && !auth.effective.isAdmin) users.touch(users.find(auth.effective.username));
      next();
    },
    // These check who the app is being used as, so an admin viewing as someone else sees what they would.
    requireAdmin(req, res, next) {
      if (req.auth.effective.isAdmin) return next();
      res.status(403).json({ error: "admin only" });
    },
    requireRealAdmin(req, res, next) {
      if (req.auth.real.isAdmin) return next();
      res.status(403).json({ error: "admin only" });
    },
    // Devices and passwords belong to the person signed in, never to whoever is being viewed.
    blockWhileViewing(req, res, next) {
      if (!req.auth.viewing) return next();
      res.status(403).json({ error: `You're viewing as ${req.auth.effective.username}. Exit that view first.` });
    },

    async login(req, res) {
      if (blocked(req.ip)) return res.status(429).json({ error: "too many attempts, try again later" });
      const username = normalizeUsername(req.body?.username);
      const identity = identityFor(username);
      const given = req.body?.password;
      let ok = false;
      if (identity) ok = await passwordOk(identity, given);
      // Unknown names go through the same hashing as real ones so timing doesn't reveal which exist.
      else await users.verify("", typeof given === "string" ? given.slice(0, MAX_PASSWORD) : "");
      if (!ok) {
        recordFailure(req.ip);
        return res.status(401).json({ error: "wrong username or password" });
      }
      if (!identity.isAdmin) users.recordLogin(users.find(identity.username));
      startSession(req, res, identity);
      res.clearCookie(VIEW_COOKIE, { path: "/" });
      res.json({ ok: true });
    },

    logout(_req, res) {
      res.clearCookie(COOKIE, { path: "/" });
      res.clearCookie(VIEW_COOKIE, { path: "/" });
      res.json({ ok: true });
    },

    viewAs(req, res) {
      const target = users.find(normalizeUsername(req.body?.username));
      if (!target) return res.status(404).json({ error: "No such user" });
      res.cookie(VIEW_COOKIE, target.username, cookieOpts(req, 12 * 3600 * 1000));
      res.json({ ok: true });
    },

    stopViewing(_req, res) {
      res.clearCookie(VIEW_COOKIE, { path: "/" });
      res.json({ ok: true });
    },

    async changePassword(req, res) {
      const { effective } = req.auth;
      if (effective.isAdmin) throw new UserError("The admin password is the ACCESS_PASSWORD variable on the server");
      if (blocked(req.ip)) return res.status(429).json({ error: "too many attempts, try again later" });
      const user = users.find(effective.username);
      if (!(await passwordOk(effective, req.body?.current))) {
        recordFailure(req.ip);
        return res.status(400).json({ error: "Current password is wrong" });
      }
      await users.setPassword(user.username, req.body?.next);
      startSession(req, res, effective);
      res.json({ ok: true });
    },
  };
}
