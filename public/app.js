import { h, timeAgo, modeIcon, describeMatch, badgeRow, leadRow, listingImage, icon, transitRow, brand, penRing, isNewMatch } from "./ui.js";
import { alertsSetup, answersFromPrefs, cleanSearch, describeAnswers, devicePlatform, homeScreenMode, inviteText, joinFromSearch, linkInviteText, listingFromSearch, safariLayout, summarizeSources } from "./app-model.js";
import { createMapView } from "./map.js";
import { alertsAsked, createSetup, iosSteps } from "./setup.js";

const root = document.getElementById("app");
let state = null;
let tab = "matches";
let view = "list";
try {
  if (localStorage.getItem("rw.view") === "map") view = "map";
} catch {}
let usersList = [];
let usersNote = null;
// Verdicts that take a listing out of the main list, each with its own collapsed section and way back.
const DISMISSED = [
  { status: "rejected", title: "Not a fit", undo: "Restore" },
  { status: "unavailable", title: "No longer available", undo: "Still available" },
];
const dismissedStatuses = new Set(DISMISSED.map((d) => d.status));
const isDismissed = (m) => dismissedStatuses.has(m.review);
const openSections = {};

let sessionEnded = false; // signed out by the server while the app was open, as opposed to never signed in
let unreachable = false; // no connection at start-up and no saved copy to show
let offline = false; // showing the last copy because the server can't be reached
let unreachableWhy = null; // set when it was the server that failed, not the connection
let loadedAt = Date.now(); // when `state` was last fetched or restored
let pushState = { supported: false, permission: "default", subscribedHere: false };
let pendingListing = listingFromSearch(location.search); // the listing an alert pointed at, until it has been shown
let arrivedId = null; // the card to highlight after arriving from an alert
let moreFor = null; // the card whose extra actions are open
let lastInvite = null; // what to send someone just added: { username, name, link } or, after a password reset, { username, password, reset }
let lastDismissAt = 0;
let pendingRefresh = false;
// What a listing's verdict was before it was dismissed, so "Restore" and "Undo" put it back as it was.
const previousReview = new Map();
// A sign-in link the page was opened with (see links.js), and what went wrong with it, for the sign-in screen.
const joinToken = joinFromSearch(location.search);
let joinError = null;
let joined = false; // signed in by that link just now, rather than already signed in
// Neither an alert's listing nor a sign-in link should stay in the address bar, where sharing the page would pass it on.
if (cleanSearch(location.search) !== location.search) history.replaceState(null, "", location.pathname + cleanSearch(location.search) + location.hash);

const SNAPSHOT_KEY = "rw.snapshot";
const ALERTS_CARD_KEY = "rw.alertsCardHidden";

// A short message that appears above the tab bar, optionally with one action (Undo). It stays in the page so a
// screen reader announces each new message.
const toast = h("div", { class: "toast", role: "status", "aria-live": "polite" });
const refreshNote = h("div", { class: "refresh-note", role: "status", "aria-live": "polite" });
document.body.append(toast, refreshNote);
let toastTimer;

function hideToast() {
  clearTimeout(toastTimer);
  toast.replaceChildren();
}

function showToast(text, action) {
  clearTimeout(toastTimer);
  toast.replaceChildren(
    ...[
      h("span", {}, text),
      action
        ? h(
            "button",
            {
              type: "button",
              onclick: () => {
                hideToast();
                action.run();
              },
            },
            action.label,
          )
        : null,
    ].filter(Boolean),
  );
  toastTimer = setTimeout(hideToast, action ? 8000 : 4000);
}

const msgBox = (cls = "") => h("div", { class: `msg ${cls}`.trim(), role: "status", "aria-live": "polite" });
const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function saveSnapshot() {
  if (!state || state.viewingAs) return;
  try {
    const { areas, vapidPublicKey, ...rest } = state;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ savedAt: Date.now(), state: rest }));
  } catch {}
}

function clearSnapshot() {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {}
}

// With no connection the last list is better than nothing: show it, say how old it is, and carry on trying.
function useSnapshot() {
  try {
    const snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY));
    // A copy saved before every account had its own campus and preferences has no `prefs`, and the screens need them.
    if (snap?.state?.user && snap.state.prefs && Array.isArray(snap.state.matches)) {
      state = { areas: {}, vapidPublicKey: null, ...snap.state };
      loadedAt = snap.savedAt;
      offline = true;
      return;
    }
  } catch {}
  unreachable = true;
}

const mapView = createMapView({
  api: (...args) => api(...args),
  onShowList: () => {
    setView("list");
    focusKey("view:list");
  },
  // Opening a listing from the map counts as having looked at it, as it does from the list.
  onOpened: (m) => openedListing(m),
});

