import { h, timeAgo, MODE_ICON, describeMatch, badgeRow, leadRow, listingImage, icon } from "./ui.js";
import { alertsSetup, inviteText, listingFromSearch, summarizeSources } from "./app-model.js";
import { createMapView } from "./map.js";

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
let loadedAt = Date.now(); // when `state` was last fetched or restored
let pushState = { supported: false, permission: "default", subscribedHere: false };
let pendingListing = listingFromSearch(location.search); // the listing an alert pointed at, until it has been shown
let arrivedId = null; // the card to highlight after arriving from an alert
let moreFor = null; // the card whose extra actions are open
let lastInvite = null; // what to send someone just added: { username, password, reset }
let lastDismissAt = 0;
let pendingRefresh = false;
// What a listing's verdict was before it was dismissed, so "Restore" and "Undo" put it back as it was.
const previousReview = new Map();
if (pendingListing) history.replaceState(null, "", location.pathname);

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
    if (snap?.state?.user && Array.isArray(snap.state.matches)) {
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
  onShowList: () => setView("list"),
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
    const err = new Error("Can't reach Rental Watch. Check your connection and try again.");
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
  return s < 3600 ? `in ${Math.round(s / 60)} min` : `in ${Math.round(s / 3600)} h`;
}

const kv = (k, v) => h("div", { class: "kv" }, h("span", {}, k), h("span", {}, v));

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;

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
  try {
    await loadState();
    await refreshPushState();
    syncSubscription();
  } catch (err) {
    state = null;
    if (err.offline) useSnapshot();
  }
  render();
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
    render();
    if (pendingListing) openListing(pendingListing);
    return;
  }
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
  root.classList.toggle("wide", Boolean(state) && tab === "matches" && view === "map");
  root.replaceChildren(state ? renderMain() : unreachable ? renderUnreachable() : renderLogin());
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
    showToast(cantReach ? "Can't reach Rental Watch to find that listing. Try again in a moment." : "That listing is no longer in your matches.");
    return;
  }
  if (isDismissed(m)) openSections[m.review] = true;
  arrivedId = m.id;
  render();
  const card = [...root.querySelectorAll(".card")].find((el) => el.dataset.id === m.id);
  card?.scrollIntoView({ block: "start" });
  setTimeout(() => {
    if (arrivedId === m.id) arrivedId = null;
    card?.classList.remove("arrived");
  }, 6000);
}

function renderLogin() {
  const msg = msgBox("err");
  msg.setAttribute("role", "alert");
  if (sessionEnded) msg.textContent = "Your session ended. Please log in again.";
  const name = h("input", { type: "text", placeholder: "Username", "aria-label": "Username", autocomplete: "username", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const input = h("input", { type: "password", placeholder: "Password", "aria-label": "Password", autocomplete: "current-password" });
  const submit = h("button", { class: "primary", type: "submit" }, "Log in");
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
          await loadState();
          await refreshPushState();
          tab = "matches";
          render();
          syncSubscription();
          if (pendingListing) openListing(pendingListing);
        } catch (err) {
          msg.textContent = sentence(err.message);
          submit.disabled = false;
        }
      },
    },
    h("h1", {}, "Rental Watch"),
    h("p", { class: "lede" }, "Alerts for new rentals near your campus."),
    h("p", { class: "hint" }, "Log in with the username and password you were given. You only need to do this once per device."),
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
    h("h1", {}, "Rental Watch"),
    h("p", { class: "lede" }, "Can't reach Rental Watch."),
    h("p", { class: "hint" }, "Check your connection. This will keep trying on its own, or you can try now."),
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
  } catch {}
}

function renderMain() {
  // Only the admin can change the one shared search or manage users.
  const admin = state.user.isAdmin;
  const tabs = [["matches", `Matches (${state.matches.filter((m) => !isDismissed(m)).length})`]];
  if (admin) tabs.push(["settings", "Settings"]);
  tabs.push(["alerts", "Alerts"]);
  if (admin) tabs.push(["users", "Users"]);
  if ((tab === "users" || tab === "settings") && !admin) tab = "matches";
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
          h("span", {}, `Can't reach Rental Watch. Showing the list from ${timeAgo(new Date(loadedAt).toISOString())}.`),
          h(
            "button",
            {
              class: "linklike",
              onclick: async (e) => {
                e.target.disabled = true;
                await refresh({ manual: true }).catch(() => {});
                if (offline) {
                  e.target.disabled = false;
                  showToast("Still can't reach Rental Watch.");
                }
              },
            },
            "Try again",
          ),
        )
      : null,
    h(
      "header",
      {},
      h("h1", {}, "Rental Watch"),
      h("div", { class: "sub" }, `${c.radiusKm} km of ${c.center.label}`),
    ),
    h("main", {}, content),
    h(
      "nav",
      { class: "tabs", "aria-label": "Sections" },
      tabs.map(([id, label]) =>
        h(
          "button",
          {
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
          label,
        ),
      ),
    ),
  );
}

