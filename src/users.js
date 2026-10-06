import crypto from "node:crypto";
import { promisify } from "node:util";
import { newSearch } from "./searches.js";

const scrypt = promisify(crypto.scrypt);
const KEY_BYTES = 32;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "UserError";
    this.status = status;
  }
}

export const normalizeUsername = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
export const isValidUsername = (v) => USERNAME_RE.test(v);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_BYTES);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function checkPassword(password, stored) {
  const [kind, salt, key] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), want.length);
  return crypto.timingSafeEqual(got, want);
}

function checkNewPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new UserError(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > MAX_PASSWORD) throw new UserError(`Password must be at most ${MAX_PASSWORD} characters`);
}

// Accounts other than the admin. The admin is not stored here: its name and password come from the server's
// environment, so it can't be created, changed or removed through the app.
export function createUsers({ store, adminUsername, now = () => new Date() }) {
  const all = () => store.data.users;
  const find = (username) => all().find((u) => u.username === normalizeUsername(username)) ?? null;
  const dummyHash = hashPassword(crypto.randomBytes(8).toString("hex"));

  return {
    list: () => all(),
    find,

    async create(rawUsername, password) {
      const username = normalizeUsername(rawUsername);
      if (!isValidUsername(username)) {
        throw new UserError("Username must be 2-32 characters: lowercase letters, numbers, dot, dash or underscore");
      }
      checkNewPassword(password);
      if (username === adminUsername || find(username)) throw new UserError("That username is taken", 409);
      const passwordHash = await hashPassword(password);
      if (find(username)) throw new UserError("That username is taken", 409);
      const user = {
        username,
        passwordHash,
        sessionKey: crypto.randomBytes(24).toString("hex"),
        createdAt: now().toISOString(),
        lastLoginAt: null,
        lastSeenAt: null,
      };
      all().push(user);
      // A new account starts with a search of its own that has no campus yet, so it is not watched until the person chooses one.
      store.data.searches[username] = newSearch();
      store.save();
      return user;
    },

    // A new password also ends every session the user has open.
    async setPassword(username, password) {
      checkNewPassword(password);
      const user = find(username);
      if (!user) throw new UserError("No such user", 404);
      user.passwordHash = await hashPassword(password);
      user.sessionKey = crypto.randomBytes(24).toString("hex");
      store.save();
      return user;
    },

    remove(username) {
      const user = find(username);
      if (!user) throw new UserError("No such user", 404);
      store.data.users = all().filter((u) => u !== user);
      // Their search goes with them, so a new account with the same name starts clean.
      delete store.data.searches[user.username];
      store.save();
    },

    // Returns the user, or null. An unknown name still costs one hash so the response time doesn't reveal it.
    async verify(username, password) {
      const user = find(username);
      const ok = await checkPassword(password, user ? user.passwordHash : await dummyHash);
      return user && ok ? user : null;
    },

    recordLogin(user) {
      user.lastLoginAt = user.lastSeenAt = now().toISOString();
      store.save();
    },

    // Kept in memory and written out with the next save, so polling doesn't rewrite the state file.
    touch(user) {
      user.lastSeenAt = now().toISOString();
    },
  };
}