function setView(v) {
  view = v;
  try {
    localStorage.setItem("rw.view", v);
  } catch {}
  render();
  window.scrollTo(0, 0);
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    const err = new Error("Can't reach ASAP accommodation. Check your connection and try again.");
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/api/login") {
    // Only say the session ended if there was one: a first visit gets a plain login screen.
    sessionEnded = Boolean(state);
    state = null;
    offline = false;
    unreachable = false;
    setup.reset();
    clearSnapshot();
    render();
    const err = new Error("Your session ended. Please log in again.");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.errors ? data.errors.join("; ") : data.error || `Something went wrong (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function inFuture(iso) {
  if (!iso) return "";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s < 60) return "any moment";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 2 * 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}

const kv = (k, v) => h("div", { class: "kv" }, h("span", {}, k), h("span", {}, v));

const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
const platform = devicePlatform({ ua: navigator.userAgent, standalone: isStandalone, touchPoints: navigator.maxTouchPoints ?? 0 });
const isIos = platform.ios;

// The guided setup, shown instead of the app to an account that isn't watching anywhere yet.
const setup = createSetup({
  state: () => state,
  api: (...args) => api(...args),
  loadState: () => loadState(),
  render: () => render(),
  showToast: (...args) => showToast(...args),
  platform,
  alertsMode: () => setupMode(),
  refreshPush: () => refreshPushState(),
  turnOnAlerts: () => enableAlerts(),
  prepareHomeScreen: () => prepareHomeScreen(),
  homeScreenMode: () => homeScreenMode({ platform, canPrompt: Boolean(installPrompt) }),
  promptInstall: () => promptInstall(),
  signInLink: () => signInLink(),
  waitForFirstCheck: () => waitForFirstCheck(),
  done: (where) => {
    tab = where;
    if (where === "matches") view = "list";
    settingsCache = null;
    render();
    window.scrollTo(0, 0);
  },
});

// After signing in: a new account goes through the setup, and a device that arrived by a sign-in link, or an iPhone's
// Home Screen app opened for the first time, is walked through turning on alerts.
function maybeStartSetup() {
  if (!state || state.viewingAs || setup.active()) return;
  if (!state.campus) return setup.start();
  const mode = setupMode();
  const firstTimeHere = (joined || (platform.ios && platform.standalone)) && !alertsAsked();
  if (firstTimeHere && mode === "install") setup.start({ step: "home" });
  else if (firstTimeHere && ["off", "blocked"].includes(mode)) setup.start({ step: "alerts", welcome: platform.standalone });
}

// Browsers that can install the app themselves (Chrome, Edge and Samsung Internet on Android) offer it with this event,
// once the person has spent a little while on the page. It is kept for the Add to Home Screen button, which can only use
// it once, from a tap.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  // Only screens that offer the button are drawn again, so nothing half-typed elsewhere is lost.
  if (state && (setup.active() || tab === "matches")) render();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  if (state && !setup.active() && tab === "matches") render();
});

// Opened from the Home Screen: say so, so the Safari page that showed the steps can tell the person it worked.
let homeScreenNoted = false;
function noteHomeScreen() {
  if (homeScreenNoted || !platform.standalone || !state || state.viewingAs) return;
  homeScreenNoted = true;
  api("POST", "/api/account/home-screen").catch(() => (homeScreenNoted = false));
}

async function promptInstall() {
  const offer = installPrompt;
  if (!offer) return "unavailable";
  installPrompt = null;
  try {
    await offer.prompt();
    return (await offer.userChoice).outcome;
  } catch {
    return "unavailable";
  }
}

// A link that signs this account in, for opening in Safari from another browser on the same phone. Asked for once.
let signInLinkPromise = null;
function signInLink() {
  signInLinkPromise ??= api("POST", "/api/account/link").then((r) => `${location.origin}/?join=${r.token}`);
  signInLinkPromise.catch(() => (signInLinkPromise = null));
  return signInLinkPromise;
}

// An iPhone's Home Screen app has cookies of its own, so on its first launch it isn't signed in. The manifest the app is
// added from names the address it opens at; pointing that at a sign-in link of this device's own makes it open signed in.
// The link is kept so the next visit reuses it instead of asking for another.
const DEVICE_LINK_KEY = "rw.deviceLink";
let homeScreenReady = null;
function prepareHomeScreen() {
  if (!platform.ios || platform.standalone || !state || state.viewingAs) return Promise.resolve();
  homeScreenReady ??= (async () => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(DEVICE_LINK_KEY));
    } catch {}
    let token = saved?.username === state.user.username && Date.parse(saved.expiresAt) > Date.now() + 30 * 86400_000 ? saved.token : null;
    if (!token) {
      const r = await api("POST", "/api/account/link");
      token = r.token;
      try {
        localStorage.setItem(DEVICE_LINK_KEY, JSON.stringify({ username: state.user.username, token, expiresAt: r.expiresAt }));
      } catch {}
    }
    document.querySelector('link[rel="manifest"]')?.setAttribute("href", `/manifest.webmanifest?join=${token}`);
  })().catch(() => (homeScreenReady = null));
  return homeScreenReady;
}

// Signing out leaves nothing behind that would sign this device in again.
function forgetDeviceLinks() {
  try {
    localStorage.removeItem(DEVICE_LINK_KEY);
  } catch {}
  homeScreenReady = null;
  signInLinkPromise = null;
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", "/manifest.webmanifest");
}

// Turns alerts on for this device and sends a test, for the setup's alerts step. Throws with a message to show.
async function enableAlerts() {
  await enablePush();
  await refreshPushState();
  await loadState();
  await api("POST", "/api/test-push").catch(() => null);
}

// Signs in with the link the page was opened with. In a browser tab that is what opening the link means, even when someone
// else was signed in. The Home Screen app opens at its link every time, so there it is only used when the app has lost its
// sign-in. A link that doesn't work is reported on the sign-in screen if there is no other sign-in to fall back on.
async function useJoinLink() {
  if (!joinToken) return;
  if (platform.standalone) {
    const res = await fetch("/api/state", { credentials: "same-origin" }).catch(() => null);
    if (!res || res.status !== 401) return;
  }
  try {
    await api("POST", "/api/join", { token: joinToken });
    joined = true;
    clearSnapshot();
  } catch (err) {
    if (!err.offline) joinError = err.message;
  }
}

async function loadState() {
  state = await api("GET", "/api/state");
  offline = false;
  unreachable = false;
  loadedAt = Date.now();
  saveSnapshot();
}

// What would change the list on screen. Anything else a refresh brings back can wait for the next time it is drawn.
const listSignature = () =>
  JSON.stringify([
    state?.matches.map((m) => [m.id, m.review, m.priceMonthly, m.lat, m.lng, m.areaKey, m.firstSeenAt, m.flags]),
    Object.keys(state?.areas ?? {}),
    state?.lastRun?.at,
    state?.config?.enabled,
  ]);

async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "open-listing") openListing(e.data.listing);
    });
  }
  await useJoinLink();
  try {
    await loadState();
    await refreshPushState();
    syncSubscription();
  } catch (err) {
    state = null;
    // Only a 401 means "not signed in" (and api() has already shown the login for it). Anything else, a connection that
    // isn't there or a server that is having a bad moment, shows the saved list or a "can't reach" screen, never a
    // login screen that asks for a password the person may not remember.
    if (err.status !== 401) {
      useSnapshot();
      unreachableWhy = err.offline ? null : "ASAP accommodation isn't responding properly right now.";
    }
  }
  noteHomeScreen();
  maybeStartSetup();
  render();
  // Signed in already, so an old link that didn't work changes nothing; say so rather than leave them wondering.
  if (state && joinError) showToast(`That sign-in link didn't work, so you're still signed in as ${state.user.name ?? state.user.username}.`);
  if (state && pendingListing) openListing(pendingListing);
  setInterval(refresh, 60_000);
  document.addEventListener("visibilitychange", () => !document.hidden && refresh());
  window.addEventListener("online", () => refresh());
}

// Fetches the latest state, on a timer, when the app is brought back to the front, and when the connection returns.
// If the list is changing under someone who has scrolled down, it offers the update instead of moving things around.
async function refresh({ manual = false } = {}) {
  if (document.hidden && !manual) return;
  if (!state && !unreachable) return;
  const before = listSignature();
  const wasOffline = offline || unreachable;
  try {
    await loadState();
  } catch (err) {
    if (err.offline && state && !offline) {
      offline = true;
      render();
    }
    if (manual) throw err;
    return;
  }
  if (wasOffline) {
    await refreshPushState();
    noteHomeScreen();
    maybeStartSetup();
    render();
    if (pendingListing) openListing(pendingListing);
    return;
  }
  // The setup has fields being filled in; it draws itself again when it needs to.
  if (setup.active()) return;
  if (tab !== "matches" || before === listSignature()) return;
  if (view === "list" && window.scrollY > 160) {
    pendingRefresh = true;
    refreshNote.replaceChildren(
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            pendingRefresh = false;
            refreshNote.replaceChildren();
            render();
            window.scrollTo(0, 0);
          },
        },
        "Matches updated · Show",
      ),
    );
    return;
  }
  render();
}

// Drawing the page again throws its controls away, which would send keyboard and screen-reader focus back to the top
// after every tap. Controls that get used one after another carry a key (data-fk); once the new page is drawn, focus
// goes back to the one that had it.
function render() {
  const key = document.activeElement?.dataset?.fk;
  if (pendingRefresh) {
    pendingRefresh = false;
    refreshNote.replaceChildren();
  }
  const inSetup = Boolean(state) && setup.active();
  root.classList.toggle("wide", Boolean(state) && !inSetup && tab === "matches" && view === "map");
  document.body.classList.toggle("in-setup", inSetup);
  root.replaceChildren(inSetup ? setup.render() : state ? renderMain() : unreachable ? renderUnreachable() : renderLogin());
  if (key) focusKey(key);
}

function focusKey(key) {
  root.querySelector('[data-fk="' + CSS.escape(key) + '"]')?.focus({ preventScroll: true });
}

// Whether this device can get alerts, and whether it is already set up for them.
async function refreshPushState() {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  let subscribedHere = false;
  if (supported && permission === "granted") {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      subscribedHere = Boolean(await reg?.pushManager.getSubscription());
    } catch {}
  }
  pushState = { supported, permission, subscribedHere };
}

// Shows the listing an alert pointed at: on the Matches list, scrolled to and highlighted. A listing that has only just
// appeared isn't in the copy of the list this device holds, so it asks for the latest before saying the listing has gone.
async function openListing(id) {
  if (!id) return;
  if (!state) {
    // Signed out, or no connection and nothing saved: show it once that is sorted out, rather than losing it.
    pendingListing = id;
    return;
  }
  pendingListing = null;
  let m = state.matches.find((x) => x.id === id);
  let cantReach = false;
  if (!m) {
    try {
      await refresh({ manual: true });
    } catch (err) {
      cantReach = Boolean(err.offline);
    }
    if (!state) {
      pendingListing = id; // the refresh found the session had ended
      return;
    }
    m = state.matches.find((x) => x.id === id);
  }
  tab = "matches";
  view = "list";
  if (!m) {
    render();
    showToast(cantReach ? "Can't reach ASAP accommodation to find that listing. Try again in a moment." : "That listing is no longer in your matches.");
    return;
  }
  if (isDismissed(m)) openSections[m.review] = true;
  arrivedId = m.id;
  render();
  const card = [...root.querySelectorAll(".card")].find((el) => el.dataset.id === m.id);
  card?.scrollIntoView({ block: "start" });
  card?.focus({ preventScroll: true });
  setTimeout(() => {
    if (arrivedId === m.id) arrivedId = null;
    card?.classList.remove("arrived");
  }, 6000);
}

function renderLogin() {
  const msg = msgBox("err");
  msg.setAttribute("role", "alert");
  if (sessionEnded) msg.textContent = "You've been signed out. Sign in again below, or use your link again.";
  const name = h("input", { type: "text", placeholder: "Username", "aria-label": "Username", autocomplete: "username", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const input = h("input", { type: "password", placeholder: "Password", "aria-label": "Password", autocomplete: "current-password" });
  const submit = h("button", { class: "primary", type: "submit" }, "Sign in");
  // Most people never had a password: they were sent a link. So the link comes first, and what to do when it has run out.
  const linkNote = joinError
    ? h(
        "div",
        { class: "panel setup link-problem", role: "alert" },
        h("h2", {}, "That link didn't work"),
        h("p", {}, joinError),
        platform.standalone ? h("p", { class: "hint" }, "When you get the new link, open it in Safari and add ASAP to your Home Screen again (you can delete this one).") : null,
      )
    : h("p", { class: "hint" }, "Were you sent a link? Tap it again on this device and you'll be signed in. Otherwise, use your username and password.");
  const form = h(
    "form",
    {
      class: "login",
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        msg.textContent = "";
        try {
          await api("POST", "/api/login", { username: name.value, password: input.value });
          sessionEnded = false;
          joinError = null;
          await loadState();
          await refreshPushState();
          tab = "matches";
          noteHomeScreen();
          maybeStartSetup();
          render();
          syncSubscription();
          if (pendingListing) openListing(pendingListing);
        } catch (err) {
          msg.textContent = sentence(err.message);
          submit.disabled = false;
        }
      },
    },
    brand("h1"),
    h("div", { class: "rules", "aria-hidden": "true" }),
    h("p", { class: "lede" }, "Alerts for new rentals near your college."),
    linkNote,
    name,
    input,
    submit,
    msg,
  );
  return form;
}

// Start-up with no connection and nothing saved to show.
function renderUnreachable() {
  const msg = msgBox("err");
  return h(
    "div",
    { class: "login" },
    brand("h1"),
    h("div", { class: "rules", "aria-hidden": "true" }),
    h("p", { class: "lede" }, unreachableWhy ?? "Can't reach ASAP accommodation."),
    h("p", { class: "hint" }, unreachableWhy ? "It should come back on its own. This will keep trying, or you can try now." : "Check your connection. This will keep trying on its own, or you can try now."),
    h(
      "button",
      {
        class: "primary",
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await refresh({ manual: true });
          } catch (err) {
            msg.textContent = err.message;
            e.target.disabled = false;
          }
        },
      },
      "Try again",
    ),
    msg,
  );
}

async function loadUsers() {
  usersList = (await api("GET", "/api/users")).users;
}

async function stopViewing() {
  try {
    await api("DELETE", "/api/view-as");
    await loadState();
    // Back where the admin came from, not on a tab about their own devices.
    tab = "users";
    await loadUsers().catch(() => {});
    render();
    window.scrollTo(0, 0);
    focusKey("tab:users");
  } catch {}
}

function renderMain() {
  // Everyone has a search of their own, so everyone has Settings; only the admin manages users.
  const admin = state.user.isAdmin;
  const tabs = [["matches", "Matches", "column", state.matches.filter((m) => !isDismissed(m)).length], ["settings", "Settings", "sliders"], ["alerts", "Alerts", "bell"]];
  if (admin) tabs.push(["users", "Users", "users"]);
  if (tab === "users" && !admin) tab = "matches";
  const content = tab === "matches" ? renderMatches() : tab === "settings" ? renderSettings() : tab === "users" ? renderUsers() : renderAlerts();
  const c = state.config;
  return h(
    "div",
    {},
    state.viewingAs
      ? h(
          "div",
          { class: "viewing" },
          h("span", {}, `Viewing as ${state.viewingAs.username}`),
          h("button", { class: "secondary", onclick: stopViewing }, "Exit"),
        )
      : null,
    offline
      ? h(
          "div",
          { class: "offline", role: "status" },
          icon("alert"),
          h("span", {}, `Can't reach ASAP accommodation. Showing the list from ${timeAgo(new Date(loadedAt).toISOString())}.`),
          h(
            "button",
            {
              class: "linklike",
              onclick: async (e) => {
                e.target.disabled = true;
                await refresh({ manual: true }).catch(() => {});
                if (offline) {
                  e.target.disabled = false;
                  showToast("Still can't reach ASAP accommodation.");
                }
              },
            },
            "Try again",
          ),
        )
      : null,
    h(
      "header",
      { class: "masthead" },
      brand("h1"),
      h("div", { class: "rules", "aria-hidden": "true" }),
      h("div", { class: "edition" }, h("span", {}, c ? `Within ${c.radiusKm} km of ${c.center.label}` : "Choose your campus")),
    ),
    h("main", {}, content),
    h(
      "nav",
      { class: "tabs", "aria-label": "Sections" },
      tabs.map(([id, label, glyph, count]) =>
        h(
          "button",
          {
            type: "button",
            class: tab === id ? "active" : "",
            "aria-current": tab === id ? "page" : false,
            "data-fk": "tab:" + id,
            onclick: async () => {
              tab = id;
              if (id === "users") {
                usersNote = null;
                await loadUsers().catch((err) => (usersNote = { text: err.message, ok: false }));
              }
              render();
              window.scrollTo(0, 0);
            },
          },
          icon(glyph, 22),
          h("span", { class: "tab-label" }, label, count === undefined ? null : h("span", { class: "count" }, String(count))),
        ),
      ),
    ),
  );
}