function renderMatches() {
  const toggle = h(
    "div",
    { class: "seg", role: "group", "aria-label": "Matches view" },
    [["list", "List"], ["map", "Map"]].map(([id, label]) =>
      h("button", { type: "button", class: view === id ? "active" : "", "aria-pressed": String(view === id), "data-fk": "view:" + id, onclick: () => view !== id && setView(id) }, label),
    ),
  );
  if (view === "map") {
    mapView.update({ ...state, matches: state.matches.filter((m) => !isDismissed(m)) });
    return [toggle, mapView.el];
  }
  return [renderAlertsCard(), toggle, renderSourceStrip(), ...[renderList()].flat()];
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
    showToast(`Moved to ${title}`, { label: "Undo", run: () => setReview(m.id, before) });
    if (next && document.activeElement === document.body) focusKey(next.id + ":open");
  }
}

async function restore(m) {
  if (await setReview(m.id, previousReview.get(m.id) ?? null)) showToast("Back in your matches.");
}

// Going to the listing's own site is the natural "I've looked at this", so it marks the card seen.
function openedListing(m) {
  if (m.review) return;
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
                window.scrollTo(0, 0);
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

// The three ways to put the app on an iPhone's Home Screen, which is the only way an iPhone can receive alerts.
const installSteps = () =>
  h(
    "ol",
    { class: "steps" },
    h("li", {}, "In Safari, tap the Share button."),
    h("li", {}, "Choose Add to Home Screen."),
    h("li", {}, "Open Rental Watch from your Home Screen, log in, and tap Turn on alerts."),
  );

const blockedSteps = () =>
  h(
    "div",
    { class: "hint" },
    isIos
      ? "Open Settings, then Notifications, then Rental Watch, and switch on Allow Notifications. Then come back here."
      : "Allow notifications for this site in your browser's site settings, then reload this page.",
  );

// Getting alerts is the point of the app, so a device that isn't set up is told so at the top of the first screen.
function renderAlertsCard() {
  const mode = setupMode();
  if (!["install", "off", "blocked"].includes(mode) || hideAlertsCard()) return null;
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
      },
    },
    "Not now",
  );
  if (mode === "install") {
    return h("section", { class: "panel setup", "aria-label": "Get alerts" }, h("h2", {}, "Get alerts on your iPhone"), h("p", {}, "Rental Watch can only send alerts once it is on your Home Screen."), installSteps(), h("div", { class: "hint" }, "Needs iOS 16.4 or later."), notNow);
  }
  if (mode === "blocked") {
    return h("section", { class: "panel setup", "aria-label": "Get alerts" }, h("h2", {}, "Alerts are blocked on this device"), blockedSteps(), notNow);
  }
  return h(
    "section",
    { class: "panel setup", "aria-label": "Get alerts" },
    h("h2", {}, "Turn on alerts"),
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
  return h(
    "article",
    { class: `card${m.review ? ` ${m.review}` : ""}${m.id === arrivedId ? " arrived" : ""}`, "data-id": m.id, "aria-label": d.price + ", " + m.title },
    listingImage(m),
    h("div", { class: "body" }, leadRow(d), h("div", { class: "title" }, m.title), h("div", { class: "meta" }, d.meta), d.transit.map((t) => h("div", { class: "transit" }, t)), badgeRow(d.badges)),
    h(
      "div",
      { class: "actions" },
      dismissed
        ? h("button", { class: "act restore", "aria-label": named(dismissed.undo), "data-fk": m.id + ":restore", onclick: () => restore(m) }, dismissed.undo)
        : [
            h("a", { class: "act open", href: m.url, target: "_blank", rel: "noopener noreferrer", "aria-label": named(`Open on ${m.sourceLabel}`), "data-fk": m.id + ":open", onclick: () => openedListing(m) }, `Open on ${m.sourceLabel}`, icon("external")),
            h("button", { class: "act", "aria-label": named("Not a fit"), "data-fk": m.id + ":rejected", onclick: () => dismiss(m, "rejected") }, "Not a fit"),
            h(
              "button",
              {
                class: "act",
                "aria-label": named(more ? "Fewer options" : "More options"),
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
                      class: "act",
                      "aria-label": named(seen ? "Mark as unseen" : "Mark as seen"),
                      "data-fk": m.id + ":seen",
                      onclick: () => {
                        moreFor = null;
                        setReview(m.id, seen ? null : "seen");
                      },
                    },
                    seen ? "Mark as unseen" : "Mark as seen",
                  ),
                  h("button", { class: "act", "aria-label": named("No longer available"), "data-fk": m.id + ":unavailable", onclick: () => dismiss(m, "unavailable") }, "No longer available"),
                ]
              : null,
          ],
    ),
    m.reviewError ? h("div", { class: "msg err card-msg", role: "alert" }, `Couldn't save that: ${m.reviewError}`) : null,
  );
}

