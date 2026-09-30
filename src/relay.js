import crypto from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

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

export const parseAllow = (s) =>
  String(s ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

function splitHostPort(target) {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(target ?? "");
  return m ? { host: (m[1] ?? m[2]).toLowerCase(), port: Number(m[3]) } : null;
}

// net.connect may ask for one address or (Happy Eyeballs) all of them; refuse if any is private.
export const guardedLookup = (allowPrivate, lookup = dns.lookup) => (hostname, opts, cb) =>
  lookup(hostname, opts, (err, address, family) => {
    if (err) return cb(err);
    const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (!allowPrivate && addresses.some(isPrivateAddress)) return cb(new Error("private address refused"));
    cb(null, address, family);
  });

const reply = (socket, code, text) =>
  socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n${code === 407 ? 'Proxy-Authenticate: Basic realm="relay"\r\n' : ""}\r\n`);

// A deliberately narrow HTTPS relay: Basic-auth protected CONNECT tunnels, only to allow-listed
// hostnames on allow-listed ports, never to private addresses. Everything else is refused.
export function createRelay({ user, password, allow, allowPorts = [443], allowPrivate = false, maxConnections = 50, idleMs = 60_000, log = { log() {}, warn() {} } }) {
  if (!user || !password) throw new Error("relay needs a user and password");
  if (!allow?.length) throw new Error("relay needs at least one allowed host");
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const hostAllowed = (h) => allow.some((s) => h === s || h.endsWith(`.${s}`));

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") return void res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    res.writeHead(405, { "Content-Type": "text/plain" }).end("only CONNECT tunnels are supported");
  });
  server.maxConnections = maxConnections;

  server.on("connect", (req, client, head) => {
    client.on("error", () => client.destroy());
    if (!safeEqual(req.headers["proxy-authorization"] ?? "", expected)) return reply(client, 407, "Proxy Authentication Required");

    const target = splitHostPort(req.url);
    if (!target || !hostAllowed(target.host) || !allowPorts.includes(target.port)) {
      log.warn(`[relay] refused CONNECT ${String(req.url).slice(0, 80)}`);
      return reply(client, 403, "Forbidden");
    }

    const upstream = net.connect({
      host: target.host,
      port: target.port,
      lookup: guardedLookup(allowPrivate),
    });
    upstream.setTimeout(idleMs, () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (err) => {
      log.warn(`[relay] upstream ${target.host}: ${err.message}`);
      if (client.writable) reply(client, err.message.includes("private") ? 403 : 502, err.message.includes("private") ? "Forbidden" : "Bad Gateway");
      client.destroy();
    });
    client.on("close", () => upstream.destroy());
  });

  return server;
}