// Until a campus is chosen there is nothing to watch. This is the first thing a new account sees.
function renderCampusPrompt() {
  if (state.viewingAs) return h("div", { class: "empty" }, `${state.viewingAs.username} hasn't chosen a campus yet, so nothing is being watched for them.`);
  return h(
    "section",
    { class: "panel setup", "aria-label": "Get started" },
    h("h2", {}, "Let's get you set up"),
    h("p", {}, "ASAP accommodation looks for places near your college and tells you when a new one is listed. A few quick questions and it starts watching."),
    h("button", { class: "primary", type: "button", "data-fk": "setup:begin", onclick: () => setup.start() }, "Get started"),
  );
}

function renderMatches() {
  if (!state.config) return renderCampusPrompt();
  const toggle = h(
    "div",
    { class: "seg", role: "group", "aria-label": "Matches view" },
    [["list", "List"], ["map", "Map"]].map(([id, label]) =>
      h("button", { type: "button", class: view === id ? "active" : "", "aria-pressed": String(view === id), "data-fk": "view:" + id, onclick: () => view !== id && setView(id) }, label),
    ),
  );
  // The head of the column: what it is, how many places are in it and how many are new, and the way to the map.
  const active = state.matches.filter((m) => !isDismissed(m));
  const fresh = active.filter(isNewMatch).length;
  const head = h(
    "div",
    { class: "colhead" },
    h("div", {}, h("h2", {}, "To let"), h("span", { class: "tally" }, `${active.length} ${active.length === 1 ? "place" : "places"}${fresh ? ` · ${fresh} new` : ""}`)),
    toggle,
  );
  if (view === "map") {
    mapView.update({ ...state, matches: active });
    return [head, mapView.el];
  }
  return [renderAlertsCard(), renderInstallOffer(), head, renderSourceStrip(), ...[renderList()].flat()];
}

// Sets (or, with null, clears) the user's verdict on a match. Updates the screen first and puts it back if the server
// says no. Looks the listing up by id because the list may have been refreshed since the button was drawn.
async function setReview(id, status) {
  const m = state?.matches.find((x) => x.id === id);
  if (!m) return false;
  const before = m.review ?? null;
  m.review = status;
  m.reviewError = null;
  render();
  try {
    await api("PUT", "/api/review", { id, status });
    saveSnapshot();
    return true;
  } catch (err) {
    m.review = before;
    m.reviewError = err.message;
    render();
    return false;
  }
}

// Takes a listing out of the main list and says where it went, with a way to put it straight back.
async function dismiss(m, status) {
  // The next card slides up under the same thumb position, so a second tap straight after is almost always a slip.
  if (Date.now() - lastDismissAt < 600) return;
  lastDismissAt = Date.now();
  const before = m.review ?? null;
  previousReview.set(m.id, before);
  moreFor = null;
  const title = DISMISSED.find((d) => d.status === status).title;
  // The card this one makes way for, so keyboard focus carries on down the list.
  const active = state.matches.filter((x) => !isDismissed(x));
  const at = active.findIndex((x) => x.id === m.id);
  const next = active[at + 1] ?? active[at - 1];
  if (await setReview(m.id, status)) {
    showToast(`Moved to ${title}`, {
      label: "Undo",
      run: async () => {
        if (await setReview(m.id, before)) focusKey(m.id + ":open");
      },
    });
    if (next && document.activeElement === document.body) focusKey(next.id + ":open");
  }
}

// Strikes the ad out in pen, then puts it away, as you'd cross one out in the paper. Without motion, straight away. A
// second tap in the meantime is caught by dismiss()'s own guard.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
function strikeOut(e, m, status) {
  const card = e.currentTarget.closest(".card");
  if (reducedMotion.matches || !card) return dismiss(m, status);
  card.classList.add("striking");
  setTimeout(() => dismiss(m, status), 260);
}

async function restore(m) {
  if (await setReview(m.id, previousReview.get(m.id) ?? null)) {
    showToast("Back in your matches.");
    focusKey(m.id + ":open");
  }
}

// Going to the listing's own site is the natural "I've looked at this", so it marks the card seen.
function openedListing(m) {
  // Looking at someone else's list is not them having looked.
  if (m.review || state.viewingAs) return;
  // After the browser has followed the link: re-drawing the list first could swallow the click.
  setTimeout(() => setReview(m.id, "seen"), 0);
}

// One line saying whether the sites are being checked, so that no news can be read as no news and not as a silent failure.
function renderSourceStrip() {
  const s = summarizeSources(state);
  const admin = state.user.isAdmin;
  const iconName = s.level === "ok" ? "check" : ["none", "paused", "catching-up"].includes(s.level) ? "pause" : "alert";
  const note = admin ? s.note : s.plainNote;
  return h(
    "div",
    { class: `strip ${s.level}` },
    icon(iconName),
    h(
      "div",
      { class: "strip-text" },
      h("div", { class: "strip-head" }, s.headline),
      note ? h("div", { class: "strip-issue" }, note) : null,
      admin && s.level !== "ok" && s.level !== "none"
        ? h(
            "button",
            {
              class: "linklike",
              "data-fk": "strip:details",
              onclick: () => {
                openSections.scanner = true;
                tab = "alerts";
                render();
                const panel = root.querySelector("details.scanner");
                panel?.scrollIntoView({ block: "start" });
                panel?.querySelector("summary")?.focus({ preventScroll: true });
              },
            },
            "Scanner details",
          )
        : null,
    ),
  );
}

// "Not now" puts the card away for a few days; a device that still isn't getting alerts is asked again after that.
const ALERTS_CARD_QUIET_MS = 3 * 24 * 3600 * 1000;
const hideAlertsCard = () => {
  try {
    const at = Number(localStorage.getItem(ALERTS_CARD_KEY));
    return at > 0 && Date.now() - at < ALERTS_CARD_QUIET_MS;
  } catch {
    return false;
  }
};