function renderSettings() {
  const c = state.config;
  const msg = msgBox();
  const f = {};
  // A label is tied to its field by id, so a screen reader announces it and tapping the label focuses the field.
  const fid = (name) => "s-" + name;
  const text = (name, label, value, attrs = {}) => {
    f[name] = h("input", { type: "text", id: fid(name), value: value ?? "", ...attrs });
    return [h("label", { for: fid(name) }, label), f[name]];
  };
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

  const sourceChecks = Object.entries(state.sources).map(([id, label]) => {
    f[`source:${id}`] = h("input", { type: "checkbox", checked: c.sources.includes(id) });
    return h("label", { class: "check" }, f[`source:${id}`], label);
  });
  const urlArea = (name, label, value) => {
    f[name] = h("textarea", { id: fid(name), value: value.join("\n"), rows: "3", spellcheck: "false", autocapitalize: "off" });
    return [h("label", { for: fid(name) }, label), f[name]];
  };
  f.unverifiedDistance = h(
    "select",
    { id: fid("unverifiedDistance") },
    [
      ["locality", "Only if the area name matches (recommended)"],
      ["include", "Always include (flagged)"],
      ["exclude", "Exclude"],
    ].map(([v, t]) => h("option", { value: v, selected: c.unverifiedDistance === v }, t)),
  );

  const sectionChecks = Object.entries(state.sections).map(([id, label]) => {
    f[`section:${id}`] = h("input", { type: "checkbox", checked: c.sections.includes(id) });
    return h("label", { class: "check" }, f[`section:${id}`], label);
  });

  const numOrNull = (el) => (el.value.trim() === "" ? null : Number(el.value));
  const collect = () => ({
    enabled: f.enabled.checked,
    intervalMinutes: Number(f.intervalMinutes.value),
    center: { label: f.centerLabel.value, lat: Number(f.lat.value), lng: Number(f.lng.value) },
    radiusKm: Number(f.radiusKm.value),
    transitEnabled: f.transitEnabled.checked,
    transitCampuses: state.campuses.filter((c) => f[`campus:${c.id}`].checked).map((c) => c.id),
    transitMaxKm: Number(f.transitMaxKm.value),
    transitWalkM: Number(f.transitWalkM.value),
    transitMaxRideMin: Number(f.transitMaxRideMin.value),
    transitMinPerDay: Number(f.transitMinPerDay.value),
    sources: Object.keys(state.sources).filter((id) => f[`source:${id}`].checked),
    sections: Object.keys(state.sections).filter((id) => f[`section:${id}`].checked),
    ulUrls: f.ulUrls.value,
    rentUrls: f.rentUrls.value,
    myhomeUrls: f.myhomeUrls.value,
    webUrls: f.webUrls.value,
    excludeOwnerOccupied: f.excludeOwnerOccupied.checked,
    excludeWeekdayOnly: f.excludeWeekdayOnly.checked,
    availabilityGraceDays: Number(f.availabilityGraceDays.value),
    endGraceDays: Number(f.endGraceDays.value),
    geocode: f.geocode.checked,
    unverifiedDistance: f.unverifiedDistance.value,
    localityHints: f.localityHints.value,
    respectRobots: f.respectRobots.checked,
    maxDetailFetches: Number(f.maxDetailFetches.value),
    priceMin: numOrNull(f.priceMin),
    priceMax: numOrNull(f.priceMax),
    bedsMin: numOrNull(f.bedsMin),
    bedsMax: numOrNull(f.bedsMax),
    leaseMinMonths: numOrNull(f.leaseMinMonths),
    leaseMaxMonths: numOrNull(f.leaseMaxMonths),
    needFrom: f.needFrom.value,
    stayUntil: f.stayUntil.value,
    includeKeywords: f.includeKeywords.value,
    excludeKeywords: f.excludeKeywords.value,
    daftLocation: f.daftLocation.value.trim(),
    maxPages: Number(f.maxPages.value),
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
          const r = await api("PUT", "/api/config", collect());
          state.config = r.config;
          msg.className = "msg ok";
          msg.textContent = "Saved. Changes apply from the next scan (or use Alerts > Scanner details > Scan now to apply them immediately).";
        } catch (err) {
          msg.className = "msg err";
          msg.textContent = err.message;
        }
      },
    },
    "Save settings",
  );

  return h(
    "form",
    { onsubmit: (e) => e.preventDefault() },
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Where"),
      text("centerLabel", "Centre name", c.center.label),
      h(
        "div",
        { class: "row" },
        num("lat", "Latitude", c.center.lat),
        num("lng", "Longitude", c.center.lng),
      ),
      num("radiusKm", "Max distance (km)", c.radiusKm, { min: "0.1", max: "20" }),
      h("div", { class: "hint" }, "Exact straight-line distance from the centre point."),
    ),
    renderTransitSettings(c, f, num, check),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Where to look"),
      sourceChecks,
      h("div", { class: "hint" }, "Daft.ie sections:"),
      sectionChecks,
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "What"),
      check("excludeOwnerOccupied", "Exclude owner-occupied properties", c.excludeOwnerOccupied),
      h("div", { class: "hint" }, "Uses Daft's owner-occupied filter for rooms, then reads each listing's description for live-in landlord wording. Untick to see them."),
      check("excludeWeekdayOnly", "Exclude weekday-only lets (Mon-Fri, 5-day)", c.excludeWeekdayOnly),
      h("div", { class: "row" }, num("priceMin", "Min €/month", c.priceMin), num("priceMax", "Max €/month", c.priceMax)),
      h("div", { class: "row" }, num("bedsMin", "Min beds (houses)", c.bedsMin), num("bedsMax", "Max beds (houses)", c.bedsMax)),
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "When"),
      h("div", { class: "row" }, date("needFrom", "Need from (blank = immediately)", c.needFrom), date("stayUntil", "Stay until", c.stayUntil)),
      h("div", { class: "row" }, num("availabilityGraceDays", "Accept up to N days after need-from", c.availabilityGraceDays, { step: "1", min: "0" }), num("endGraceDays", "Accept ending up to N days before stay-until", c.endGraceDays, { step: "1", min: "0" })),
      h("div", { class: "row" }, num("leaseMinMonths", "Min lease (months)", c.leaseMinMonths), num("leaseMaxMonths", "Max lease (months)", c.leaseMaxMonths)),
      h(
        "div",
        { class: "hint" },
        "Availability is read from listing text where stated (UL Accommodation, Rent.ie, MyHome.ie). Daft search results rarely include it, so Daft listings are not date-filtered. Listings that state a start date too late, or an end date too early, are excluded. Lease limits only apply to Daft.",
      ),
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Keywords"),
      area("excludeKeywords", "Exclude if title/description contains", c.excludeKeywords, "Comma separated."),
      area("includeKeywords", "Only if it contains one of (optional)", c.includeKeywords),
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Scanning"),
      check("enabled", "Scanning enabled", c.enabled),
      num("intervalMinutes", "Scan every (minutes)", c.intervalMinutes, { min: "5", max: "1440", step: "1" }),
      h(
        "details",
        {},
        h("summary", {}, "Advanced"),
        urlArea("ulUrls", "UL Accommodation pages (one per line)", c.ulUrls),
        urlArea("rentUrls", "Rent.ie search pages", c.rentUrls),
        urlArea("myhomeUrls", "MyHome.ie search pages", c.myhomeUrls),
        urlArea("webUrls", "Custom pages (any listings site; enable under Where to look)", c.webUrls),
        h("label", { for: fid("unverifiedDistance") }, "If a listing has no coordinates"),
        f.unverifiedDistance,
        area("localityHints", "Area names that count as nearby", c.localityHints, "Used only for listings whose location can't be determined."),
        check("geocode", "Look up coordinates from addresses (OpenStreetMap)", c.geocode),
        check("respectRobots", "Respect robots.txt on scraped sites", c.respectRobots),
        num("maxDetailFetches", "Max detail pages fetched per scan", c.maxDetailFetches, { step: "1", min: "0" }),
        text("daftLocation", "Daft area", c.daftLocation, { autocapitalize: "off", spellcheck: "false" }),
        h("div", { class: "hint" }, "The area name in a Daft search URL: daft.ie/sharing/<this>. Search the area on daft.ie and copy it from the address bar."),
        num("maxPages", "Max result pages per search (Daft: 20 per page)", c.maxPages, { min: "1", max: "10", step: "1" }),
      ),
    ),
    save,
    msg,
  );
}

const mapLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

// "Public transport": accept homes beyond the radius that have a direct route to the campus, and browse
// the stops that go there (with coordinates, to open in a maps app or export).
function renderTransitSettings(c, f, num, check) {
  const byRegion = new Map();
  for (const campus of state.campuses) {
    if (!byRegion.has(campus.region)) byRegion.set(campus.region, []);
    byRegion.get(campus.region).push(campus);
  }
  const auto = state.autoCampuses.map((id) => state.campuses.find((x) => x.id === id)?.name).filter(Boolean);
  const campusBoxes = [...byRegion].map(([region, list]) =>
    h(
      "details",
      { open: list.some((x) => c.transitCampuses.includes(x.id)) },
      h("summary", {}, region),
      list.map((x) => {
        f[`campus:${x.id}`] = h("input", { type: "checkbox", checked: c.transitCampuses.includes(x.id) });
        return h("label", { class: "check" }, f[`campus:${x.id}`], x.name);
      }),
    ),
  );

  const result = h("div", { class: "stops" });
  const pick = h(
    "select",
    { "aria-label": "Campus" },
    state.campuses.map((x) => h("option", { value: x.id, selected: x.id === (c.transitCampuses[0] ?? state.autoCampuses[0]) }, x.name)),
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
                h("summary", {}, `${MODE_ICON[r.mode] ?? ""} ${r.label} · ${r.operator} · ${r.stops.length} stops`),
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
    "div",
    { class: "panel" },
    h("h2", {}, "Public transport"),
    check("transitEnabled", "Also accept homes beyond the distance above that are on a direct bus, tram or train route to the campus", c.transitEnabled),
    h("div", { class: "hint" }, "Uses the National Transport Authority's timetables for Bus Éireann, Dublin Bus, Go-Ahead, Luas and Irish Rail. Only services that go straight to the campus count, and only the stops on the side of the road that heads there."),
    h("div", { class: "row" }, num("transitMaxKm", "Furthest from the centre (km)", c.transitMaxKm, { min: "0.5", max: "20" }), num("transitWalkM", "Walk to the stop (m)", c.transitWalkM, { step: "50", min: "100", max: "2000" })),
    h("div", { class: "row" }, num("transitMaxRideMin", "Longest ride (minutes)", c.transitMaxRideMin, { step: "1", min: "5", max: "90" }), num("transitMinPerDay", "Fewest trips per weekday", c.transitMinPerDay, { step: "1", min: "1" })),
    h("div", { class: "hint" }, "The walk is a straight line to the stop, so allow about a quarter more on the ground."),
    h("label", {}, "Campuses"),
    h("div", { class: "hint" }, auto.length ? `Leave all unticked to use the campus at your search centre (now: ${auto.join(", ")}).` : "Nothing is near your search centre, so tick the campus you want."),
    campusBoxes,
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
    install: [icon("pause"), "Not available until Rental Watch is on your Home Screen"],
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
  const r = state.lastRun;
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
          r ? kv("Last scan", `${timeAgo(r.at)} (${r.ok ? "ok" : "failed"})`) : kv("Last scan", "not yet"),
          r && r.ok ? kv("Found / matching / new", `${r.candidates} / ${r.matches} / ${r.newCount}`) : null,
          r && r.ok && r.pending ? kv("Waiting for detail pages", String(r.pending)) : null,
          r && !r.ok ? kv("Error", r.error) : null,
          kv("Next scan", state.scanning ? "running now" : state.config.enabled ? inFuture(state.nextRunAt) : "paused"),
          state.failureCount ? kv("Consecutive failures", String(state.failureCount)) : null,
          watching.rows.map((row) => kv(row.label, row.raw)),
          scan,
          scanMsg,
        )
      : null,
    renderAccount(),
  );
}

