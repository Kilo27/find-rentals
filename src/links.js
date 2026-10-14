import crypto from "node:crypto";

// Sign-in links: a link that signs someone in on whatever device opens it, so a person the admin adds never has to type a
// username or a password. The admin sends one to each new person, and an iPhone gets one of its own for the Home Screen
// app, which keeps its own cookies apart from Safari's and so has to be signed in again.
//
// Only a hash of each link's secret is kept. A link names the account and the session key it was made under, so it stops
// working when that account's sessions are ended (a password reset, the account being removed, a new ACCESS_PASSWORD for
// the admin), as well as when it expires or is replaced.
export const INVITE_TTL_MS = 14 * 24 * 3600_000;
// A device's own link is what its Home Screen app opens at every time, so it lasts as long as a session does: if iOS ever
// loses the app's cookie, the app signs itself in again. It is never shown or sent; it lives in the app's manifest.
export const DEVICE_TTL_MS = 365 * 24 * 3600_000;
const MAX_PER_ACCOUNT = 10;

export const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
export const isLinkToken = (v) => typeof v === "string" && TOKEN_RE.test(v);

// The secret is 24 random bytes, so a plain hash is enough to store it by (there is nothing to guess).
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function createLinks({ store, now = () => new Date() }) {
  const all = () => (store.data.signInLinks ??= []);
  const live = (l) => Date.parse(l.expiresAt) > now().getTime();

  return {
    // A new link for `username`. `replace` drops that account's other links of the same purpose, so a fresh invite
    // retires the last one sent.
    issue(username, sessionKey, { ttlMs = INVITE_TTL_MS, purpose = "invite", replace = false } = {}) {
      const token = crypto.randomBytes(24).toString("base64url");
      const mine = all().filter((l) => l.username === username && live(l) && !(replace && l.purpose === purpose));
      const others = all().filter((l) => l.username !== username && live(l));
      const link = { username, purpose, hash: sha(token), key: sha(sessionKey), createdAt: now().toISOString(), expiresAt: new Date(now().getTime() + ttlMs).toISOString() };
      store.data.signInLinks = [...others, ...mine.slice(-(MAX_PER_ACCOUNT - 1)), link];
      store.save();
      return { token, expiresAt: link.expiresAt };
    },

    // The account a token signs in to, or null if it isn't a link, has expired or been replaced, or the account's sessions
    // have been ended since it was made. `keyOf(username)` is the account's current session key (null if it is gone).
    redeem(token, keyOf) {
      if (!isLinkToken(token)) return null;
      const hash = sha(token);
      const link = all().find((l) => l.hash === hash);
      if (!link || !live(link)) return null;
      const key = keyOf(link.username);
      return key && sha(key) === link.key ? link.username : null;
    },

    forget(username) {
      const before = all().length;
      store.data.signInLinks = all().filter((l) => l.username !== username);
      if (store.data.signInLinks.length !== before) store.save();
    },
  };
}