const setupMode = () => alertsSetup({ ...pushState, viewing: Boolean(state.viewingAs), isIos, standalone: isStandalone });

// The three steps to put the app on an iPhone's Home Screen, which is the only way an iPhone can receive alerts. The app
// added from here opens signed in (prepareHomeScreen).
function installSteps() {
  prepareHomeScreen();
  if (!platform.safari) return h("p", { class: "hint" }, "Open this page in Safari first: only Safari can add it to your Home Screen.");
  return iosSteps(safariLayout(platform));
}

// On Android, where the browser can install the app with one tap, a quiet offer above the list until it is taken or put away.
const INSTALL_CARD_KEY = "rw.installCardHidden";
function renderInstallOffer() {
  if (!installPrompt || platform.ios || state.viewingAs) return null;
  try {
    if (Number(localStorage.getItem(INSTALL_CARD_KEY)) > Date.now() - 14 * 86400_000) return null;
  } catch {}
  return h(
    "div",
    { class: "strip quiet install-offer" },
    icon("add-home"),
    h(
      "div",
      { class: "strip-text" },
      h("span", { class: "strip-head" }, "Put ASAP on your Home Screen"),
      h(
        "span",
        {},
        h(
          "button",
          {
            class: "linklike",
            "data-fk": "install:add",
            onclick: async () => {
              const outcome = await promptInstall();
              render();
              if (outcome === "accepted") showToast("Added. Open ASAP from your Home Screen any time.");
            },
          },
          "Add",
        ),
        h(
          "button",
          {
            class: "linklike",
            "data-fk": "install:later",
            onclick: () => {
              try {
                localStorage.setItem(INSTALL_CARD_KEY, String(Date.now()));
              } catch {}
              render();
            },
          },
          "Not now",
        ),
      ),
    ),
  );
}

const blockedSteps = () =>
  h(
    "div",
    { class: "hint" },
    isIos
      ? "Open Settings, then Notifications, then ASAP, and switch on Allow Notifications. Then come back here."
      : "Allow notifications for this site in your browser's site settings, then reload this page.",
  );

// Getting alerts is the point of the app, so a device that isn't set up is told so at the top of the first screen.
function renderAlertsCard() {
  const mode = setupMode();
  if (!["install", "off", "blocked"].includes(mode)) return null;
  // Put away with "Not now": one quiet line stays, so silence can't be mistaken for there being nothing new.
  if (hideAlertsCard()) {
    return h(
      "div",
      { class: "strip quiet" },
      icon("pause"),
      h(
        "div",
        { class: "strip-text" },
        h("span", { class: "strip-head" }, "Alerts are off on this phone"),
        h(
          "button",
          {
            class: "linklike",
            "data-fk": "alerts:setup",
            onclick: () => {
              try {
                localStorage.removeItem(ALERTS_CARD_KEY);
              } catch {}
              render();
            },
          },
          "Set up",
        ),
      ),
    );
  }
  const msg = msgBox("err");
  const notNow = h(
    "button",
    {
      class: "linklike",
      "data-fk": "alerts:not-now",
      onclick: () => {
        try {
          localStorage.setItem(ALERTS_CARD_KEY, String(Date.now()));
        } catch {}
        render();
        focusKey("view:list");
      },
    },
    "Not now",
  );
  if (mode === "install") {
    return h("section", { class: "panel setup notice", "aria-label": "Get alerts" }, h("h2", {}, icon("bell"), "Get alerts on your iPhone"), h("p", {}, "ASAP accommodation can only send alerts once it is on your Home Screen."), installSteps(), h("div", { class: "hint" }, "Needs iOS 16.4 or later."), notNow);
  }
  if (mode === "blocked") {
    return h("section", { class: "panel setup notice", "aria-label": "Get alerts" }, h("h2", {}, icon("alert"), "Alerts are blocked on this device"), blockedSteps(), notNow);
  }
  return h(
    "section",
    { class: "panel setup notice", "aria-label": "Get alerts" },
    h("h2", {}, icon("bell"), "Turn on alerts"),
    h("p", {}, "Get a notification on this device when a new place matches."),
    h(
      "button",
      {
        class: "primary",
        onclick: (e) => {
          e.target.disabled = true;
          turnOnAlerts(msg).finally(() => (e.target.disabled = false));
        },
      },
      "Turn on alerts",
    ),
    notNow,
    msg,
  );
}

function renderList() {
  if (!state.matches.length) {
    const ran = state.lastRun;
    return h("div", { class: "empty" }, ran ? "No matching listings right now. You'll get an alert when a new place appears." : "Waiting for the first check. Places that match will appear here.");
  }
  const active = state.matches.filter((m) => !isDismissed(m));
  return [
    ...(active.length ? active.map(renderCard) : [h("div", { class: "empty" }, "Nothing left to look at. Everything here has been put away.")]),
    ...DISMISSED.map(({ status, title }) => {
      const group = state.matches.filter((m) => m.review === status);
      return group.length
        ? h(
            "details",
            { class: "dismissed", open: openSections[status] === true, ontoggle: (e) => (openSections[status] = e.target.open) },
            h("summary", {}, `${title} (${group.length})`),
            group.map(renderCard),
          )
        : null;
    }),
  ];
}

function renderCard(m) {
  const seen = m.review === "seen";
  const dismissed = DISMISSED.find((d) => d.status === m.review);
  const d = describeMatch(m, state.config);
  const more = moreFor === m.id;
  // Every card repeats the same buttons, so each is named with its listing for anyone who can't see the card around it.
  const named = (label) => label + ": " + m.title;
  // The admin viewing as someone can open a listing but can't put it away or mark it for them.
  const viewing = Boolean(state.viewingAs);
  // A place not yet looked at runs as a display ad, photo across the top; once it has a mark it becomes a line ad.
  const cls = ["card", m.review, m.review ? "line" : null, d.isNew ? "fresh" : null, m.id === arrivedId ? "arrived" : null].filter(Boolean).join(" ");
  const lead = leadRow(d);
  // The listing an alert pointed at has its price circled in pen.
  if (m.id === arrivedId) lead.querySelector(".price")?.append(penRing());
  return h(
    "article",
    { class: cls, "data-id": m.id, tabindex: "-1", "aria-label": d.price + ", " + m.title },
    listingImage(m),
    h("div", { class: "body" }, lead, h("div", { class: "title" }, m.title), h("div", { class: "meta" }, d.meta), d.transit.map(transitRow), badgeRow(d.badges)),
    h(
      "div",
      { class: "actions" },
      viewing
        ? h("a", { class: "act open", href: m.url, target: "_blank", rel: "noopener noreferrer", "aria-label": named(`Open on ${m.sourceLabel}`) }, `Open on ${m.sourceLabel}`, icon("external"))
        : dismissed
        ? h("button", { class: "act restore", "aria-label": named(dismissed.undo), "data-fk": m.id + ":restore", onclick: () => restore(m) }, dismissed.undo)
        : [
            h("a", { class: "act open", href: m.url, target: "_blank", rel: "noopener noreferrer", "aria-label": named(`Open on ${m.sourceLabel}`), "data-fk": m.id + ":open", onclick: () => openedListing(m) }, `Open on ${m.sourceLabel}`, icon("external")),
            h("button", { class: "act", "aria-label": named("Not a fit"), "data-fk": m.id + ":rejected", onclick: (e) => strikeOut(e, m, "rejected") }, "Not a fit"),
            h(
              "button",
              {
                class: "act",
                "aria-label": named(more ? "Less options" : "More options"),
                "data-fk": m.id + ":more",
                "aria-expanded": String(more),
                onclick: () => {
                  moreFor = more ? null : m.id;
                  render();
                },
              },
              more ? "Less" : "More",
            ),
            more
              ? [
                  h(
                    "button",
                    {
                      class: "act extra",
                      "aria-label": named(seen ? "Mark as unseen" : "Mark as seen"),
                      "data-fk": m.id + ":seen",
                      onclick: () => {
                        moreFor = null;
                        setReview(m.id, seen ? null : "seen");
                        focusKey(m.id + ":more");
                      },
                    },
                    seen ? "Mark as unseen" : "Mark as seen",
                  ),
                  h("button", { class: "act extra", "aria-label": named("No longer available"), "data-fk": m.id + ":unavailable", onclick: (e) => strikeOut(e, m, "unavailable") }, "No longer available"),
                ]
              : null,
          ],
    ),
    m.reviewError ? h("div", { class: "msg err card-msg", role: "alert" }, `Couldn't save that: ${m.reviewError}`) : null,
  );
}

