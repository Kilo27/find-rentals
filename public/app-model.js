// The decisions behind the screens, kept apart from the DOM so they can be tested without a browser.
import { timeAgo } from "./ui.js";

// A scan is "late" once it is this many minutes old, or three scan intervals, whichever is longer.
const LATE_AFTER_MIN = 90;

// How the scanner is doing, in words a person who never set it up can act on. `rows` has one entry per site that ran;
// `raw` keeps the technical wording for the admin's details panel.
export function summarizeSources(state, now = Date.now()) {
  const { config, lastRun } = state;
  const none = { issues: [], rows: [], note: null, plainNote: null, checkedAt: lastRun?.at ?? null };
  // No campus chosen yet (the state has no search): there is nothing to check until there is one.
  if (config === null) return { ...none, level: "none", headline: "Choose a campus to start watching" };
  if (config && config.enabled === false) return { ...none, level: "paused", headline: "Watching is paused" };
  if (!lastRun) return { ...none, level: "none", headline: "Waiting for the first check" };
  if (lastRun.ok === false) {
    return { ...none, level: "failed", headline: `The last check didn't work (${timeAgo(lastRun.at, now)})`, issues: [{ id: "scan", text: "It will try again on the next scan." }], note: "It will try again on the next scan.", plainNote: "It will try again on the next scan." };
  }

  const ago = timeAgo(lastRun.at, now);
  const rows = (lastRun.sources ?? []).map((s) => {
    const failing = state.sourceHealth?.[s.id]?.failures;
    const row = { id: s.id, label: s.label };
    if (s.skipped) return { ...row, status: "paused", detail: "Paused for now. It will catch up by itself.", raw: `not checked: ${s.skipped}` };
    if (!s.ok) return { ...row, status: "down", detail: failing >= 3 ? "Not responding for a while." : "Not responding right now.", raw: `error: ${s.error}${failing >= 3 ? ` (failing x${failing})` : ""}` };
    if ((s.notes ?? []).some((n) => n.warning)) return { ...row, status: "warn", detail: "Loaded, but some listings may be missing.", raw: `${s.fetched} found - check layout` };
    return { ...row, status: "ok", detail: `Checked ${ago}.`, raw: `${s.fetched} found` };
  });

  const issues = rows.filter((r) => r.status !== "ok").map((r) => ({ id: r.id, text: `${r.label}: ${r.detail}` }));
  const working = rows.filter((r) => r.status === "ok" || r.status === "warn").length;
  // A site that is only paused (the laptop that fetches it is asleep) is routine and fixes itself, so it is not a warning.
  // Trouble is a site that isn't responding or came back looking wrong.
  const notOk = rows.filter((r) => r.status !== "ok");
  const troubled = notOk.some((r) => r.status === "down" || r.status === "warn");
  const WHY = { paused: "paused", down: "not responding", warn: "may be missing some" };
  // One short line for above the list. The admin gets the site names; everyone else only whether anything is amiss,
  // because they can't do anything about a particular site.
  const note = notOk.length ? `${troubled ? "Not checking properly" : "Catching up"}: ${notOk.map((r) => (troubled ? `${r.label} (${WHY[r.status]})` : r.label)).join(", ")}` : null;
  const plainNote = !notOk.length ? null : troubled ? "Some sites aren't responding, so you may miss a few places." : "Some sites are catching up.";
  const base = { rows, issues, note, plainNote, checkedAt: lastRun.at };
  const lateMs = Math.max(LATE_AFTER_MIN, 3 * (config?.intervalMinutes ?? 30)) * 60_000;

  if (now - Date.parse(lastRun.at) > lateMs) return { ...base, level: "stale", headline: `Last check was ${ago}, so alerts may be late` };
  if (!rows.length) return { ...base, level: "down", headline: "No sites are selected to watch" };
  if (!working) return { ...base, level: "down", headline: `Not watching any sites right now (${ago})` };
  const sites = (n) => `${n} ${n === 1 ? "site" : "sites"}`;
  const level = !notOk.length ? "ok" : troubled ? "partial" : "catching-up";
  const headline = working === rows.length ? `Watching ${sites(working)} · last check ${ago}` : `Watching ${working} of ${sites(rows.length)} · last check ${ago}`;
  return { ...base, level, headline };
}

// What the admin sends to someone they have just added (or whose password they have reset).
export function inviteText({ url, username, password, reset = false }) {
  const lines = [
    reset ? "Your Rental Watch password has been reset." : "I've set you up on Rental Watch. It tells you when a new place near campus is listed.",
    "",
    `Open: ${url}`,
    `Username: ${username}`,
    `Password: ${password}`,
  ];
  if (!reset) {
    lines.push(
      "",
      "On an iPhone:",
      "1. Copy the link into Safari (a link opened inside WhatsApp or Messages can't be added to your Home Screen).",
      "2. Tap Share, then Add to Home Screen.",
      "3. Open Rental Watch from your Home Screen and log in again (it's a separate app to Safari).",
      "4. Choose your campus, then tap Turn on alerts.",
      "",
      "You can change your password any time under Alerts.",
    );
  }
  return lines.join("\n");
}

// Where this device stands on getting alerts. "on" and "viewing" need no prompt; the rest each have their own message.
export function alertsSetup({ viewing, isIos, standalone, supported, permission, subscribedHere }) {
  if (viewing) return "viewing";
  if (isIos && !standalone) return "install";
  if (!supported) return "unsupported";
  if (permission === "denied") return "blocked";
  if (permission === "granted" && subscribedHere) return "on";
  return "off";
}

// The listing an alert pointed at: "?listing=daft%3A123" -> "daft:123".
export function listingFromSearch(search) {
  const id = new URLSearchParams(search).get("listing");
  return id ? id : null;
}