function renderAccount() {
  const msg = msgBox();
  const { user, viewingAs } = state;
  const current = h("input", { type: "password", placeholder: "Current password", "aria-label": "Current password", autocomplete: "current-password" });
  const next = h("input", { type: "password", placeholder: "New password (8+ characters)", "aria-label": "New password", autocomplete: "new-password" });
  const change = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api("POST", "/api/account/password", { current: current.value, next: next.value });
          current.value = next.value = "";
          msg.className = "msg ok";
          msg.textContent = "Password changed. Your other devices have been signed out.";
        } catch (err) {
          msg.className = "msg err";
          msg.textContent = err.message;
        }
      },
    },
    h("h3", {}, "Change password"),
    current,
    next,
    h("button", { class: "secondary", type: "submit" }, "Change password"),
    msg,
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
          await api("POST", "/api/logout").catch(() => {});
          state = null;
          sessionEnded = false;
          clearSnapshot();
          render();
        },
      },
      "Log out",
    ),
  );
}

const deviceName = (ua = "") =>
  /iphone|ipad/i.test(ua) ? "iPhone / iPad" : /android/i.test(ua) ? "Android" : /windows/i.test(ua) ? "Windows" : /macintosh/i.test(ua) ? "Mac" : "Device";

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => chars[b % chars.length]).join("");
}