// Moves to another campus, which starts watching there afresh, then shows the first matches (or says they are on their
// way). A new account chooses its first campus in the guided setup instead.
function renderCampusPicker() {
  const msg = msgBox();
  const current = state.campus?.id ?? null;
  let picked = current;
  const groups = new Map();
  for (const c of state.searchCampuses) groups.set(c.region, [...(groups.get(c.region) ?? []), c]);
  const go = h("button", { class: "primary", type: "button", disabled: true }, "Switch campus");
  const choose = (id) => {
    picked = id;
    go.disabled = picked === current;
    msg.textContent = "";
  };
  const list = [...groups].map(([region, campuses]) =>
    h(
      "fieldset",
      { class: "campuses" },
      h("legend", {}, region),
      campuses.map((c) =>
        h(
          "label",
          { class: "check" },
          h("input", { type: "radio", name: "campus", value: c.id, checked: c.id === current, onchange: () => choose(c.id) }),
          c.name,
        ),
      ),
    ),
  );
  go.addEventListener("click", async () => {
    go.disabled = true;
    msg.className = "msg";
    msg.textContent = "Setting up...";
    try {
      const r = await api("PUT", "/api/campus", { campus: picked });
      await loadState();
      settingsCache = null;
      tab = "matches";
      view = "list";
      render();
      window.scrollTo(0, 0);
      showToast(r.matched ? `Now watching near ${r.campus.short}.` : `Now watching near ${r.campus.short}. The first check is on its way.`);
      if (!r.matched) waitForFirstCheck();
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
      go.disabled = false;
    }
  });
  return [
    list,
    h("div", { class: "hint" }, "Switching clears your current list and starts fresh, so you aren't alerted to places that were already listed."),
    go,
    msg,
  ];
}

// After choosing a campus whose first check hasn't run yet, look again every few seconds for a while, so the first matches
// appear without the person having to come back to the app.
let waitingForFirstCheck = false;
async function waitForFirstCheck() {
  if (waitingForFirstCheck) return;
  waitingForFirstCheck = true;
  try {
    for (let i = 0; i < 24 && state && !state.lastRun; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await loadState();
      if (state.lastRun && (tab === "matches" || setup.active())) render();
    }
  } catch {
    /* the regular refresh carries on */
  } finally {
    waitingForFirstCheck = false;
  }
}

// The campus the account is watching, and the way to change it.
function renderCampusPanel() {
  const viewing = Boolean(state.viewingAs);
  const c = state.campus;
  return h(
    "div",
    { class: "panel" },
    h("h2", {}, "Your campus"),
    c
      ? [
          kv("Watching near", c.name),
          state.config ? kv("Within", `${state.config.radiusKm} km`) : null,
          viewing ? null : h("details", {}, h("summary", {}, "Change campus"), renderCampusPicker()),
        ]
      : viewing
        ? h("div", { class: "hint" }, `${state.viewingAs.username} hasn't chosen a campus yet.`)
        : [h("div", { class: "hint" }, "Choose the college you want places near."), h("button", { class: "primary", type: "button", onclick: () => setup.start() }, "Get started")],
  );
}

function renderSettings() {
  const admin = state.user.isAdmin && !state.viewingAs;
  return [
    renderCampusPanel(),
    state.config ? renderSearchSummary() : null,
    state.config
      ? h(
          "details",
          { class: "all-settings", open: openSections.allSettings === true, ontoggle: (e) => (openSections.allSettings = e.target.open) },
          h("summary", {}, "All settings"),
          h("div", { class: "hint" }, "Every option, including price ranges, bedrooms, keywords and public transport."),
          renderPrefs(),
        )
      : null,
    admin ? renderRegions() : null,
  ];
}

// What the account is looking for, in the words of the setup questions, each with a way to change just that answer.
function renderSearchSummary() {
  const viewing = Boolean(state.viewingAs);
  const answers = answersFromPrefs(state.prefs);
  const said = describeAnswers(answers, state.campus, { transitMaxKm: state.config.transitMaxKm });
  const row = (id, label, text) =>
    h(
      "div",
      { class: "answer" },
      h("div", {}, h("div", { class: "answer-label" }, label), h("div", { class: "answer-text" }, text)),
      viewing ? null : h("button", { type: "button", class: "linklike", "data-fk": `change:${id}`, "aria-label": `Change ${label.toLowerCase()}`, onclick: () => setup.start({ edit: id }) }, "Change"),
    );
  return h(
    "div",
    { class: "panel" },
    h("h2", {}, "What you're looking for"),
    row("kind", "Looking for", said.kind),
    row("budget", "Budget", said.budget),
    row("dates", "When", said.dates),
    answers.kind === "whole" ? null : row("sharing", "Sharing", said.sharing),
    row("distance", "Distance", said.distance),
  );
}

// Kept while someone visits other tabs, so a half-made change isn't lost. It is rebuilt only when the saved
// preferences themselves change.
let settingsCache = null;

// The preferences: everything about what this account wants. Where the sites are searched belongs to the region (admin).
function renderPrefs() {
  const viewing = Boolean(state.viewingAs);
  const cacheKey = JSON.stringify([state.prefs, state.campus?.id, viewing]);
  if (settingsCache?.key === cacheKey) return settingsCache.el;
  const p = state.prefs;
  const maxKm = state.campus?.maxRadiusKm ?? 20;
  const msg = msgBox();
  let dirty = false;
  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    msg.className = "msg";
    msg.textContent = "You have unsaved changes.";
  };
  const f = {};
  // A label is tied to its field by id, so a screen reader announces it and tapping the label focuses the field.
  const fid = (name) => "s-" + name;
  const num = (name, label, value, attrs = {}) => {
    f[name] = h("input", { type: "number", id: fid(name), inputmode: "decimal", step: "any", value: value ?? "", ...attrs });
    return h("div", {}, h("label", { for: fid(name) }, label), f[name]);
  };
  const date = (name, label, value) => {
    f[name] = h("input", { type: "date", id: fid(name), value: value ?? "" });
    return h("div", {}, h("label", { for: fid(name) }, label), f[name]);
  };
  const check = (name, label, value) => {
    f[name] = h("input", { type: "checkbox", checked: value });
    return h("label", { class: "check" }, f[name], label);
  };
  const area = (name, label, value, hint) => {
    f[name] = h("textarea", { id: fid(name), value: value.join(", ") });
    return [h("label", { for: fid(name) }, label), f[name], hint ? h("div", { class: "hint" }, hint) : null];
  };
  f.unverifiedDistance = h(
    "select",
    { id: fid("unverifiedDistance") },
    [
      ["locality", "Only if the area name matches (recommended)"],
      ["include", "Always include (flagged)"],
      ["exclude", "Exclude"],
    ].map(([v, t]) => h("option", { value: v, selected: p.unverifiedDistance === v }, t)),
  );

  const sectionChecks = Object.entries(state.sections).map(([id, label]) => {
    f[`section:${id}`] = h("input", { type: "checkbox", checked: p.sections.includes(id) });
    return h("label", { class: "check" }, f[`section:${id}`], label);
  });

  const numOrNull = (el) => (el.value.trim() === "" ? null : Number(el.value));
  const collect = () => ({
    radiusKm: Number(f.radiusKm.value),
    sections: Object.keys(state.sections).filter((id) => f[`section:${id}`].checked),
    excludeOwnerOccupied: f.excludeOwnerOccupied.checked,
    excludeWeekdayOnly: f.excludeWeekdayOnly.checked,
    needFrom: f.needFrom.value,
    stayUntil: f.stayUntil.value,
    availabilityGraceDays: Number(f.availabilityGraceDays.value),
    endGraceDays: Number(f.endGraceDays.value),
    priceMin: numOrNull(f.priceMin),
    priceMax: numOrNull(f.priceMax),
    bedsMin: numOrNull(f.bedsMin),
    bedsMax: numOrNull(f.bedsMax),
    leaseMinMonths: numOrNull(f.leaseMinMonths),
    leaseMaxMonths: numOrNull(f.leaseMaxMonths),
    includeKeywords: f.includeKeywords.value,
    excludeKeywords: f.excludeKeywords.value,
    unverifiedDistance: f.unverifiedDistance.value,
    transitEnabled: f.transitEnabled.checked,
    transitMaxKm: Number(f.transitMaxKm.value),
    transitWalkM: Number(f.transitWalkM.value),
    transitMaxRideMin: Number(f.transitMaxRideMin.value),
    transitMinPerDay: Number(f.transitMinPerDay.value),
  });

  const save = h(
    "button",
    {
      class: "primary",
      onclick: async (e) => {
        e.preventDefault();
        msg.className = "msg";
        msg.textContent = "Saving...";
        try {
          const r = await api("PUT", "/api/prefs", collect());
          await loadState();
          dirty = false;
          msg.className = "msg ok";
          msg.textContent = r.matched ? "Saved. Your matches are updated." : "Saved. It applies from the next check.";
          render();
        } catch (err) {
          msg.className = "msg err";
          msg.textContent = err.message;
        }
      },
    },
    "Save settings",
  );

  const form = h(
    "form",
    { onsubmit: (e) => e.preventDefault() },
    h(
      "fieldset",
      { class: "prefs", disabled: viewing },
      h(
        "div",
        { class: "panel" },
        h("h2", {}, "What"),
        check("excludeOwnerOccupied", "Exclude owner-occupied properties", p.excludeOwnerOccupied),
        h("div", { class: "hint" }, "Rooms where the owner lives there. Daft's own filter is used for rooms, then each listing's description is read for live-in landlord wording. Untick to see them."),
        check("excludeWeekdayOnly", "Exclude weekday-only lets (Mon-Fri, 5-day)", p.excludeWeekdayOnly),
        h("h3", {}, "Kinds of place"),
        sectionChecks,
        h("div", { class: "row" }, num("priceMin", "Min €/month", p.priceMin), num("priceMax", "Max €/month", p.priceMax)),
        h("div", { class: "row" }, num("bedsMin", "Min beds (houses)", p.bedsMin), num("bedsMax", "Max beds (houses)", p.bedsMax)),
      ),
      h(
        "div",
        { class: "panel" },
        h("h2", {}, "When"),
        h("div", { class: "row" }, date("needFrom", "Need from (blank = immediately)", p.needFrom), date("stayUntil", "Stay until", p.stayUntil)),
        h("div", { class: "row" }, num("availabilityGraceDays", "Accept up to N days after need-from", p.availabilityGraceDays, { step: "1", min: "0" }), num("endGraceDays", "Accept ending up to N days before stay-until", p.endGraceDays, { step: "1", min: "0" })),
        h("div", { class: "row" }, num("leaseMinMonths", "Min lease (months)", p.leaseMinMonths), num("leaseMaxMonths", "Max lease (months)", p.leaseMaxMonths)),
        h(
          "div",
          { class: "hint" },
          "Availability is read from listing text where stated (UL Accommodation, Rent.ie, MyHome.ie). Daft search results rarely include it, so Daft listings are not date-filtered. Listings that state a start date too late, or an end date too early, are excluded. Lease limits only apply to Daft, and ask Daft again for you, so they are applied from the next check.",
        ),
      ),
      h(
        "div",
        { class: "panel" },
        h("h2", {}, "How far"),
        num("radiusKm", "Max distance from your campus (km)", p.radiusKm, { min: "0.1", max: String(maxKm) }),
        h("div", { class: "hint" }, `Exact straight-line distance. Up to ${maxKm} km for this campus.`),
      ),
      h(
        "div",
        { class: "panel" },
        h("h2", {}, "Keywords"),
        area("excludeKeywords", "Exclude if title/description contains", p.excludeKeywords, "Comma separated."),
        area("includeKeywords", "Only if it contains one of (optional)", p.includeKeywords),
      ),
      renderTransitSettings(p, maxKm, f, num, check),
      h(
        "details",
        { class: "panel" },
        h("summary", {}, "Advanced"),
        h("label", { for: fid("unverifiedDistance") }, "If a listing has no coordinates"),
        f.unverifiedDistance,
        h("div", { class: "hint" }, "Only listings whose location can't be worked out. Area names near your campus decide whether they count."),
      ),
      viewing ? null : h("div", { class: "savebar" }, save, msg),
    ),
    viewing ? h("div", { class: "hint" }, `You're viewing as ${state.viewingAs.username}, so these can be read but not changed.`) : null,
  );
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  settingsCache = { key: cacheKey, el: form };
  return form;
}

