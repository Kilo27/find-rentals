#!/usr/bin/env node
// The laptop agent on Linux, as a systemd user service: it runs in the background and whenever you log in, restarts if
// it crashes, says whether it is connected, and keeps the computer awake for a few hours when asked. What the tray app
// (scripts/agent-tray.ps1) does on Windows, as a command instead of an icon.
//
//   Install (also adds the asap-agent command to ~/.local/bin):  node scripts/agent-linux.mjs install
//   Then:  asap-agent [status] | pause | start | restart | log | awake <hours> | awake off | uninstall
//
// Needs systemd, .env in the repo root with AGENT_SERVER_URL and AGENT_TOKEN (see .env.example) and `npm install`.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";
import {
  AWAKE_UNIT,
  MAX_AWAKE_HOURS,
  UNIT,
  awakeUntil,
  clock,
  describe,
  execPath,
  holdUntil,
  isAgentCommand,
  logStatus,
  nodeProblem,
  setupProblem,
  startedAt,
  unitFile,
} from "./lib/agent-linux.mjs";

const SCRIPT = fileURLToPath(import.meta.url); // the real file, even when run through the ~/.local/bin link
const REPO = path.dirname(path.dirname(SCRIPT));
const LOG = path.join(REPO, "agent.log");
const UNIT_PATH = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user", UNIT);
const LINK = path.join(os.homedir(), ".local", "bin", "asap-agent");
const CMD = path.basename(process.argv[1] ?? "") === "asap-agent" ? "asap-agent" : "node scripts/agent-linux.mjs";
const RUNNING = new Set(["active", "activating", "reloading"]);

const USAGE = `The ASAP accommodation laptop agent as a Linux service (systemd --user).

  install        run it now and whenever you log in (also adds the asap-agent command)
  status         is it connected, and when did it last fetch a page? (the default)
  pause          stop it until you start it again
  start          start it again
  restart        restart it, for example after a git pull
  log            follow its log (Ctrl+C stops following, not the agent)
  awake <hours>  keep this computer from sleeping by itself, for up to 8 hours
  awake off      let it sleep as usual again
  uninstall      stop it and remove the service and the asap-agent command`;

