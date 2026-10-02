import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runAgent } from "../src/agent.js";
import { TRAY_TEXT, startTray, trayWanted } from "../src/agent-tray.js";

const TOKEN = "t".repeat(40);

// A stand-in for the PowerShell process: what the agent writes to it lands in `written`, and `stdout` is what the icon says back.
function fakeChild() {
  const child = new EventEmitter();
  child.written = [];
  child.ended = false;
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (s) => child.written.push(s),
    end: () => {
      child.ended = true;
      child.stdin.writable = false;
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function trayWith(over = {}) {
  const child = fakeChild();
  const calls = [];
  const warnings = [];
  const quits = [];
  const tray = startTray({
    onQuit: () => quits.push(1),
    log: { warn: (m) => warnings.push(m) },
    spawnImpl: (...args) => (calls.push(args), child),
    script: "C:\\repo\\scripts\\agent-tray.ps1",
    icon: "C:\\repo\\public\\icons\\icon-192.png",
    ...over,
  });
  return { tray, child, calls, warnings, quits };
}

test("tray: on by default on Windows only, and AGENT_TRAY=0 turns it off", () => {
  assert.equal(trayWanted({}, "win32"), true);
  assert.equal(trayWanted({ AGENT_TRAY: "0" }, "win32"), false);
  assert.equal(trayWanted({ AGENT_TRAY: "1" }, "win32"), true);
  assert.equal(trayWanted({}, "linux"), false);
  assert.equal(trayWanted({}, "darwin"), false);
});

test("tray: starts a hidden PowerShell with the script, the icon, and the log and app address when there are some", () => {
  const { calls } = trayWith({ logPath: "C:\\repo\\agent.log", url: "https://app.example" });
  const [exe, args, opts] = calls[0];
  assert.equal(exe, "powershell.exe");
  assert.deepEqual(args.slice(0, 8), ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.deepEqual(args.slice(8), ["C:\\repo\\scripts\\agent-tray.ps1", "-IconPath", "C:\\repo\\public\\icons\\icon-192.png", "-LogPath", "C:\\repo\\agent.log", "-Url", "https://app.example"]);
  assert.equal(opts.windowsHide, true, "no console window");

  const bare = trayWith().calls[0][1];
  assert.ok(!bare.includes("-LogPath") && !bare.includes("-Url"), "no empty arguments to trip over");
});

test("tray: sends the state as one line, with the text kept to one line", () => {
  const { tray, child } = trayWith();
  tray.set("connecting", TRAY_TEXT.connecting);
  tray.set("connected", TRAY_TEXT.connected("app.example"));
  tray.set("offline", "line one\r\nline two | with a bar");
  assert.deepEqual(child.written, [
    "connecting|Rental Watch agent: connecting...\n",
    "connected|Rental Watch agent: connected to app.example\n",
    "offline|line one line two with a bar\n",
  ]);
});

test("tray: Quit in the icon's menu stops the agent, and any other output is ignored", async () => {
  const { child, quits } = trayWith();
  child.stdout.write("something else\nquit\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(quits.length, 1);
});

test("tray: stopping closes the pipe, which is how the icon knows to go away", () => {
  const { tray, child } = trayWith();
  tray.stop();
  assert.equal(child.ended, true);
  tray.set("connected", "ignored after stop");
  assert.equal(child.written.length, 0);
});

test("tray: if the icon can't start or dies, the agent says why in its log and keeps going", () => {
  const dies = trayWith();
  dies.child.stderr.write("Add-Type : Cannot add type.\r\n");
  dies.child.emit("exit", 1);
  assert.match(dies.warnings[0], /^\[agent\] tray icon stopped \(exit 1\): Add-Type : Cannot add type\.; the agent keeps running$/);
  dies.tray.set("connected", "x");
  assert.equal(dies.child.written.length, 0, "nothing is written to a process that has gone");
  dies.child.emit("exit", 1);
  assert.equal(dies.warnings.length, 1, "said once");

  const noShell = trayWith();
  noShell.child.emit("error", new Error("spawn powershell.exe ENOENT"));
  assert.match(noShell.warnings[0], /tray icon not started: spawn powershell\.exe ENOENT/);

  const warnings = [];
  const throws = startTray({ onQuit() {}, log: { warn: (m) => warnings.push(m) }, spawnImpl: () => { throw new Error("EACCES"); } });
  throws.set("connected", "x");
  throws.stop();
  assert.match(warnings[0], /tray icon not started: EACCES/);

  const { tray, child } = trayWith();
  child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  tray.set("connected", "x");
});

test("tray: the script takes the arguments the agent passes, knows every state the agent reports, and finds its icon", () => {
  const script = fs.readFileSync(new URL("../scripts/agent-tray.ps1", import.meta.url), "utf8");
  for (const param of ["IconPath", "LogPath", "Url"]) assert.match(script, new RegExp(`\\$${param}\\b`), param);
  for (const state of Object.keys(TRAY_TEXT)) assert.match(script, new RegExp(`${state}\\s*=\\s*"#[0-9a-f]{6}"`), `a colour for ${state}`);
  assert.match(script, /WriteLine\("quit"\)/);
  assert.ok(fs.existsSync(new URL("../public/icons/icon-192.png", import.meta.url)));
});

test("agent loop: reports connected, offline and refused as they change, not on every poll or retry", async () => {
  const states = [];
  const ctl = new AbortController();
  const replies = [
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
    "down",
    "down",
    new Response(null, { status: 401 }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 204 }),
  ];
  const fetchImpl = async () => {
    const next = replies.shift();
    if (replies.length === 0) ctl.abort();
    if (next === "down") throw new Error("ECONNREFUSED");
    return next;
  };
  await runAgent({ server: "https://srv.example", token: TOKEN, fetchJob: async () => ({}), fetchImpl, sleep: async () => {}, log: { log() {}, warn() {} }, signal: ctl.signal, onState: (s) => states.push(s) });
  assert.deepEqual(states, ["connected", "offline", "refused", "connected"]);
});