// The admin's settings for each region: which sites and pages are read for everyone in it, and how often.
function renderRegions() {
  const regions = state.regions ?? [];
  const msg = msgBox();
  return h(
    "div",
    {},
    h("h2", { class: "section-title" }, "Regions"),
    h("div", { class: "hint" }, "Where to look is set per region, for everyone watching there. Only a region with someone watching is scanned."),
    regions.map((r) => renderRegionForm(r, msg)),
    msg,
  );
}

function renderRegionForm(r, msg) {
  const s = r.settings;
  const f = {};
  const id = (name) => `r-${r.id}-${name}`;
  const text = (name, label, value, attrs = {}) => {
    f[name] = h("input", { type: "text", id: id(name), value: value ?? "", autocapitalize: "off", spellcheck: "false", ...attrs });
    return [h("label", { for: id(name) }, label), f[name]];
  };
  const num = (name, label, value, attrs = {}) => {
    f[name] = h("input", { type: "number", id: id(name), inputmode: "decimal", step: "1", value: value ?? "", ...attrs });
    return h("div", {}, h("label", { for: id(name) }, label), f[name]);
  };
  const check = (name, label, value) => {
    f[name] = h("input", { type: "checkbox", checked: value });
    return h("label", { class: "check" }, f[name], label);
  };
  const urls = (name, label, value) => {
    f[name] = h("textarea", { id: id(name), value: value.join("\n"), rows: "3", spellcheck: "false", autocapitalize: "off" });
    return [h("label", { for: id(name) }, label), f[name]];
  };
  const sourceChecks = Object.entries(state.sources).map(([sid, label]) => {
    f[`source:${sid}`] = h("input", { type: "checkbox", checked: s.sources.includes(sid) });
    return h("label", { class: "check" }, f[`source:${sid}`], label);
  });
  const watching = r.campuses.filter((c) => c.watching).map((c) => `${c.short} ${c.watching}`);

  const save = h(
    "button",
    {
      class: "primary",
      type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        msg.className = "msg";
        msg.textContent = `Saving ${s.name}...`;
        try {
          const body = {
            enabled: f.enabled.checked,
            intervalMinutes: Number(f.intervalMinutes.value),
            daftLocation: f.daftLocation.value.trim(),
            radiusKm: Number(f.radiusKm.value),
            sources: Object.keys(state.sources).filter((sid) => f[`source:${sid}`].checked),
            ulUrls: f.ulUrls.value,
            rentUrls: f.rentUrls.value,
            myhomeUrls: f.myhomeUrls.value,
            webUrls: f.webUrls.value,
            geocode: f.geocode.checked,
            respectRobots: f.respectRobots.checked,
            maxDetailFetches: Number(f.maxDetailFetches.value),
            maxPages: Number(f.maxPages.value),
          };
          await api("PUT", `/api/regions/${r.id}`, body);
          await loadState();
          msg.className = "msg ok";
          msg.textContent = `Saved ${s.name}. Changes apply from its next scan.`;
        } catch (err) {
          msg.className = "msg err";
          msg.textContent = err.message;
        }
        e.target.disabled = false;
      },
    },
    `Save ${s.name}`,
  );

  return h(
    "details",
    { class: "panel region", open: openSections[`region:${r.id}`] === true, ontoggle: (e) => (openSections[`region:${r.id}`] = e.target.open) },
    h("summary", {}, `${s.name}${s.enabled ? "" : " (off)"} · ${watching.length ? watching.join(", ") : "nobody watching"}`),
    check("enabled", "Scan this region", s.enabled),
    h("div", { class: "row" }, num("intervalMinutes", "Scan every (minutes)", s.intervalMinutes, { min: "5", max: "1440" }), num("maxPages", "Result pages per search (Daft: 20 a page)", s.maxPages, { min: "1", max: "10" })),
    h("h3", {}, "Sites"),
    sourceChecks,
    text("daftLocation", "Daft area", s.daftLocation),
    h("div", { class: "hint" }, "The area name in a Daft search URL: daft.ie/sharing/<this>. Search the area on daft.ie and copy it from the address bar."),
    num("radiusKm", "Daft radius around it (km)", s.radiusKm, { min: "1", max: "20" }),
    h("div", { class: "hint" }, "How far around the area to ask for. It has to reach every campus in the region."),
    urls("ulUrls", "UL Accommodation pages (one per line)", s.ulUrls),
    urls("rentUrls", "Rent.ie search pages", s.rentUrls),
    urls("myhomeUrls", "MyHome.ie search pages", s.myhomeUrls),
    urls("webUrls", "Custom pages (any listings site; tick Custom pages above)", s.webUrls),
    h("div", { class: "hint" }, "A campus's own extra pages are added to these while someone has chosen it."),
    h("h3", {}, "How"),
    check("geocode", "Look up coordinates from addresses (OpenStreetMap)", s.geocode),
    check("respectRobots", "Respect robots.txt on scraped sites", s.respectRobots),
    num("maxDetailFetches", "Max detail pages fetched per scan", s.maxDetailFetches, { min: "0", max: "200" }),
    save,
  );
}

const mapLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

