import { h, timeAgo, describeMatch, badgeRow, listingImage } from "./ui.js";
import { createMapView } from "./map.js";

const root = document.getElementById("app");
let state = null;
let tab = "matches";
let view = "list";
try {
  if (localStorage.getItem("rw.view") === "map") view = "map";
} catch {}

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

function inFuture(iso) {
  if (!iso) return "";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s < 60) return "any moment";
  return s < 3600 ? `in ${Math.round(s / 60)} min` : `in ${Math.round(s / 3600)} h`;
}

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
      const before = matchSignature();
      await loadState();
      if (tab === "matches" && (view === "list" || before !== matchSignature())) render();
    } catch {}
  }, 60_000);
}

const matchSignature = () => JSON.stringify([state?.matches.map((m) => [m.id, m.priceMonthly, m.lat, m.lng, m.areaKey]), Object.keys(state?.areas ?? {})]);

function render() {
  root.classList.toggle("wide", Boolean(state) && tab === "matches" && view === "map");
  root.replaceChildren(state ? renderMain() : renderLogin());
}

function renderLogin() {
  const msg = h("div", { class: "msg err" });
  const input = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const form = h(
    "form",
    {
      class: "login",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api("POST", "/api/login", { password: input.value });
          await loadState();
          render();
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    h("h1", {}, "Rental Watch"),
    h("p", { class: "hint" }, "Enter the access password. You only need to do this once per device."),
    input,
    h("button", { class: "primary", type: "submit" }, "Log in"),
    msg,
  );
  return form;
}

function renderMain() {
  const tabs = [
    ["matches", `Matches (${state.matches.length})`],
    ["settings", "Settings"],
    ["status", "Status"],
  ];
  const content = tab === "matches" ? renderMatches() : tab === "settings" ? renderSettings() : renderStatus();
  const c = state.config;
  return h(
    "div",
    {},
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
            onclick: () => {
              tab = id;
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
      h("button", { type: "button", class: view === id ? "active" : "", "aria-pressed": String(view === id), onclick: () => view !== id && setView(id) }, label),
    ),
  );
  if (view === "map") {
    mapView.update(state);
    return [toggle, mapView.el];
  }
  return [toggle, ...[renderList()].flat()];
}

function renderList() {
  if (!state.matches.length) {
    const ran = state.lastRun;
    return h("div", { class: "empty" }, ran ? "No matching listings right now. You'll get a notification when one appears." : "Waiting for the first scan...");
  }
  return state.matches.map((m) => {
    const d = describeMatch(m);
    return h(
      "a",
      { class: "card", href: m.url, target: "_blank", rel: "noopener noreferrer" },
      listingImage(m),
      h("div", { class: "body" }, h("div", { class: "price" }, d.price), h("div", { class: "title" }, m.title), h("div", { class: "meta" }, d.meta), badgeRow(d.badges)),
    );
  });
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

  const kv = (k, v) => h("div", { class: "kv" }, h("span", {}, k), h("span", {}, v));

  return h(
    "div",
    {},
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Notifications"),
      isIos && !isStandalone
        ? h("div", { class: "hint" }, "On iPhone: tap Share, then Add to Home Screen, then open Rental Watch from your Home Screen and come back here. (Needs iOS 16.4 or later.)")
        : null,
      kv("Permission on this device", perm),
      kv("Devices subscribed", String(state.subscriptions.length)),
      state.subscriptions.map((s) => (s.lastError ? kv("Last push error", s.lastError) : null)),
      enable,
      test,
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
    h(
      "div",
      { class: "panel" },
      h("button", {
        class: "secondary",
        onclick: async () => {
          await api("POST", "/api/logout").catch(() => {});
          state = null;
          render();
        },
      }, "Log out"),
    ),
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
