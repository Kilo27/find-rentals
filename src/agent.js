import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import { Agent, fetch as undiciFetch } from "undici";

// Runs on a home computer (npm run agent). It asks the server for page requests and fetches them from
// this connection, but only https GETs to allow-listed sites, never to private addresses, so even a
// compromised server can't use it as an open proxy or reach the home network.

export const DEFAULT_ALLOW = ["daft.ie", "rent.ie"];
const MAX_BYTES = 3_000_000;
const FETCH_TIMEOUT_MS = 15_000; // answers before the server's own 20 s limit per request
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SAFE_HEADERS = new Set(["user-agent", "accept", "accept-language"]);

export function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v = addr.toLowerCase();
  if (v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

// net.connect may ask for one address or (Happy Eyeballs) all of them; refuse if any is private.
export const guardedLookup = (allowPrivate, lookup = dns.lookup) => (hostname, opts, cb) =>
  lookup(hostname, opts, (err, address, family) => {
    if (err) return cb(err);
    const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (!allowPrivate && addresses.some(isPrivateAddress)) return cb(new Error("private address refused"));
    cb(null, address, family);
  });

export const parseAllow = (s) =>
  String(s ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

export function checkTarget(url, allow) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${String(url).slice(0, 80)}`);
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password) {
    throw new Error(`not allowed: ${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`);
  }
  if (!allow.some((s) => host === s || host.endsWith(`.${s}`))) throw new Error(`not allowed: ${host}`);
  return u;
}

// Reads at most maxBytes, like the server's own fetcher, and stops downloading after that.
async function readCapped(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

export function createJobFetcher({ allow = DEFAULT_ALLOW, fetchImpl, allowPrivate = false, maxBytes = MAX_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const dispatcher = fetchImpl ? null : new Agent({ connect: { lookup: guardedLookup(allowPrivate) } });
  const doFetch = fetchImpl ?? ((url, opts) => undiciFetch(url, { ...opts, dispatcher }));

  return async function fetchJob(job) {
    const headers = {};
    for (const [k, v] of Object.entries(job.headers ?? {})) if (SAFE_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
    let url = checkTarget(job.url, allow).href;
    const signal = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url, { headers, redirect: "manual", signal });
      const location = res.headers.get("location");
      if (REDIRECTS.has(res.status) && location) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
        url = checkTarget(new URL(location, url).href, allow).href; // every hop must be allowed too
        continue;
      }
      return { status: res.status, url, contentType: res.headers.get("content-type") ?? "", body: await readCapped(res, maxBytes) };
    }
  };
}

const where = (url) => {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return String(url).slice(0, 80);
  }
};

const whenAborted = (signal) => new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true })));

// Long-polls the server for requests and posts each answer back gzipped. Never exits on its own:
// network trouble (the laptop sleeping, Wi-Fi changes, a redeploy) is retried with backoff.
//
// A sleeping laptop freezes this process, and on waking the poll in flight is dead but only noticed when its own timeout
// runs out, with any backoff still counting. The clock jumping further than a tick can explain means it slept (or was
// frozen): the poll and any backoff wait are dropped and the agent reconnects at once, from a fresh backoff.
export async function runAgent({
  server,
  token,
  fetchJob,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
  signal,
  pollTimeoutMs = 40_000,
  now = () => Date.now(),
  tickMs = 5_000,
  wakeGapMs = 20_000,
}) {
  const base = server.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${token}` };
  let backoff = 1_000;
  let connected = false;
  let wake = new AbortController(); // aborted when the computer wakes; a fresh one for each turn of the loop

  let lastTick = now();
  const watchdog = setInterval(() => {
    const t = now();
    const gap = t - lastTick;
    lastTick = t;
    if (gap <= wakeGapMs) return;
    log.log(`[agent] the computer was asleep for about ${Math.max(1, Math.round(gap / 60_000))} min; reconnecting`);
    backoff = 1_000;
    connected = false;
    wake.abort();
  }, tickMs);
  watchdog.unref?.();

  try {
    while (!signal?.aborted) {
      wake = new AbortController();
      const woken = wake.signal;
      try {
        const res = await fetchImpl(`${base}/api/agent/next`, { headers: auth, signal: AbortSignal.any([AbortSignal.timeout(pollTimeoutMs), woken]) });
        if (res.status === 401) throw new Error("the server refused the token (AGENT_TOKEN must match on both sides)");
        if (res.status !== 200 && res.status !== 204) throw new Error(`the server answered HTTP ${res.status}`);
        if (!connected) log.log(`[agent] connected to ${base}`);
        connected = true;
        backoff = 1_000;
        if (res.status === 204) continue;

        const job = await res.json();
        const started = Date.now();
        let answer;
        try {
          answer = { id: job.id, ...(await fetchJob(job)) };
          log.log(`[agent] ${where(job.url)} -> ${answer.status}, ${Math.round(answer.body.length / 1024)} KB in ${Date.now() - started} ms`);
        } catch (err) {
          answer = { id: job.id, error: err.message };
          log.warn(`[agent] ${where(job.url)} -> failed: ${err.message}`);
        }
        const posted = await fetchImpl(`${base}/api/agent/result`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/octet-stream" },
          body: zlib.gzipSync(JSON.stringify(answer)),
          signal: AbortSignal.timeout(30_000),
        });
        if (!posted.ok) throw new Error(`the server refused the answer (HTTP ${posted.status})`);
      } catch (err) {
        if (signal?.aborted) break;
        if (woken.aborted && err === woken.reason) continue; // the dead poll was dropped on waking; the watchdog has said so
        log.warn(`[agent] ${connected ? "lost the server" : "can't reach the server"}: ${err.message}; retrying in ${backoff / 1000}s`);
        connected = false;
        await Promise.race([sleep(backoff), whenAborted(woken)]);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  } finally {
    clearInterval(watchdog);
  }
}
