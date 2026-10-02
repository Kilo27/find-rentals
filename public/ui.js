// Small helpers shared by the list and the map, so a listing reads the same wherever it appears.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  // Arrays can sit inside arrays (a conditional group inside a list of children), so flatten all the way down: a
  // shallower flatten leaves an inner array to be printed as "[object HTMLButtonElement],...".
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Replaces an element's children with `children`, skipping null/false and flattening arrays, like h() does.
export function fill(el, ...children) {
  el.replaceChildren(
    ...children
      .flat(Infinity)
      .filter((c) => c !== null && c !== undefined && c !== false)
      .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))),
  );
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// New in the last day and not yet looked at.
export const isNewMatch = (m) => !m.review && Boolean(m.firstSeenAt) && Date.now() - Date.parse(m.firstSeenAt) < 24 * 3600 * 1000;

export const MODE_ICON = { bus: "🚌", tram: "🚋", rail: "🚆" };
const MODE_WORD = { bus: "bus", tram: "tram", rail: "train" };

// Small inline icons on one 24px grid with 2px round strokes. They inherit the text colour.
const ICON_PATHS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  alert: '<path d="M12 4l9.5 16h-19z"/><path d="M12 10v4M12 17v.01"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/>',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "icon");
  svg.innerHTML = ICON_PATHS[name] ?? "";
  return svg;
}

// How a home connects to the campus: the nearest stop of each direct route, shown when the home is far enough
// from the campus that you'd want to ride (or when that link is the reason it is listed at all).
function transitLines(m, flags) {
  const via = flags.includes("transit-access");
  if (!m.transit?.campuses?.length || !(via || (m.distanceKm ?? 0) >= 1)) return [];
  const rows = m.transit.campuses.flatMap((c) => c.options.slice(0, via ? 3 : 2).map((o) => ({ c, o }))).slice(0, 4);
  return rows.map(({ c, o }) => `${MODE_ICON[o.mode] ?? "🚌"} ${o.label} · ${o.stop}, ${o.distM} m${o.mins ? ` · ${o.mins} min to ${c.short}` : ` · to ${c.short}`} · ${o.perDay} a day`);
}

export const priceText = (m) => (m.priceMonthly !== null && m.priceMonthly !== undefined ? `€${m.priceMonthly.toLocaleString("en-IE")}/mo` : m.priceText || "Price n/a");

// Everything a card shows about a listing, as plain data. `config` is the search settings (for the radius).
export function describeMatch(m, config) {
  const flags = m.flags ?? [];
  const isNew = isNewMatch(m);

  // How close it is, shown beside the price because it is the second thing anyone decides on. An unverified distance
  // has no figure to show; the "check distance" badge says so once.
  let near = null;
  if (m.distanceKm !== null && m.distanceKm !== undefined) {
    const approx = flags.includes("distance-approx");
    const note = m.distanceSource === "geocoded" ? "from address" : m.distanceSource === "geocoded-area" ? "area only" : null;
    near = { text: `${approx ? "~" : ""}${m.distanceKm.toFixed(1)} km`, note, tone: approx || note === "area only" ? "approx" : null };
    // Beyond the radius the direct route is the whole reason it is listed, so lead with how long it takes.
    const campus = m.transit?.campuses?.[0];
    const best = campus?.options?.[0];
    if (flags.includes("transit-access") && best?.mins) near = { ...near, note: `${best.mins} min to ${campus.short} by ${MODE_WORD[best.mode] ?? "bus"}`, tone: "via" };
  }

  const badges = [];
  if (isNew) badges.push({ cls: "new", text: "NEW" });
  if (m.publishedAt) badges.push({ text: `listed ${timeAgo(m.publishedAt)}` });
  if (m.review === "seen") badges.push({ text: "seen" });
  if (flags.includes("available-now")) badges.push({ text: "available now" });
  else if (m.availableFrom) badges.push({ text: `from ${fmtDate(m.availableFrom)}` });
  if (flags.includes("ends-early")) badges.push({ cls: "warn", text: `ends ${fmtDate(m.availableTo)}` });
  if (flags.includes("short-term")) badges.push({ text: "short-term friendly" });
  if (flags.includes("owner-occupied-unknown")) badges.push({ cls: "warn", text: "check owner-occupied" });
  if (flags.includes("transit-access")) badges.push({ cls: "transit", text: `beyond ${config.radiusKm} km · direct route` });
  if (flags.includes("distance-unverified")) badges.push({ cls: "warn", text: "check distance" });
  if (flags.includes("availability-unknown")) badges.push({ cls: "warn", text: "availability not stated" });
  if (m.alsoOn?.length) badges.push({ text: `also on ${m.alsoOn.map((a) => a.label).join(", ")}` });

  return {
    isNew,
    price: priceText(m),
    near,
    meta: [m.bedsText, m.propertyType, m.sourceLabel].filter(Boolean).join(" · "),
    transit: transitLines(m, flags),
    badges,
  };
}

// The first line of a listing: what it costs, and how near it is.
export const leadRow = (d) =>
  h(
    "div",
    { class: "lead" },
    h("div", { class: "price" }, d.price),
    d.near ? h("div", { class: `near${d.near.tone ? ` ${d.near.tone}` : ""}` }, d.near.text, d.near.note ? h("span", { class: "note" }, d.near.note) : null) : null,
  );

export const badgeRow = (badges) =>
  h("div", { class: "badges" }, badges.map((b) => h("span", { class: b.cls ? `badge ${b.cls}` : "badge" }, b.text)));

export const listingImage = (m) => (m.image ? h("img", { src: m.image, loading: "lazy", alt: "", referrerpolicy: "no-referrer" }) : null);