// The message to send someone just added (or whose password was reset), ready to copy or share. The password is only
// ever held here, in memory, until the admin says they're done.
function renderInvite() {
  if (!lastInvite) return null;
  const text = inviteText({ url: location.origin, ...lastInvite });
  const box = h("textarea", { readonly: true, rows: "9", spellcheck: "false", "aria-label": `Message for ${lastInvite.username}`, value: text });
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
  return h(
    "div",
    { class: "panel invite" },
    h("h2", {}, lastInvite.reset ? `New password for ${lastInvite.username}` : `${lastInvite.username} is ready`),
    h("div", { class: "hint" }, "Send them this. The password is only shown here, so copy it before you click Done."),
    box,
    h("button", { class: "primary", type: "button", onclick: copy }, "Copy message"),
    navigator.share
      ? h(
          "button",
          { class: "secondary", type: "button", onclick: () => navigator.share({ text }).catch(() => {}) },
          "Share",
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

  const name = h("input", { type: "text", placeholder: "Username", "aria-label": "Username", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const pass = h("input", { type: "text", placeholder: "Password (8+ characters)", "aria-label": "Password", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const add = h(
    "form",
    {
      onsubmit: (e) => {
        e.preventDefault();
        act(async () => {
          const username = name.value.trim().toLowerCase();
          const password = pass.value;
          await api("POST", "/api/users", { username, password });
          lastInvite = { username, password, reset: false };
          say(`Created ${username}. They can change their password under Alerts.`);
        })();
      },
    },
    name,
    pass,
    h("button", { class: "secondary", type: "button", onclick: () => (pass.value = randomPassword()) }, "Generate password"),
    h("button", { class: "primary", type: "submit" }, "Create user"),
  );

  const userPanel = (u) =>
    h(
      "div",
      { class: "panel" },
      h("h2", {}, u.username),
      kv("Last signed in", u.lastLoginAt ? timeAgo(u.lastLoginAt) : "never"),
      kv("Last active", u.lastSeenAt ? timeAgo(u.lastSeenAt) : "never"),
      kv("Devices subscribed", String(u.devices.length)),
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
      h(
        "button",
        {
          class: "secondary",
          onclick: act(async () => {
            const password = prompt(`New password for ${u.username} (8+ characters). They will be signed out everywhere.`);
            if (!password) return;
            await api("PUT", `/api/users/${encodeURIComponent(u.username)}/password`, { password });
            lastInvite = { username: u.username, password, reset: true };
            say(`Password for ${u.username} changed.`);
          }),
        },
        "Reset password",
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
      h("h2", {}, "Add a user"),
      h("div", { class: "hint" }, "Only you can add people. Everyone sees the same listings from one search that only you can change, and each person gets alerts on their own devices."),
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
  if (!state.vapidPublicKey) throw new Error("Can't reach Rental Watch. Check your connection and try again.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(
      isIos
        ? "Alerts weren't allowed. Open Settings, then Notifications, then Rental Watch, and switch on Allow Notifications."
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
