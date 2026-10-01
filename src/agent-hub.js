import crypto from "node:crypto";
import zlib from "node:zlib";

export const MIN_TOKEN_LENGTH = 32;
const MAX_RESULT_BYTES = 8_000_000;
// Request headers worth passing to the laptop; everything else stays on the server.
const FORWARD_HEADERS = new Set(["user-agent", "accept", "accept-language"]);
const NULL_BODY = new Set([204, 205, 304]);

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

export class AgentOfflineError extends Error {
  constructor() {
    super("laptop agent offline");
    this.name = "AgentOfflineError";
  }
}

export function pickHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of new Headers(headers)) if (FORWARD_HEADERS.has(k)) out[k] = v;
  return out;
}

function toResponse(r) {
  const status = Number(r.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error(`laptop agent: bad status ${r.status}`);
  const res = new Response(NULL_BODY.has(status) ? null : String(r.body ?? ""), {
    status,
    headers: r.contentType ? { "content-type": String(r.contentType) } : {},
  });
  if (typeof r.url === "string") Object.defineProperty(res, "url", { value: r.url });
  return res;
}

// The laptop agent connects out to this server and asks for work (long polling), so it needs no open
// port or tunnel. hub.fetch hands one request to the agent and resolves with its answer as a Response,
// which makes it a drop-in for the proxy fetch the scanner already supports.
export function createAgentHub({
  token,
  now = () => Date.now(),
  pollWaitMs = 25_000,
  onlineWindowMs = 60_000,
  jobTimeoutMs = 45_000,
  onOnline = () => {},
}) {
  if (!token || token.length < MIN_TOKEN_LENGTH) throw new Error(`the agent token must be at least ${MIN_TOKEN_LENGTH} characters`);
  const expected = `Bearer ${token}`;
  const queue = [];
  const pending = new Map();
  let waiter = null;
  let lastSeen = 0;

  const online = () => waiter !== null || (lastSeen > 0 && now() - lastSeen < onlineWindowMs);
  const authed = (req) => safeEqual(req.get("authorization") ?? "", expected);

  function seen() {
    const wasOnline = online();
    lastSeen = now();
    if (!wasOnline) onOnline();
  }

  function dispatch(job) {
    if (!waiter) return void queue.push(job);
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    w.res.json(job);
  }

  function fetch(url, opts = {}) {
    if (!online()) return Promise.reject(new AgentOfflineError());
    const { signal } = opts;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const settle = (fn) => (value) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const queued = queue.findIndex((j) => j.id === id);
        if (queued >= 0) queue.splice(queued, 1);
        fn(value);
      };
      const ok = settle(resolve);
      const fail = settle(reject);
      const onAbort = () => fail(signal.reason);
      const timer = setTimeout(() => fail(new Error("laptop agent did not answer in time")), jobTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, { ok, fail });
      dispatch({ id, url: String(url), headers: pickHeaders(opts.headers) });
    });
  }

  // GET: hands the agent the next request, or holds the poll open until one arrives.
  function next(req, res) {
    if (!authed(req)) return void res.status(401).json({ error: "unauthorized" });
    seen();
    if (queue.length) return void res.json(queue.shift());
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.res.status(204).end();
    }
    const w = {
      res,
      timer: setTimeout(() => {
        if (waiter === w) waiter = null;
        res.status(204).end();
      }, pollWaitMs),
    };
    waiter = w;
    res.on("close", () => {
      lastSeen = now();
      if (waiter !== w) return;
      clearTimeout(w.timer);
      waiter = null;
    });
  }

  // POST: the agent's answer, gzipped JSON. A late answer for a request that already gave up is dropped.
  function result(req, res) {
    if (!authed(req)) return void res.status(401).json({ error: "unauthorized" });
    seen();
    let r;
    try {
      r = JSON.parse(zlib.gunzipSync(req.body, { maxOutputLength: MAX_RESULT_BYTES }).toString("utf8"));
    } catch {
      return void res.status(400).json({ error: "bad result" });
    }
    res.status(204).end();
    const p = pending.get(r?.id);
    if (!p) return;
    if (r.error) return void p.fail(new Error(`laptop agent: ${String(r.error).slice(0, 200)}`));
    try {
      p.ok(toResponse(r));
    } catch (err) {
      p.fail(err);
    }
  }

  return { fetch, online, next, result };
}
