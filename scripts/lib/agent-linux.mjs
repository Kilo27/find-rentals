// The pure parts of scripts/agent-linux.mjs (the laptop agent as a systemd user service): the unit file, the checks
// before it can run, and reading its status from agent.log the way the Windows tray app (scripts/agent-tray.ps1) does.

export const UNIT = "asap-agent.service";
// Holds a systemd-inhibit sleep lock while "awake" is asked for; PartOf the agent, so pausing the agent ends it too.
export const AWAKE_UNIT = "asap-agent-awake.service";
export const MAX_AWAKE_HOURS = 8;

// One ExecStart= argument: quoted, with systemd's specifier (%) and variable ($) expansion turned off.
export const execArg = (s) => `"${String(s).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

// Runs the agent the way `npm run agent` does, from the repo with its .env, logging to agent.log. Restarts it if it
// crashes, but three quick failures in a row (a bad .env, a missing node) stop it until it is started again.
export function unitFile({ repo, node }) {
  return `# Written by scripts/agent-linux.mjs install; install again to update it, uninstall to remove it.
[Unit]
Description=ASAP accommodation agent: fetches Daft.ie and Rent.ie pages from this computer
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
WorkingDirectory=${repo.replace(/%/g, "%%")}
ExecStart=${execArg(node)} --env-file-if-exists=.env src/agent-main.js
Environment=AGENT_LOG=agent.log
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// --env-file-if-exists, which the service uses like `npm run agent`, arrived in Node 22.9.
export function nodeProblem(version) {
  const [major, minor] = String(version).replace(/^v/, "").split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 9)) return null;
  return `Node.js ${version} is too old for the agent; it needs 22.9 or later (nodejs.org, or nvm).`;
}

// What only the user can fix before the agent can run, as the tray app words it; null when there is nothing.
export function setupProblem({ env, hasModules }) {
  if (!env.AGENT_SERVER_URL || !env.AGENT_TOKEN) return "Add AGENT_SERVER_URL and AGENT_TOKEN to .env (see .env.example).";
  if (!hasModules) return "Run npm install in the repo folder first.";
  return null;
}

// The node binary a unit runs, from `systemctl show -p ExecStart`.
export const execPath = (execStart) => /\bpath=(.+?) ;/.exec(execStart ?? "")?.[1] ?? null;

// The deadline a running awake unit holds the lock until, from `systemctl show -p ExecStart` ("... hold <ms> ;").
export function holdUntil(execStart) {
  const m = / hold (\d+) ;/.exec(execStart ?? "");
  return m ? Number(m[1]) : null;
}

// "awake 4" or "awake 4h": the deadline that many hours from now; null for anything else or more than MAX_AWAKE_HOURS.
export function awakeUntil(arg, now) {
  const m = /^(\d+(?:\.\d+)?)h?$/i.exec(String(arg ?? "").trim());
  const hours = m ? Number(m[1]) : NaN;
  return hours > 0 && hours <= MAX_AWAKE_HOURS ? now + hours * 3_600_000 : null;
}

// When the agent's process started, in ms since the epoch, from systemd's ExecMainStartTimestampMonotonic (µs on the
// monotonic clock, which process.hrtime also reads). Exact to the millisecond, so a restart a second after the last run
// still tells the two runs' log lines apart. 0 when it isn't running.
export function startedAt(monotonicUs, now, monotonicNowMs) {
  const us = Number(monotonicUs);
  return us > 0 ? Math.round(now - (monotonicNowMs - us / 1000)) : 0;
}

// A node process running the agent (npm run agent, or the service), from the NUL-separated /proc/<pid>/cmdline.
export const isAgentCommand = (argv) => /(^|\/)node[^/]*$/.test(argv[0] ?? "") && argv.slice(1).some((a) => /(^|\/)src\/agent-main\.js$/.test(a));

// The newest connection line since the agent started decides the state; a fetched page also proves it is connected.
// Lines from earlier runs (the same file) are ignored. Same rules as the tray app's Get-LogStatus.
export function logStatus(lines, sinceMs) {
  let state = null;
  let message = "";
  let lastPage = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\d{4}-\d\d-\d\dT\S+Z) (.*)$/.exec(lines[i]);
    if (!m) continue;
    const when = Date.parse(m[1]);
    if (when < sinceMs) break;
    const text = m[2];
    const page = /^\[agent\] \S+ -> (\d{3}|failed)/.test(text);
    if (lastPage === null && page) lastPage = when;
    if (!state) {
      const offline = /(lost|can't reach) the server: (.*?)(; retrying.*)?$/.exec(text);
      if (/refused the token/.test(text)) state = "token";
      else if (offline) [state, message] = ["offline", offline[2]];
      else if (/^\[agent\] connected to /.test(text) || page) state = "connected";
      else if (/^\[agent\] starting/.test(text)) state = "starting";
    }
    if (state && lastPage !== null) break;
  }
  return { state, message, lastPage };
}

export function formatAgo(whenMs, now) {
  const minutes = Math.floor((now - whenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

export const clock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Key is the status colour (ok/wait/off/bad, as the tray icon's), title the first line, detail the second.
// unit is the service's LoadState and ActiveState; cmd is how the user runs this script, for the hints.
export function describe({ problem, unit, log, host, startedMs, now, cmd }) {
  if (problem) return { key: "bad", title: "Needs attention", detail: problem };
  if (unit.load !== "loaded") return { key: "off", title: "Not installed", detail: `Run ${cmd} install to run it as a service` };
  switch (unit.active) {
    case "active":
    case "reloading":
      break;
    case "activating":
      return { key: "wait", title: "Restarting", detail: "The agent stopped; starting it again" };
    case "failed":
      return { key: "bad", title: "Needs attention", detail: `The agent keeps stopping. Run npm run agent in the repo to see why, then ${cmd} start.` };
    default:
      return { key: "off", title: "Paused", detail: `Daft and Rent.ie are not being checked (${cmd} start resumes)` };
  }
  switch (log.state) {
    case "connected":
      return { key: "ok", title: `Connected to ${host}`, detail: log.lastPage ? `Last page fetched ${formatAgo(log.lastPage, now)}` : "Waiting for the next scan" };
    case "offline":
      return { key: "wait", title: `Can't reach ${host}`, detail: `Retrying: ${log.message}` };
    case "token":
      return { key: "bad", title: "The server refused the token", detail: "AGENT_TOKEN in .env must match Railway's" };
    default:
      // The agent logs "connected" within ~40 s of starting, so silence after that means agent.log isn't being written.
      if (now - startedMs > 90_000) return { key: "wait", title: "Running", detail: "Nothing in agent.log since it started; check the repo folder is writable" };
      return { key: "wait", title: "Starting", detail: "Connecting to the server" };
  }
}