// "Public transport": accept homes beyond the distance that have a direct route to the campus, and browse
// the stops that go there (with coordinates, to open in a maps app or export).
function renderTransitSettings(p, maxKm, f, num, check) {
  const result = h("div", { class: "stops" });
  const pick = h(
    "select",
    { "aria-label": "Campus" },
    state.campuses.map((x) => h("option", { value: x.id, selected: x.id === state.campus?.id }, x.name)),
  );
  const show = h(
    "button",
    {
      class: "secondary",
      type: "button",
      onclick: async () => {
        result.replaceChildren(h("div", { class: "hint" }, "Loading..."));
        try {
          const d = await api("GET", `/api/transit/${pick.value}`);
          const base = `/api/transit/${pick.value}`;
          result.replaceChildren(
            h("div", { class: "hint" }, `${d.routes.length} routes with a direct service to ${d.campus.name}. Trips are on a typical weekday; times are the ride to the campus.`),
            h(
              "div",
              { class: "hint" },
              h("a", { href: `${base}?format=csv`, download: `${pick.value}-stops.csv` }, "Download CSV"),
              " · ",
              h("a", { href: `${base}?format=geojson`, download: `${pick.value}-stops.geojson` }, "Download GeoJSON"),
            ),
            ...d.routes.map((r) =>
              h(
                "details",
                { class: "route" },
                h("summary", {}, modeIcon(r.mode), `${r.label} · ${r.operator} · ${r.stops.length} stops`),
                h("div", { class: "hint" }, r.name),
                r.stops.map((s) =>
                  h(
                    "div",
                    { class: "stoprow" },
                    h("span", {}, `${s.name}${s.code ? ` (${s.code})` : ""}`),
                    h("span", {}, `${s.mins ?? "?"} min · ${s.perDay}/day · `, h("a", { href: mapLink(s.lat, s.lng), target: "_blank", rel: "noopener noreferrer" }, `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`)),
                  ),
                ),
              ),
            ),
          );
        } catch (err) {
          result.replaceChildren(h("div", { class: "msg err" }, err.message));
        }
      },
    },
    "Show stops",
  );

  return h(
    "details",
    { class: "panel" },
    h("summary", {}, "Public transport"),
    check("transitEnabled", "Also accept homes beyond the distance above that are on a direct bus, tram or train route to your campus", p.transitEnabled),
    h("div", { class: "hint" }, "Uses the National Transport Authority's timetables for Bus Éireann, Dublin Bus, Go-Ahead, Luas and Irish Rail. Only services that go straight to the campus count, and only the stops on the side of the road that heads there."),
    h("div", { class: "row" }, num("transitMaxKm", "Furthest from the campus (km)", p.transitMaxKm, { min: "0.5", max: String(maxKm) }), num("transitWalkM", "Walk to the stop (m)", p.transitWalkM, { step: "50", min: "100", max: "2000" })),
    h("div", { class: "row" }, num("transitMaxRideMin", "Longest ride (minutes)", p.transitMaxRideMin, { step: "1", min: "5", max: "90" }), num("transitMinPerDay", "Fewest trips per weekday", p.transitMinPerDay, { step: "1", min: "1" })),
    h("div", { class: "hint" }, "The walk is a straight line to the stop, so allow about a quarter more on the ground."),
    h(
      "details",
      {},
      h("summary", {}, "Stops that go to a campus"),
      pick,
      show,
      result,
      state.transit ? h("div", { class: "hint" }, `Timetables from ${state.transit.generated}. ${state.transit.attribution}`) : h("div", { class: "msg err" }, "Transport data is not installed on this server (run npm run transit)."),
    ),
  );
}

// Turns alerts on for this device, reporting progress and failure in `msg`.
async function turnOnAlerts(msg) {
  const say = (text, ok = true) => {
    msg.className = `msg ${ok ? "ok" : "err"}`;
    msg.textContent = text;
  };
  try {
    say("Turning on alerts...");
    await enablePush();
    await refreshPushState();
    await loadState();
    render();
    // A real alert, so there is proof it works before the first listing arrives.
    const test = await api("POST", "/api/test-push").catch(() => null);
    showToast(test?.sent ? "Alerts are on. A test alert is on its way." : "Alerts are on for this device.");
  } catch (err) {
    say(err.message, false);
  }
}

const SOURCE_ICON = { ok: "check", paused: "pause", warn: "alert", down: "alert" };

function renderAlerts() {
  const mode = setupMode();
  const msg = msgBox();
  const say = (text, ok = true) => {
    msg.className = `msg ${ok ? "ok" : "err"}`;
    msg.textContent = text;
  };
  const viewing = Boolean(state.viewingAs);
  const admin = state.user.isAdmin && !viewing;

  const statusLine = {
    on: [icon("check"), "On for this device"],
    off: [icon("pause"), "Off on this device"],
    blocked: [icon("alert"), "Blocked on this device"],
    install: [icon("pause"), "Not available until ASAP accommodation is on your Home Screen"],
    unsupported: [icon("alert"), "This browser can't receive alerts"],
    viewing: [icon("pause"), `Devices can't be changed while viewing as ${state.viewingAs?.username}`],
  }[mode];

  const test = h(
    "button",
    {
      class: "secondary",
      onclick: async () => {
        try {
          const res = await api("POST", "/api/test-push");
          say(res.sent ? "Test alert sent to this device." : "No device received it. Turn on alerts first.", res.sent > 0);
        } catch (err) {
          say(err.message, false);
        }
      },
    },
    "Send a test alert",
  );
  const enable = h(
    "button",
    {
      class: "primary",
      onclick: (e) => {
        e.target.disabled = true;
        turnOnAlerts(msg).finally(() => (e.target.disabled = false));
      },
    },
    "Turn on alerts",
  );

  const watching = summarizeSources(state);
  const scanMsg = msgBox();
  const scan = h(
    "button",
    {
      class: "secondary",
      onclick: async (e) => {
        e.target.disabled = true;
        scanMsg.className = "msg";
        scanMsg.textContent = "Scanning...";
        try {
          await api("POST", "/api/scan");
          await loadState();
          render();
        } catch (err) {
          scanMsg.className = "msg err";
          scanMsg.textContent = err.message;
          e.target.disabled = false;
        }
      },
    },
    "Scan now",
  );

  return h(
    "div",
    {},
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Alerts on this device"),
      h("div", { class: `status-line mode-${mode}` }, statusLine),
      mode === "install" ? [installSteps(), h("div", { class: "hint" }, "Needs iOS 16.4 or later.")] : null,
      mode === "blocked" ? blockedSteps() : null,
      mode === "off" ? enable : null,
      mode === "on" ? test : null,
      msg,
      viewing ? null : kv("Devices receiving your alerts", String(state.subscriptions.length)),
      state.subscriptions.map((s) => (s.lastError ? h("div", { class: "hint" }, `One of your devices couldn't be reached: ${s.lastError}`) : null)),
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Sites being watched"),
      watching.rows.length
        ? watching.rows.map((row) => h("div", { class: `site ${row.status}` }, icon(SOURCE_ICON[row.status]), h("div", {}, h("div", { class: "site-name" }, row.label), h("div", { class: "hint" }, row.detail))))
        : h("div", { class: "hint" }, watching.headline),
    ),
    admin
      ? h(
          "details",
          { class: "panel scanner", open: openSections.scanner === true, ontoggle: (e) => (openSections.scanner = e.target.open) },
          h("summary", {}, "Scanner details"),
          (state.regions ?? []).map(renderRegionStatus),
          h("div", { class: "hint" }, "Each region is scanned on its own timer while someone is watching there. Scan now scans them all."),
          scan,
          scanMsg,
        )
      : null,
    renderAccount(),
  );
}

// How one region's last scan went, for the admin: who is being watched for, what it found and how each site did.
function renderRegionStatus(r) {
  const run = r.lastRun;
  const who = r.campuses.filter((c) => c.watching).map((c) => `${c.short} ${c.watching}`);
  const sites = summarizeSources({ config: { enabled: r.settings.enabled, intervalMinutes: r.settings.intervalMinutes }, lastRun: run, sourceHealth: r.sourceHealth });
  return h(
    "div",
    { class: "region-status" },
    h("h3", {}, r.settings.enabled ? r.settings.name : `${r.settings.name} (off)`),
    kv("Watching", who.length ? who.join(", ") : "nobody, so it isn't scanned"),
    run ? kv("Last scan", `${timeAgo(run.at)} (${run.ok ? "ok" : "failed"})`) : kv("Last scan", "not yet"),
    run && run.ok && run.accounts ? kv("Found / matching / new", `${run.candidates} / ${run.matches} / ${run.newCount}`) : null,
    run && run.ok && run.pending ? kv("Waiting for detail pages", String(run.pending)) : null,
    run && !run.ok ? kv("Error", run.error) : null,
    kv("Next scan", state.scanning ? "running now" : r.settings.enabled && r.watching ? inFuture(r.nextRunAt) : "not scheduled"),
    r.failureCount ? kv("Consecutive failures", String(r.failureCount)) : null,
    sites.rows.map((row) => kv(row.label, row.raw)),
  );
}

function renderAccount() {
  const msg = msgBox();
  const { user, viewingAs } = state;
  // Someone who came in by a link has no password and doesn't need one; they can set one to sign in without a link.
  const first = !user.hasPassword;
  const current = first ? null : h("input", { type: "password", placeholder: "Current password", "aria-label": "Current password", autocomplete: "current-password" });
  const next = h("input", { type: "password", placeholder: "New password (8+ characters)", "aria-label": "New password", autocomplete: "new-password" });
  const fields = [current, next, h("button", { class: "secondary", type: "submit" }, first ? "Set password" : "Change password"), msg];
  const change = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api("POST", "/api/account/password", { current: current?.value, next: next.value });
          next.value = "";
          if (current) current.value = "";
          msg.className = "msg ok";
          msg.textContent = first ? `Password set. Your username is ${user.username}.` : "Password changed. Your other devices have been signed out.";
          await loadState();
        } catch (err) {
          msg.className = "msg err";
          msg.textContent = err.message;
        }
      },
    },
    first
      ? h("details", {}, h("summary", {}, "Set a password (optional)"), h("div", { class: "hint" }, "You signed in with a link, so you don't need one. A password lets you sign in on another device without asking for a new link."), fields)
      : [h("h3", {}, "Change password"), fields],
  );

  return h(
    "div",
    { class: "panel" },
    h("h2", {}, "Account"),
    kv("Signed in as", viewingAs ? viewingAs.by : `${user.username}${user.isAdmin ? " (admin)" : ""}`),
    viewingAs ? kv("Viewing as", viewingAs.username) : null,
    !viewingAs && user.isAdmin ? h("div", { class: "hint" }, "The admin password is the ACCESS_PASSWORD variable on the server. Add people under Users.") : null,
    !viewingAs && !user.isAdmin ? change : null,
    h(
      "button",
      {
        class: "secondary",
        onclick: async () => {
          // With no password, the only way back in is a link, and the one they were sent may have run out.
          if (!viewingAs && !user.hasPassword && !confirm("You don't have a password, so to sign in again you'll need your link (or a new one from whoever added you). Sign out?")) return;
          await api("POST", "/api/logout").catch(() => {});
          state = null;
          sessionEnded = false;
          setup.reset();
          forgetDeviceLinks();
          clearSnapshot();
          render();
        },
      },
      "Sign out",
    ),
  );
}

