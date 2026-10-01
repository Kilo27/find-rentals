const root = document.getElementById("app");
let state = null;
let tab = "matches";
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

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== "/api/login") {
    state = null;
    render();
    throw new Error("Please log in");
  }
  if (!res.ok) {
    const err = new Error(data.errors ? data.errors.join("; ") : data.error || `HTTP ${res.status}`);
    throw err;
  }
  return data;
}

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
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
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    await loadState();
    syncSubscription();
  } catch {
    state = null;
  }
  render();
  setInterval(async () => {
    if (!state || document.hidden) return;
    try {
      await loadState();
      if (tab === "matches") render();
    } catch {}
  }, 60_000);
}

function render() {
  root.replaceChildren(state ? renderMain() : renderLogin());
}

function renderLogin() {
  const msg = h("div", { class: "msg err" });
  const name = h("input", { type: "text", placeholder: "Username", autocomplete: "username", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const input = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const form = h(
    "form",
    {
      class: "login",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api("POST", "/api/login", { username: name.value, password: input.value });
          await loadState();
          tab = "matches";
          render();
          syncSubscription();
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    h("h1", {}, "Rental Watch"),
    h("p", { class: "hint" }, "Sign in with your username and password. You only need to do this once per device."),
    name,
    input,
    h("button", { class: "primary", type: "submit" }, "Log in"),
    msg,
  );
  return form;
}

async function loadUsers() {
  usersList = (await api("GET", "/api/users")).users;
}

async function stopViewing() {
  try {
    await api("DELETE", "/api/view-as");
    await loadState();
    render();
  } catch {}
}

function renderMain() {
  // Only the admin can change the one shared search or manage users.
  const admin = state.user.isAdmin;
  const tabs = [["matches", `Matches (${state.matches.filter((m) => !isDismissed(m)).length})`]];
  if (admin) tabs.push(["settings", "Settings"]);
  tabs.push(["status", "Status"]);
  if (admin) tabs.push(["users", "Users"]);
  if ((tab === "users" || tab === "settings") && !admin) tab = "matches";
  const content = tab === "matches" ? renderMatches() : tab === "settings" ? renderSettings() : tab === "users" ? renderUsers() : renderStatus();
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
    h(
      "header",
      {},
      h("h1", {}, "Rental Watch"),
      h("div", { class: "sub" }, `${c.radiusKm} km of ${c.center.label}`),
    ),
    h("main", {}, content),
    h(
      "nav",
      { class: "tabs" },
      tabs.map(([id, label]) =>
        h(
          "button",
          {
            class: tab === id ? "active" : "",
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

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Sets (or, with null, clears) the user's verdict on a match. Updates the screen first and puts it back if the server says no.
async function setReview(m, status) {
  const before = m.review;
  m.review = status;
  m.reviewError = null;
  render();
  try {
    await api("PUT", "/api/review", { id: m.id, status });
  } catch (err) {
    m.review = before;
    m.reviewError = err.message;
    render();
  }
}

function renderMatches() {
  if (!state.matches.length) {
    const ran = state.lastRun;
    return h(
      "div",
      { class: "empty" },
      ran ? "No matching listings right now. You'll get a notification when one appears." : "Waiting for the first scan...",
    );
  }
  const active = state.matches.filter((m) => !isDismissed(m));
  return [
    ...(active.length ? active.map(renderCard) : [h("div", { class: "empty" }, "Nothing left to look at: everything here has been dismissed.")]),
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
  const isNew = !m.review && m.firstSeenAt && Date.now() - Date.parse(m.firstSeenAt) < 24 * 3600 * 1000;
  const flags = m.flags ?? [];
  let dist = null;
  if (m.distanceKm !== null && m.distanceKm !== undefined) {
    const how = m.distanceSource === "geocoded" ? " (from address)" : m.distanceSource === "geocoded-area" ? " (approx, area only)" : "";
    dist = `${flags.includes("distance-approx") ? "~" : ""}${m.distanceKm.toFixed(1)} km${how}`;
  } else if (flags.includes("distance-unverified")) dist = "distance unverified";
  const meta = [m.bedsText, m.propertyType, dist, m.sourceLabel].filter(Boolean);
  return h(
    "div",
    { class: `card${m.review ? ` ${m.review}` : ""}` },
    h(
      "a",
      { class: "card-link", href: m.url, target: "_blank", rel: "noopener noreferrer" },
      m.image ? h("img", { src: m.image, loading: "lazy", alt: "", referrerpolicy: "no-referrer" }) : null,
      h(
        "div",
        { class: "body" },
        h("div", { class: "price" }, m.priceMonthly !== null ? `€${m.priceMonthly.toLocaleString("en-IE")}/mo` : m.priceText || "Price n/a"),
        h("div", { class: "title" }, m.title),
        h("div", { class: "meta" }, meta.join(" · ")),
        h(
          "div",
          { class: "badges" },
          isNew ? h("span", { class: "badge new" }, "NEW") : null,
          seen ? h("span", { class: "badge" }, "seen") : null,
          flags.includes("available-now") ? h("span", { class: "badge" }, "available now") : m.availableFrom ? h("span", { class: "badge" }, `from ${fmtDate(m.availableFrom)}`) : null,
          flags.includes("ends-early") ? h("span", { class: "badge warn" }, `ends ${fmtDate(m.availableTo)}`) : null,
          flags.includes("short-term") ? h("span", { class: "badge" }, "short-term friendly") : null,
          flags.includes("owner-occupied-unknown") ? h("span", { class: "badge warn" }, "check owner-occupied") : null,
          flags.includes("distance-unverified") ? h("span", { class: "badge warn" }, "check distance") : null,
          flags.includes("availability-unknown") ? h("span", { class: "badge warn" }, "availability not stated") : null,
          m.alsoOn?.length ? h("span", { class: "badge" }, `also on ${m.alsoOn.map((a) => a.label).join(", ")}`) : null,
          m.publishedAt ? h("span", { class: "badge" }, `listed ${timeAgo(m.publishedAt)}`) : null,
        ),
      ),
    ),
    h(
      "div",
      { class: "actions" },
      dismissed
        ? h("button", { class: "act", onclick: () => setReview(m, "seen") }, dismissed.undo)
        : [
            h("button", { class: "act", onclick: () => setReview(m, seen ? null : "seen") }, seen ? "Mark as unseen" : "Mark as seen"),
            h("button", { class: "act bad", onclick: () => setReview(m, "rejected") }, "Not a fit"),
            h("button", { class: "act bad", onclick: () => setReview(m, "unavailable") }, "No longer available"),
          ],
    ),
    m.reviewError ? h("div", { class: "msg err card-msg" }, `Couldn't save that: ${m.reviewError}`) : null,
  );
}

function renderSettings() {
  const c = state.config;
  const msg = h("div", { class: "msg" });
  const f = {};
  const text = (name, label, value, attrs = {}) => {
    f[name] = h("input", { type: "text", value: value ?? "", ...attrs });
    return [h("label", {}, label), f[name]];
  };
  const num = (name, label, value, attrs = {}) => {
    f[name] = h("input", { type: "number", inputmode: "decimal", step: "any", value: value ?? "", ...attrs });
    return h("div", {}, h("label", {}, label), f[name]);
  };
  const date = (name, label, value) => {
    f[name] = h("input", { type: "date", value: value ?? "" });
    return h("div", {}, h("label", {}, label), f[name]);
  };
  const check = (name, label, value) => {
    f[name] = h("input", { type: "checkbox", checked: value });
    return h("label", { class: "check" }, f[name], label);
  };
  const area = (name, label, value, hint) => {
    f[name] = h("textarea", { value: value.join(", ") });
    return [h("label", {}, label), f[name], hint ? h("div", { class: "hint" }, hint) : null];
  };

  const sourceChecks = Object.entries(state.sources).map(([id, label]) => {
    f[`source:${id}`] = h("input", { type: "checkbox", checked: c.sources.includes(id) });
    return h("label", { class: "check" }, f[`source:${id}`], label);
  });
  const urlArea = (name, label, value) => {
    f[name] = h("textarea", { value: value.join("\n"), rows: "3", spellcheck: "false", autocapitalize: "off" });
    return [h("label", {}, label), f[name]];
  };
  f.unverifiedDistance = h(
    "select",
    {},
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
          msg.textContent = "Saved. Changes apply from the next scan (use Status > Scan now to apply immediately).";
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
        h("label", {}, "If a listing has no coordinates"),
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

function renderStatus() {
  const r = state.lastRun;
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const msg = h("div", { class: "msg" });
  const say = (text, ok = true) => {
    msg.className = `msg ${ok ? "ok" : "err"}`;
    msg.textContent = text;
  };

  const enable = h(
    "button",
    {
      class: "primary",
      onclick: async () => {
        try {
          say("Enabling...");
          await enablePush();
          await loadState();
          render();
        } catch (err) {
          say(err.message, false);
        }
      },
    },
    "Enable notifications on this device",
  );
  const test = h(
    "button",
    {
      class: "secondary",
      onclick: async () => {
        try {
          const res = await api("POST", "/api/test-push");
          say(res.sent ? `Sent to ${res.sent} device(s).` : "No device received it. Enable notifications first.", res.sent > 0);
        } catch (err) {
          say(err.message, false);
        }
      },
    },
    "Send test notification",
  );
  const scan = h(
    "button",
    {
      class: "secondary",
      onclick: async (e) => {
        e.target.disabled = true;
        say("Scanning Daft...");
        try {
          await api("POST", "/api/scan");
          await loadState();
          render();
        } catch (err) {
          say(err.message, false);
          e.target.disabled = false;
        }
      },
    },
    "Scan now",
  );

  const viewing = Boolean(state.viewingAs);

  return h(
    "div",
    {},
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Notifications"),
      !viewing && isIos && !isStandalone
        ? h("div", { class: "hint" }, "On iPhone: tap Share, then Add to Home Screen, then open Rental Watch from your Home Screen and come back here. (Needs iOS 16.4 or later.)")
        : null,
      viewing ? null : kv("Permission on this device", perm),
      kv("Devices subscribed", String(state.subscriptions.length)),
      state.subscriptions.map((s) => (s.lastError ? kv("Last push error", s.lastError) : null)),
      viewing
        ? h("div", { class: "hint" }, `Devices and passwords can't be changed while viewing as ${state.viewingAs.username}. Exit to change yours.`)
        : [enable, test],
      msg,
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Scanner"),
      r ? kv("Last scan", `${timeAgo(r.at)} (${r.ok ? "ok" : "FAILED"})`) : kv("Last scan", "not yet"),
      r && r.ok ? kv("Listings seen / matching / new", `${r.candidates} / ${r.matches} / ${r.newCount}`) : null,
      r && r.ok && r.pending ? kv("Waiting for detail pages", String(r.pending)) : null,
      r && !r.ok ? kv("Error", r.error) : null,
      kv("Next scan", state.scanning ? "running now" : state.config.enabled ? inFuture(state.nextRunAt) : "paused"),
      state.failureCount ? kv("Consecutive failures", String(state.failureCount)) : null,
      scan,
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Sources"),
      r
        ? r.sources.map((src) => {
            const health = state.sourceHealth?.[src.id];
            const warn = src.notes.find((n) => n.warning)?.warning;
            const skipped = src.notes.filter((n) => n.skipped).length;
            const detail = src.skipped
              ? `not checked: ${src.skipped}`
              : src.ok
                ? `${src.fetched} found${skipped ? `, ${skipped} page(s) not found` : ""}${warn ? " - check layout" : ""}`
                : `error: ${src.error}`;
            return kv(src.label, health?.failures >= 3 ? `${detail} (failing x${health.failures})` : detail);
          })
        : h("div", { class: "hint" }, "No scan yet."),
    ),
    renderAccount(),
  );
}

function renderAccount() {
  const msg = h("div", { class: "msg" });
  const { user, viewingAs } = state;
  const current = h("input", { type: "password", placeholder: "Current password", autocomplete: "current-password" });
  const next = h("input", { type: "password", placeholder: "New password (8+ characters)", autocomplete: "new-password" });
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

function renderUsers() {
  const note = h("div", { class: `msg ${usersNote ? (usersNote.ok ? "ok" : "err") : ""}` }, usersNote?.text ?? "");
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

  const name = h("input", { type: "text", placeholder: "Username", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const pass = h("input", { type: "text", placeholder: "Password (8+ characters)", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const add = h(
    "form",
    {
      onsubmit: (e) => {
        e.preventDefault();
        act(async () => {
          const username = name.value.trim().toLowerCase();
          const password = pass.value;
          await api("POST", "/api/users", { username, password });
          say(`Created ${username}. Give them this password: ${password}. They can change it under Status.`);
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
            say(`Password for ${u.username} changed. Give them: ${password}`);
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
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was not granted. Check Settings > Notifications for this app.");
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
