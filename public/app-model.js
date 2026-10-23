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

// What the admin sends to someone they have just added, or a fresh link: one link that signs them in, and nothing to
// remember. `link` is the full address.
export function linkInviteText({ name, link, fresh = false }) {
  const hi = name ? `Hi ${name.split(/\s+/)[0]}, ` : "";
  return [
    fresh
      ? `${hi}${hi ? "here's" : "Here's"} a new link for ASAP accommodation.`
      : `${hi}I've set you up on ASAP accommodation. It tells you when a new place to rent near your college is listed, so you don't have to keep checking Daft and the rest.`,
    "",
    "Open this on your phone to get started. It signs you in, so there's no password:",
    link,
    "",
    "On an iPhone, open it in Safari. The link works for 2 weeks.",
  ].join("\n");
}

// What the admin sends to someone whose password they have just set or reset. Adding someone sends a link instead.
export function inviteText({ url, username, password }) {
  return ["Your ASAP accommodation password has been changed.", "", `Open: ${url}`, `Username: ${username}`, `Password: ${password}`].join("\n");
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

// The sign-in link a page was opened with: "?join=<token>" -> "<token>", or null.
export function joinFromSearch(search) {
  const token = new URLSearchParams(search).get("join");
  return token && /^[A-Za-z0-9_-]{20,64}$/.test(token) ? token : null;
}

// The address without what was only there to be read once (an alert's listing, a sign-in link).
export function cleanSearch(search) {
  const params = new URLSearchParams(search);
  params.delete("listing");
  params.delete("join");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

// What kind of device and browser this is, for saying how to get alerts on it. iPads that ask for desktop pages say they
// are a Mac, but have a touch screen. Only Safari can add a page to an iPhone's Home Screen with the steps the app shows,
// and apps like Instagram or Facebook open links in a browser of their own that can't at all.
export function devicePlatform({ ua = "", standalone = false, touchPoints = 0 }) {
  const ipad = /ipad/i.test(ua) || (/macintosh/i.test(ua) && touchPoints > 1);
  const ios = ipad || /iphone|ipod/i.test(ua);
  const android = /android/i.test(ua);
  const inApp = /FBAN|FBAV|Instagram|Line\/|Snapchat|LinkedInApp|GSA\//i.test(ua) || (ios && !/Safari\//.test(ua));
  const otherBrowser = ios && /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua);
  const safari = ios && !inApp && !otherBrowser;
  // Safari's own version ("Version/26.0"). Safari 26 reports an older iOS number, so this is what says how it looks.
  const version = safari ? Number(/Version\/(\d+)/.exec(ua)?.[1]) || null : null;
  return { ios, ipad, android, standalone, safari, safariVersion: version, inApp: !standalone && inApp, otherBrowser };
}

// How this device gets ASAP accommodation onto its Home Screen:
//   "installed"      it is running from the Home Screen already
//   "ios-safari"     Safari on an iPhone or iPad: no page can do it there, so the person is shown the taps
//   "ios-elsewhere"  another browser, or an app's own browser, on iOS: it has to be opened in Safari first
//   "prompt"         the browser has offered to install it, so one tap does it (Chrome, Edge, Samsung Internet on Android)
//   "android-menu"   Android without that offer (yet, or in that browser): from the browser's menu
//   "none"           a computer: not worth asking about
export function homeScreenMode({ platform, canPrompt = false }) {
  if (platform.standalone) return "installed";
  if (platform.ios) return platform.safari ? "ios-safari" : "ios-elsewhere";
  if (canPrompt) return "prompt";
  if (platform.android) return "android-menu";
  return "none";
}

// Where Safari keeps Share, which decides the steps and where the arrow points. Safari 26 on an iPhone puts it behind
// the ⋯ button at the bottom right (unless the tab bar has been set to the older layout); before that it sat in the middle
// of the bottom toolbar; an iPad has it at the top right.
export function safariLayout(platform) {
  if (platform.ipad) return "ipad";
  return (platform.safariVersion ?? 0) >= 26 ? "compact" : "classic";
}

// --- The guided setup --------------------------------------------------------------------------------------------------
// A few plain questions stand in for the preferences form. Each answer maps onto preferences and back, so Settings shows
// the same questions with the person's answers, and the full form stays for anyone who wants it.

export const ROOM_SECTIONS = ["sharing", "student-accommodation-to-share"];
export const WHOLE_SECTIONS = ["residential-to-rent"];

export const KINDS = [
  { id: "room", title: "A room", sub: "In a shared house or apartment" },
  { id: "whole", title: "A whole place", sub: "A house or apartment to myself, or with friends" },
  { id: "either", title: "Either is fine", sub: "Show me both" },
];

export function kindOf(sections = []) {
  const room = sections.some((s) => ROOM_SECTIONS.includes(s));
  const whole = sections.some((s) => WHOLE_SECTIONS.includes(s));
  return room && whole ? "either" : whole ? "whole" : "room";
}

export const sectionsFor = (kind) => (kind === "room" ? [...ROOM_SECTIONS] : kind === "whole" ? [...WHOLE_SECTIONS] : [...ROOM_SECTIONS, ...WHOLE_SECTIONS]);

// Monthly rents worth offering as one tap, by kind of place. Anything else can be typed.
export const BUDGETS = { room: [500, 650, 800, 1000], whole: [1200, 1600, 2000, 2500], either: [700, 1000, 1500, 2000] };

export const euro = (n) => `€${Number(n).toLocaleString("en-IE")}`;

export function answersFromPrefs(prefs) {
  return {
    kind: kindOf(prefs.sections),
    budget: prefs.priceMax ?? null,
    moveIn: prefs.needFrom || "",
    stayUntil: prefs.stayUntil || "",
    liveIn: prefs.excludeOwnerOccupied === false,
    weekdays: prefs.excludeWeekdayOnly === false,
    radiusKm: prefs.radiusKm,
    transit: prefs.transitEnabled !== false,
  };
}

// The preferences a set of answers stands for. Only what the questions ask about; everything else is left as it is.
export function prefsFromAnswers(a) {
  const out = {
    sections: sectionsFor(a.kind),
    priceMax: a.budget ?? null,
    needFrom: a.moveIn || "",
    stayUntil: a.stayUntil || "",
    excludeOwnerOccupied: !a.liveIn,
    excludeWeekdayOnly: !a.weekdays,
  };
  if (a.radiusKm !== undefined) out.radiusKm = a.radiusKm;
  if (a.transit !== undefined) out.transitEnabled = a.transit;
  return out;
}

// The questions to ask, in order. Living with the owner and weekday-only lets are about rooms, so someone after a whole
// place isn't asked.
export const setupQuestions = (answers) => ["campus", "kind", "budget", "dates", ...(answers.kind === "whole" ? [] : ["sharing"])];

// The end of the academic year the default "stay until" date is in, for offering it by name.
export function collegeYearEnd(today = new Date()) {
  const y = today.getUTCFullYear() + (today.getUTCMonth() >= 6 ? 1 : 0);
  return `${y}-06-30`;
}

const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// The answers as short sentences, for the Settings summary. `campus` is { short, name }; `maxKm` the campus's limit.
export function describeAnswers(a, campus, { transitMaxKm } = {}) {
  const where = campus?.short ?? "your campus";
  return {
    kind: { room: "A room in a shared place", whole: "A whole house or apartment", either: "A room or a whole place" }[a.kind],
    budget: a.budget ? `Up to ${euro(a.budget)} a month` : "Any price",
    dates: `${a.moveIn ? `From ${fmt(a.moveIn)}` : "As soon as possible"}, ${a.stayUntil ? `until ${fmt(a.stayUntil)}` : "for as long as I like"}`,
    sharing: [a.liveIn ? "Living with the owner is fine" : "Not with a live-in owner", a.weekdays ? "weekdays only is fine" : "7 days a week"].join(" · "),
    distance: `Within ${a.radiusKm} km of ${where}${a.transit && transitMaxKm ? `, or up to ${transitMaxKm} km on a direct bus or train` : ""}`,
  };
}

// The distances worth offering as one tap, up to the campus's limit.
export const distanceChoices = (maxKm) => [1, 2, 3, 5].filter((km) => km <= maxKm);
