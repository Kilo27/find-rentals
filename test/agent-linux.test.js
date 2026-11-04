import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  MAX_AWAKE_HOURS,
  awakeUntil,
  describe,
  execArg,
  execPath,
  formatAgo,
  holdUntil,
  isAgentCommand,
  logStatus,
  nodeProblem,
  setupProblem,
  startedAt,
  unitFile,
} from "../scripts/lib/agent-linux.mjs";

const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const base = { problem: null, unit: { load: "loaded", active: "active" }, host: "asap.example.app", startedMs: T0, now: T0 + 60_000, cmd: "asap-agent" };

test("unit file: runs the agent from the repo like npm run agent, logging to agent.log, and survives awkward paths", () => {
  const unit = unitFile({ repo: "/home/kyle/My Code/100%/find-rentals", node: "/home/kyle/.nvm/versions/node/v22.11.0/bin/node" });
  assert.match(unit, /^WorkingDirectory=\/home\/kyle\/My Code\/100%%\/find-rentals$/m);
  assert.match(unit, /^ExecStart="\/home\/kyle\/\.nvm\/versions\/node\/v22\.11\.0\/bin\/node" --env-file-if-exists=\.env src\/agent-main\.js$/m);
  assert.match(unit, /^Environment=AGENT_LOG=agent\.log$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.equal(execArg(`/opt/a "b"\\c/$HOME/%n`), String.raw`"/opt/a \"b\"\\c/$$HOME/%%n"`);
});

test("before it can run: Node 22.9 or later, the server and token in .env, and npm install", () => {
  for (const ok of ["22.9.0", "v22.22.1", "24.18.0"]) assert.equal(nodeProblem(ok), null, ok);
  for (const old of ["22.8.0", "20.18.1", "18.19.1"]) assert.match(nodeProblem(old), /too old.*22\.9/, old);
  const env = { AGENT_SERVER_URL: "https://asap.example.app", AGENT_TOKEN: "t" };
  assert.equal(setupProblem({ env, hasModules: true }), null);
  assert.match(setupProblem({ env: { AGENT_TOKEN: "t" }, hasModules: true }), /AGENT_SERVER_URL and AGENT_TOKEN/);
  assert.match(setupProblem({ env, hasModules: false }), /npm install/);
});

test("systemctl show: the unit's node binary and the awake deadline are read back from ExecStart", () => {
  const agent = "{ path=/usr/bin/node ; argv[]=/usr/bin/node --env-file-if-exists=.env src/agent-main.js ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }";
  assert.equal(execPath(agent), "/usr/bin/node");
  assert.equal(execPath(""), null);
  const holder = "{ path=/usr/bin/systemd-inhibit ; argv[]=/usr/bin/systemd-inhibit --what=sleep --mode=block /usr/bin/node /home/kyle/My Code/scripts/agent-linux.mjs hold 1793790000000 ; ignore_errors=no ; pid=812 }";
  assert.equal(holdUntil(holder), 1793790000000);
  assert.equal(holdUntil(agent), null);
});

test("awake: a few hours from now, never more than eight, and nothing it can't read", () => {
  assert.equal(awakeUntil("4", T0), T0 + 4 * 3_600_000);
  assert.equal(awakeUntil("1.5h", T0), T0 + 1.5 * 3_600_000);
  assert.equal(awakeUntil(String(MAX_AWAKE_HOURS), T0), T0 + 8 * 3_600_000);
  for (const bad of ["9", "0", "-1", "", undefined, "forever", "4 hours"]) assert.equal(awakeUntil(bad, T0), null, String(bad));
});

test("the agent's start time: systemd's monotonic timestamp, moved onto the wall clock", () => {
  // Started at 5000.250 s of uptime; it is now 5012.000 s of uptime and T0 on the wall clock.
  assert.equal(startedAt("5000250000", T0, 5_012_000), T0 - 11_750);
  assert.equal(startedAt("0", T0, 5_012_000), 0, "not running");
  assert.equal(startedAt(undefined, T0, 5_012_000), 0);
});

test("only node processes running src/agent-main.js count as agents (not the shell npm starts them from)", () => {
  assert.equal(isAgentCommand(["node", "--env-file-if-exists=.env", "src/agent-main.js", ""]), true);
  assert.equal(isAgentCommand(["/home/kyle/.nvm/versions/node/v22.11.0/bin/node", "/home/kyle/find-rentals/src/agent-main.js"]), true);
  assert.equal(isAgentCommand(["sh", "-c", "node --env-file-if-exists=.env src/agent-main.js"]), false);
  assert.equal(isAgentCommand(["node", "scripts/agent-linux.mjs", "status"]), false);
  assert.equal(isAgentCommand([""]), false);
});

test("log status: the newest connection line of this run decides, and a fetched page proves it is connected", () => {
  const lines = [
    `${at(-600)} [agent] starting: fetching daft.ie, rent.ie for https://asap.example.app`,
    `${at(-590)} [agent] can't reach the server: fetch failed; retrying in 1s`, // an earlier run
    `${at(0)} [agent] starting: fetching daft.ie, rent.ie for https://asap.example.app`,
    `${at(1)} [agent] connected to https://asap.example.app`,
    `${at(30)} [agent] www.daft.ie/sharing/limerick -> 200, 312 KB in 840 ms`,
    `${at(31)} [agent] www.rent.ie/rooms-to-share/limerick -> failed: fetch failed`,
    "",
  ];
  assert.deepEqual(logStatus(lines, T0), { state: "connected", message: "", lastPage: T0 + 31_000 });
  assert.deepEqual(logStatus(lines.slice(0, 4), T0), { state: "connected", message: "", lastPage: null });
  assert.deepEqual(logStatus(lines.slice(0, 3), T0), { state: "starting", message: "", lastPage: null });
  assert.deepEqual(logStatus(lines.slice(0, 2), T0), { state: null, message: "", lastPage: null }, "an earlier run's lines are ignored");

  const lost = [...lines, `${at(40)} [agent] lost the server: the server answered HTTP 502; retrying in 2s`];
  assert.deepEqual(logStatus(lost, T0), { state: "offline", message: "the server answered HTTP 502", lastPage: T0 + 31_000 });
  const refused = [...lines, `${at(40)} [agent] lost the server: the server refused the token (AGENT_TOKEN must match on both sides); retrying in 1s`];
  assert.equal(logStatus(refused, T0).state, "token");
  const woke = [...lines, `${at(50)} [agent] the computer was asleep for about 25 min; reconnecting`];
  assert.equal(logStatus(woke, T0).state, "connected", "waking says nothing about the connection");
});

test("status: what the service and its log say, in the tray app's words and colours", () => {
  const connected = { state: "connected", message: "", lastPage: T0 + 30_000 };
  assert.deepEqual(describe({ ...base, now: T0 + 4 * 60_000, log: connected }), { key: "ok", title: "Connected to asap.example.app", detail: "Last page fetched 3 min ago" });
  assert.equal(describe({ ...base, log: { ...connected, lastPage: null } }).detail, "Waiting for the next scan");
  assert.deepEqual(describe({ ...base, log: { state: "offline", message: "fetch failed", lastPage: null } }), { key: "wait", title: "Can't reach asap.example.app", detail: "Retrying: fetch failed" });
  assert.equal(describe({ ...base, log: { state: "token" } }).key, "bad");
  assert.equal(describe({ ...base, log: { state: null } }).title, "Starting");
  assert.equal(describe({ ...base, now: T0 + 120_000, log: { state: null } }).title, "Running", "silence well after starting means no log is being written");

  const unit = (active, load = "loaded") => describe({ ...base, unit: { load, active }, log: connected });
  assert.deepEqual(unit("inactive"), { key: "off", title: "Paused", detail: "Daft and Rent.ie are not being checked (asap-agent start resumes)" });
  assert.equal(unit("activating").title, "Restarting");
  assert.match(unit("failed").detail, /keeps stopping.*npm run agent.*asap-agent start/);
  assert.match(unit("inactive", "not-found").detail, /asap-agent install/);
  assert.deepEqual(describe({ ...base, problem: "Run npm install in the repo folder first.", log: connected }), { key: "bad", title: "Needs attention", detail: "Run npm install in the repo folder first." });
});

test("formatAgo", () => {
  assert.equal(formatAgo(T0, T0 + 59_000), "just now");
  assert.equal(formatAgo(T0, T0 + 59 * 60_000), "59 min ago");
  assert.equal(formatAgo(T0, T0 + 47 * 3_600_000), "47 h ago");
  assert.equal(formatAgo(T0, T0 + 72 * 3_600_000), "3 days ago");
});

test("the command explains itself anywhere, and points Windows users at the tray app", () => {
  const run = (...args) => spawnSync(process.execPath, ["scripts/agent-linux.mjs", ...args], { encoding: "utf8" });
  const help = run("help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /install .*log in/);
  assert.match(help.stdout, /awake <hours>/);
  const unknown = run("frobnicate");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command "frobnicate"/);
  if (process.platform !== "linux") {
    const elsewhere = run("status");
    assert.equal(elsewhere.status, 1);
    assert.match(elsewhere.stderr, /agent-tray\.ps1/);
  }
});
