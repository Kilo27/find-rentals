// The laptop agent: npm run agent (settings in .env, see .env.example).
import fs from "node:fs";
import { DEFAULT_ALLOW, createJobFetcher, parseAllow, runAgent } from "./agent.js";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const { AGENT_SERVER_URL: serverUrl, AGENT_TOKEN: token, AGENT_ALLOW, AGENT_LOG } = process.env;
if (!serverUrl || !token) fail("AGENT_SERVER_URL and AGENT_TOKEN are required (put them in .env, see .env.example)");
let server;
try {
  server = new URL(serverUrl);
} catch {
  fail("AGENT_SERVER_URL is not a valid URL");
}
if (server.protocol !== "https:" && !(server.protocol === "http:" && LOCAL.has(server.hostname))) {
  fail("AGENT_SERVER_URL must be https:// so the token isn't sent in clear text");
}

// Timestamped lines on the console, and in AGENT_LOG when it is set (the scheduled task runs hidden).
const line = (level) => (...parts) => {
  const text = `${new Date().toISOString()} ${parts.join(" ")}`;
  console[level](text);
  if (AGENT_LOG) {
    try {
      fs.appendFileSync(AGENT_LOG, `${text}\n`);
    } catch {
      /* logging must never stop the agent */
    }
  }
};
const log = { log: line("log"), warn: line("warn") };

const allow = AGENT_ALLOW ? parseAllow(AGENT_ALLOW) : DEFAULT_ALLOW;
log.log(`[agent] starting: fetching ${allow.join(", ")} for ${server.origin}`);

const controller = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    controller.abort();
    process.exit(0);
  });
}
await runAgent({ server: server.origin, token, fetchJob: createJobFetcher({ allow }), log, signal: controller.signal });
