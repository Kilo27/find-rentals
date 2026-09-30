import crypto from "node:crypto";

const COOKIE = "fr_session";
const ONE_YEAR_S = 365 * 24 * 3600;

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

export function createAuth({ password, secret }) {
  const token = crypto.createHmac("sha256", secret || sha(`find-rentals:${password}`)).update("session-v1").digest("hex");

  const parseCookies = (header = "") =>
    Object.fromEntries(
      header
        .split(";")
        .map((p) => p.trim().split("="))
        .filter(([k]) => k)
        .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]),
    );

  const isAuthed = (req) => {
    const c = parseCookies(req.headers.cookie)[COOKIE];
    return typeof c === "string" && safeEqual(c, token);
  };

  const attempts = new Map();
  const rateLimited = (ip) => {
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || a.resetAt < now) {
      attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
      return false;
    }
    a.count++;
    return a.count > 10;
  };

  return {
    isAuthed,
    requireAuth(req, res, next) {
      if (isAuthed(req)) return next();
      res.status(401).json({ error: "unauthorized" });
    },
    login(req, res) {
      if (rateLimited(req.ip)) return res.status(429).json({ error: "too many attempts, try again later" });
      const given = typeof req.body?.password === "string" ? req.body.password : "";
      if (!safeEqual(given, password)) return res.status(401).json({ error: "wrong password" });
      res.cookie(COOKIE, token, {
        httpOnly: true,
        secure: req.secure,
        sameSite: "lax",
        maxAge: ONE_YEAR_S * 1000,
        path: "/",
      });
      res.json({ ok: true });
    },
    logout(_req, res) {
      res.clearCookie(COOKIE, { path: "/" });
      res.json({ ok: true });
    },
  };
}