const deviceName = (ua = "") =>
  /iphone|ipad/i.test(ua) ? "iPhone / iPad" : /android/i.test(ua) ? "Android" : /windows/i.test(ua) ? "Windows" : /macintosh/i.test(ua) ? "Mac" : "Device";

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => chars[b % chars.length]).join("");
}

// A QR code for a link, drawn by the QR library the server hands out. Without it (offline, say) there is just no code.
function qrCode(text, label) {
  const el = h("div", { class: "qr", role: "img", "aria-label": label });
  import("/vendor/qrcode/qrcode.mjs")
    .then(({ default: qrcode }) => {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
      el.firstElementChild?.setAttribute("aria-hidden", "true");
    })
    .catch(() => el.remove());
  return el;
}

// The message to send someone just added, or their new link, ready to share, copy or scan. A reset password is shown
// the old way. The link and the password are only ever held here, in memory, until the admin says they're done.
function renderInvite() {
  if (!lastInvite) return null;
  const who = lastInvite.name ?? lastInvite.username;
  const link = lastInvite.link ? `${location.origin}/?join=${lastInvite.link}` : null;
  const text = link ? linkInviteText({ name: lastInvite.name, link, fresh: lastInvite.fresh }) : inviteText({ url: location.origin, ...lastInvite });
  const box = h("textarea", { readonly: true, rows: link ? "7" : "9", spellcheck: "false", "aria-label": `Message for ${who}`, value: text });
  const note = msgBox();
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      box.focus();
      box.select();
      try {
        ok = document.execCommand("copy");
      } catch {}
    }
    note.className = `msg ${ok ? "ok" : "err"}`;
    note.textContent = ok ? "Copied. Paste it into a message to them." : "Couldn't copy. Select the text above and copy it.";
  };
  const share = navigator.share ? h("button", { class: "primary", type: "button", onclick: () => navigator.share({ text }).catch(() => {}) }, "Share") : null;
  return h(
    "div",
    { class: "panel invite" },
    h("h2", {}, lastInvite.reset ? `New password for ${lastInvite.username}` : `Send this to ${who}`),
    h(
      "div",
      { class: "hint" },
      link
        ? `The link signs ${who} in on their phone, with no username or password, and walks them through the rest. It works for 2 weeks; make a new one any time.`
        : "Send them this. The password is only shown here, so copy it before you click Done.",
    ),
    box,
    share,
    h("button", { class: share ? "secondary" : "primary", type: "button", onclick: copy }, "Copy message"),
    link
      ? h(
          "details",
          { class: "qr-box" },
          h("summary", {}, "With them now? Show a QR code"),
          h("div", { class: "hint" }, "They point their phone's camera at it and tap the link that appears. On an iPhone that opens Safari, which is what's needed."),
          qrCode(link, `QR code of ${who}'s sign-in link`),
        )
      : null,
    h(
      "button",
      {
        class: "secondary",
        type: "button",
        onclick: () => {
          lastInvite = null;
          render();
          focusKey("users:name");
        },
      },
      "Done",
    ),
    note,
  );
}

function renderUsers() {
  const note = msgBox(usersNote ? (usersNote.ok ? "ok" : "err") : "");
  note.textContent = usersNote?.text ?? "";
  const say = (text, ok = true) => {
    usersNote = { text, ok };
    note.className = `msg ${ok ? "ok" : "err"}`;
    note.textContent = text;
  };
  // Runs an admin action, then reloads the list so the page shows what the server now has.
  const act = (fn) => async () => {
    try {
      await fn();
      await loadUsers();
      render();
    } catch (err) {
      say(err.message, false);
    }
  };

  // Adding someone takes their name and nothing else: the username is made from it, and they get a link, not a password.
  const name = h("input", { type: "text", placeholder: "Their name, e.g. Sam", "aria-label": "Their name", "data-fk": "users:name", autocomplete: "off", autocapitalize: "words", spellcheck: "false" });
  const add = h(
    "form",
    {
      onsubmit: (e) => {
        e.preventDefault();
        act(async () => {
          const r = await api("POST", "/api/users", { name: name.value });
          lastInvite = { username: r.user.username, name: r.user.name, link: r.link.token };
          say(`Added ${r.user.name ?? r.user.username} (username ${r.user.username}).`);
        })();
      },
    },
    name,
    h("button", { class: "primary", type: "submit" }, "Add and get their link"),
  );

  const userPanel = (u) =>
    h(
      "div",
      { class: "panel" },
      h("h2", {}, u.name ? `${u.name} (${u.username})` : u.username),
      kv("Signs in with", u.hasPassword ? "a link or a password" : "a link"),
      kv("Campus", u.campus ? u.campus.name : "not chosen yet, so nothing is watched for them"),
      u.campus ? kv("Matches now", String(u.matches)) : null,
      u.campus ? kv("Last checked", u.lastCheckAt ? timeAgo(u.lastCheckAt) : "not yet") : null,
      kv("Last signed in", u.lastLoginAt ? timeAgo(u.lastLoginAt) : "never"),
      kv("Last active", u.lastSeenAt ? timeAgo(u.lastSeenAt) : "never"),
      kv("Devices subscribed", String(u.devices.length)),
      kv("Home Screen app", u.homeScreenAt ? `last opened ${timeAgo(u.homeScreenAt)}` : "not opened yet"),
      u.devices.map((d) => kv(deviceName(d.userAgent), d.lastError ? `error: ${d.lastError}` : `added ${timeAgo(d.addedAt)}`)),
      h(
        "button",
        {
          class: "primary",
          onclick: async () => {
            try {
              await api("POST", "/api/view-as", { username: u.username });
              await loadState();
              tab = "matches";
              render();
              window.scrollTo(0, 0);
            } catch (err) {
              say(err.message, false);
            }
          },
        },
        "View as",
      ),
      h(
        "button",
        {
          class: "secondary",
          onclick: act(async () => {
            const r = await api("POST", `/api/users/${encodeURIComponent(u.username)}/test-push`);
            say(r.sent ? `Test sent to ${r.sent} of ${u.username}'s device(s).` : `${u.username} has no device that received it.`, r.sent > 0);
          }),
        },
        "Send test",
      ),
      // For a new phone, a lost one, or a link that ran out. It replaces the last link sent and signs nobody out.
      h(
        "button",
        {
          class: "secondary",
          onclick: act(async () => {
            const r = await api("POST", `/api/users/${encodeURIComponent(u.username)}/link`);
            lastInvite = { username: u.username, name: u.name, link: r.link.token, fresh: true };
            say(`New link for ${u.name ?? u.username}. The last one sent no longer works.`);
            window.scrollTo(0, 0);
          }),
        },
        "New sign-in link",
      ),
      h(
        "button",
        {
          class: "secondary",
          onclick: act(async () => {
            const password = prompt(`${u.hasPassword ? "New password" : "A password"} for ${u.username} (8+ characters). They will be signed out everywhere, and their links stop working.`, randomPassword());
            if (!password) return;
            await api("PUT", `/api/users/${encodeURIComponent(u.username)}/password`, { password });
            lastInvite = { username: u.username, password, reset: true };
            say(`Password for ${u.username} changed.`);
          }),
        },
        u.hasPassword ? "Reset password" : "Give a password",
      ),
      h(
        "button",
        {
          class: "secondary danger",
          onclick: act(async () => {
            if (!confirm(`Remove ${u.username}? They are signed out and their devices stop getting alerts.`)) return;
            await api("DELETE", `/api/users/${encodeURIComponent(u.username)}`);
            say(`Removed ${u.username}.`);
          }),
        },
        "Remove",
      ),
    );

  return h(
    "div",
    {},
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Add someone"),
      h("div", { class: "hint" }, "Type their name and send them the link you get. It signs them in and walks them through choosing their college, what they're after and turning on alerts. Each person has their own search, matches and alerts."),
      add,
      note,
    ),
    renderInvite(),
    usersList.length ? usersList.map(userPanel) : h("div", { class: "empty" }, "No other users yet."),
  );
}

function urlB64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push isn't available here. On iPhone, add this page to your Home Screen and open it from there (iOS 16.4+).");
  }
  if (!state.vapidPublicKey) throw new Error("Can't reach ASAP accommodation. Check your connection and try again.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(
      isIos
        ? "Alerts weren't allowed. Open Settings, then Notifications, then ASAP, and switch on Allow Notifications."
        : "Alerts weren't allowed. Allow notifications for this site in your browser's site settings, then try again.",
    );
  }
  const existing = await reg.pushManager.getSubscription();
  if (existing) await existing.unsubscribe();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8(state.vapidPublicKey),
  });
  await api("POST", "/api/subscribe", sub.toJSON());
}

async function syncSubscription() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api("POST", "/api/subscribe", sub.toJSON());
  } catch {}
}

boot();