class Stop extends Error {}
const fail = (message) => {
  throw new Stop(message);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const systemctl = (...args) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
function must(...args) {
  const r = systemctl(...args);
  if (r.error || r.status !== 0) fail(`systemctl --user ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
}
// A unit's properties as an object; an unknown unit comes back with LoadState=not-found.
function show(unit, ...props) {
  const r = systemctl("show", unit, ...props.map((p) => `--property=${p}`));
  const out = {};
  for (const line of (r.stdout ?? "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function needSystemd() {
  const r = systemctl("show-environment");
  if (r.error || r.status !== 0) {
    fail("systemd isn't running services for your user here (systemctl --user doesn't answer), so the agent can't run as a service. Run npm run agent in a terminal instead; in WSL, turn systemd on in /etc/wsl.conf first.");
  }
}

function readEnv() {
  try {
    return util.parseEnv(fs.readFileSync(path.join(REPO, ".env"), "utf8"));
  } catch {
    return {};
  }
}
const currentProblem = () => setupProblem({ env: readEnv(), hasModules: fs.existsSync(path.join(REPO, "node_modules")) });

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}

function readLogTail() {
  let fd;
  try {
    fd = fs.openSync(LOG, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 65_536);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8").split(/\r?\n/);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Agents of this user's not run by the service (npm run agent in a terminal); two would share the work for no gain.
function otherAgents(servicePid) {
  const uid = process.getuid();
  const found = [];
  for (const name of fs.readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === servicePid || pid === process.pid) continue;
    try {
      if (fs.statSync(`/proc/${name}`).uid !== uid) continue;
      if (isAgentCommand(fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0"))) found.push(pid);
    } catch {
      // it ended while we looked
    }
  }
  return found;
}
const otherAgentsNote = (pids) =>
  pids.length ? `Another agent is running outside the service (pid ${pids.join(", ")}); stop it (Ctrl+C in its terminal) so only one fetches.` : null;

const COLOURS = { ok: 32, wait: 33, off: 90, bad: 31 };
const paint = (key, text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${COLOURS[key]}m${text}\x1b[0m` : text);

function readStatus() {
  const unit = show(UNIT, "LoadState", "ActiveState", "MainPID", "ExecStart", "ExecMainStartTimestampMonotonic", "UnitFileState");
  const pid = Number(unit.MainPID) || 0;
  const node = execPath(unit.ExecStart);
  let problem = currentProblem();
  if (!problem && unit.LoadState === "loaded" && node && !fs.existsSync(node)) problem = `Node.js is no longer at ${node}. Run ${CMD} install again.`;
  const since = pid ? startedAt(unit.ExecMainStartTimestampMonotonic, Date.now(), Number(process.hrtime.bigint()) / 1e6) : 0;
  const s = describe({
    problem,
    unit: { load: unit.LoadState, active: unit.ActiveState },
    log: logStatus(readLogTail(), since),
    host: hostOf(readEnv().AGENT_SERVER_URL),
    startedMs: since,
    now: Date.now(),
    cmd: CMD,
  });
  return { s, unit, pid };
}

function status() {
  needSystemd();
  const { s, unit, pid } = readStatus();
  const notes = [s.detail];
  const awake = show(AWAKE_UNIT, "ActiveState", "ExecStart");
  const until = awake.ActiveState === "active" ? holdUntil(awake.ExecStart) : null;
  if (until) notes.push(`Keeping this computer awake until ${clock(until)} (${CMD} awake off lets it sleep)`);
  const others = otherAgentsNote(otherAgents(pid));
  if (others) notes.push(others);
  if (unit.LoadState === "loaded") {
    const linger = spawnSync("loginctl", ["show-user", os.userInfo().username, "--property=Linger", "--value"], { encoding: "utf8" }).stdout?.trim() === "yes";
    if (unit.UnitFileState === "enabled") notes.push(linger ? "Starts when the computer starts" : "Starts when you log in");
    else notes.push(`Doesn't start by itself (${CMD} install turns that on)`);
    notes.push(`Log: ${LOG}`);
  }
  console.log(`${paint(s.key, "●")} ${s.title}`);
  for (const note of notes) console.log(`  ${note}`);
}

// The agent logs "connected" once the server first answers, which can take the server's whole 25 s long poll, so after
// starting it, wait for that (or a problem) rather than show "Starting".
async function statusOnceSettled() {
  console.log("Waiting for the server to answer...");
  for (let i = 0; i < 30 && ["Starting", "Restarting"].includes(readStatus().s.title); i++) await wait(1_000);
  console.log("");
  status();
}

// ~/.local/bin/asap-agent -> this script, unless something else already has that name.
function linkCommand() {
  try {
    return fs.readlinkSync(LINK) === SCRIPT;
  } catch (err) {
    if (err.code !== "ENOENT") return false;
  }
  try {
    fs.accessSync(SCRIPT, fs.constants.X_OK);
  } catch {
    fs.chmodSync(SCRIPT, 0o755);
  }
  fs.mkdirSync(path.dirname(LINK), { recursive: true });
  fs.symlinkSync(SCRIPT, LINK);
  return true;
}

async function install() {
  needSystemd();
  const problem = nodeProblem(process.versions.node) ?? currentProblem();
  if (problem) fail(problem);
  fs.mkdirSync(path.dirname(UNIT_PATH), { recursive: true });
  fs.writeFileSync(UNIT_PATH, unitFile({ repo: REPO, node: process.execPath }));
  must("daemon-reload");
  must("enable", UNIT);
  systemctl("reset-failed", UNIT);
  must("restart", UNIT); // an install after a git pull picks up the new agent
  const linked = linkCommand();
  const onPath = (process.env.PATH ?? "").split(":").includes(path.dirname(LINK));
  console.log(`Installed: the agent runs now and whenever you log in, logging to ${LOG}.`);
  if (!linked) console.log(`${LINK} is something else, so the asap-agent command wasn't added; use node scripts/agent-linux.mjs <command>.`);
  else if (!onPath) console.log(`Added ${LINK}; ~/.local/bin isn't on your PATH yet (log out and in), so until then use ${LINK} <command>.`);
  else console.log("Use asap-agent status, pause, start, log or awake <hours> from now on; asap-agent help lists them all.");
  console.log("It runs while you're logged in. To run it from boot even when nobody logs in (a home server), run: loginctl enable-linger");
  const others = otherAgentsNote(otherAgents(Number(show(UNIT, "MainPID").MainPID) || 0));
  if (others) console.log(others);
  console.log("");
  await statusOnceSettled();
}

function uninstall() {
  needSystemd();
  systemctl("stop", AWAKE_UNIT);
  systemctl("disable", "--now", UNIT);
  fs.rmSync(UNIT_PATH, { force: true });
  must("daemon-reload");
  systemctl("reset-failed", UNIT, AWAKE_UNIT);
  try {
    if (fs.readlinkSync(LINK) === SCRIPT) fs.unlinkSync(LINK);
  } catch {
    // not ours, or not there
  }
  console.log(`Removed the service and the asap-agent command; the agent has stopped. agent.log is still in ${REPO}.`);
}

function needInstalled() {
  needSystemd();
  if (show(UNIT, "LoadState").LoadState !== "loaded") fail(`The agent isn't installed as a service yet. Run ${CMD} install first.`);
}

async function start(action) {
  needInstalled();
  const problem = currentProblem();
  if (problem) fail(problem);
  systemctl("reset-failed", UNIT); // a fresh start after it gave up
  must(action, UNIT);
  await statusOnceSettled();
}

function pause() {
  needInstalled();
  must("stop", UNIT);
  console.log(`Paused: Daft and Rent.ie aren't being checked until ${CMD} start (or the next time you log in after a restart).`);
}

function followLog() {
  console.log(`${LOG} (Ctrl+C stops following; the agent keeps running)`);
  const tail = spawn("tail", ["-n", "40", "-F", LOG], { stdio: "inherit" });
  process.on("SIGINT", () => tail.kill());
  return new Promise((resolve) => tail.on("exit", resolve));
}

// Asks logind not to sleep the computer by itself, through systemd-inhibit in a unit of its own that ends at the
// deadline, when the agent stops, or with "awake off". Never longer than MAX_AWAKE_HOURS, and not remembered across a
// restart. logind only grants it for a user who is logged in at the computer's own screen, and closing the lid still
// sleeps it (LidSwitchIgnoreInhibited=yes by default).
async function awake(arg) {
  needInstalled();
  if (arg === "off") {
    systemctl("stop", AWAKE_UNIT);
    systemctl("reset-failed", AWAKE_UNIT);
    console.log("This computer sleeps as usual again.");
    return;
  }
  const until = awakeUntil(arg, Date.now());
  if (!until) fail(`Say for how many hours, up to ${MAX_AWAKE_HOURS}: for example "${CMD} awake 4". "${CMD} awake off" lets it sleep again.`);
  if (!RUNNING.has(show(UNIT, "ActiveState").ActiveState)) fail(`The agent isn't running, so there's nothing to stay awake for. Start it first: ${CMD} start`);
  systemctl("stop", AWAKE_UNIT);
  systemctl("reset-failed", AWAKE_UNIT);
  const r = spawnSync(
    "systemd-run",
    [
      "--user",
      "--quiet",
      `--unit=${AWAKE_UNIT}`,
      "--description=ASAP accommodation agent: keep this computer awake",
      `--property=PartOf=${UNIT}`,
      `--property=After=${UNIT}`,
      "systemd-inhibit",
      "--what=sleep",
      "--mode=block",
      "--who=ASAP accommodation agent",
      `--why=Fetching Daft.ie and Rent.ie pages until ${clock(until)}`,
      process.execPath,
      SCRIPT,
      "hold",
      String(until),
    ],
    { encoding: "utf8" },
  );
  if (r.error || r.status !== 0) fail(`systemd-run failed: ${(r.stderr || r.error?.message || "").trim()}`);
  await wait(1_500);
  if (show(AWAKE_UNIT, "ActiveState").ActiveState !== "active") {
    const why = spawnSync("journalctl", ["--user", "--unit", AWAKE_UNIT, "--lines", "20", "--output", "cat", "--no-pager"], { encoding: "utf8" })
      .stdout?.split("\n")
      .findLast((l) => l.startsWith("Failed to inhibit"));
    systemctl("reset-failed", AWAKE_UNIT);
    fail(`Linux wouldn't keep this computer awake${why ? ` (${why})` : ""}. It only allows that for someone logged in at the computer's own screen; otherwise change its power settings instead.`);
  }
  console.log(`Keeping this computer awake until ${clock(until)}, while the agent runs. Closing the lid still sleeps it; ${CMD} awake off lets it sleep as usual.`);
}

// Runs inside systemd-inhibit (the awake unit), which holds the lock until this exits: at the deadline, or once the agent
// is paused or has given up. The clock is checked every 30 s, so a deadline that passed while asleep ends it on waking.
async function hold(arg) {
  const until = Number(arg);
  while (Date.now() < until && RUNNING.has(show(UNIT, "ActiveState").ActiveState)) await wait(Math.min(30_000, until - Date.now()));
}

const COMMANDS = { install, uninstall, status, start: () => start("start"), restart: () => start("restart"), pause, stop: pause, log: followLog, awake, hold };

const [command = "status", ...args] = process.argv.slice(2);
try {
  if (["help", "--help", "-h"].includes(command)) {
    console.log(USAGE);
  } else if (!COMMANDS[command]) {
    fail(`Unknown command "${command}".\n\n${USAGE}`);
  } else if (process.platform !== "linux") {
    fail("This is for Linux. On Windows, use the tray app: scripts\\agent-tray.ps1 (see README).");
  } else if (process.getuid() === 0) {
    fail("Run this as yourself, not as root or with sudo: the agent runs as your own user's service.");
  } else {
    await COMMANDS[command](...args);
    if (process.argv.length <= 2) console.log(`\n${CMD} help lists the commands.`);
  }
} catch (err) {
  if (!(err instanceof Stop)) throw err;
  console.error(err.message);
  process.exitCode = 1;
}
