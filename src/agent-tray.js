import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/agent-tray.ps1", import.meta.url));
const ICON = fileURLToPath(new URL("../public/icons/icon-192.png", import.meta.url));

// The icon by the clock is on by default on Windows; AGENT_TRAY=0 turns it off.
export const trayWanted = (env = process.env, platform = process.platform) => platform === "win32" && env.AGENT_TRAY !== "0";

// What the icon says for each state the agent can be in (the colours are in the script).
export const TRAY_TEXT = {
  connecting: "Rental Watch agent: connecting...",
  connected: (host) => `Rental Watch agent: connected to ${host}`,
  offline: "Rental Watch agent: can't reach the server",
  refused: "Rental Watch agent: the server refused the token",
};

// Starts the icon as a hidden PowerShell process and tells it the agent's state as it changes, one line each
// ("state|text"). The icon is never worth stopping the agent for: if it can't start or dies, the agent says so in its log
// and carries on. Quit in the icon's menu calls onQuit.
export function startTray({ onQuit, log, logPath = "", url = "", spawnImpl = spawn, script = SCRIPT, icon = ICON }) {
  const args = ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script, "-IconPath", icon];
  if (logPath) args.push("-LogPath", logPath);
  if (url) args.push("-Url", url);

  let alive = true;
  let child;
  try {
    child = spawnImpl("powershell.exe", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    log.warn(`[agent] tray icon not started: ${err.message}`);
    return { set() {}, stop() {} };
  }

  const stderr = [];
  child.stderr?.on("data", (d) => stderr.push(String(d)));
  child.stdin?.on("error", () => {});
  child.on("error", (err) => {
    alive = false;
    log.warn(`[agent] tray icon not started: ${err.message}`);
  });
  child.on("exit", (code) => {
    if (!alive) return;
    alive = false;
    const why = stderr.join("").replace(/\s+/g, " ").trim().slice(0, 300);
    log.warn(`[agent] tray icon stopped (exit ${code})${why ? `: ${why}` : ""}; the agent keeps running`);
  });
  if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", (line) => line.trim() === "quit" && onQuit());

  return {
    set(state, text) {
      if (!alive || !child.stdin?.writable) return;
      child.stdin.write(`${state}|${String(text).replace(/\s*[\r\n|]+\s*/g, " ")}\n`);
    },
    // Closing the pipe is how the icon knows to go away.
    stop() {
      alive = false;
      child.stdin?.end();
    },
  };
}
