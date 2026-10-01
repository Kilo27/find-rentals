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
  for (const c of children.flat()) {
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

export function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
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

export const isNewMatch = (m) => Boolean(m.firstSeenAt) && Date.now() - Date.parse(m.firstSeenAt) < 24 * 3600 * 1000;

export const priceText = (m) => (m.priceMonthly !== null && m.priceMonthly !== undefined ? `€${m.priceMonthly.toLocaleString("en-IE")}/mo` : m.priceText || "Price n/a");

// Everything a card shows about a listing, as plain data.
export function describeMatch(m) {
  const flags = m.flags ?? [];
  const isNew = isNewMatch(m);
  let dist = null;
  if (m.distanceKm !== null && m.distanceKm !== undefined) {
    const how = m.distanceSource === "geocoded" ? " (from address)" : m.distanceSource === "geocoded-area" ? " (approx, area only)" : "";
    dist = `${flags.includes("distance-approx") ? "~" : ""}${m.distanceKm.toFixed(1)} km${how}`;
  } else if (flags.includes("distance-unverified")) dist = "distance unverified";

  const badges = [];
  if (isNew) badges.push({ cls: "new", text: "NEW" });
  if (flags.includes("available-now")) badges.push({ text: "available now" });
  else if (m.availableFrom) badges.push({ text: `from ${fmtDate(m.availableFrom)}` });
  if (flags.includes("ends-early")) badges.push({ cls: "warn", text: `ends ${fmtDate(m.availableTo)}` });
  if (flags.includes("short-term")) badges.push({ text: "short-term friendly" });
  if (flags.includes("owner-occupied-unknown")) badges.push({ cls: "warn", text: "check owner-occupied" });
  if (flags.includes("distance-unverified")) badges.push({ cls: "warn", text: "check distance" });
  if (flags.includes("availability-unknown")) badges.push({ cls: "warn", text: "availability not stated" });
  if (m.alsoOn?.length) badges.push({ text: `also on ${m.alsoOn.map((a) => a.label).join(", ")}` });
  if (m.publishedAt) badges.push({ text: `listed ${timeAgo(m.publishedAt)}` });

  return {
    isNew,
    price: priceText(m),
    meta: [m.bedsText, m.propertyType, dist, m.sourceLabel].filter(Boolean).join(" · "),
    badges,
  };
}

export const badgeRow = (badges) =>
  h("div", { class: "badges" }, badges.map((b) => h("span", { class: b.cls ? `badge ${b.cls}` : "badge" }, b.text)));

export const listingImage = (m) => (m.image ? h("img", { src: m.image, loading: "lazy", alt: "", referrerpolicy: "no-referrer" }) : null);
